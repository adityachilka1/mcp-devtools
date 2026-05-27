import { spawn } from "node:child_process";
/**
 * Recorder mode — same proxy plumbing but skips the UI and writes a
 * `.mcptrace` (gzipped JSONL) artifact instead. Designed to be replayable
 * deterministically; useful in CI to catch protocol regressions.
 *
 * ## Rotation
 *
 * For long-running sessions an unbounded `.mcptrace` becomes a liability. When
 * `rotateBytes` is set, after each frame write we check the bytes-fed-to-gzip
 * counter; if it exceeds the threshold we close the current gzip stream
 * cleanly (so the rotated file is a self-contained gzip archive), shift the
 * numbered suffixes (`<base>.1` → `<base>.2`, …), rename `<base>` → `<base>.1`,
 * delete anything past `keep`, and reopen `<base>` for the next frame.
 *
 * Why input bytes, not on-disk size: zlib's Transform buffers internally and
 * only flushes on `end()`, so the file stream's `bytesWritten` counter (and
 * `statSync().size`) stays near zero between rotations. Triggering on
 * pre-compression input bytes is deterministic, sync-cheap, and gives a
 * stable rotation cadence; the on-disk archive is always smaller (gzip
 * compresses), so `--rotate 10MB` is an upper bound on the *uncompressed*
 * payload per archive.
 *
 * Rotation is async (we must wait for `gz.end()` + writeStream `finish` so the
 * gzip trailer is on disk). To avoid losing frames or interleaving writes with
 * the rename, an in-flight rotation buffers subsequent frames in memory; they
 * flush to the fresh gzip stream once rotation completes.
 *
 * `tail.ts` already handles the read-side: when the file shrinks below the
 * tail's read offset it reopens from byte 0. Our rotation triggers exactly
 * that shrink, so live `tail -f` keeps working across rotations.
 */
import { type WriteStream, createWriteStream, promises as fsp } from "node:fs";
import { type Gzip, createGzip } from "node:zlib";
import { parseFrames } from "./jsonrpc.js";
import { log } from "./util/log.js";

export interface RecorderOptions {
  upstreamCommand: string;
  outPath: string;
  /** When set, rotate the trace file after this many input bytes have been written. */
  rotateBytes?: number;
  /** Maximum number of rotated files to retain (default 3). Older ones are deleted. */
  keep?: number;
}

/**
 * Parse a size string like "10MB", "500KB", "1GB" into bytes. Accepts decimal
 * numbers and the suffixes B/KB/MB/GB (case-insensitive, optional). Throws
 * with a clear message on garbage input — callers should let it bubble.
 */
export function parseSize(input: string): number {
  const m = String(input)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!m) {
    throw new Error(
      `invalid --rotate size: ${JSON.stringify(input)} (expected e.g. "10MB", "500KB", "1GB", "1024")`,
    );
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? "b").toLowerCase();
  const mult = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  const bytes = Math.floor(n * mult);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`invalid --rotate size: ${JSON.stringify(input)} (must be > 0 bytes)`);
  }
  return bytes;
}

/**
 * Shift `<base>.{N}` → `<base>.{N+1}` for N from `keep-1` down to 1, then
 * rename `<base>` → `<base>.1`. Anything at or past `keep` is unlinked.
 * Idempotent against missing files — every step is best-effort.
 */
