/**
 * `mcp-devtools profile` — per-method latency profiler for a `.mcptrace` file.
 *
 * Reads a recorded session and reports p50/p95/p99/max/total per method, plus
 * the slowest individual calls. Think Chrome DevTools Performance tab, but for
 * MCP traffic.
 *
 * Pairing logic: we walk frames in chronological order, stash request frames
 * (id-bearing, method-bearing) by id, and when a response (id-bearing, no
 * method) arrives we compute `responseTs - requestTs` and stamp it onto the
 * method bucket the request belongs to. Notifications (no id) are skipped from
 * per-method stats but still counted in `totalFrames`. Orphan requests with no
 * matching response are reported as `unpairedRequests`.
 */
import kleur from "kleur";
import type { JsonRpcFrame } from "./jsonrpc.js";
import type { StoredFrame } from "./trace-store.js";

export interface MethodStats {
  method: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  totalMs: number;
}

export interface SlowCall {
  method: string;
  id: number | string;
  latencyMs: number;
  requestTs: number;
}

export interface ProfileResult {
  path: string;
  totalFrames: number;
  pairedRequests: number;
  unpairedRequests: number;
  /** last frame ts - first frame ts, in ms. 0 for empty traces. */
  wallClockMs: number;
  perMethod: MethodStats[];
  /** Top 10 slowest individual calls, latency desc. */
  slowest: SlowCall[];
}

const SLOWEST_LIMIT = 10;

/**
 * Compute a percentile from a sorted (ascending) array of numbers using the
 * "nearest-rank" definition: ceil(p/100 × N) gives the 1-indexed rank.
 *
 * We chose nearest-rank over linear interpolation because latency buckets are
 * usually small (often single-digit calls) and interpolating between two
 * samples in that regime invents precision the data doesn't have. Single-call
 * methods correctly collapse to p50 = p95 = p99 = that one sample.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[idx] ?? 0;
}

interface PendingReq {
  method: string;
  ts: number;
}

/**
 * Compute the profile from an array of frames. Pure — no I/O. Exposed for
 * testing and embedding; the CLI wrapper handles file reading.
 */
export function computeProfile(path: string, frames: StoredFrame[]): ProfileResult {
  const pending = new Map<number | string, PendingReq>();
  const buckets = new Map<string, number[]>();
  const slowAll: SlowCall[] = [];
  let paired = 0;

  for (const f of frames) {
    const frame = f.frame as JsonRpcFrame;
    // Skip malformed-line frames stored as { _raw, _parseError } — they have
    // neither id nor method on the JSON-RPC surface.
    if ("_parseError" in frame) continue;
    const hasId = "id" in frame && frame.id != null;
    const method = "method" in frame ? (frame as { method?: unknown }).method : undefined;

    if (hasId && typeof method === "string") {
      // Request frame. Stash by id; if a duplicate id arrives we overwrite —
      // that's a server bug worth surfacing later, but for profiling purposes
      // the latest-seen request is the one we pair against.
      pending.set((frame as { id: number | string }).id, { method, ts: f.ts });
      continue;
    }

    if (hasId && method === undefined) {
      // Response frame. Pair against a pending request.
      const id = (frame as { id: number | string }).id;
      const req = pending.get(id);
      if (!req) continue; // orphan response — no matching request seen
      pending.delete(id);
      const latency = Math.max(0, f.ts - req.ts);
      let bucket = buckets.get(req.method);
      if (!bucket) {
        bucket = [];
        buckets.set(req.method, bucket);
      }
      bucket.push(latency);
      slowAll.push({ method: req.method, id, latencyMs: latency, requestTs: req.ts });
      paired += 1;
    }
    // Notifications (method but no id) and other shapes are ignored.
  }

  const perMethod: MethodStats[] = [];
  for (const [method, latencies] of buckets) {
    const sorted = latencies.slice().sort((a, b) => a - b);
    const total = sorted.reduce((s, n) => s + n, 0);
    perMethod.push({
      method,
      count: sorted.length,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      maxMs: sorted[sorted.length - 1] ?? 0,
      totalMs: total,
    });
  }
  // Biggest time-burners first. Ties broken by method name for determinism.
  perMethod.sort((a, b) => b.totalMs - a.totalMs || a.method.localeCompare(b.method));

  slowAll.sort((a, b) => b.latencyMs - a.latencyMs);
  const slowest = slowAll.slice(0, SLOWEST_LIMIT);

  const wallClockMs =
    frames.length === 0
      ? 0
      : Math.max(0, (frames[frames.length - 1]?.ts ?? 0) - (frames[0]?.ts ?? 0));

  return {
    path,
    totalFrames: frames.length,
    pairedRequests: paired,
    unpairedRequests: pending.size,
    wallClockMs,
    perMethod,
    slowest,
  };
}

