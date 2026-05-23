import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  emptyPricing,
  estimateCost,
  estimateTokens,
  loadPricingFromFile,
  lookup,
  normalizeModelId,
  parsePricingYaml,
} from "./pricing.js";

describe("normalizeModelId", () => {
  it("lowercases and converts underscores to dashes", () => {
    expect(normalizeModelId("Claude_Sonnet_4_6")).toBe("claude-sonnet-4-6");
  });
  it("trims whitespace", () => {
    expect(normalizeModelId("  gpt-5  ")).toBe("gpt-5");
  });
});

describe("estimateTokens", () => {
  it("approximates chars/4 with a floor of 1 token", () => {
    expect(estimateTokens(0)).toBe(1);
    expect(estimateTokens(3)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(40)).toBe(10);
    expect(estimateTokens(41)).toBe(11);
  });
});

describe("parsePricingYaml", () => {
  it("parses a cloud-model entry", () => {
    const t = parsePricingYaml("claude-sonnet-4-6:\n  input: 3.0\n  output: 15.0\n");
    const r = lookup(t, "Claude-Sonnet-4-6");
    expect(r).toEqual({ kind: "cloud", inputPerMillion: 3.0, outputPerMillion: 15.0 });
  });
  it("parses a local-model entry", () => {
    const t = parsePricingYaml("llama-3-local:\n  per_second: 0.001\n");
    expect(lookup(t, "llama-3-local")).toEqual({ kind: "local", perSecond: 0.001 });
  });
  it("ignores comments and blank lines", () => {
    const src = "# header comment\n\ngpt-5:\n  input: 5\n  output: 15  # trailing\n";
    const r = lookup(parsePricingYaml(src), "gpt-5");
    expect(r).toEqual({ kind: "cloud", inputPerMillion: 5, outputPerMillion: 15 });
  });
  it("rejects a cloud entry missing output", () => {
    expect(() => parsePricingYaml("gpt-5:\n  input: 5\n")).toThrow(/missing/);
  });
  it("rejects unknown sub-keys", () => {
    expect(() => parsePricingYaml("m:\n  bogus: 1\n")).toThrow(/unknown field/);
  });
  it("rejects unparseable indented lines", () => {
    expect(() => parsePricingYaml("m:\n  garbage\n")).toThrow(/unparseable/);
  });
  it("rejects sub-key without parent", () => {
    expect(() => parsePricingYaml("  input: 5\n")).toThrow(/unparseable/);
  });
});

describe("estimateCost", () => {
  const table = parsePricingYaml(`
gpt-5:
  input: 5
  output: 15
llama-local:
  per_second: 0.001
`);

  it("computes cloud cost from token estimates", () => {
    // 400 bytes ≈ 100 tokens; 800 bytes ≈ 200 tokens.
    // cost = (100 * 5 + 200 * 15) / 1_000_000 = 0.0035
    const c = estimateCost(table, {
      modelId: "gpt-5",
      inputBytes: 400,
      outputBytes: 800,
      elapsedSeconds: 1,
    });
    expect(c.basis).toBe("cloud-tokens");
    expect(c.cost).toBeCloseTo(0.0035, 6);
    expect(c.inputTokens).toBe(100);
    expect(c.outputTokens).toBe(200);
  });

  it("computes local cost from wall-clock seconds", () => {
    const c = estimateCost(table, {
      modelId: "llama-local",
      inputBytes: 4000,
      outputBytes: 4000,
      elapsedSeconds: 12.5,
    });
    expect(c.basis).toBe("local-seconds");
    expect(c.cost).toBeCloseTo(0.0125, 6);
  });

  it("returns null cost for an unknown model — never guesses", () => {
    const c = estimateCost(table, {
      modelId: "this-model-is-not-in-the-table",
      inputBytes: 400,
      outputBytes: 800,
      elapsedSeconds: 1,
    });
    expect(c.cost).toBeNull();
    expect(c.basis).toBe("unknown-model");
  });

  it("matches model ids case-insensitively", () => {
    const c = estimateCost(table, {
      modelId: "GPT-5",
      inputBytes: 4,
      outputBytes: 4,
      elapsedSeconds: 1,
    });
    expect(c.cost).not.toBeNull();
  });
});

describe("emptyPricing", () => {
  it("returns null cost for every model", () => {
    const t = emptyPricing();
    const c = estimateCost(t, {
      modelId: "gpt-5",
      inputBytes: 4,
      outputBytes: 4,
      elapsedSeconds: 1,
    });
    expect(c.cost).toBeNull();
  });
});

describe("loadPricingFromFile", () => {
  it("reads the bundled docs/pricing.yaml without errors", () => {
    // The bundled table is the source of truth; if it doesn't parse, the
    // smoke test that ships the package will fail.
    const t = loadPricingFromFile(fileURLToPath(new URL("../docs/pricing.yaml", import.meta.url)));
    expect(t.rates.size).toBeGreaterThan(5);
    expect(lookup(t, "claude-sonnet-4-6")).toMatchObject({ kind: "cloud" });
    expect(lookup(t, "llama-3.3-70b-local")).toMatchObject({ kind: "local" });
  });
});
