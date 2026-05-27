/**
 * `mcp-devtools cost <trace> --model <id> --budget <usd>` — a focused per-trace
 * cost gate for CI pipelines.
 *
 * The story: `summary` (#62) already computes cost, but in a CI workflow the
 * caller has to pipe `summary --json` through `jq` and a tiny shell script to
 * turn "total > budget" into a non-zero exit. This subcommand collapses that
 * pattern into one line:
 *
 *   mcp-devtools cost session.mcptrace --model gpt-4o-mini --budget 0.05
 *
 * Exit codes:
 *   0   — total ≤ budget (or no budget set)
 *   1   — total > budget (the gate trips)
 *   2   — I/O or config error (missing file, bad pricing YAML, missing model)
 *
 * Implementation strategy: thin wrapper around `CostAnnotator` so the dollar
 * figures here are byte-identical with what `summary` and the inspector UI
 * report. We deliberately do NOT re-implement token math — `pricing.ts` and
 * `cost-annotator.ts` are the single source of truth.
 *
 * Unknown-model handling: if every priced call resolves to the `unknown-model`
 * basis, we return `totalUsd: 0` AND `overBudget: false` even when the budget
 * is `0`. The rule is "we can't measure → don't fail CI" — flipping a build
 * red on a missing model id would punish the wrong person.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import kleur from "kleur";
import { CostAnnotator } from "./cost-annotator.js";
import { readTrace } from "./diff.js";
import { loadPricingFromFile, parsePricingYaml } from "./pricing.js";

export interface CostGateOptions {
  tracePath: string;
  /** Required — the cost gate is meaningless without a model. */
  modelId: string;
  pricingFile?: string;
  /** Exit non-zero if the priced total strictly exceeds this number of USD. */
  budgetUsd?: number;
}

export interface CostByMethod {
  method: string;
  /** Number of priced `tools/call` responses attributed to this method. */
  count: number;
  /** Sum of USD across those responses. */
  totalUsd: number;
}

export interface CostGateResult {
  /** Active model id used to price the trace. Useful so JSON callers don't
   * have to round-trip the input flag. */
  modelId: string;
  /** Sum of USD across every priced call that produced a numeric cost. */
  totalUsd: number;
  /** Number of `tools/call` request/response pairs the annotator could
   * stamp — regardless of whether the resulting cost was numeric or null. */
  pairedTotal: number;
  /** Of `pairedTotal`, how many had `cost.usd === null` (unknown-model basis). */
  unknownCount: number;
  /** The budget the caller passed in, or null if they didn't. */
  budgetUsd: number | null;
  /** True iff the gate should trip (exit code 1 in CLI mode). */
  overBudget: boolean;
  /** Per-method cost rollup, sorted by totalUsd descending. Only includes
   * methods with at least one priced (non-null) call. */
  byMethod: CostByMethod[];
}

/**
 * Run the cost gate. Pure with respect to its inputs — never mutates anything
 * the caller passed in. File I/O lives here so callers can compose this with
 * other tooling without re-reading the trace.
 */
export async function runCostGate(opts: CostGateOptions): Promise<CostGateResult> {
  // Runtime guard for callers who skip TypeScript (the CLI surface, for one).
  if (!opts.modelId || typeof opts.modelId !== "string") {
    throw new Error("cost: --model <id> is required");
  }

  const pricing = opts.pricingFile
    ? loadPricingFromFile(opts.pricingFile)
    : parsePricingYaml(readBuiltinPricing());

  // Stat first so a missing trace surfaces as a clean promise rejection
  // rather than an unhandled stream 'error' event (same trick `profileTrace`
  // uses, for the same reason).
  const { stat } = await import("node:fs/promises");
  await stat(opts.tracePath);

  const annotator = new CostAnnotator({ pricing, modelId: opts.modelId });
  const frames = await readTrace(opts.tracePath);
  const annotated = annotator.annotate(frames);

  // Build a id → method side-table by walking the raw frames once. We need
  // this because the annotator stamps cost onto *response* frames, but the
  // method name lives on the *request* frame. `summary.ts` does an identical
  // pairing pass — we keep ours here rather than refactoring summary's
  // helper into a shared utility (the hard rules forbid touching summary).
  const methodByRpcId = new Map<number | string, string>();
  for (const f of frames) {
    const frame = f.frame as Record<string, unknown>;
    if ("_parseError" in frame) continue;
    const id = frame.id as number | string | undefined;
    const method = typeof frame.method === "string" ? frame.method : undefined;
    if (id != null && method) methodByRpcId.set(id, method);
  }

  let totalUsd = 0;
  let pairedTotal = 0;
  let unknownCount = 0;
  const perMethod = new Map<string, { count: number; totalUsd: number }>();

  for (const f of annotated) {
    if (!f.cost) continue;
    pairedTotal += 1;
    const usd = f.cost.usd;
    if (typeof usd !== "number") {
      unknownCount += 1;
      continue;
    }
    totalUsd += usd;
    // Look up the originating request method via the response's rpc id. The
    // annotator only stamps responses, so `frame.id` here is the response id.
    const rawFrame = f.frame as Record<string, unknown>;
    const rpcId = rawFrame.id as number | string | undefined;
    const method = rpcId != null ? methodByRpcId.get(rpcId) : undefined;
    if (method !== undefined) {
      const cur = perMethod.get(method) ?? { count: 0, totalUsd: 0 };
      cur.count += 1;
      cur.totalUsd += usd;
      perMethod.set(method, cur);
    }
  }

  // unknown-model rule: if we could not produce a single numeric cost, then
  // we have no business failing CI on a budget the operator can't reason
  // about. Force overBudget to false in that case even when budgetUsd is 0.
  const haveAnyPriced = totalUsd > 0;
  const budgetUsd = typeof opts.budgetUsd === "number" ? opts.budgetUsd : null;
  const overBudget = budgetUsd !== null && haveAnyPriced && totalUsd > budgetUsd;

  const byMethod: CostByMethod[] = Array.from(perMethod.entries())
    .map(([method, v]) => ({ method, count: v.count, totalUsd: v.totalUsd }))
    .sort((a, b) => b.totalUsd - a.totalUsd || a.method.localeCompare(b.method));

  return {
    modelId: opts.modelId,
    totalUsd,
    pairedTotal,
    unknownCount,
    budgetUsd,
    overBudget,
    byMethod,
  };
}