/**
 * Read a `.mcptrace` and profile it. Wraps `readTrace` from diff.ts so the
 * file-reader stays one well-tested implementation.
 *
 * We stat the file first because `readTrace` builds a readable stream lazily
 * and missing-file errors surface as unhandled stream 'error' events rather
 * than a clean promise rejection. Stat-then-read converts that into a normal
 * exception we can show the user.
 */
export async function profileTrace(path: string): Promise<ProfileResult> {
  // Lazy-import so tests can stub `computeProfile` without pulling node:fs.
  const { stat } = await import("node:fs/promises");
  const { readTrace } = await import("./diff.js");
  await stat(path); // throws ENOENT cleanly if missing
  const frames = await readTrace(path);
  return computeProfile(path, frames);
}

// ── formatting ─────────────────────────────────────────────────────────────

/** Format a millisecond count as a tidy string (µs/ms/s scale). */
export function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)}ms`;
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(1) : s.toFixed(0)}s`;
}

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return align === "right" ? fill + s : s + fill;
}

function formatCount(n: number): string {
  // Thousands separators give the eye an anchor on dense traces. Tabular
  // numerals in the terminal come from the default monospace font.
  return n.toLocaleString("en-US");
}

/**
 * Render the Chrome-DevTools-Performance-style summary for a terminal.
 * Sentence case headings, right-aligned numeric columns, tabular numerals.
 */
export function formatProfile(result: ProfileResult): string {
  const lines: string[] = [];
  lines.push(`${kleur.bold("mcp-devtools profile")}  ${kleur.dim(result.path)}`);
  lines.push(kleur.dim("─".repeat(60)));
  lines.push(`Total frames    : ${formatCount(result.totalFrames)}`);
  lines.push(`Wall clock      : ${formatMs(result.wallClockMs)}`);
  const totalRequests = result.pairedRequests + result.unpairedRequests;
  const pct = totalRequests > 0 ? Math.round((result.pairedRequests / totalRequests) * 100) : 0;
  lines.push(
    `Paired requests : ${formatCount(result.pairedRequests)} (${pct}%)${
      result.unpairedRequests > 0 ? kleur.dim(`  ${result.unpairedRequests} unpaired`) : ""
    }`,
  );

  if (result.perMethod.length === 0) {
    lines.push("");
    lines.push(kleur.dim("No paired requests in this trace."));
    return lines.join("\n");
  }

  lines.push("");
  lines.push(kleur.bold("Per-method latency"));
  // Column widths chosen so 6-digit method names + 3-digit ms values fit
  // without truncation but the table still feels compact on an 80-col
  // terminal.
  const methodWidth = Math.max(14, ...result.perMethod.map((m) => m.method.length));
  const header = `  ${pad(kleur.dim("method"), methodWidth)}${pad(kleur.dim("count"), 8, "right")}${pad(kleur.dim("p50"), 9, "right")}${pad(kleur.dim("p95"), 9, "right")}${pad(kleur.dim("p99"), 9, "right")}${pad(kleur.dim("max"), 9, "right")}${pad(kleur.dim("total"), 9, "right")}`;
  lines.push(header);
  for (const m of result.perMethod) {
    lines.push(
      `  ${pad(m.method, methodWidth)}${pad(formatCount(m.count), 8, "right")}${pad(formatMs(m.p50Ms), 9, "right")}${pad(formatMs(m.p95Ms), 9, "right")}${pad(formatMs(m.p99Ms), 9, "right")}${pad(formatMs(m.maxMs), 9, "right")}${pad(formatMs(m.totalMs), 9, "right")}`,
    );
  }

  if (result.slowest.length > 0) {
    lines.push("");
    lines.push(kleur.bold(`Slowest ${result.slowest.length} calls`));
    for (const c of result.slowest) {
      lines.push(
        `  ${pad(formatMs(c.latencyMs), 8, "right")}  ${c.method}${kleur.dim(`#${String(c.id)}`)}`,
      );
    }
  }

  return lines.join("\n");
}

/** One-line JSON envelope for `profile --json`. */
export function printProfileJson(result: ProfileResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
