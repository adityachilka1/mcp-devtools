/**
 * `mcp-devtools summary <trace>` — one-shot overview of a `.mcptrace`.
 *
 * Combines three lenses on the same trace file into one envelope:
 *
 *   - profile (per-method latency + slowest calls + wall clock) — delegated
 *     wholesale to `profileTrace` so the percentile math stays one
 *     well-tested implementation.
 *   - error breakdown — a separate pass over the frames that counts
 *     responses with a `.error` field, both globally and per-method. The
 *     profiler doesn't expose this because it's blind to response payloads.
 *   - cost — only computed when `--model <id>` is set, mirroring what the UI
 *     shows. Uses `CostAnnotator` + `parsePricingYaml` / `loadPricingFromFile`
 *     so the numbers stay byte-identical with the inspector.
 *
 * The output is intentionally narrower than `profile`: we surface the top
 * five most-called methods by default with `count / p95 / errorRate`, and the
 * top three slowest calls. The full table is one `--json | jq` away.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import kleur from "kleur";
import { CostAnnotator } from "./cost-annotator.js";
import { readTrace } from "./diff.js";
import type { CostEstimate } from "./pricing.js";
import { loadPricingFromFile, parsePricingYaml } from "./pricing.js";
import { type ProfileResult, formatMs, profileTrace } from "./profile.js";

export interface SummaryByMethod {
  method: string;
  count: number;
  p95Ms: number;
  errorRate: number;
}

export interface SummarySlowCall {
  method: string;
  latencyMs: number;
}

export interface SummaryCost {
  /** Total USD across every `tools/call` we could price. `null` if every
   * paired call had an unknown-model basis (e.g. modelId not in the table). */
  totalUsd: number | null;
  modelId: string;
  /** How many `tools/call` request/response pairs contributed. */
  pricedCalls: number;
  /** Of those, how many produced a non-null USD figure. */
  pricedWithCost: number;
  /** Same basis taxonomy `pricing.ts` uses, deduped + sorted. */
  bases: CostEstimate["basis"][];
}

export interface SummaryResult {
  path: string;
  totalFrames: number;
  wallClockMs: number;
  pairedRequests: number;
  errorCount: number;
  byMethod: SummaryByMethod[];
  slowest: SummarySlowCall[];
  cost?: SummaryCost;
}

export interface SummarizeOptions {
  tracePath: string;
  /** Active model id for cost attribution. Omit to skip the cost block. */
  modelId?: string;
  /** YAML pricing file. If omitted (and `modelId` is set), uses the built-in
   * `docs/pricing.yaml` so the CLI behaves like the inspector default. */
  pricingFile?: string;
}

/**
 * One-shot summary. File I/O lives here; everything below is pure.
 *
 * We deliberately keep the cost path optional — opening a trace with no
 * `--model` is the common case and we don't want to pay the YAML-parse cost
 * (or surface a confusing `unknown-model` block) for it.
 */
export async function summarizeTrace(opts: SummarizeOptions): Promise<SummaryResult> {
  // Lean on profileTrace for percentiles + slowest calls. The hard rule says
  // no refactor of profile.ts, so we treat it strictly as a library here.
  const profile = await profileTrace(opts.tracePath);

  // Error count + per-method error rate. profileTrace doesn't expose this
  // because it's blind to response payloads — second pass needed.
  const errors = await computeErrorBreakdown(opts.tracePath);

  const byMethod = mergeMethodAndErrors(profile, errors);
  const slowest = profile.slowest.slice(0, 3).map((s) => ({
    method: s.method,
    latencyMs: s.latencyMs,
  }));

  const result: SummaryResult = {
    path: profile.path,
    totalFrames: profile.totalFrames,
    wallClockMs: profile.wallClockMs,
    pairedRequests: profile.pairedRequests,
    errorCount: errors.totalErrors,
    byMethod,
    slowest,
  };

  if (opts.modelId !== undefined) {
    result.cost = await computeCost(opts.tracePath, opts.modelId, opts.pricingFile);
  }

  return result;
}

