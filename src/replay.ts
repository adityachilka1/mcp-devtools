/**
 * `mcp-devtools serve --replay` — turn a captured `.mcptrace` into a fake MCP
 * server that talks to a client over stdio.
 *
 * Purpose: develop and test MCP clients (agents, IDEs, scripts) deterministically
 * against a known-good recorded conversation, with no upstream dependency and no
 * network. Pair with `record` to capture once, `serve --replay` to replay forever.
 *
 * Strategy:
 *   1. Read the trace file (gzipped JSONL, via the same `readTrace` helper that
 *      `diff` and `profile` use — keeps the file-format reader single-sourced).
 *   2. Walk the frames in chronological order to pair every request (id+method,
 *      direction "out") with its matching response (same id, direction "in").
 *      Collect those responses into a per-method FIFO queue, preserving trace
 *      order. Same method called twice → two responses queued → consumed in
 *      order on the wire.
 *   3. On each parsed client frame from stdin:
 *        - Notification (no id) → silently ignored. The replayed server has
 *          nothing to say back, and forwarding to nowhere matches what a real
 *          server does for fire-and-forget notifications.
 *        - Request (has id + method) → shift the next queued response for that
 *          method, swap the captured id for the *client's* id (the trace's
 *          original id is meaningless on this connection), write to stdout.
 *        - Request with no remaining queued response →
 *            strict (default): emit JSON-RPC error -32601 "Method not found in
 *              replay trace" so the client sees a clean protocol-level failure
 *              instead of a hang.
 *            !strict: emit a canned `{ result: {} }` success so loose smoke
 *              tests against a partial trace still progress.
 *
 * Intentionally NOT in scope (yet):
 *   - Replaying server-initiated notifications (no client request to trigger
 *     them off of). Could come later as a timer-driven replay.
 *   - Param matching. Two `tools/call` with different args still get the
 *     responses in trace order. Same-method-different-args is the common case
 *     and matters for sequence determinism; arg-aware lookup would solve a
 *     different problem (fuzz-style replay) and belongs in a separate slice.
 */
import { type Readable, Writable } from "node:stream";
import { readTrace } from "./diff.js";
import { parseFrames } from "./jsonrpc.js";
import type { JsonRpcFrame, JsonRpcRequest, JsonRpcResponse } from "./jsonrpc.js";
import type { StoredFrame } from "./trace-store.js";

export interface ReplayOptions {
  tracePath: string;
  /** Default true — unmatched requests return -32601. */
  strict?: boolean;
  /** Injected for tests. Defaults to process.stdin / process.stdout. */
  stdin?: Readable;
  stdout?: Writable;
}

export interface ReplayHandle {
  /** Resolves when stdin emits 'end'. */
  done: Promise<void>;
  /** Internal — handler exposed for unit tests. */
  handleFrame(frame: JsonRpcFrame): void;
  /** Internal — built once at startup, exposed for inspection in tests. */
  queues: Map<string, JsonRpcResponse[]>;
}

/**
 * Build a per-method FIFO queue of responses from a recorded trace. Pairing is
 * id-keyed: we walk frames in order, remember the method of every request, and
 * when a matching id-bearing response shows up we push it onto that method's
 * queue. Responses with no matching request are dropped — they're trace noise
 * (e.g. the recorder caught a tail-end stray frame).
 *
 * Exported for testing; `startReplay` calls this internally.
 */
export function buildIndex(frames: StoredFrame[]): Map<string, JsonRpcResponse[]> {
  const pendingMethod = new Map<number | string, string>();
  const out = new Map<string, JsonRpcResponse[]>();

  for (const f of frames) {
    const frame = f.frame as JsonRpcFrame;
    if ("_parseError" in frame) continue;
    const hasId = "id" in frame && frame.id != null;
    const method = "method" in frame ? (frame as { method?: unknown }).method : undefined;

    if (hasId && typeof method === "string") {
      // Request frame — stash so we can credit its response to this method.
      pendingMethod.set((frame as { id: number | string }).id, method);
      continue;
    }
    if (hasId && method === undefined) {
      // Response frame — pair against a remembered request.
      const id = (frame as { id: number | string }).id;
      const m = pendingMethod.get(id);
      if (!m) continue; // orphan response, no request seen
      pendingMethod.delete(id);
      let q = out.get(m);
      if (!q) {
        q = [];
        out.set(m, q);
      }
      q.push(frame as JsonRpcResponse);
    }
    // Notifications (method-only) and other shapes are not server-side
    // responses we can hand back to a client request, so ignore.
  }
  return out;
}

