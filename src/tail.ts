/**
 * `mcp-devtools tail <trace>` — `tail -f`-style live viewer for a `.mcptrace`.
 *
 * Purpose: when a user runs `record` in one terminal, they need a way to watch
 * frames stream in from another terminal without firing up the inspector UI.
 * `tail` is that — read the trace once, then follow appends, printing one tidy
 * line per new frame.
 *
 * The trace format is gzipped JSONL (see recorder.ts). Live-tailing a gzip is
 * the tricky bit: we keep a single long-lived `createGunzip()` transform alive
 * for the whole session, and feed it bytes from the file as they appear. This
 * works for both single-member streams (a normal recorder that hasn't flushed
 * mid-stream) and multi-member streams (concatenated gzip members — what you
 * get from a flushing writer or our own tests). Node's gunzip transparently
 * handles both.
 *
 * Watchers:
 *   - We use the builtin `fs.watch` (no new dep). On macOS and Linux it fires
 *     'change' events on size changes; we re-stat to detect grow/shrink/none.
 *   - When the file shrinks below our current read offset (truncation or
 *     rotation), we close and reopen the gunzip transform and start over from
 *     byte zero — the only safe move, since the previous deflate state is
 *     unrecoverable.
 *
 * Output: timestamp HH:MM:SS.SSS, direction arrow (← / →), method or response
 * id, with a latency hint when pairing is obvious. Uses the same kleur palette
 * as the rest of the CLI for visual continuity.
 *
 * Hand-off back to the caller: returns `{ stop }` so the CLI (or a test) can
 * tear down all watchers, file descriptors, and timers in a single call.
 */
import { type FSWatcher, type ReadStream, createReadStream, promises as fsp, watch } from "node:fs";
import { type Gunzip, createGunzip } from "node:zlib";
import kleur from "kleur";
import type { JsonRpcFrame } from "./jsonrpc.js";
import type { StoredFrame } from "./trace-store.js";

/** Shape of a parsed-but-malformed line, mirroring jsonrpc.ts. */
export interface TailParseError {
  _raw: string;
  _parseError: string;
}

/**
 * One emitted record. Either a normal `StoredFrame` from the trace, or a
 * parse-error envelope keeping the consumer's hot path branch-free.
 */
export type TailRecord = StoredFrame | TailParseError;

export interface TailOptions {
  path: string;
  /** "start" (default) reads the file from byte 0. "end" skips to current EOF. */
  since?: "start" | "end";
  /** When true, keeps watching for appends after the initial read drains. */
  follow?: boolean;
  /** Callback invoked once per parsed record (or parse error). */
  onLine?: (record: TailRecord) => void;
}

export interface TailHandle {
  /** Idempotent — tears down watchers, streams, and the gunzip transform. */
  stop: () => Promise<void>;
}

/** Parse a single JSONL line into a `TailRecord`. */
function parseLine(line: string): TailRecord {
  try {
    return JSON.parse(line) as StoredFrame;
  } catch (err) {
    return { _raw: line, _parseError: (err as Error).message };
  }
}

/**
 * Stream the file from `startOffset` onward through a fresh gunzip transform.
 * Resolves with the new read offset (= file size at the time of stream end).
 * Emits decoded text into `onText`.
 */
async function drainFromOffset(
  path: string,
  startOffset: number,
  onText: (chunk: string) => void,
  state: { gz: Gunzip | null; rs: ReadStream | null },
): Promise<number> {
  const stats = await fsp.stat(path);
  if (stats.size <= startOffset) return startOffset;

  // Fresh gunzip per drain — the recorder writes single-shot gzipSync members
  // when flushing, and one Gunzip transform consumes a concatenated sequence
  // happily. Keeping it short-lived also means partial trailing bytes (a half-
  // written gzip member) don't poison long-running state: we just drop the
  // error and pick up on the next 'change' event.
  const gz = createGunzip();
  const rs = createReadStream(path, { start: startOffset, end: stats.size - 1 });
  state.gz = gz;
  state.rs = rs;

  return await new Promise<number>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      state.gz = null;
      state.rs = null;
      resolve(stats.size);
    };
    gz.on("data", (chunk: Buffer) => onText(chunk.toString("utf8")));
    gz.on("end", finish);
    // A truncation-mid-write or a half-flushed gzip member surfaces as an
    // unexpected-end-of-stream error. Don't crash the tail — we'll get another
    // 'change' event soon enough and retry from the same offset.
    gz.on("error", finish);
    rs.on("error", finish);
    rs.pipe(gz);
  });
}

/**
 * Live-tail a `.mcptrace` file. Returns once initial drain has completed (for
 * `follow: false`) or after watchers are installed (for `follow: true`).
 */
