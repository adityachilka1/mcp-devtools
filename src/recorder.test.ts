import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _writeWithRotationForTest, parseSize } from "./recorder.js";

let workDir: string;
let tracePath: string;

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-rec-test-")));
  tracePath = join(workDir, "session.mcptrace");
});

afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

/** Build a JSONL line of roughly `padBytes` size — pads the frame body so we can
 *  predict how many lines it takes to trip the rotation threshold. */
function lineOfSize(id: number, padBytes: number): string {
  const body = "x".repeat(Math.max(1, padBytes));
  return `${JSON.stringify({ id, ts: 1_700_000_000_000 + id, direction: "out", frame: { jsonrpc: "2.0", id, method: "x", params: { pad: body } } })}\n`;
}

/** Snapshot the rotation file layout in workDir. Returns sorted basenames. */
function listTraceFiles(): string[] {
  return readdirSync(workDir)
    .filter((n) => n.startsWith("session.mcptrace"))
    .sort();
}

/** Gunzip a (possibly multi-member) trace file and return its raw text. */
function readTraceText(p: string): string {
  return gunzipSync(readFileSync(p)).toString("utf8");
}

describe("parseSize", () => {
  it("parses bare numbers as bytes", () => {
    expect(parseSize("1024")).toBe(1024);
    expect(parseSize("0.5KB")).toBe(512);
  });

  it("parses common size suffixes", () => {
    expect(parseSize("1KB")).toBe(1024);
    expect(parseSize("10MB")).toBe(10 * 1024 * 1024);
    expect(parseSize("2GB")).toBe(2 * 1024 ** 3);
    expect(parseSize("500B")).toBe(500);
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(parseSize(" 1mb ")).toBe(1024 * 1024);
    expect(parseSize("1Gb")).toBe(1024 ** 3);
  });

  it("rejects garbage with a clear message", () => {
    expect(() => parseSize("ten megs")).toThrow(/invalid --rotate/);
    expect(() => parseSize("")).toThrow(/invalid --rotate/);
    expect(() => parseSize("-5MB")).toThrow(/invalid --rotate/);
    expect(() => parseSize("0")).toThrow(/invalid --rotate/);
  });
});

describe("recorder rotation — threshold tripped", () => {
  it("rotates once when the compressed file grows past rotateBytes", async () => {
    // Lines are ~200 chars of mostly-redundant text — gzip compresses hard, so
    // we need many lines to push the *compressed* size past the threshold.
    const lines = Array.from({ length: 200 }, (_, i) => lineOfSize(i + 1, 400));
    await _writeWithRotationForTest({
      outPath: tracePath,
      lines,
      rotateBytes: 1024,
      keep: 3,
    });

    const files = listTraceFiles();
    expect(files).toContain("session.mcptrace");
    expect(files).toContain("session.mcptrace.1");

    // Each rotated file must be a complete gzip archive on its own.
    expect(() => readTraceText(join(workDir, "session.mcptrace.1"))).not.toThrow();
    expect(() => readTraceText(tracePath)).not.toThrow();
  });

  it("leaves the active file smaller than (or close to) rotateBytes", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => lineOfSize(i + 1, 400));
    await _writeWithRotationForTest({
      outPath: tracePath,
      lines,
      rotateBytes: 2048,
      keep: 5,
    });

    // The trailing active file shouldn't have been allowed to grow unboundedly:
    // it must be no larger than rotateBytes plus a small gzip-flush overshoot.
    const activeSize = statSync(tracePath).size;
    // Generous bound — write buffering can let it overshoot by an OS buffer.
    expect(activeSize).toBeLessThanOrEqual(2048 + 64 * 1024);
  });
});