/** JSON-RPC -32601 envelope (Method not found) with the client's id. */
function methodNotFound(id: number | string, method: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found in replay trace: ${method}` },
  };
}

/** Canned `{ result: {} }` for non-strict mode. */
function cannedSuccess(id: number | string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: {} };
}

/**
 * Start the replay server. Reads `tracePath`, builds the per-method queue, and
 * wires the supplied (or process default) stdio streams. Returns a handle whose
 * `done` resolves when the input stream ends — useful in tests, irrelevant for
 * the CLI which holds the process open until stdin closes.
 */
export async function startReplay(opts: ReplayOptions): Promise<ReplayHandle> {
  const strict = opts.strict !== false; // default true
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  // Stat first so a missing file surfaces as a clean promise rejection rather
  // than an unhandled stream 'error' event (same pattern profile.ts uses).
  const { stat } = await import("node:fs/promises");
  await stat(opts.tracePath);
  const frames = await readTrace(opts.tracePath);
  const queues = buildIndex(frames);

  const write = (resp: JsonRpcResponse): void => {
    stdout.write(`${JSON.stringify(resp)}\n`);
  };

  function handleFrame(frame: JsonRpcFrame): void {
    if ("_parseError" in frame) return; // malformed client input — silently drop
    const hasId = "id" in frame && (frame as { id?: unknown }).id != null;
    const method = "method" in frame ? (frame as { method?: unknown }).method : undefined;

    if (!hasId) {
      // Notification — nothing to reply with. Real servers don't respond to
      // these either, so silent-drop is the spec-correct behaviour.
      return;
    }
    if (typeof method !== "string") {
      // It's a response or some non-request shape from the client. A server
      // shouldn't be receiving these; ignore.
      return;
    }

    const req = frame as JsonRpcRequest;
    const queue = queues.get(method);
    const next = queue?.shift();

    if (next) {
      // Substitute the *client's* id into the recorded response envelope —
      // the trace's id was bound to a different connection and would confuse
      // the client's id-tracker.
      write({ ...next, id: req.id });
      return;
    }
    if (strict) {
      write(methodNotFound(req.id, method));
    } else {
      write(cannedSuccess(req.id));
    }
  }

  // Wire stdin → parseFrames → handleFrame. We can't use parseFrames' shared
  // buffer state for multiple concurrent replays, but the CLI is one process =
  // one replay, and the tests instantiate their own data + invoke handleFrame
  // directly, so this is fine.
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });

  stdin.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (const frame of parseFrames(buf)) {
      handleFrame(frame);
    }
  });
  stdin.on("end", () => {
    resolveDone();
  });

  return { done, handleFrame, queues };
}

// ── tiny helpers exposed for tests ───────────────────────────────────────────

/** Collect everything written to a Writable as a string. Test-only helper. */
export function collectingWritable(): { stream: Writable; getOutput: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString("utf8");
      cb();
    },
  });
  return { stream, getOutput: () => buf };
}

// ── bench entrypoint ─────────────────────────────────────────────────────────

/**
 * Additive helper for `bench`: programmatically drive one full replay drain
 * over already-loaded frames, without touching stdio. Returns the frame count
 * fed to the replay handler so bench can compute frames/sec.
 *
 * This is intentionally a thin shim — it reuses `buildIndex` + the same
 * request/response handling `startReplay` does, but pulls request frames
 * straight out of the trace instead of waiting on stdin. That keeps the
 * timed loop tight and the benchmark insensitive to stream/IPC scheduling.
 *
 * Additive: no caller in the existing surface depends on this; `startReplay`,
 * `buildIndex`, `collectingWritable` are untouched. New module only.
 */
export function drainOnce(frames: StoredFrame[]): { frameCount: number } {
  const queues = buildIndex(frames);
  // Walk the trace's request frames and "answer" each one against the queue.
  // We discard the response — bench only cares about how fast we can pair.
  let count = 0;
  for (const f of frames) {
    const frame = f.frame as JsonRpcFrame;
    if ("_parseError" in frame) continue;
    const hasId = "id" in frame && (frame as { id?: unknown }).id != null;
    const method = "method" in frame ? (frame as { method?: unknown }).method : undefined;
    count += 1;
    if (!hasId || typeof method !== "string") continue;
    const q = queues.get(method);
    if (!q) continue;
    // Shift consumes the response — mirrors the FIFO consumption that
    // `startReplay.handleFrame` performs on the live wire.
    q.shift();
  }
  return { frameCount: count };
}
