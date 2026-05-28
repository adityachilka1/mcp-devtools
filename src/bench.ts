/**
 * `mcp-devtools bench <trace>` — measure replay-drain throughput for a
 * `.mcptrace` file. Useful for performance-regression testing of the replay
 * path itself: "how fast can we serve this entire conversation back?"
 *
 * Approach: read the trace once, then run `iterations` full drains (optionally
 * preceded by `warmup` discarded drains for JIT/warmup effects). Each drain
 * runs the same per-frame logic `startReplay` uses (`drainOnce` in
 * `replay.ts`), timed with `performance.now()`. We report durationMs and
 * framesPerSecond per run plus median / p95 / best / worst across the
 * non-warmup runs.
 *
 * Percentiles use the same nearest-rank definition as `profile.ts` so the two
 * tools are consistent for the user. Bench is intentionally lightweight — no
 * histogram, no GC pauses, no allocations metric. If we ever want those they
 * belong on a separate `bench --profile-cpu` slice.
 */
import { performance } from "node:perf_hooks";
import kleur from "kleur";
import { readTrace } from "./diff.js";
import { drainOnce } from "./replay.js";

export interface BenchOptions {
  tracePath: string;
  /** How many full drains to measure (default 1). Must be >= 1. */
  iterations?: number;
  /** How many warmup drains to run and discard (default 0). Must be >= 0. */
  warmup?: number;
}

export interface BenchRun {
  index: number;
  durationMs: number;
  framesPerSecond: number;
}

export interface BenchStat {
  durationMs: number;
  framesPerSecond: number;
}

export interface BenchResult {
  tracePath: string;
  totalFrames: number;
  iterations: number;
  warmup: number;
  runs: BenchRun[];
  median: BenchStat;
  p95: BenchStat;
  best: BenchStat;
  worst: BenchStat;
}

/**
 * Nearest-rank percentile on a sorted-ascending array. Matches `profile.ts`'s
 * `percentile` semantics so users see consistent statistics across the two
 * subcommands. Empty input → 0.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0] ?? 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(Math.max(rank, 1), sortedAsc.length) - 1;
  return sortedAsc[idx] ?? 0;
}

/** fps = frames / (ms / 1000). Guards against div-by-zero (returns 0). */
function fps(frameCount: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return frameCount / (durationMs / 1000);
}

/**
 * Read the trace and run `warmup + iterations` drains. Returns full timing
 * stats. Warmup runs are present in `runs` (so callers can inspect them) but
 * excluded from median/p95/best/worst, which only summarize the measured
 * iterations.
 */
export async function benchTrace(opts: BenchOptions): Promise<BenchResult> {
  const iterations = opts.iterations ?? 1;
  const warmup = opts.warmup ?? 0;

  if (!Number.isFinite(iterations) || !Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`bench: iterations must be a positive integer, got ${String(iterations)}`);
  }
  if (!Number.isFinite(warmup) || !Number.isInteger(warmup) || warmup < 0) {
    throw new Error(`bench: warmup must be a non-negative integer, got ${String(warmup)}`);
  }

  // Stat first — same pattern as profileTrace — so a missing file surfaces as
  // a clean promise rejection rather than an unhandled stream 'error' event.
  const { stat } = await import("node:fs/promises");
  await stat(opts.tracePath);

  const frames = await readTrace(opts.tracePath);

  const runs: BenchRun[] = [];
  const total = warmup + iterations;
  for (let i = 0; i < total; i++) {
    const t0 = performance.now();
    const { frameCount } = drainOnce(frames);
    const t1 = performance.now();
    const durationMs = Math.max(0, t1 - t0);
    runs.push({ index: i, durationMs, framesPerSecond: fps(frameCount, durationMs) });
  }

  // Only the measured iterations contribute to the summary stats. Warmup is
  // observable in `runs` so the operator can see if warmup runs were clearly
  // slower (a JIT / page-fault signal), but it should not pollute the median.
  const measured = runs.slice(warmup);
  const sortedMs = measured.map((r) => r.durationMs).sort((a, b) => a - b);

  const medianMs = percentile(sortedMs, 50);
  const p95Ms = percentile(sortedMs, 95);
  // best = lowest duration / highest fps; worst = highest duration / lowest fps.
  const bestMs = sortedMs[0] ?? 0;
  const worstMs = sortedMs[sortedMs.length - 1] ?? 0;

  return {
    tracePath: opts.tracePath,
    totalFrames: frames.length,
    iterations,
    warmup,
    runs,
    median: { durationMs: medianMs, framesPerSecond: fps(frames.length, medianMs) },
    p95: { durationMs: p95Ms, framesPerSecond: fps(frames.length, p95Ms) },
    best: { durationMs: bestMs, framesPerSecond: fps(frames.length, bestMs) },
    worst: { durationMs: worstMs, framesPerSecond: fps(frames.length, worstMs) },
  };
}

