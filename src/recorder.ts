import { spawn } from "node:child_process";
/**
 * Recorder mode — same proxy plumbing but skips the UI and writes a
 * `.mcptrace` (gzipped JSONL) artifact instead. Designed to be replayable
 * deterministically; useful in CI to catch protocol regressions.
 */
import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { parseFrames } from "./jsonrpc.js";
import { log } from "./util/log.js";

export interface RecorderOptions {
  upstreamCommand: string;
  outPath: string;
}

export async function startRecorder(opts: RecorderOptions): Promise<void> {
  const gz = createGzip();
  const out = createWriteStream(opts.outPath);
  gz.pipe(out);

  const parts = opts.upstreamCommand.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const cmd = parts[0];
  if (!cmd) throw new Error("empty --upstream command");
  const args = parts.slice(1);

  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  log.info(`recording → ${opts.outPath}`);

  let seq = 0;
  const write = (direction: "in" | "out", chunk: Buffer) => {
    for (const frame of parseFrames(chunk)) {
      gz.write(`${JSON.stringify({ id: ++seq, ts: Date.now(), direction, frame })}\n`);
    }
  };

  process.stdin.on("data", (c) => {
    child.stdin.write(c);
    write("out", c);
  });
  // Propagate stdin EOF to the child so it can shut down cleanly.
  process.stdin.on("end", () => child.stdin.end());
  child.stdout.on("data", (c) => {
    process.stdout.write(c);
    write("in", c);
  });
  child.stderr.on("data", (c) => process.stderr.write(c));

  child.on("exit", (code) => {
    // End the gzip transform; wait for the file stream to drain *and* close
    // before exiting, otherwise the trailing bytes never reach disk.
    gz.end();
    out.on("finish", () => process.exit(code ?? 0));
  });
}