interface ErrorBreakdown {
  totalErrors: number;
  /** request method → number of paired responses that carried `.error`. */
  perMethodErrors: Map<string, number>;
}

/**
 * Walk the trace once, pair requests with responses by id, and count
 * responses that carry an `error` field. We don't reuse profile.ts's pairing
 * pass because that one is intentionally blind to response bodies (it only
 * needs the timestamps); attaching error counting to it would be the kind of
 * refactor the hard rules forbid.
 *
 * Same skip rules as `computeProfile`:
 *   - `_parseError` envelopes are not real frames
 *   - notifications (method but no id) cannot be errors at this layer
 *   - orphan responses (no matching request) get counted in `totalErrors`
 *     but not in `perMethodErrors` (we have no method to attribute them to)
 */
async function computeErrorBreakdown(path: string): Promise<ErrorBreakdown> {
  const frames = await readTrace(path);

  const pending = new Map<number | string, string>(); // id → method
  const perMethodErrors = new Map<string, number>();
  let totalErrors = 0;

  for (const f of frames) {
    const frame = f.frame as Record<string, unknown>;
    if ("_parseError" in frame) continue;
    const id = frame.id as number | string | undefined;
    const method = typeof frame.method === "string" ? frame.method : undefined;

    if (id != null && method) {
      pending.set(id, method);
      continue;
    }
    if (id != null && method === undefined) {
      // Response. Bump error counters if `.error` is set.
      const hasError = "error" in frame && frame.error != null;
      const reqMethod = pending.get(id);
      if (reqMethod !== undefined) pending.delete(id);
      if (hasError) {
        totalErrors += 1;
        if (reqMethod !== undefined) {
          perMethodErrors.set(reqMethod, (perMethodErrors.get(reqMethod) ?? 0) + 1);
        }
      }
    }
  }

  return { totalErrors, perMethodErrors };
}

/**
 * Build the byMethod summary table. Ordered by count desc (then method asc
 * for determinism) — matches what a user expects from a "top callers"
 * leaderboard. Trimmed to the top 5 because the human-mode output should fit
 * on screen; `--json` callers still get the full list via the profile path
 * if they want it, but the summary contract keeps the top 5.
 */
function mergeMethodAndErrors(profile: ProfileResult, errors: ErrorBreakdown): SummaryByMethod[] {
  const rows: SummaryByMethod[] = profile.perMethod.map((m) => {
    const errs = errors.perMethodErrors.get(m.method) ?? 0;
    const rate = m.count > 0 ? errs / m.count : 0;
    return {
      method: m.method,
      count: m.count,
      p95Ms: m.p95Ms,
      errorRate: rate,
    };
  });
  rows.sort((a, b) => b.count - a.count || a.method.localeCompare(b.method));
  return rows.slice(0, 5);
}

/**
 * Compute the aggregate cost by streaming the trace through `CostAnnotator`,
 * just like the UI does. Summing happens here rather than in the annotator —
 * the annotator's contract is "stamp a row", not "aggregate a session".
 */
async function computeCost(
  path: string,
  modelId: string,
  pricingFile: string | undefined,
): Promise<SummaryCost> {
  const pricing = pricingFile
    ? loadPricingFromFile(pricingFile)
    : parsePricingYaml(readBuiltinPricing());

  const annotator = new CostAnnotator({ pricing, modelId });
  const frames = await readTrace(path);
  const annotated = annotator.annotate(frames);

  let totalUsd = 0;
  let pricedCalls = 0;
  let pricedWithCost = 0;
  const bases = new Set<CostEstimate["basis"]>();

  for (const f of annotated) {
    if (!f.cost) continue;
    pricedCalls += 1;
    bases.add(f.cost.basis);
    if (typeof f.cost.usd === "number") {
      totalUsd += f.cost.usd;
      pricedWithCost += 1;
    }
  }

  return {
    totalUsd: pricedWithCost > 0 ? totalUsd : null,
    modelId,
    pricedCalls,
    pricedWithCost,
    bases: Array.from(bases).sort(),
  };
}

