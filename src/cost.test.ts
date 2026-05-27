import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatCostGate, runCostGate } from "./cost.js";
import type { StoredFrame } from "./trace-store.js";

let workDir: string;
let tracePath: string;
let pricingPath: string;

beforeEach(() => {
  // macOS `/tmp` is a symlink to `/private/tmp` — without realpath, the path
  // we hand back from `runCostGate` (which comes from `readTrace` calls that
  // canonicalise it) won't match the value we expect in asserts.
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-cost-test-")));
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

describe("runCostGate — happy path", () => {
  it("returns a positive totalUsd and overBudget=false when no budget is set", async () => {
    const frames: StoredFrame[] = [
      req(1, 0, 1, "tools/call", { name: "echo", arguments: { text: "hello world" } }),
      res(2, 10, 1, { content: [{ type: "text", text: "hi" }] }),
      req(3, 20, 2, "tools/call", { name: "search", arguments: { q: "mcp" } }),
      res(4, 40, 2, { content: [{ type: "text", text: "results: 12345" }] }),
    ];
    writeTrace(frames);

    const r = await runCostGate({ tracePath, modelId: "gpt-4o-mini" });
    expect(r.totalUsd).toBeGreaterThan(0);
    expect(r.pairedTotal).toBe(2);
    expect(r.unknownCount).toBe(0);
    expect(r.budgetUsd).toBeNull();
    expect(r.overBudget).toBe(false);
  });
});

describe("runCostGate — budget gate", () => {
  it("flags overBudget=true when total exceeds an absurdly small budget", async () => {
    const frames: StoredFrame[] = [
      req(1, 0, 1, "tools/call", { name: "echo", arguments: { text: "hello world" } }),
      res(2, 10, 1, { content: [{ type: "text", text: "hi" }] }),
    ];
    writeTrace(frames);

    const r = await runCostGate({
      tracePath,
      modelId: "gpt-4o-mini",
      budgetUsd: 0.0000001,
    });
    expect(r.totalUsd).toBeGreaterThan(0.0000001);
    expect(r.budgetUsd).toBe(0.0000001);
    expect(r.overBudget).toBe(true);
  });

  it("keeps overBudget=false when the total fits inside a generous budget", async () => {
    const frames: StoredFrame[] = [
      req(1, 0, 1, "tools/call", { name: "echo", arguments: { text: "hello world" } }),
      res(2, 10, 1, { content: [{ type: "text", text: "hi" }] }),
    ];
    writeTrace(frames);

    const r = await runCostGate({ tracePath, modelId: "gpt-4o-mini", budgetUsd: 1.0 });
    expect(r.totalUsd).toBeLessThan(1.0);
    expect(r.budgetUsd).toBe(1.0);
    expect(r.overBudget).toBe(false);
  });

  it("treats budget=0 as a strict 'no spend' threshold (anything > 0 is over)", async () => {
    const frames: StoredFrame[] = [req(1, 0, 1, "tools/call"), res(2, 10, 1)];
    writeTrace(frames);
    const r = await runCostGate({ tracePath, modelId: "gpt-4o-mini", budgetUsd: 0 });
    expect(r.overBudget).toBe(true);
  });
});

describe("runCostGate — required model id", () => {
  it("rejects when modelId is missing — cost gate has no meaning without one", async () => {
    writeTrace([req(1, 0, 1, "tools/call"), res(2, 10, 1)]);
    await expect(
      // @ts-expect-error — exercising the runtime guard for callers who skip TS
      runCostGate({ tracePath }),
    ).rejects.toThrow(/model/i);
  });
});

describe("runCostGate — unknown model never fails CI", () => {
  it("reports unknownCount > 0, totalUsd=0, overBudget=false even with budget=0", async () => {
    // Custom pricing file with a single unrelated entry → every tools/call
    // against `made-up-model` resolves to the unknown-model basis.
    writeFileSync(pricingPath, "real-model:\n  input: 1.0\n  output: 2.0\n");
    writeTrace([
      req(1, 0, 1, "tools/call"),
      res(2, 10, 1),
      req(3, 20, 2, "tools/call"),
      res(4, 30, 2),
    ]);

    const r = await runCostGate({
      tracePath,
      modelId: "made-up-model",
      pricingFile: pricingPath,
      budgetUsd: 0,
    });
    expect(r.unknownCount).toBe(2);
    expect(r.totalUsd).toBe(0);
    // Critical: "we can't measure → don't fail CI".
    expect(r.overBudget).toBe(false);
  });
});

describe("runCostGate — byMethod aggregation", () => {
  it("sorts byMethod by totalUsd descending and only includes priced methods", async () => {
    // Two tools/call (priced), one tools/list (not priced — annotator only
    // stamps tools/call). Expect tools/call to show up; tools/list to be
    // absent because it never received a cost annotation.
    const longBody = "x".repeat(2000); // makes tools/call cost a hair larger
    const frames: StoredFrame[] = [
      req(1, 0, 1, "tools/call", { name: "echo", arguments: { text: longBody } }),
      res(2, 10, 1, { content: [{ type: "text", text: longBody }] }),
      req(3, 20, 2, "tools/call", { name: "search", arguments: { q: "k" } }),
      res(4, 30, 2, { content: [{ type: "text", text: "r" }] }),
      req(5, 40, 3, "tools/list"),
      res(6, 45, 3),
    ];
    writeTrace(frames);

    const r = await runCostGate({ tracePath, modelId: "gpt-4o-mini" });
    expect(r.byMethod.length).toBeGreaterThan(0);
    // every row has > 0 cost
    for (const m of r.byMethod) expect(m.totalUsd).toBeGreaterThan(0);
    // sorted descending
    for (let i = 1; i < r.byMethod.length; i++) {
      const prev = r.byMethod[i - 1]?.totalUsd ?? 0;
      const cur = r.byMethod[i]?.totalUsd ?? 0;
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
    // tools/list never gets a price → must not appear
    expect(r.byMethod.find((m) => m.method === "tools/list")).toBeUndefined();
    // tools/call must appear with count of 2 priced calls
    const call = r.byMethod.find((m) => m.method === "tools/call");
    expect(call).toBeDefined();
    expect(call?.count).toBe(2);
  });
});

describe("runCostGate — edge cases", () => {
  it("handles an empty trace without throwing", async () => {
    writeFileSync(tracePath, gzipSync(Buffer.from("")));
    const r = await runCostGate({ tracePath, modelId: "gpt-4o-mini" });
    expect(r.totalUsd).toBe(0);
    expect(r.pairedTotal).toBe(0);
    expect(r.unknownCount).toBe(0);
    expect(r.byMethod).toEqual([]);
    expect(r.overBudget).toBe(false);
  });

  it("rejects on a file that does not exist", async () => {
    await expect(
      runCostGate({
        tracePath: join(workDir, "missing.mcptrace"),
        modelId: "gpt-4o-mini",
      }),
    ).rejects.toThrow();
  });

  it("honors --pricing-file when supplied (custom YAML takes priority)", async () => {
    // Write a custom pricing entry with a 100x rate vs gpt-4o-mini's
    // built-in, then check the total against the custom file is much larger
    // than against an empty file (which would yield 0 / unknown).
    writeFileSync(pricingPath, "tiny-model:\n  input: 1000.0\n  output: 1000.0\n");
    writeTrace([
      req(1, 0, 1, "tools/call", { name: "echo", arguments: { text: "hello" } }),
      res(2, 10, 1, { content: [{ type: "text", text: "world" }] }),
    ]);

    const r = await runCostGate({
      tracePath,
      modelId: "tiny-model",
      pricingFile: pricingPath,
    });
    expect(r.totalUsd).toBeGreaterThan(0);
    expect(r.pairedTotal).toBe(1);
    expect(r.unknownCount).toBe(0);
  });

  it("ignores notifications and non-tools/call frames in pairedTotal", async () => {
    // Notifications (no id) shouldn't show up at all. tools/list pairs also
    // shouldn't count toward pairedTotal because the annotator only buckets
    // tools/call.
    const frames: StoredFrame[] = [
      // notification — no id
      {
        id: 1,
        ts: 0,
        direction: "out",
        frame: { jsonrpc: "2.0", method: "notifications/initialized" } as never,
      },
      // tools/list pair — not a tools/call
      req(2, 5, 1, "tools/list"),
      res(3, 10, 1),
      // tools/call pair — counts
      req(4, 15, 2, "tools/call"),
      res(5, 20, 2),
    ];
    writeTrace(frames);
    const r = await runCostGate({ tracePath, modelId: "gpt-4o-mini" });
    expect(r.pairedTotal).toBe(1);
  });
});

describe("formatCostGate (smoke)", () => {
  it("renders the model, total, per-method table, and a verdict line", async () => {
    const frames: StoredFrame[] = [
      req(1, 0, 1, "tools/call", { name: "echo", arguments: { text: "hi" } }),
      res(2, 10, 1, { content: [{ type: "text", text: "ok" }] }),
    ];
    writeTrace(frames);

    const r = await runCostGate({ tracePath, modelId: "gpt-4o-mini", budgetUsd: 1.0 });
    const out = formatCostGate(r);
    expect(out).toContain("mcp-devtools cost");
    expect(out).toContain("gpt-4o-mini");
    expect(out).toContain("tools/call");
    // verdict — under budget when totalUsd <= budget
    expect(out.toLowerCase()).toContain("under budget");
  });

  it("renders an 'over budget by $X' line when the gate trips", async () => {
    const frames: StoredFrame[] = [
      req(1, 0, 1, "tools/call", { name: "echo", arguments: { text: "hi" } }),
      res(2, 10, 1, { content: [{ type: "text", text: "ok" }] }),
    ];
    writeTrace(frames);
    const r = await runCostGate({
      tracePath,
      modelId: "gpt-4o-mini",
      budgetUsd: 0.0000001,
    });
    const out = formatCostGate(r);
    expect(out.toLowerCase()).toContain("over budget");
  });

  it("renders a clear 'unable to price' note when every call is unknown-model", async () => {
    writeFileSync(pricingPath, "real-model:\n  input: 1.0\n  output: 2.0\n");
    writeTrace([req(1, 0, 1, "tools/call"), res(2, 10, 1)]);
    const r = await runCostGate({
      tracePath,
      modelId: "ghost",
      pricingFile: pricingPath,
      budgetUsd: 0,
    });
    const out = formatCostGate(r);
    // Either a dim "unable to price" / "unknown" hint must show up so the
    // operator understands why overBudget is false despite budget=0.
    expect(out.toLowerCase()).toMatch(/unknown|unable to price/);
  });
});