describe("recorder rotation — multiple rotations", () => {
  it("shifts numbered suffixes correctly across many rotations", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => lineOfSize(i + 1, 400));
    await _writeWithRotationForTest({
      outPath: tracePath,
      lines,
      rotateBytes: 1024,
      keep: 5,
    });

    const files = listTraceFiles();
    // Should have rotated at least twice — .1 and .2 should both exist.
    expect(files).toContain("session.mcptrace.1");
    expect(files).toContain("session.mcptrace.2");
    // Every numbered file should be a self-contained gzip archive.
    for (const name of files) {
      const full = join(workDir, name);
      expect(() => readTraceText(full)).not.toThrow();
    }
  });

  it("preserves chronological order: .1 is newer than .2, .2 newer than .3", async () => {
    // Tag lines with their sequence number so we can reconstruct ordering
    // after gunzipping each rotated archive.
    const lines = Array.from({ length: 400 }, (_, i) => lineOfSize(i + 1, 400));
    await _writeWithRotationForTest({
      outPath: tracePath,
      lines,
      rotateBytes: 1024,
      keep: 5,
    });

    const files = listTraceFiles();
    // Pull the smallest id seen in each rotated file. .1 should contain ids
    // *older* than the active file but newer than .2, etc. (Lower id = older.)
    function minIdIn(p: string): number {
      const text = readTraceText(p);
      const ids = text
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { id: number }).id);
      return Math.min(...ids);
    }
    const active = minIdIn(tracePath);
    if (files.includes("session.mcptrace.1")) {
      const one = minIdIn(join(workDir, "session.mcptrace.1"));
      expect(one).toBeLessThan(active);
      if (files.includes("session.mcptrace.2")) {
        const two = minIdIn(join(workDir, "session.mcptrace.2"));
        expect(two).toBeLessThan(one);
      }
    }
  });
});

describe("recorder rotation — keep cap", () => {
  it("with keep=2, only .1 and .2 survive (no .3)", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => lineOfSize(i + 1, 400));
    await _writeWithRotationForTest({
      outPath: tracePath,
      lines,
      rotateBytes: 1024,
      keep: 2,
    });

    const files = listTraceFiles();
    expect(files).toContain("session.mcptrace");
    expect(files).toContain("session.mcptrace.1");
    expect(files).toContain("session.mcptrace.2");
    // The cap means .3 must never accumulate, even after many rotations.
    expect(files).not.toContain("session.mcptrace.3");
    expect(files).not.toContain("session.mcptrace.4");
  });
});

describe("recorder rotation — disabled", () => {
  it("without rotateBytes, no rotation files appear no matter how much we write", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => lineOfSize(i + 1, 400));
    await _writeWithRotationForTest({
      outPath: tracePath,
      lines,
      // rotateBytes intentionally omitted.
      keep: 3,
    });

    const files = listTraceFiles();
    expect(files).toEqual(["session.mcptrace"]);
  });
});

describe("recorder rotation — content integrity", () => {
  it("no frame is lost across a small number of rotations (keep large enough)", async () => {
    // Pick a small batch where the keep cap (50) easily exceeds the rotations
    // we trigger; every frame should round-trip through some archive.
    const total = 20;
    const lines = Array.from({ length: total }, (_, i) => lineOfSize(i + 1, 400));
    await _writeWithRotationForTest({
      outPath: tracePath,
      lines,
      rotateBytes: 1024,
      keep: 50,
    });

    const files = listTraceFiles();
    const ids = new Set<number>();
    for (const name of files) {
      const text = readTraceText(join(workDir, name));
      for (const l of text.split("\n").filter(Boolean)) {
        ids.add((JSON.parse(l) as { id: number }).id);
      }
    }
    expect(ids.size).toBe(total);
    expect([...ids].sort((a, b) => a - b)[0]).toBe(1);
    expect([...ids].sort((a, b) => a - b)[total - 1]).toBe(total);
  });

  it("respects keep cap: frames in oldest archives are intentionally discarded", async () => {
    // With keep=3 and many rotations, only the last 3 archives + active should
    // survive — older frames are *expected* to be gone. This documents the
    // unix-logrotate behavior the user opted into via `--keep`.
    const total = 200;
    const lines = Array.from({ length: total }, (_, i) => lineOfSize(i + 1, 400));
    await _writeWithRotationForTest({
      outPath: tracePath,
      lines,
      rotateBytes: 1024,
      keep: 3,
    });

    const files = listTraceFiles();
    // Active + at most 3 numbered archives. Anything beyond would mean the
    // delete-past-keep step regressed.
    expect(files.length).toBeLessThanOrEqual(4);
  });
});