export async function tailTrace(opts: TailOptions): Promise<TailHandle> {
  const { path, since = "start", follow = false, onLine } = opts;

  // Pre-flight stat so file-not-found surfaces as a clean promise rejection
  // (mirrors the profile.ts / replay.ts convention).
  const initial = await fsp.stat(path);
  let offset = since === "end" ? initial.size : 0;

  // Carry buffer for partial-line decoded text — we only emit complete lines.
  let lineBuf = "";
  let stopped = false;
  let draining = false;
  let pendingDrain = false;
  let watcher: FSWatcher | null = null;
  // Held so stop() can force-destroy a mid-flight stream/transform.
  const inflight: { gz: Gunzip | null; rs: ReadStream | null } = { gz: null, rs: null };

  const handleText = (text: string) => {
    lineBuf += text;
    let nl = lineBuf.indexOf("\n");
    while (nl !== -1) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (line) onLine?.(parseLine(line));
      nl = lineBuf.indexOf("\n");
    }
  };

  const drainOnce = async (): Promise<void> => {
    if (stopped) return;
    if (draining) {
      // Coalesce — if a drain is in flight, mark that another should run when
      // it finishes. fs.watch can fire many events in a tight loop.
      pendingDrain = true;
      return;
    }
    draining = true;
    try {
      // Detect truncation/rotation: if the file is now smaller than our read
      // offset, the previous gzip stream is meaningless. Reopen from zero.
      let stats: import("node:fs").Stats;
      try {
        stats = await fsp.stat(path);
      } catch {
        return;
      }
      if (stats.size < offset) {
        offset = 0;
        lineBuf = "";
      }
      offset = await drainFromOffset(path, offset, handleText, inflight);
    } finally {
      draining = false;
      if (pendingDrain && !stopped) {
        pendingDrain = false;
        // Microtask-loop so we don't recurse and blow the stack on a hot file.
        queueMicrotask(() => {
          void drainOnce();
        });
      }
    }
  };

  // Initial read — only if since=start, otherwise we've already jumped to EOF.
  if (since === "start") {
    await drainOnce();
  }

  if (follow) {
    // fs.watch on macOS/Linux fires 'change' on size changes. We don't trust
    // the event payload — every fire just kicks a coalesced drain.
    try {
      watcher = watch(path, () => {
        void drainOnce();
      });
    } catch {
      // Watcher creation can fail in pathological filesystems; tail still works
      // for what we've already read, but follow won't fire. Surface nothing —
      // the CLI layer logs the configured mode separately.
    }
  }

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    if (inflight.rs) {
      inflight.rs.destroy();
      inflight.rs = null;
    }
    if (inflight.gz) {
      inflight.gz.destroy();
      inflight.gz = null;
    }
  };

  return { stop };
}

// ── formatting ─────────────────────────────────────────────────────────────

/** Pad a 1–3 digit ms count to a stable 3-char field for the HH:MM:SS.SSS slot. */
function pad3(n: number): string {
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return String(n);
}

/** Render a unix-ms timestamp as HH:MM:SS.SSS in the local timezone. */
export function formatTs(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}.${pad3(d.getMilliseconds())}`;
}

/** Pretty-format a tail record for the terminal. Pure — no I/O. */
export function formatRecord(rec: TailRecord, latencyMs?: number): string {
  if ("_parseError" in rec) {
    return `${kleur.dim("--:--:--.---")} ${kleur.red("?")} ${kleur.red("parse error")} ${kleur.dim(rec._parseError)}`;
  }
  const ts = formatTs(rec.ts);
  // Arrow: client → server is "out" (we print →), server → client is "in" (←).
  const arrow = rec.direction === "out" ? kleur.cyan("→") : kleur.magenta("←");
  const frame = rec.frame as JsonRpcFrame;
  const id = "id" in frame ? (frame as { id?: unknown }).id : undefined;
  const method = "method" in frame ? (frame as { method?: unknown }).method : undefined;

  let label: string;
  if (typeof method === "string" && id != null) {
    // Request — method name.
    label = `${kleur.bold(method)}${kleur.dim(`#${String(id)}`)}`;
  } else if (typeof method === "string") {
    // Notification — method name, dimmed (no response will pair).
    label = kleur.dim(method);
  } else if (id != null) {
    // Response — id only (we can't recover the method without state). The
    // leading arrow already came from `direction`, so we just stamp the id.
    const isError = "error" in frame && (frame as { error?: unknown }).error != null;
    const tag = isError ? kleur.red(`#${String(id)}`) : kleur.dim(`#${String(id)}`);
    label = tag;
  } else {
    label = kleur.dim("(unknown shape)");
  }

  const latency = latencyMs != null && latencyMs >= 0 ? ` ${kleur.dim(`(${latencyMs}ms)`)}` : "";
  return `${kleur.dim(ts)} ${arrow} ${label}${latency}`;
}

/**
 * Build a stateful printer that tracks request timestamps by id, so it can
 * stamp a `(Nms)` latency hint onto the response line. Exposed separately from
 * `tailTrace` so consumers (and tests) can compose differently.
 */
export function createPrinter(write: (line: string) => void): (rec: TailRecord) => void {
  const pending = new Map<number | string, number>();
  return (rec: TailRecord) => {
    if ("_parseError" in rec) {
      write(formatRecord(rec));
      return;
    }
    const frame = rec.frame as JsonRpcFrame;
    const id = "id" in frame ? (frame as { id?: unknown }).id : undefined;
    const method = "method" in frame ? (frame as { method?: unknown }).method : undefined;
    let latency: number | undefined;
    if (id != null && typeof method === "string") {
      // Request — remember the ts so we can pair the response.
      pending.set(id as number | string, rec.ts);
    } else if (id != null && method === undefined) {
      // Response — look up the pending request.
      const reqTs = pending.get(id as number | string);
      if (reqTs != null) {
        latency = Math.max(0, rec.ts - reqTs);
        pending.delete(id as number | string);
      }
    }
    write(formatRecord(rec, latency));
  };
}
