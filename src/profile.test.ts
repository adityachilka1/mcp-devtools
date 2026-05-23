import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { computeProfile, formatProfile, percentile, profileTrace } from "./profile.js";
import type { StoredFrame } from "./trace-store.js";

function f(id: number, ts: number, direction: "in" | "out", body: unknown): StoredFrame {
  return { id, ts, direction, frame: body as never };
}

/** Build a request/response pair for `method` with a given latency. */
function pair(
  startId: number,
  rpcId: number | string,
  method: string,
  requestTs: number,
  latencyMs: number,
): [StoredFrame, StoredFrame] {
  return [
    f(startId, requestTs, "out", { jsonrpc: "2.0", id: rpcId, method, params: {} }),
    f(startId + 1, requestTs + latencyMs, "in", { jsonrpc: "2.0", id: rpcId, result: {} }),
  ];
}

describe("percentile (nearest-rank)", () => {
  it("returns the only sample for single-element arrays", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it("returns 0 for empty arrays", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("computes p50/p95/p99 on a known distribution", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // nearest-rank: p50 → ceil(0.5*10)=5 → index 4 → value 5
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 99)).toBe(10);
  });
});

describe("computeProfile", () => {
  it("computes per-method percentiles on a multi-method trace", () => {
    const frames: StoredFrame[] = [];
    // tools/call: 10 calls at latencies 1..10 ms.
    for (let i = 0; i < 10; i++) {
      frames.push(...pair(i * 2 + 1, 100 + i, "tools/call", 1000 + i * 100, i + 1));
    }
    // tools/list: 3 calls at 2, 4, 6 ms.
    for (let i = 0; i < 3; i++) {
      frames.push(...pair(100 + i * 2, 200 + i, "tools/list", 5000 + i * 100, (i + 1) * 2));
    }
    // initialize: 1 call at 8 ms.
    frames.push(...pair(200, 300, "initialize", 6000, 8));

    const r = computeProfile("test.mcptrace", frames);
    expect(r.totalFrames).toBe(frames.length);
    expect(r.pairedRequests).toBe(14);
    expect(r.unpairedRequests).toBe(0);

    const byMethod = new Map(r.perMethod.map((m) => [m.method, m]));

    const tc = byMethod.get("tools/call");
    expect(tc).toBeDefined();
    expect(tc?.count).toBe(10);
    expect(tc?.p50Ms).toBe(5);
    expect(tc?.p95Ms).toBe(10);
    expect(tc?.p99Ms).toBe(10);
    expect(tc?.maxMs).toBe(10);
    expect(tc?.totalMs).toBe(55);

    const tl = byMethod.get("tools/list");
    expect(tl?.count).toBe(3);
    expect(tl?.totalMs).toBe(12);
    expect(tl?.maxMs).toBe(6);

    const init = byMethod.get("initialize");
    expect(init?.count).toBe(1);
    // Single-call method: every percentile equals the lone sample.
    expect(init?.p50Ms).toBe(8);
    expect(init?.p95Ms).toBe(8);
    expect(init?.p99Ms).toBe(8);
  });

  it("ranks per-method buckets by total time descending", () => {
    const frames: StoredFrame[] = [
      ...pair(1, 1, "fast", 0, 1),
      ...pair(3, 2, "fast", 100, 1),
      ...pair(5, 3, "slow", 200, 500),
    ];
    const r = computeProfile("t", frames);
    // Even though "fast" has more calls, "slow" eats more wall time → first.
    expect(r.perMethod[0]?.method).toBe("slow");
    expect(r.perMethod[1]?.method).toBe("fast");
  });

  it("treats a trace with only requests (no responses) as all unpaired", () => {
    const frames: StoredFrame[] = [
      f(1, 0, "out", { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
      f(2, 100, "out", { jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }),
      f(3, 200, "out", { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    ];
    const r = computeProfile("t", frames);
    expect(r.pairedRequests).toBe(0);
    expect(r.unpairedRequests).toBe(3);
    expect(r.perMethod).toEqual([]);
    expect(r.slowest).toEqual([]);
  });

  it("ignores notifications from per-method stats", () => {
    const frames: StoredFrame[] = [
      // A bare notification — method but no id. Must NOT show up in perMethod.
      f(1, 0, "in", { jsonrpc: "2.0", method: "notifications/progress", params: {} }),
      ...pair(2, 1, "tools/call", 100, 5),
      // Another notification mid-stream.
      f(5, 150, "in", { jsonrpc: "2.0", method: "notifications/message", params: {} }),
    ];
    const r = computeProfile("t", frames);
    expect(r.totalFrames).toBe(4);
    expect(r.perMethod).toHaveLength(1);
    expect(r.perMethod[0]?.method).toBe("tools/call");
    // Notifications still counted in totalFrames but not paired.
    expect(r.pairedRequests).toBe(1);
  });

  it("handles an empty trace deterministically", () => {
    const r = computeProfile("empty.mcptrace", []);
    expect(r).toEqual({
      path: "empty.mcptrace",
      totalFrames: 0,
      pairedRequests: 0,
      unpairedRequests: 0,
      wallClockMs: 0,
      perMethod: [],
      slowest: [],
    });
  });

  it("handles malformed-line frames gracefully (consistent with the reader)", () => {
    const frames: StoredFrame[] = [
      // A frame the reader couldn't JSON-parse and stored as a parse-error
      // envelope. computeProfile should skip it without throwing.
      f(1, 0, "in", { _raw: "garbage{", _parseError: "Unexpected token g" }),
      ...pair(2, 1, "tools/call", 50, 10),
    ];
    const r = computeProfile("t", frames);
    expect(r.pairedRequests).toBe(1);
    expect(r.perMethod[0]?.method).toBe("tools/call");
    expect(r.totalFrames).toBe(3);
  });

  it("returns top-10 slowest calls sorted descending", () => {
    const frames: StoredFrame[] = [];
    // 12 calls with latencies 10, 20, ..., 120.
    for (let i = 0; i < 12; i++) {
      frames.push(...pair(i * 2 + 1, i + 1, "tools/call", i * 200, (i + 1) * 10));
    }
    const r = computeProfile("t", frames);
    expect(r.slowest).toHaveLength(10);
    // First entry must be the slowest (120ms).
    expect(r.slowest[0]?.latencyMs).toBe(120);
    expect(r.slowest[9]?.latencyMs).toBe(30);
    // Strictly descending.
    for (let i = 1; i < r.slowest.length; i++) {
      const prev = r.slowest[i - 1];
      const cur = r.slowest[i];
      if (!prev || !cur) continue;
      expect(prev.latencyMs).toBeGreaterThanOrEqual(cur.latencyMs);
    }
  });

  it("computes wall clock as last-ts minus first-ts", () => {
    const frames: StoredFrame[] = [
      f(1, 1_000, "out", { jsonrpc: "2.0", id: 1, method: "x" }),
      f(2, 1_500, "in", { jsonrpc: "2.0", id: 1, result: {} }),
      f(3, 11_000, "out", { jsonrpc: "2.0", id: 2, method: "y" }),
      f(4, 12_345, "in", { jsonrpc: "2.0", id: 2, result: {} }),
    ];
    const r = computeProfile("t", frames);
    expect(r.wallClockMs).toBe(11_345);
  });
});

describe("formatProfile (smoke)", () => {
  it("renders the empty-trace case without crashing", () => {
    const out = formatProfile(computeProfile("empty", []));
    expect(out).toContain("mcp-devtools profile");
    expect(out).toContain("No paired requests");
  });

  it("renders a real trace with the expected method names", () => {
    const frames: StoredFrame[] = [
      ...pair(1, 1, "tools/call", 0, 12),
      ...pair(3, 2, "tools/list", 50, 3),
    ];
    const out = formatProfile(computeProfile("test", frames));
    expect(out).toContain("tools/call");
    expect(out).toContain("tools/list");
    expect(out).toContain("Per-method latency");
    expect(out).toContain("Slowest");
  });
});

describe("profileTrace (file I/O)", () => {
  it("reads a gzipped JSONL .mcptrace from disk and profiles it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-profile-test-"));
    const path = join(dir, "fixture.mcptrace");
    const stored: StoredFrame[] = [
      ...pair(1, 1, "tools/call", 1000, 15),
      ...pair(3, 2, "tools/call", 1050, 25),
      ...pair(5, 3, "initialize", 2000, 4),
    ];
    const jsonl = stored.map((s) => JSON.stringify(s)).join("\n");
    writeFileSync(path, gzipSync(Buffer.from(`${jsonl}\n`)));

    const r = await profileTrace(path);
    expect(r.path).toBe(path);
    expect(r.totalFrames).toBe(6);
    expect(r.pairedRequests).toBe(3);
    const byMethod = new Map(r.perMethod.map((m) => [m.method, m]));
    expect(byMethod.get("tools/call")?.count).toBe(2);
    expect(byMethod.get("initialize")?.count).toBe(1);
  });

  it("rejects on a file that does not exist", async () => {
    await expect(profileTrace("/nonexistent/path/definitely-not-here.mcptrace")).rejects.toThrow();
  });
});
