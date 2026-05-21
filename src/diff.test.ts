import { describe, expect, it } from "vitest";
import { diffFrames, formatDiffReport } from "./diff.js";
import type { StoredFrame } from "./trace-store.js";

const frame = (
  id: number,
  direction: "in" | "out",
  body: Record<string, unknown>,
): StoredFrame => ({
  id,
  ts: id * 1000,
  direction,
  frame: body as never,
});

const baseline: StoredFrame[] = [
  frame(1, "out", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
  frame(2, "in", { jsonrpc: "2.0", id: 1, result: { tools: [] } }),
  frame(3, "out", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping" } }),
  frame(4, "in", { jsonrpc: "2.0", id: 2, result: "pong" }),
];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("diffFrames", () => {
  it("returns identical when traces match byte-for-byte", () => {
    const r = diffFrames(baseline, clone(baseline));
    expect(r.identical).toBe(true);
    expect(r.differences).toEqual([]);
  });

  it("flags frame-count mismatch", () => {
    const shorter = clone(baseline).slice(0, 2);
    const r = diffFrames(baseline, shorter);
    expect(r.identical).toBe(false);
    expect(r.differences[0]).toMatchObject({ kind: "frame-count", expected: 4, actual: 2 });
  });

  it("flags method drift on a specific frame", () => {
    const drifted = clone(baseline);
    (drifted[2]!.frame as Record<string, unknown>).method = "tools/INVOKE";
    const r = diffFrames(baseline, drifted);
    expect(r.differences).toContainEqual({
      kind: "method",
      index: 2,
      expected: "tools/call",
      actual: "tools/INVOKE",
    });
  });

  it("flags is-error flip when a result becomes an error", () => {
    const drifted = clone(baseline);
    // Swap `result` for `error` to flip the is-error flag.
    drifted[3]!.frame = {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32600, message: "bad" },
    } as never;
    const r = diffFrames(baseline, drifted);
    expect(r.differences.some((d) => d.kind === "is-error")).toBe(true);
  });

  it("flags body diff when shape matches but content differs", () => {
    const drifted = clone(baseline);
    ((drifted[2]!.frame as Record<string, unknown>).params as Record<string, unknown>).name =
      "pong";
    const r = diffFrames(baseline, drifted);
    expect(r.differences.some((d) => d.kind === "frame-body" && d.index === 2)).toBe(true);
  });

  it("flags direction flip", () => {
    const drifted = clone(baseline);
    drifted[0]!.direction = "in";
    const r = diffFrames(baseline, drifted);
    expect(r.differences[0]).toMatchObject({
      kind: "direction",
      index: 0,
      expected: "out",
      actual: "in",
    });
  });

  it("formatDiffReport renders identical case tersely", () => {
    expect(formatDiffReport(diffFrames(baseline, clone(baseline)))).toBe(
      "traces are structurally identical (4 frames)",
    );
  });
});