/**
 * Resolve `docs/pricing.yaml` relative to this module. Mirrors `summary.ts`
 * so both subcommands see the same built-in table in dev and bundled modes.
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
  return "";
}

// ── formatting ─────────────────────────────────────────────────────────────

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return align === "right" ? fill + s : s + fill;
}

function formatUsd(n: number): string {
  // Six decimals so sub-cent estimates remain visible. The actual precision
  // is bounded by the chars/4 token heuristic, but truncating to two decimals
  // would hide every cost in a small smoke trace.
  if (n === 0) return "$0.000000";
  if (n < 0.0001) return `$${n.toFixed(8)}`;
  return `$${n.toFixed(6)}`;
}

/**
 * Render the cost gate for a terminal. Short summary up top, per-method
 * table in the middle, and a final verdict line so the user can tell at a
 * glance whether CI should pass or fail. Right-aligned numeric columns give
 * the "tabular-nums" look that the rest of the CLI uses.
 */
export function formatCostGate(r: CostGateResult): string {
  const lines: string[] = [];
  lines.push(kleur.bold("mcp-devtools cost"));
  lines.push(kleur.dim("─".repeat(48)));
  lines.push(`Model          : ${r.modelId}`);
  lines.push(`Total estimate : ${formatUsd(r.totalUsd)}`);
  lines.push(`Priced calls   : ${r.pairedTotal - r.unknownCount} / ${r.pairedTotal}`);
  if (r.unknownCount > 0) {
    lines.push(
      kleur.dim(`  (${r.unknownCount} unknown — model id not in pricing table; unable to price)`),
    );
  }

  if (r.byMethod.length > 0) {
    lines.push("");
    lines.push(kleur.bold("By method"));
    const methodWidth = Math.max(12, ...r.byMethod.map((m) => m.method.length));
    const header = `  ${pad(kleur.dim("method"), methodWidth)}${pad(kleur.dim("calls"), 8, "right")}${pad(kleur.dim("usd"), 14, "right")}`;
    lines.push(header);
    for (const m of r.byMethod) {
      lines.push(
        `  ${pad(m.method, methodWidth)}${pad(String(m.count), 8, "right")}${pad(formatUsd(m.totalUsd), 14, "right")}`,
      );
    }
  }

  lines.push("");
  if (r.budgetUsd === null) {
    lines.push(kleur.dim("No budget set — gate is informational only."));
  } else if (r.overBudget) {
    const over = r.totalUsd - r.budgetUsd;
    lines.push(
      kleur.red(
        `over budget by ${formatUsd(over)} (budget ${formatUsd(r.budgetUsd)}, total ${formatUsd(r.totalUsd)})`,
      ),
    );
  } else if (r.unknownCount > 0 && r.totalUsd === 0) {
    lines.push(
      kleur.yellow(`unable to price any call — gate held open (budget ${formatUsd(r.budgetUsd)})`),
    );
  } else {
    const under = r.budgetUsd - r.totalUsd;
    lines.push(kleur.green(`${formatUsd(under)} under budget (budget ${formatUsd(r.budgetUsd)})`));
  }

  return lines.join("\n");
}

/** One-line JSON envelope for `cost --json | jq .`. */
export function printCostGateJson(r: CostGateResult): void {
  process.stdout.write(`${JSON.stringify(r)}\n`);
}
