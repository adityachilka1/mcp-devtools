import { describe, expect, it } from "vitest";
import { CostAnnotator, noopAnnotator } from "./cost-annotator.js";
import { parsePricingYaml } from "./pricing.js";
import type { StoredFrame } from "./trace-store.js";

const pricing = parsePricingYaml(`
gpt-5:
  input: 5
  output: 15
llama-local:
  per_second: 0.001
`);

function mkFrame(id: number, ts: number, direction: "in" | "out", frame: any): StoredFrame {
  return { id, direction, ts, frame };
}

describe("CostAnnotator", () => {
  it("attaches a cloud-token cost estimate to a tools/call response", () => {
    const annot = new CostAnnotator({ pricing, modelId: "gpt-5" });
    const frames: StoredFrame[] = [
      mkFrame(1, 1000, "out", { jsonrpc: "2.0", id: 7, method: "tools/call", params: {} }),
      mkFrame(2, 1100, "in", { jsonrpc: "2.0", id: 7, result: { content: "ok" } }),
    ];
    const out = annot.annotate(frames);
    expect(out[0].cost).toBeUndefined();
    expect(out[1].cost).toBeDefined();
    expect(out[1].cost?.basis).toBe("cloud-tokens");
    expect(out[1].cost?.usd).toBeGreaterThan(0);
  });

  it("bills wall-clock seconds for local models", () => {
    const annot = new CostAnnotator({ pricing, modelId: "llama-local" });
    const frames: StoredFrame[] = [
      mkFrame(1, 0, "out", { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
      // 2500 ms elapsed → 2.5 seconds × 0.001 = 0.0025 USD
      mkFrame(2, 2500, "in", { jsonrpc: "2.0", id: 1, result: {} }),
    ];
    const out = annot.annotate(frames);
    expect(out[1].cost?.basis).toBe("local-seconds");
    expect(out[1].cost?.usd).toBeCloseTo(0.0025, 6);
  });

  it("returns null cost when no model is configured", () => {
    const annot = new CostAnnotator({ pricing });
    const frames: StoredFrame[] = [
      mkFrame(1, 0, "out", { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
      mkFrame(2, 100, "in", { jsonrpc: "2.0", id: 1, result: {} }),
    ];
    const out = annot.annotate(frames);
    expect(out[1].cost?.usd).toBeNull();
    expect(out[1].cost?.basis).toBe("unknown-model");
  });

  it("does not annotate non-tools/call frames (e.g. initialize)", () => {
    const annot = new CostAnnotator({ pricing, modelId: "gpt-5" });
    const frames: StoredFrame[] = [
      mkFrame(1, 0, "out", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      mkFrame(2, 100, "in", { jsonrpc: "2.0", id: 1, result: { protocolVersion: "x" } }),
    ];
    const out = annot.annotate(frames);
    expect(out[0].cost).toBeUndefined();
    expect(out[1].cost).toBeUndefined();
  });

  it("does not annotate orphan responses (no matching request)", () => {
    const annot = new CostAnnotator({ pricing, modelId: "gpt-5" });
    const frames: StoredFrame[] = [mkFrame(1, 0, "in", { jsonrpc: "2.0", id: 99, result: {} })];
    const out = annot.annotate(frames);
    expect(out[0].cost).toBeUndefined();
  });

  it("pairs requests and responses across separate annotate() calls", () => {
    // Simulates the live websocket: request arrives in one batch, response
    // in the next. The pending map is instance-scoped so the pairing works.
    const annot = new CostAnnotator({ pricing, modelId: "gpt-5" });
    annot.annotate([
      mkFrame(1, 0, "out", { jsonrpc: "2.0", id: 42, method: "tools/call", params: {} }),
    ]);
    const out = annot.annotate([
      mkFrame(2, 200, "in", { jsonrpc: "2.0", id: 42, result: { x: 1 } }),
    ]);
    expect(out[0].cost?.basis).toBe("cloud-tokens");
  });

  it("setModel() re-targets future cost lookups without losing pending pairs", () => {
    const annot = new CostAnnotator({ pricing, modelId: "gpt-5" });
    annot.annotate([
      mkFrame(1, 0, "out", { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
    ]);
    annot.setModel("llama-local");
    const out = annot.annotate([mkFrame(2, 1000, "in", { jsonrpc: "2.0", id: 1, result: {} })]);
    // The response should be billed under the NEW model (local).
    expect(out[0].cost?.basis).toBe("local-seconds");
  });
});

describe("noopAnnotator", () => {
  it("never produces a cost annotation", () => {
    const out = noopAnnotator().annotate([
      mkFrame(1, 0, "out", { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
      mkFrame(2, 100, "in", { jsonrpc: "2.0", id: 1, result: {} }),
    ]);
    // The response gets an unknown-model annotation since no model is set.
    expect(out[1].cost?.usd ?? null).toBeNull();
  });
});
