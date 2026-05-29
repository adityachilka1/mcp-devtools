/**
 * `mcp-devtools call <tool>` — single-shot tool invocation.
 *
 * Non-interactive sibling to `proxy`: spin up (or POST to) an upstream MCP
 * server, run the canonical initialize → notifications/initialized → tools/call
 * handshake, return the response, exit. Designed for CI / scripting where the
 * inspector UI would be overkill.
 *
 * Both `modelcontextprotocol/inspector` and `wong2/mcp-cli` ship a similar
 * "just fire this one tool call" flow — we previously had `proxy`, `record`,
 * `replay`, `bench` but nothing for the single-shot case.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { type FetchLike, HttpTransport } from "./http-transport.js";
import type { FrameSink } from "./http-transport.js";
import type { JsonRpcFrame, JsonRpcResponse } from "./jsonrpc.js";

export interface CallOptions {
  /** Command (stdio) or `https?://` URL (http transport). */
  upstream: string;
  toolName: string;
  args?: Record<string, unknown>;
  transport?: "stdio" | "http";
  /** Default 10_000. */
  timeoutMs?: number;
  /** Extra HTTP headers — http transport only. */
  headers?: Record<string, string>;
}

export interface CallResult {
  toolName: string;
  ok: boolean;
  /** Raw `result` field from the JSON-RPC response on success. */
  result?: unknown;
  /** JSON-RPC error envelope on failure, OR a synthetic envelope for
   *  transport / config errors (in which case `code` is a negative
   *  value outside the JSON-RPC reserved range). */
  error?: { code: number; message: string; data?: unknown };
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Synthetic error codes for problems that happen on our side of the wire.
// Kept well away from the JSON-RPC reserved range (-32768..-32000).
const ERR_CONFIG = -10001;
const ERR_TRANSPORT = -10002;
const ERR_TIMEOUT = -10003;

/**
 * Top-level entry: dispatch to stdio or http and return a CallResult. Never
 * throws — every failure becomes a `{ ok: false, error: {...} }` envelope so
 * callers can switch on `result.ok` instead of try/catch.
 */
export async function callTool(opts: CallOptions): Promise<CallResult> {
  const t0 = performance.now();
  const upstream = (opts.upstream ?? "").trim();
  if (!upstream) {
    return synthError(opts.toolName, ERR_CONFIG, "upstream is required", t0);
  }

  const transport = opts.transport ?? "stdio";
  try {
    if (transport === "http") {
      if (!upstream.startsWith("http://") && !upstream.startsWith("https://")) {
        return synthError(
          opts.toolName,
          ERR_CONFIG,
          `http transport requires upstream to be a URL, got: ${opts.upstream}`,
          t0,
        );
      }
      // Internal-only hook for unit tests — see call.test.ts. Not part of
      // the public CallOptions surface, so we read it off the bag here.
      const fetchImpl = (opts as { fetchImpl?: FetchLike }).fetchImpl;
      return await callViaHttp(opts, upstream, fetchImpl, t0);
    }
    return await callViaStdio(opts, upstream, t0);
  } catch (err) {
    return synthError(opts.toolName, ERR_TRANSPORT, (err as Error).message ?? String(err), t0);
  }
}

/**
 * Build the synthetic `{ ok: false, error }` envelope. `t0` is the start time
 * so we can stamp a meaningful `durationMs` even on early-exit errors.
 */
function synthError(toolName: string, code: number, message: string, t0: number): CallResult {
  return {
    toolName,
    ok: false,
    error: { code, message },
    durationMs: Math.max(0, performance.now() - t0),
  };
}

// ── stdio path ───────────────────────────────────────────────────────────────

async function callViaStdio(opts: CallOptions, upstream: string, t0: number): Promise<CallResult> {
  const parts = splitCommand(upstream);
  const exe = parts[0];
  if (!exe) {
    return synthError(opts.toolName, ERR_CONFIG, "empty upstream command", t0);
  }
  const args = parts.slice(1);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(exe, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MCP_DEVTOOLS_CALL: "1" },
    }) as ChildProcessWithoutNullStreams;
  } catch (err) {
    return synthError(opts.toolName, ERR_TRANSPORT, (err as Error).message, t0);
  }

  // Capture spawn errors (ENOENT on a non-existent binary fires async).
  const spawnErr = new Promise<Error>((resolve) => {
    child.once("error", resolve);
  });

  try {
    const racePromise = runCallOverStreams({
      toolName: opts.toolName,
      args: opts.args,
      stdin: child.stdout,
      stdout: child.stdin,
      timeoutMs: opts.timeoutMs,
      _t0: t0,
    });
    const result = await Promise.race([
      racePromise,
      spawnErr.then((e): CallResult => synthError(opts.toolName, ERR_TRANSPORT, e.message, t0)),
    ]);
    return result;
  } finally {
    // Clean up the child — we got our answer, kill it.
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Naive shell split — matches the convention used by proxy.ts / doctor.ts. */
function splitCommand(s: string): string[] {
  return s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

// ── http path ────────────────────────────────────────────────────────────────

async function callViaHttp(
  opts: CallOptions,
  url: string,
  fetchImpl: FetchLike | undefined,
  t0: number,
): Promise<CallResult> {
  const transport = new HttpTransport({
    url,
    extraHeaders: opts.headers,
    fetchImpl,
  });

  // The HTTP transport delivers frames via a FrameSink callback; we route
  // every incoming frame through a single dispatcher that resolves the
  // pending id-matched promise.
  const pending = new Map<number | string, (frame: JsonRpcResponse) => void>();

  const sink: FrameSink = {
    onIncoming(frame) {
      if ("_parseError" in frame) return;
      if (!("id" in frame) || frame.id == null) return;
      const cb = pending.get(frame.id);
      if (cb) {
        pending.delete(frame.id);
        cb(frame as JsonRpcResponse);
      }
    },
  };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 1. initialize
  const initFrame = makeInitialize(1);
  const initWait = waitForId(pending, 1, timeoutMs);
  try {
    await transport.sendOutbound(initFrame, sink);
  } catch (err) {
    return synthError(opts.toolName, ERR_TRANSPORT, (err as Error).message, t0);
  }
  const initResp = await initWait;
  if (!initResp) {
    return synthError(opts.toolName, ERR_TIMEOUT, "timeout waiting for initialize response", t0);
  }
  if ("error" in initResp && initResp.error) {
    return {
      toolName: opts.toolName,
      ok: false,
      error: initResp.error,
      durationMs: Math.max(0, performance.now() - t0),
    };
  }

  // 2. notifications/initialized (notification — no response expected).
  try {
    await transport.sendOutbound(makeInitialized(), sink);
  } catch (err) {
    return synthError(opts.toolName, ERR_TRANSPORT, (err as Error).message, t0);
  }

  // 3. tools/call
  const callFrame = makeToolCall(2, opts.toolName, opts.args);
  const callWait = waitForId(pending, 2, timeoutMs);
  try {
    await transport.sendOutbound(callFrame, sink);
  } catch (err) {
    return synthError(opts.toolName, ERR_TRANSPORT, (err as Error).message, t0);
  }
  const callResp = await callWait;
  if (!callResp) {
    return synthError(opts.toolName, ERR_TIMEOUT, "timeout waiting for tools/call response", t0);
  }
  if ("error" in callResp && callResp.error) {
    return {
      toolName: opts.toolName,
      ok: false,
      error: callResp.error,
      durationMs: Math.max(0, performance.now() - t0),
    };
  }
  return {
    toolName: opts.toolName,
    ok: true,
    result: (callResp as { result?: unknown }).result,
    durationMs: Math.max(0, performance.now() - t0),
  };
}

function waitForId(
  pending: Map<number | string, (f: JsonRpcResponse) => void>,
  id: number | string,
  timeoutMs: number,
): Promise<JsonRpcResponse | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, timeoutMs);
    pending.set(id, (frame) => {
      clearTimeout(timer);
      resolve(frame);
    });
  });
}