async function rollFiles(base: string, keep: number): Promise<void> {
  // Drop the file that would be pushed past the cap.
  await fsp.rm(`${base}.${keep}`, { force: true });
  // Shift numbered backups down. Going high-to-low avoids clobbering.
  for (let i = keep - 1; i >= 1; i--) {
    const src = `${base}.${i}`;
    const dst = `${base}.${i + 1}`;
    try {
      await fsp.rename(src, dst);
    } catch (err) {
      // Missing intermediate slots are fine — the user may have rotated only
      // once so far. Any other error is real and should surface.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  // Finally, the current file becomes .1. It must exist by the time we
  // call this (we only rotate after writing at least one frame).
  await fsp.rename(base, `${base}.1`);
}

/** Open a fresh gzip → writeStream pair on `outPath`. */
function openStreams(outPath: string): { gz: Gzip; out: WriteStream } {
  const gz = createGzip();
  const out = createWriteStream(outPath);
  gz.pipe(out);
  return { gz, out };
}

/**
 * Close a gzip transform cleanly and wait for the underlying file stream to
 * flush its trailer. After this resolves the rotated file is a complete,
 * self-contained gzip archive.
 */
function closeStreams(gz: Gzip, out: WriteStream): Promise<void> {
  return new Promise<void>((resolve) => {
    out.once("finish", () => resolve());
    out.once("close", () => resolve());
    out.once("error", () => resolve());
    gz.end();
  });
}

export async function startRecorder(opts: RecorderOptions): Promise<void> {
  const rotateBytes = opts.rotateBytes;
  const keep = opts.keep ?? 3;
  if (rotateBytes != null && rotateBytes <= 0) {
    throw new Error("rotateBytes must be > 0");
  }
  if (keep <= 0) {
    throw new Error("keep must be > 0");
  }

  let { gz, out } = openStreams(opts.outPath);

  const parts = opts.upstreamCommand.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const cmd = parts[0];
  if (!cmd) throw new Error("empty --upstream command");
  const args = parts.slice(1);

  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  log.info(`recording → ${opts.outPath}`);

  let seq = 0;
  // Bytes fed into the current gzip stream since the last rotation.
  let inputBytes = 0;
  // While a rotation is in flight any frames produced get queued, then flushed
  // to the fresh gzip stream once the rename completes. Without this we'd
  // either drop frames or write them to a closed gzip and crash.
  let rotating = false;
  const pendingFrames: string[] = [];

  const maybeRotate = async (): Promise<void> => {
    if (rotateBytes == null || rotating) return;
    if (inputBytes < rotateBytes) return;
    rotating = true;
    const oldGz = gz;
    const oldOut = out;
    try {
      await closeStreams(oldGz, oldOut);
      await rollFiles(opts.outPath, keep);
      const fresh = openStreams(opts.outPath);
      gz = fresh.gz;
      out = fresh.out;
      inputBytes = 0;
      // Drain the buffered frames produced while rotation was running.
      for (const line of pendingFrames) {
        gz.write(line);
        inputBytes += Buffer.byteLength(line, "utf8");
      }
      pendingFrames.length = 0;
    } catch (err) {
      // Surface but don't kill the recorder — a failed rotate leaves the
      // freshly opened streams in place and we'll try again next frame.
      log.warn(`rotation failed: ${(err as Error).message}`);
    } finally {
      rotating = false;
    }
  };

  const write = (direction: "in" | "out", chunk: Buffer) => {
    for (const frm of parseFrames(chunk)) {
      const line = `${JSON.stringify({ id: ++seq, ts: Date.now(), direction, frame: frm })}\n`;
      if (rotating) {
        pendingFrames.push(line);
      } else {
        gz.write(line);
        inputBytes += Buffer.byteLength(line, "utf8");
        // Fire-and-forget — rotation is async and any subsequent frames will
        // queue via the `rotating` guard. We don't await here so the proxy
        // hot-path stays non-blocking.
        void maybeRotate();
      }
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

// ── test seams ─────────────────────────────────────────────────────────────

/**
 * Internal: write a sequence of pre-formed JSONL lines through the rotation
 * machinery, without spawning a child process. Mirrors `startRecorder`'s
 * rotation flow byte-for-byte. Exposed only for `recorder.test.ts`.
 */
export async function _writeWithRotationForTest(opts: {
  outPath: string;
  lines: string[];
  rotateBytes?: number;
  keep?: number;
}): Promise<void> {
  const rotateBytes = opts.rotateBytes;
  const keep = opts.keep ?? 3;

  let { gz, out } = openStreams(opts.outPath);
  let inputBytes = 0;
  let rotating = false;
  const pending: string[] = [];

  const maybeRotate = async () => {
    if (rotateBytes == null || rotating) return;
    if (inputBytes < rotateBytes) return;
    rotating = true;
    const oldGz = gz;
    const oldOut = out;
    await closeStreams(oldGz, oldOut);
    await rollFiles(opts.outPath, keep);
    const fresh = openStreams(opts.outPath);
    gz = fresh.gz;
    out = fresh.out;
    inputBytes = 0;
    for (const line of pending) {
      gz.write(line);
      inputBytes += Buffer.byteLength(line, "utf8");
    }
    pending.length = 0;
    rotating = false;
  };

  for (const line of opts.lines) {
    if (rotating) {
      pending.push(line);
    } else {
      gz.write(line);
      inputBytes += Buffer.byteLength(line, "utf8");
      await maybeRotate();
    }
  }

  // Wait for any in-flight rotation to settle before tearing down.
  while (rotating) await new Promise((r) => setTimeout(r, 5));
  await closeStreams(gz, out);
  if (pending.length > 0) {
    throw new Error(`pending frames not flushed: ${pending.length}`);
  }
}
