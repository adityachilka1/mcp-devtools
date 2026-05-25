import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSummary, summarizeTrace } from "./summary.js";
import type { StoredFrame } from "./trace-store.js";

let workDir: string;
let tracePath: string;
let pricingPath: string;

beforeEach(() => {
  // macOS `/tmp` is a symlink to `/private/tmp` — without realpath, the path
  // we hand back from `summarizeTrace` (which comes from `profileTrace` and
  // is byte-identical with what the caller passed in) will round-trip
  // through `node:fs` calls that canonicalise it, breaking equality asserts
  // and confusing any downstream tooling that diffs paths.
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-summary-test-")));
  tracePath = join(workDir, "session.mcptrace");
  pricingPath = join(workDir, "pricing.yaml");
});

afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

/** Write a list of frames as a gzipped JSONL `.mcptrace` to disk. */
function writeTrace(frames: StoredFrame[]): void {
  const jsonl = `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`;
  writeFileSync(tracePath, gzipSync(Buffer.from(jsonl)));
}

/** Build a request frame. */
function req(
  storeId: number,
  ts: number,
  rpcId: number | string,
  method: string,
  params: unknown = {},
): StoredFrame {
  return {
    id: storeId,
    ts,
    direction: "out",
    frame: { jsonrpc: "2.0", id: rpcId, method, params } as never,
  };
}

/** Build a successful response frame. */
function res(
  storeId: number,
  ts: number,
  rpcId: number | string,
  result: unknown = {},
): StoredFrame {
  return {
    id: storeId,
    ts,
    direction: "in",
    frame: { jsonrpc: "2.0", id: rpcId, result } as never,
  };
}

/** Build an error response frame (JSON-RPC error envelope). */
function err(
  storeId: number,
  ts: number,
  rpcId: number | string,
  code = -32601,
  message = "method not found",
): StoredFrame {
  return {
    id: storeId,
    ts,
    direction: "in",
    frame: { jsonrpc: "2.0", id: rpcId, error: { code, message } } as never,
  };
}

describe("summarizeTrace — happy path", () => {
  it("returns totals, byMethod ordered by count desc, and top-3 slowest", async () => {
    const frames: StoredFrame[] = [
      // tools/call ×3 at 5ms, 10ms, 50ms
      req(1, 1000, 1, "tools/call"),
      res(2, 1005, 1),
      req(3, 1010, 2, "tools/call"),
      res(4, 1020, 2),
      req(5, 1030, 3, "tools/call"),
      res(6, 1080, 3),
      // tools/list ×2 at 1ms, 3ms
      req(7, 2000, 4, "tools/list"),
      res(8, 2001, 4),
      req(9, 2010, 5, "tools/list"),
      res(10, 2013, 5),
      // initialize ×1 at 2ms
      req(11, 3000, 6, "initialize"),
      res(12, 3002, 6),
    ];
    writeTrace(frames);

    const r = await summarizeTrace({ tracePath });

    expect(r.path).toBe(tracePath);
    expect(r.totalFrames).toBe(12);
    expect(r.pairedRequests).toBe(6);
    expect(r.errorCount).toBe(0);
    expect(r.wallClockMs).toBe(2002); // 3002 - 1000

    // byMethod ordered by count desc, ties broken by method name asc.
    expect(r.byMethod[0]?.method).toBe("tools/call");
    expect(r.byMethod[0]?.count).toBe(3);
    expect(r.byMethod[1]?.method).toBe("tools/list");
    expect(r.byMethod[1]?.count).toBe(2);
    expect(r.byMethod[2]?.method).toBe("initialize");
    expect(r.byMethod[2]?.count).toBe(1);

    // All non-error → 0% error rate everywhere.
    for (const m of r.byMethod) expect(m.errorRate).toBe(0);

    // Top-3 slowest, descending.
    expect(r.slowest).toHaveLength(3);
    expect(r.slowest[0]?.latencyMs).toBe(50);
    expect(r.slowest[0]?.method).toBe("tools/call");
    expect(r.slowest[1]?.latencyMs).toBeGreaterThanOrEqual(r.slowest[2]?.latencyMs ?? 0);

    expect(r.cost).toBeUndefined();
  });
});

describe("summarizeTrace — error rate", () => {
  it("counts errors globally and stamps per-method error rate", async () => {
    const frames: StoredFrame[] = [
      // tools/call: 4 calls, 1 error → 25%
      req(1, 0, 1, "tools/call"),
      res(2, 5, 1),
      req(3, 10, 2, "tools/call"),
      err(4, 20, 2), // error
      req(5, 30, 3, "tools/call"),
      res(6, 35, 3),
      req(7, 40, 4, "tools/call"),
      res(8, 50, 4),
      // tools/list: 2 calls, 2 errors → 100%
      req(9, 60, 5, "tools/list"),
      err(10, 65, 5),
      req(11, 70, 6, "tools/list"),
      err(12, 80, 6),
    ];
    writeTrace(frames);

    const r = await summarizeTrace({ tracePath });
    expect(r.errorCount).toBe(3);

    const byName = new Map(r.byMethod.map((m) => [m.method, m]));
    expect(byName.get("tools/call")?.errorRate).toBeCloseTo(0.25, 5);
    expect(byName.get("tools/list")?.errorRate).toBe(1);
  });
});

