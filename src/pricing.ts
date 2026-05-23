/**
 * Token-cost attribution for MCP `tools/call` frames.
 *
 * The proxy is protocol-agnostic — it sees JSON-RPC frames, not tokens — so
 * "cost per call" is necessarily an estimate. The strategy:
 *
 *   1. Approximate token counts from frame payload size (chars/4, the
 *      well-known English-text heuristic).
 *   2. Multiply by per-1M-token rates loaded from a YAML price table.
 *   3. For local models, bill wall-clock seconds between request and
 *      response instead of tokens.
 *
 * Model identification is the hard part — it isn't always in the MCP frame.
 * Callers pass a single active `modelId` per session (via `--model` on the
 * CLI, or via the embed API). An unknown model yields `cost: null`, never a
 * guess.
 *
 * The YAML loader handles the small format documented in `docs/pricing.yaml`:
 *
 *   model-id:
 *     input: <USD per 1M input tokens>
 *     output: <USD per 1M output tokens>
 *
 *   local-model-id:
 *     per_second: <USD per second>
 *
 * No external YAML dep — the format is restricted enough that a hand-rolled
 * parser stays under 40 LOC and avoids pulling `js-yaml` into the publish
 * tree.
 */
import { readFileSync } from "node:fs";

export interface CloudRate {
  kind: "cloud";
  /** USD per 1,000,000 input tokens. */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillion: number;
}

export interface LocalRate {
  kind: "local";
  /** USD per second of wall-clock compute. */
  perSecond: number;
}

export type ModelRate = CloudRate | LocalRate;

export interface PricingTable {
  /** Map from normalized model id to rate. Use `lookup()` to read. */
  rates: Map<string, ModelRate>;
}

/** Normalize a model id for case-insensitive lookups (underscores → dashes). */
export function normalizeModelId(id: string): string {
  return id.trim().toLowerCase().replace(/_/g, "-");
}

export function lookup(table: PricingTable, modelId: string): ModelRate | undefined {
  return table.rates.get(normalizeModelId(modelId));
}

/**
 * Estimate token count for a frame payload. Uses the canonical chars/4
 * heuristic — accurate to ±20% on English-language JSON. Good enough for
 * surfacing order-of-magnitude cost, which is what the issue asks for.
 */
export function estimateTokens(payloadBytes: number): number {
  return Math.max(1, Math.ceil(payloadBytes / 4));
}

export interface CostEstimateInput {
  modelId: string;
  inputBytes: number;
  outputBytes: number;
  /** Wall-clock seconds between request and response. Used for local models. */
  elapsedSeconds: number;
}

export interface CostEstimate {
  /** USD. `null` when the model is unknown — we never guess. */
  cost: number | null;
  /** How we arrived at the number, for the UI tooltip. */
  basis: "cloud-tokens" | "local-seconds" | "unknown-model";
  inputTokens?: number;
  outputTokens?: number;
}

export function estimateCost(table: PricingTable, input: CostEstimateInput): CostEstimate {
  const rate = lookup(table, input.modelId);
  if (!rate) {
    return { cost: null, basis: "unknown-model" };
  }
  if (rate.kind === "local") {
    return {
      cost: rate.perSecond * input.elapsedSeconds,
      basis: "local-seconds",
    };
  }
  const inputTokens = estimateTokens(input.inputBytes);
  const outputTokens = estimateTokens(input.outputBytes);
  const cost =
    (inputTokens * rate.inputPerMillion) / 1_000_000 +
    (outputTokens * rate.outputPerMillion) / 1_000_000;
  return { cost, basis: "cloud-tokens", inputTokens, outputTokens };
}

/**
 * Parse the minimal YAML subset used by `docs/pricing.yaml`:
 *
 *   model-id:
 *     input: <number>
 *     output: <number>
 *     per_second: <number>
 *
 * - `#` starts a comment.
 * - Blank lines are ignored.
 * - Top-level keys must start at column 0.
 * - Sub-keys must be indented (any consistent indent ≥ 1 space).
 *
 * Anything outside this shape throws. We intentionally don't pull in a real
 * YAML library — the format is fixed and a 40-line parser is auditable.
 */
export function parsePricingYaml(source: string): PricingTable {
  const rates = new Map<string, ModelRate>();
  let currentModel: string | null = null;
  let currentEntry: Partial<Record<"input" | "output" | "perSecond", number>> = {};

  const flush = () => {
    if (currentModel === null) return;
    const { input, output, perSecond } = currentEntry;
    if (perSecond !== undefined) {
      rates.set(currentModel, { kind: "local", perSecond });
    } else if (input !== undefined && output !== undefined) {
      rates.set(currentModel, {
        kind: "cloud",
        inputPerMillion: input,
        outputPerMillion: output,
      });
    } else {
      throw new Error(`pricing: model "${currentModel}" missing input/output rates or per_second`);
    }
    currentModel = null;
    currentEntry = {};
  };

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) {
      // Top-level model key, e.g. `claude-sonnet-4-6:`.
      flush();
      const m = line.match(/^([^:#\s][^:]*):\s*$/);
      if (!m) throw new Error(`pricing: unparseable line ${i + 1}: ${rawLine}`);
      currentModel = normalizeModelId(m[1] ?? "");
      continue;
    }
    // Indented sub-key, e.g. `  input: 3.00`.
    const m = line.match(/^\s+([a-z_]+):\s*([+-]?\d+(?:\.\d+)?)\s*$/i);
    if (!m || !currentModel) {
      throw new Error(`pricing: unparseable line ${i + 1}: ${rawLine}`);
    }
    const key = m[1]?.toLowerCase();
    const value = Number(m[2]);
    if (Number.isNaN(value)) {
      throw new Error(`pricing: NaN value on line ${i + 1}: ${rawLine}`);
    }
    if (key === "input") currentEntry.input = value;
    else if (key === "output") currentEntry.output = value;
    else if (key === "per_second") currentEntry.perSecond = value;
    else throw new Error(`pricing: unknown field "${key}" on line ${i + 1}`);
  }
  flush();
  return { rates };
}

export function loadPricingFromFile(path: string): PricingTable {
  return parsePricingYaml(readFileSync(path, "utf8"));
}

/** Used when no price table is configured — every cost comes back null. */
export function emptyPricing(): PricingTable {
  return { rates: new Map() };
}