// ── formatting ──────────────────────────────────────────────────────────────

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return align === "right" ? fill + s : s + fill;
}

/** Format a millisecond count as a tidy µs/ms/s string. Matches `profile.ts`. */
function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)}ms`;
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(2) : s.toFixed(1)}s`;
}

/** Format frames-per-second with thousands separators. */
function formatFps(fpsValue: number): string {
  if (fpsValue === 0) return "0";
  if (fpsValue >= 1000) return Math.round(fpsValue).toLocaleString("en-US");
  return fpsValue.toFixed(1);
}

/**
 * Render a compact, design-engineer-grade table: per-run rows on top, then a
 * summary block. Right-aligned numerals, tabular column widths, dim chrome,
 * sentence-case headings — same visual conventions as `profile.ts` /
 * `summary.ts`.
 */
export function formatBench(result: BenchResult): string {
  const lines: string[] = [];
  lines.push(`${kleur.bold("mcp-devtools bench")}  ${kleur.dim(result.tracePath)}`);
  lines.push(kleur.dim("─".repeat(60)));
  lines.push(`Total frames    : ${result.totalFrames.toLocaleString("en-US")}`);
  lines.push(
    `Iterations      : ${result.iterations}${
      result.warmup > 0 ? kleur.dim(`  (+${result.warmup} warmup)`) : ""
    }`,
  );

  lines.push("");
  lines.push(kleur.bold("Per-run timing"));
  const idxWidth = Math.max(3, String(result.runs.length - 1).length + 1);
  const header = `  ${pad(kleur.dim("#"), idxWidth, "right")}${pad(kleur.dim("duration"), 12, "right")}${pad(kleur.dim("frames/s"), 14, "right")}`;
  lines.push(header);
  for (const run of result.runs) {
    // Warmup rows are visibly dimmed so the eye can skip them — same idea as
    // dimmed unknown-model lines in `cost.ts`.
    const isWarmup = run.index < result.warmup;
    const idxLabel = isWarmup ? kleur.dim(`${run.index}*`) : String(run.index);
    const row = `  ${pad(idxLabel, idxWidth, "right")}${pad(formatMs(run.durationMs), 12, "right")}${pad(formatFps(run.framesPerSecond), 14, "right")}`;
    lines.push(isWarmup ? kleur.dim(row) : row);
  }
  if (result.warmup > 0) {
    lines.push(kleur.dim("  * warmup run — excluded from summary"));
  }

  lines.push("");
  lines.push(kleur.bold("Summary"));
  const labelWidth = 8;
  const rowFor = (label: string, stat: BenchStat): string =>
    `  ${pad(kleur.dim(label), labelWidth)}${pad(formatMs(stat.durationMs), 12, "right")}${pad(formatFps(stat.framesPerSecond), 14, "right")}`;
  lines.push(
    `  ${pad("", labelWidth)}${pad(kleur.dim("duration"), 12, "right")}${pad(kleur.dim("frames/s"), 14, "right")}`,
  );
  lines.push(rowFor("median", result.median));
  lines.push(rowFor("p95", result.p95));
  lines.push(rowFor("best", result.best));
  lines.push(rowFor("worst", result.worst));

  return lines.join("\n");
}

/** One-line JSON envelope for `bench --json`. */
export function printBenchJson(result: BenchResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