// ── shared frame helpers ─────────────────────────────────────────────────────

function makeInitialize(id: number): JsonRpcFrame {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "mcp-devtools-call", version: "0.1.0" },
      capabilities: {},
    },
  };
}

function makeInitialized(): JsonRpcFrame {
  return {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  };
}

function makeToolCall(
  id: number,
  name: string,
  args: Record<string, unknown> | undefined,
): JsonRpcFrame {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args ?? {} },
  };
}

// ── In-process streams driver (used by both spawn-path and tests) ────────────

export interface RunCallOverStreamsOptions {
  toolName: string;
  args?: Record<string, unknown>;
  /** Frames *from* the server. Caller writes to this. */
  stdin: Readable;
  /** Frames *to* the server. Caller reads from this. */
  stdout: Writable;
  timeoutMs?: number;
  /** Internal — propagate the outer t0 so durationMs spans spawn time too. */
  _t0?: number;
}

/**
 * Drive a single tool call over a pair of streams. The "stdin" stream is the
 * channel where the upstream's frames arrive (we read from it), and "stdout"
 * is where our outbound frames go (we write to it). Symmetric with the way
 * proxy.ts pipes data.
 *
 * Exported so:
 *  - the spawn path in `callViaStdio` reuses it,
 *  - the http path could swap to it too,
 *  - tests can drive it with PassThrough streams (no child process).
 */
