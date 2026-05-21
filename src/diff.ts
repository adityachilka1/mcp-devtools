/**
 * Compare two `.mcptrace` files at the JSON-RPC frame level.
 *
 * This is the wire-level cousin of agentbench's semantic `compareTraces`.
 * Where agentbench compares "did the agent take the same steps", this
 * compares "did the protocol go over the wire identically" — useful when
 * the same client + server + prompt should produce the same JSON-RPC
 * conversation deterministically and you want to catch regressions.
 *
 * v0.2 baseline: structural diff. Future v0.3 may add semantic diff
 * (ignoring volatile fields like timestamps).
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import type { StoredFrame } from "./trace-store.js";

export type FrameDifference =
  | { kind: "frame-count"; expected: number; actual: number }
  | { kind: "direction"; index: number; expected: "in" | "out"; actual: "in" | "out" }
  | {
      kind: "method";
      index: number;
      expected: string | undefined;
      actual: string | undefined;
    }
  | { kind: "is-error"; index: number; expected: boolean; actual: boolean }
  | { kind: "frame-body"; index: number; expectedJson: string; actualJson: string };

export interface DiffReport {
  identical: boolean;
  differences: FrameDifference[];
  baselineFrames: number;
  currentFrames: number;
}

/** Read every frame out of a gzipped JSONL .mcptrace file. */
export async function readTrace(path: string): Promise<StoredFrame[]> {
  const rl = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const frames: StoredFrame[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    frames.push(JSON.parse(line) as StoredFrame);
  }
  return frames;
}

/** Pull (method, id, isError) tuple out of a frame so we can compare structurally. */
function shape(frame: StoredFrame): {
  method: string | undefined;
  id: number | string | undefined;
  isError: boolean;
} {
  const f = frame.frame as Record<string, unknown>;
  return {
    method: typeof f.method === "string" ? f.method : undefined,
    id: typeof f.id === "number" || typeof f.id === "string" ? f.id : undefined,
    isError: "error" in f && f.error != null,
  };
}

export function diffFrames(baseline: StoredFrame[], current: StoredFrame[]): DiffReport {
  const diffs: FrameDifference[] = [];

  if (baseline.length !== current.length) {
    diffs.push({ kind: "frame-count", expected: baseline.length, actual: current.length });
  }

  const max = Math.max(baseline.length, current.length);
  for (let i = 0; i < max; i++) {
    const a = baseline[i];
    const b = current[i];
    if (!a || !b) continue; // already reported via frame-count

    if (a.direction !== b.direction) {
      diffs.push({
        kind: "direction",
        index: i,
        expected: a.direction,
        actual: b.direction,
      });
    }

    const sa = shape(a);
    const sb = shape(b);

    if (sa.method !== sb.method) {
      diffs.push({
        kind: "method",
        index: i,
        expected: sa.method,
        actual: sb.method,
      });
    }

    if (sa.isError !== sb.isError) {
      diffs.push({
        kind: "is-error",
        index: i,
        expected: sa.isError,
        actual: sb.isError,
      });
    }

    // Body diff is computed only when shape matches — saves noise.
    if (sa.method === sb.method && sa.isError === sb.isError) {
      const ja = JSON.stringify(a.frame);
      const jb = JSON.stringify(b.frame);
      if (ja !== jb) {
        diffs.push({
          kind: "frame-body",
          index: i,
          expectedJson: ja,
          actualJson: jb,
        });
      }
    }
  }

  return {
    identical: diffs.length === 0,
    differences: diffs,
    baselineFrames: baseline.length,
    currentFrames: current.length,
  };
}

export function formatDiffReport(report: DiffReport): string {
  if (report.identical) {
    return `traces are structurally identical (${report.baselineFrames} frames)`;
  }
  const lines: string[] = [
    `${report.differences.length} differences across ${report.baselineFrames} → ${report.currentFrames} frames:`,
  ];
  for (const d of report.differences) {
    switch (d.kind) {
      case "frame-count":
        lines.push(`  · frame count: expected ${d.expected}, got ${d.actual}`);
        break;
      case "direction":
        lines.push(`  · frame #${d.index} direction: expected ${d.expected}, got ${d.actual}`);
        break;
      case "method":
        lines.push(
          `  · frame #${d.index} method: expected ${d.expected ?? "<none>"}, got ${d.actual ?? "<none>"}`,
        );
        break;
      case "is-error":
        lines.push(`  · frame #${d.index} error-flag: expected ${d.expected}, got ${d.actual}`);
        break;
      case "frame-body":
        lines.push(`  · frame #${d.index} body differs`);
        break;
    }
  }
  return lines.join("\n");
}
