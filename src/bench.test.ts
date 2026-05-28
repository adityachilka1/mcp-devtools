import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { benchTrace, formatBench } from "./bench.js";
import type { StoredFrame } from "./trace-store.js";

/** Build a StoredFrame for trace fixtures. */
function f(id: number, direction: "in" | "out", body: unknown): StoredFrame {
  return { id, ts: id * 10, direction, frame: body as never };
}

/** Build a request/response pair for `method`. Returns 2 frames. */
function pair(startId: number, rpcId: number | string, method: string): StoredFrame[] {
  return [
    f(startId, "out", { jsonrpc: "2.0", id: rpcId, method }),
    f(startId + 1, "in", { jsonrpc: "2.0", id: rpcId, result: {} }),
  ];
}

/** Serialize a frame array as gzipped JSONL to `<dir>/<name>.mcptrace`. */
function writeTrace(dir: string, name: string, frames: StoredFrame[]): string {
  const path = join(dir, `${name}.mcptrace`);
  const jsonl = frames.map((s) => JSON.stringify(s)).join("\n");
  writeFileSync(path, gzipSync(Buffer.from(`${jsonl}\n`)));
  return path;
}

describe("benchTrace", () => {
  let dir: string;
  beforeEach(async () => {
    // realpath unwinds the /var → /private/var alias macOS uses for /tmp.
    dir = realpathSync(await mkdtemp(join(tmpdir(), "mcp-bench-")));
  });

  it("single-iteration happy path: runs.length === 1, durationMs > 0, fps > 0", async () => {
    const frames: StoredFrame[] = [];
    for (let i = 0; i < 5; i++) frames.push(...pair(i * 2 + 1, i + 1, "tools/call"));
    const path = writeTrace(dir, "single", frames);

    const r = await benchTrace({ tracePath: path, iterations: 1 });
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.runs[0]?.framesPerSecond).toBeGreaterThan(0);
    expect(r.totalFrames).toBe(10);
    expect(r.iterations).toBe(1);
    expect(r.warmup).toBe(0);
  });

  it("iterations: 3 → runs.length === 3, median == middle value of sorted durations", async () => {
    const frames: StoredFrame[] = [];
    for (let i = 0; i < 3; i++) frames.push(...pair(i * 2 + 1, i + 1, "ping"));
    const path = writeTrace(dir, "three", frames);

    const r = await benchTrace({ tracePath: path, iterations: 3 });
    expect(r.runs).toHaveLength(3);

    const sortedMs = r.runs.map((x) => x.durationMs).sort((a, b) => a - b);
    expect(r.median.durationMs).toBe(sortedMs[1]);
  });

  it("warmup: 2, iterations: 5 → runs.length 5 but median uses last 5 (warmup discarded)", async () => {
    const frames: StoredFrame[] = [];
    for (let i = 0; i < 4; i++) frames.push(...pair(i * 2 + 1, i + 1, "x"));
    const path = writeTrace(dir, "warm", frames);

    // The signature says: iterations excludes warmup, so total runs = warmup + iterations = 7.
    const r = await benchTrace({ tracePath: path, iterations: 5, warmup: 2 });
    expect(r.runs).toHaveLength(7);
    expect(r.warmup).toBe(2);
    expect(r.iterations).toBe(5);

    // Compute expected median over the last 5 measured runs only.
    const measured = r.runs
      .slice(2)
      .map((x) => x.durationMs)
      .sort((a, b) => a - b);
    expect(r.median.durationMs).toBe(measured[2]);
  });

  it("iterations: 0 → rejects with a clear error", async () => {
    const frames = [...pair(1, 1, "ping")];
    const path = writeTrace(dir, "zero", frames);
    await expect(benchTrace({ tracePath: path, iterations: 0 })).rejects.toThrow(/iterations/i);
  });

  it("rejects with a clear error when the trace file does not exist", async () => {
    await expect(
      benchTrace({ tracePath: join(dir, "nope.mcptrace"), iterations: 1 }),
    ).rejects.toThrow();
  });

  it("p95 correctness on a 20-run sample (nearest-rank: ceil(0.95*20)=19 → idx 18)", async () => {
    const frames = [...pair(1, 1, "ping")];
    const path = writeTrace(dir, "p95", frames);
    const r = await benchTrace({ tracePath: path, iterations: 20 });
    expect(r.runs).toHaveLength(20);

    const sorted = r.runs.map((x) => x.durationMs).sort((a, b) => a - b);
    expect(r.p95.durationMs).toBe(sorted[18]);
  });

  it("best.fps >= median.fps >= worst.fps (fps inverts duration)", async () => {
    const frames: StoredFrame[] = [];
    for (let i = 0; i < 5; i++) frames.push(...pair(i * 2 + 1, i + 1, "ping"));
    const path = writeTrace(dir, "order", frames);
    const r = await benchTrace({ tracePath: path, iterations: 7 });
    expect(r.best.framesPerSecond).toBeGreaterThanOrEqual(r.median.framesPerSecond);
    expect(r.median.framesPerSecond).toBeGreaterThanOrEqual(r.worst.framesPerSecond);
    // Dual invariant: best duration <= median <= worst.
    expect(r.best.durationMs).toBeLessThanOrEqual(r.median.durationMs);
    expect(r.median.durationMs).toBeLessThanOrEqual(r.worst.durationMs);
  });

  it("empty trace → safe shape: 0 frames, runs still present with 0 fps", async () => {
    const path = writeTrace(dir, "empty", []);
    const r = await benchTrace({ tracePath: path, iterations: 3 });
    expect(r.totalFrames).toBe(0);
    expect(r.runs).toHaveLength(3);
    for (const run of r.runs) {
      expect(run.framesPerSecond).toBe(0);
    }
    expect(r.median.framesPerSecond).toBe(0);
  });

  it("default iterations === 1 when no iterations option is passed", async () => {
    const frames = [...pair(1, 1, "ping")];
    const path = writeTrace(dir, "def", frames);
    const r = await benchTrace({ tracePath: path });
    expect(r.runs).toHaveLength(1);
    expect(r.iterations).toBe(1);
  });

  it("rejects negative iterations and negative warmup", async () => {
    const frames = [...pair(1, 1, "ping")];
    const path = writeTrace(dir, "neg", frames);
    await expect(benchTrace({ tracePath: path, iterations: -1 })).rejects.toThrow(/iterations/i);
    await expect(benchTrace({ tracePath: path, iterations: 1, warmup: -2 })).rejects.toThrow(
      /warmup/i,
    );
  });

  it("framesPerSecond matches totalFrames / (durationMs / 1000) per run", async () => {
    const frames: StoredFrame[] = [];
    for (let i = 0; i < 8; i++) frames.push(...pair(i * 2 + 1, i + 1, "ping"));
    const path = writeTrace(dir, "fps", frames);
    const r = await benchTrace({ tracePath: path, iterations: 3 });
    for (const run of r.runs) {
      if (run.durationMs > 0) {
        const expected = r.totalFrames / (run.durationMs / 1000);
        // tolerate fp jitter
        expect(Math.abs(run.framesPerSecond - expected)).toBeLessThan(1e-6);
      }
    }
  });

  it("median equals best when iterations: 1 and equals worst when iterations: 1", async () => {
    const frames = [...pair(1, 1, "ping")];
    const path = writeTrace(dir, "one", frames);
    const r = await benchTrace({ tracePath: path, iterations: 1 });
    expect(r.median.durationMs).toBe(r.best.durationMs);
    expect(r.median.durationMs).toBe(r.worst.durationMs);
    expect(r.p95.durationMs).toBe(r.runs[0]?.durationMs);
  });

  it("each run index is 0-based and contiguous", async () => {
    const frames = [...pair(1, 1, "ping")];
    const path = writeTrace(dir, "idx", frames);
    const r = await benchTrace({ tracePath: path, iterations: 4 });
    expect(r.runs.map((x) => x.index)).toEqual([0, 1, 2, 3]);
  });

  it("warmup: 0 (explicit) behaves the same as omitted warmup", async () => {
    const frames = [...pair(1, 1, "ping")];
    const path = writeTrace(dir, "w0", frames);
    const r = await benchTrace({ tracePath: path, iterations: 2, warmup: 0 });
    expect(r.warmup).toBe(0);
    expect(r.runs).toHaveLength(2);
  });
});

describe("formatBench", () => {
  let dir: string;
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(join(tmpdir(), "mcp-bench-fmt-")));
  });

  it("renders a compact table with per-run rows and a summary block", async () => {
    const frames: StoredFrame[] = [];
    for (let i = 0; i < 3; i++) frames.push(...pair(i * 2 + 1, i + 1, "ping"));
    const path = writeTrace(dir, "fmt", frames);
    const r = await benchTrace({ tracePath: path, iterations: 3 });
    const text = formatBench(r);
    expect(text).toMatch(/mcp-devtools bench/);
    expect(text).toMatch(/median/i);
    expect(text).toMatch(/p95/i);
    expect(text).toMatch(/best/i);
    expect(text).toMatch(/worst/i);
    // Three run rows present.
    expect(text.split("\n").filter((l) => /\b[0-2]\b/.test(l)).length).toBeGreaterThanOrEqual(3);
  });
});