describe("summarizeTrace — cost", () => {
  it("computes total USD when modelId is in the built-in pricing table", async () => {
    // Two tools/call pairs against gpt-4o-mini, which is in docs/pricing.yaml
    // (input 0.15, output 0.60 per 1M tokens). The numbers themselves matter
    // less than the contract: totalUsd is a positive number, basis is
    // cloud-tokens, and the priced-calls counters line up.
    const frames: StoredFrame[] = [
      req(1, 0, 1, "tools/call", { name: "echo", arguments: { text: "hello world" } }),
      res(2, 10, 1, { content: [{ type: "text", text: "hello world" }] }),
      req(3, 20, 2, "tools/call", { name: "search", arguments: { q: "mcp" } }),
      res(4, 40, 2, { content: [{ type: "text", text: "results: 12345" }] }),
    ];
    writeTrace(frames);

    const r = await summarizeTrace({ tracePath, modelId: "gpt-4o-mini" });
    expect(r.cost).toBeDefined();
    expect(r.cost?.modelId).toBe("gpt-4o-mini");
    expect(r.cost?.pricedCalls).toBe(2);
    expect(r.cost?.pricedWithCost).toBe(2);
    expect(typeof r.cost?.totalUsd).toBe("number");
    expect(r.cost?.totalUsd).toBeGreaterThan(0);
    expect(r.cost?.bases).toContain("cloud-tokens");
  });

  it("returns totalUsd: null when modelId is unknown to the pricing table", async () => {
    // Use a custom pricing file with a single unrelated entry → every
    // tools/call against `made-up-model` resolves to the unknown-model basis.
    writeFileSync(pricingPath, "real-model:\n  input: 1.0\n  output: 2.0\n");
    const frames: StoredFrame[] = [req(1, 0, 1, "tools/call"), res(2, 5, 1)];
    writeTrace(frames);

    const r = await summarizeTrace({
      tracePath,
      modelId: "made-up-model",
      pricingFile: pricingPath,
    });
    expect(r.cost).toBeDefined();
    expect(r.cost?.totalUsd).toBeNull();
    expect(r.cost?.pricedCalls).toBe(1);
    expect(r.cost?.pricedWithCost).toBe(0);
    expect(r.cost?.bases).toEqual(["unknown-model"]);
  });

  it("omits the cost block entirely when modelId is not set", async () => {
    const frames: StoredFrame[] = [req(1, 0, 1, "tools/call"), res(2, 5, 1)];
    writeTrace(frames);
    const r = await summarizeTrace({ tracePath });
    expect(r.cost).toBeUndefined();
  });
});

describe("summarizeTrace — edge cases", () => {
  it("handles an empty trace without throwing", async () => {
    // gzipped empty file is still a valid (zero-frame) trace.
    writeFileSync(tracePath, gzipSync(Buffer.from("")));
    const r = await summarizeTrace({ tracePath });
    expect(r.totalFrames).toBe(0);
    expect(r.pairedRequests).toBe(0);
    expect(r.errorCount).toBe(0);
    expect(r.byMethod).toEqual([]);
    expect(r.slowest).toEqual([]);
    expect(r.wallClockMs).toBe(0);
  });

  it("survives a malformed JSONL line stored as a parse-error envelope", async () => {
    // Mirror what the recorder/jsonrpc parser produces when a single line
    // can't be JSON-parsed: `{ _raw, _parseError }` on the inner `frame`.
    const frames: StoredFrame[] = [
      {
        id: 1,
        ts: 0,
        direction: "in",
        frame: { _raw: "garbage{", _parseError: "Unexpected token g" } as never,
      },
      req(2, 5, 1, "tools/call"),
      res(3, 15, 1),
    ];
    writeTrace(frames);

    const r = await summarizeTrace({ tracePath });
    expect(r.totalFrames).toBe(3);
    expect(r.pairedRequests).toBe(1);
    expect(r.errorCount).toBe(0);
    expect(r.byMethod[0]?.method).toBe("tools/call");
  });

  it("rejects on a file that does not exist", async () => {
    await expect(
      summarizeTrace({ tracePath: join(workDir, "missing.mcptrace") }),
    ).rejects.toThrow();
  });
});

describe("formatSummary (smoke)", () => {
  it("renders the byMethod row of the most-called method in human mode", async () => {
    const frames: StoredFrame[] = [
      req(1, 0, 1, "tools/call"),
      res(2, 7, 1),
      req(3, 10, 2, "tools/call"),
      res(4, 25, 2),
      req(5, 30, 3, "tools/call"),
      err(6, 50, 3),
      req(7, 60, 4, "tools/list"),
      res(8, 65, 4),
    ];
    writeTrace(frames);
    const r = await summarizeTrace({ tracePath });

    const out = formatSummary(r);
    expect(out).toContain("mcp-devtools summary");
    expect(out).toContain("Top methods by call count");
    expect(out).toContain("tools/call");
    expect(out).toContain("tools/list");
    expect(out).toContain("Slowest");
    // Header is right-aligned: count/p95/err columns must all appear.
    expect(out).toContain("count");
    expect(out).toContain("p95");
    expect(out).toContain("err");
  });
});