/**
 * Resolve `docs/pricing.yaml` relative to this module. The bundled package
 * publishes `dist/` and `docs/pricing.yaml` side-by-side, and during local
 * dev the layout is `src/summary.ts` ↔ `docs/pricing.yaml`. Walk up until we
 * find it so the function works in both modes without a config knob.
 */
function readBuiltinPricing(): string {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    join(dirname(here), "..", "docs", "pricing.yaml"),
    join(dirname(here), "..", "..", "docs", "pricing.yaml"),
  ];
  for (const c of candidates) {
    try {
      return readFileSync(c, "utf8");
    } catch {
      // try next
    }
  }
  // Fallback: empty pricing → every model id is unknown → totalUsd: null.
  return "";
}

// ── formatting ─────────────────────────────────────────────────────────────

/** Format `0.041` as `4.1%`, `0` as `0%`. Tidy for the byMethod table. */
function formatPct(ratio: number): string {
  if (ratio === 0) return "0%";
  const pct = ratio * 100;
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return align === "right" ? fill + s : s + fill;
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Render the summary for a terminal — overview block, byMethod table with
 * right-aligned numeric columns (tabular-nums look), top-3 slowest, optional
 * cost block. Matches the visual style of `formatProfile`.
 */
export function formatSummary(result: SummaryResult): string {
  const lines: string[] = [];
  lines.push(`${kleur.bold("mcp-devtools summary")}  ${kleur.dim(result.path)}`);
  lines.push(kleur.dim("─".repeat(60)));
  lines.push(`Total frames    : ${formatCount(result.totalFrames)}`);
  lines.push(`Wall clock      : ${formatMs(result.wallClockMs)}`);
  lines.push(`Paired requests : ${formatCount(result.pairedRequests)}`);
  lines.push(
    `Errors          : ${result.errorCount > 0 ? kleur.red(formatCount(result.errorCount)) : "0"}`,
  );

  if (result.byMethod.length === 0) {
    lines.push("");
    lines.push(kleur.dim("No paired requests in this trace."));
    return lines.join("\n");
  }

  lines.push("");
  lines.push(kleur.bold("Top methods by call count"));
  const methodWidth = Math.max(14, ...result.byMethod.map((m) => m.method.length));
  // tabular-nums look in the terminal comes from monospace + right alignment.
  const header = `  ${pad(kleur.dim("method"), methodWidth)}${pad(kleur.dim("count"), 9, "right")}${pad(kleur.dim("p95"), 10, "right")}${pad(kleur.dim("err"), 9, "right")}`;
  lines.push(header);
  for (const m of result.byMethod) {
    const errCell = m.errorRate > 0 ? kleur.red(formatPct(m.errorRate)) : formatPct(m.errorRate);
    lines.push(
      `  ${pad(m.method, methodWidth)}${pad(formatCount(m.count), 9, "right")}${pad(formatMs(m.p95Ms), 10, "right")}${pad(errCell, 9, "right")}`,
    );
  }

  if (result.slowest.length > 0) {
    lines.push("");
    lines.push(kleur.bold(`Slowest ${result.slowest.length} calls`));
    for (const c of result.slowest) {
      lines.push(`  ${pad(formatMs(c.latencyMs), 8, "right")}  ${c.method}`);
    }
  }

  if (result.cost) {
    lines.push("");
    lines.push(kleur.bold("Cost"));
    lines.push(`  Model           : ${result.cost.modelId}`);
    const usdStr =
      result.cost.totalUsd === null
        ? kleur.dim("—  (no priced calls — check --model matches the pricing table)")
        : `$${result.cost.totalUsd.toFixed(4)}`;
    lines.push(`  Total estimate  : ${usdStr}`);
    lines.push(
      `  Priced calls    : ${formatCount(result.cost.pricedWithCost)} / ${formatCount(result.cost.pricedCalls)}`,
    );
    if (result.cost.bases.length > 0) {
      lines.push(`  Basis           : ${result.cost.bases.join(", ")}`);
    }
  }

  return lines.join("\n");
}

/** One-line JSON envelope for `summary --json | jq .`. */
export function printSummaryJson(result: SummaryResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
