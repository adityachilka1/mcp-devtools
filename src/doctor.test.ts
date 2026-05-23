import { describe, expect, it } from "vitest";
import { type CheckResult, formatResultsJson, printResults, printResultsJson } from "./doctor.js";

const allPass: CheckResult[] = [
  { name: "initialize responds", passed: true },
  { name: "initialize.result has protocolVersion", passed: true },
  { name: "tools/list responds with tools array", passed: true, detail: "3 tools" },
];

const mixed: CheckResult[] = [
  { name: "initialize responds", passed: true },
  { name: "initialize.result has protocolVersion", passed: false, detail: "missing or non-string" },
  { name: "tools/list responds with tools array", passed: true, detail: "2 tools" },
  {
    name: "unknown method returns JSON-RPC error envelope",
    passed: false,
    detail: "server returned a result for an unknown method (should be error)",
  },
];

const allFail: CheckResult[] = [
  {
    name: "initialize responds",
    passed: false,
    detail: "no response within 5000ms",
  },
  {
    name: "tools/list responds with tools array",
    passed: false,
    detail: "missing or non-array tools field",
  },
];

describe("formatResultsJson", () => {
  it("emits the canonical shape on the all-pass case", () => {
    const report = formatResultsJson(allPass, {
      version: "0.1.0",
      upstream: "node ./server.js",
    });
    expect(report).toEqual({
      version: "0.1.0",
      upstream: "node ./server.js",
      summary: { passed: 3, failed: 0, total: 3 },
      checks: [
        { name: "initialize responds", passed: true },
        { name: "initialize.result has protocolVersion", passed: true },
        { name: "tools/list responds with tools array", passed: true, message: "3 tools" },
      ],
    });
  });

  it("reports a mixed pass/fail breakdown and forwards detail as message", () => {
    const report = formatResultsJson(mixed, {
      version: "9.9.9",
      upstream: "node ./broken.js",
    });
    expect(report.summary).toEqual({ passed: 2, failed: 2, total: 4 });
    // detail → message rename is the externally-stable contract.
    expect(report.checks[1]).toEqual({
      name: "initialize.result has protocolVersion",
      passed: false,
      message: "missing or non-string",
    });
    // version + upstream are echoed verbatim.
    expect(report.version).toBe("9.9.9");
    expect(report.upstream).toBe("node ./broken.js");
  });

  it("emits an all-fail report when nothing passes", () => {
    const report = formatResultsJson(allFail, {
      version: "0.1.0",
      upstream: "node ./dead.js",
    });
    expect(report.summary).toEqual({ passed: 0, failed: 2, total: 2 });
    expect(report.checks.every((c) => c.passed === false)).toBe(true);
    // Every failed check carries a message in this fixture, so all should
    // round-trip.
    expect(report.checks[0].message).toBe("no response within 5000ms");
  });

  it("omits the message field entirely when detail is absent", () => {
    const report = formatResultsJson([{ name: "x", passed: true }], {
      version: "0.1.0",
      upstream: "cmd",
    });
    // Important — we want a clean envelope with no `message: undefined`
    // littering it. JSON consumers should see the field absent.
    expect(Object.hasOwn(report.checks[0], "message")).toBe(false);
  });

  it("handles an empty check list deterministically", () => {
    const report = formatResultsJson([], { version: "0.1.0", upstream: "cmd" });
    expect(report.summary).toEqual({ passed: 0, failed: 0, total: 0 });
    expect(report.checks).toEqual([]);
  });
});

/**
 * Vitest's pool wraps `process.stdout.write` for its own output capture, so
 * `vi.spyOn(process.stdout, "write")` is a no-op. Patch only the stdout
 * stream's own `write` method (not the shared prototype, which would also
 * capture stderr/log.info writes) and restore after.
 */
function captureStdout<T>(fn: () => T): { result: T; writes: string[] } {
  const writes: string[] = [];
  const stream = process.stdout as unknown as { write: (...a: unknown[]) => boolean };
  const original = stream.write;
  stream.write = function patched(chunk: unknown) {
    writes.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  } as typeof stream.write;
  try {
    return { result: fn(), writes };
  } finally {
    stream.write = original;
  }
}

describe("printResultsJson", () => {
  it("writes a single line of valid JSON to stdout", () => {
    const { writes } = captureStdout(() =>
      printResultsJson(mixed, { version: "0.1.0", upstream: "node ./broken.js" }),
    );
    expect(writes).toHaveLength(1);
    const payload = writes[0] ?? "";
    expect(payload.endsWith("\n")).toBe(true);
    // Must parse cleanly — this is the CI consumer's contract.
    const parsed = JSON.parse(payload);
    expect(parsed.summary).toEqual({ passed: 2, failed: 2, total: 4 });
    expect(parsed.checks).toHaveLength(4);
    // Single-line — no embedded newlines outside the trailing one.
    expect(payload.slice(0, -1).includes("\n")).toBe(false);
  });
});

describe("printResults (regression guard for human-readable mode)", () => {
  it("still writes per-check lines and a summary line — JSON mode must not perturb this", () => {
    const { writes } = captureStdout(() => printResults(mixed));
    // 4 per-check lines + blank line + summary line + trailing newline = 6 writes.
    expect(writes.length).toBeGreaterThanOrEqual(6);
    // Per-check lines should include the check names verbatim (modulo color
    // escapes).
    expect(writes.some((l) => l.includes("initialize responds"))).toBe(true);
    expect(writes.some((l) => l.includes("2/4 checks passed"))).toBe(true);
    // No JSON-looking opener leaked into the human-readable path.
    expect(writes.some((l) => l.trimStart().startsWith("{"))).toBe(false);
  });
});