export async function runCallOverStreams(opts: RunCallOverStreamsOptions): Promise<CallResult> {
  const t0 = opts._t0 ?? performance.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const pending = new Map<number | string, (f: JsonRpcResponse) => void>();
  // We can't share the module-level `parseFrames` buffer because multiple
  // calls would corrupt each other. Use a local stateful parser.
  let buf = "";
  opts.stdin.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        try {
          const frame = JSON.parse(line) as JsonRpcFrame;
          if ("id" in frame && frame.id != null) {
            const cb = pending.get(frame.id);
            if (cb) {
              pending.delete(frame.id);
              cb(frame as JsonRpcResponse);
            }
            // else: response with non-matching id — drop, do NOT accept.
          }
        } catch {
          // malformed — ignore, eventually the timeout will fire.
        }
      }
      nl = buf.indexOf("\n");
    }
  });

  const write = (frame: JsonRpcFrame) => {
    opts.stdout.write(`${JSON.stringify(frame)}\n`);
  };

  // 1. initialize
  // IMPORTANT: register the pending callback BEFORE writing — otherwise the
  // server's response can arrive on `data` before `waitForId` populates the
  // map, and we'd silently drop it as "unknown id" and time out.
  const initWait = waitForId(pending, 1, timeoutMs);
  write(makeInitialize(1));
  const initResp = await initWait;
  if (!initResp) {
    return {
      toolName: opts.toolName,
      ok: false,
      error: { code: ERR_TIMEOUT, message: "timeout waiting for initialize response" },
      durationMs: Math.max(0, performance.now() - t0),
    };
  }
  if ("error" in initResp && initResp.error) {
    return {
      toolName: opts.toolName,
      ok: false,
      error: initResp.error,
      durationMs: Math.max(0, performance.now() - t0),
    };
  }

  // 2. notifications/initialized
  write(makeInitialized());

  // 3. tools/call (same ordering rule — register first, then write)
  const callWait = waitForId(pending, 2, timeoutMs);
  write(makeToolCall(2, opts.toolName, opts.args));
  const callResp = await callWait;
  if (!callResp) {
    return {
      toolName: opts.toolName,
      ok: false,
      error: { code: ERR_TIMEOUT, message: "timeout waiting for tools/call response" },
      durationMs: Math.max(0, performance.now() - t0),
    };
  }
  if ("error" in callResp && callResp.error) {
    return {
      toolName: opts.toolName,
      ok: false,
      error: callResp.error,
      durationMs: Math.max(0, performance.now() - t0),
    };
  }
  return {
    toolName: opts.toolName,
    ok: true,
    result: (callResp as { result?: unknown }).result,
    durationMs: Math.max(0, performance.now() - t0),
  };
}

// ── Pretty-print helpers (used by the CLI) ───────────────────────────────────

export function formatCallResultHuman(result: CallResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(`✓ ${result.toolName} (${Math.round(result.durationMs)}ms)`);
    lines.push(JSON.stringify(result.result, null, 2));
  } else {
    lines.push(`✗ ${result.toolName} (${Math.round(result.durationMs)}ms)`);
    if (result.error) {
      lines.push(`error ${result.error.code}: ${result.error.message}`);
      if (result.error.data !== undefined) {
        lines.push(JSON.stringify(result.error.data, null, 2));
      }
    }
  }
  return lines.join("\n");
}

export function formatCallResultJson(result: CallResult): string {
  return JSON.stringify(result);
}

/** Exit code mapping: 0 success, 1 tool error, 2 transport/config error. */
export function exitCodeFor(result: CallResult): 0 | 1 | 2 {
  if (result.ok) return 0;
  const code = result.error?.code;
  if (code === ERR_CONFIG || code === ERR_TRANSPORT || code === ERR_TIMEOUT) return 2;
  return 1;
}
