/**
 * Transparent MCP proxy.
 *
 * Spawns the upstream MCP server as a child process and pipes JSON-RPC frames
 * in both directions while persisting them to the in-memory ring buffer that
 * the inspector UI subscribes to.
 *
 * The proxy is intentionally protocol-agnostic — it does NOT parse semantic
 * tool calls; it parses JSON-RPC envelopes and tags each frame with direction,
 * timestamp, and a monotonically-increasing sequence number. Semantic
 * interpretation (e.g. "this is a tools/call") happens in the UI layer.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { parseFrames } from "./jsonrpc.js";
import { TraceStore } from "./trace-store.js";
import { startUiServer } from "./ui-server.js";
import { log } from "./util/log.js";
import { openBrowserAt } from "./util/open.js";

export interface ProxyOptions {
  upstreamCommand: string;
  port: number;
  transport: "stdio" | "http";
  openBrowser: boolean;
}

export async function startProxy(opts: ProxyOptions): Promise<void> {
  if (opts.transport === "http") {
    throw new Error("HTTP transport is on the v0.2 roadmap. Use stdio for now.");
  }

  const store = new TraceStore();
  const events = new EventEmitter();

  // Spawn the upstream server.
  const parts = splitCommand(opts.upstreamCommand);
  const cmd = parts[0];
  if (!cmd) throw new Error("empty --upstream command");
  const args = parts.slice(1);

  const child: ChildProcessWithoutNullStreams = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MCP_DEVTOOLS_PROXIED: "1" },
  });
  log.info(`upstream → ${opts.upstreamCommand} (pid ${child.pid})`);

  // Stream stdin → upstream, tagging frames going "out" (client → server).
  process.stdin.on("data", (chunk) => {
    child.stdin.write(chunk);
    for (const frame of parseFrames(chunk)) {
      const id = store.record({ direction: "out", frame });
      events.emit("frame", id);
    }
  });
  // Propagate stdin EOF so the upstream can shut down cleanly.
  process.stdin.on("end", () => child.stdin.end());

  // Stream upstream stdout → stdin, tagging frames going "in" (server → client).
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    for (const frame of parseFrames(chunk)) {
      const id = store.record({ direction: "in", frame });
      events.emit("frame", id);
    }
  });

  // Surface upstream stderr — never swallow it.
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  child.on("exit", (code) => {
    log.info(`upstream exited with code ${code}`);
    process.exit(code ?? 0);
  });

  // Spin up the UI server.
  await startUiServer({ port: opts.port, store, events });
  log.info(`inspector ready → http://localhost:${opts.port}/inspect`);

  if (opts.openBrowser) {
    await openBrowserAt(`http://localhost:${opts.port}/inspect`);
  }
}

function splitCommand(s: string): string[] {
  // Naive shell split — good enough for the common case `node ./server.js`.
  // Real users can pass `--upstream "/bin/sh -c '...'"` for anything fancier.
  return s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}
