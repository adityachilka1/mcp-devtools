import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TailRecord } from "./tail.js";
import { createPrinter, formatRecord, formatTs, tailTrace } from "./tail.js";
import type { StoredFrame } from "./trace-store.js";

/** Build a stored frame fixture. */
function frame(id: number, direction: "in" | "out", body: unknown, ts = id * 1000): StoredFrame {
  return { id, ts, direction, frame: body as never };
}

/** Encode frames as a single-member gzipped JSONL blob. */
function encode(frames: StoredFrame[]): Buffer {
  const jsonl = `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`;
  return gzipSync(Buffer.from(jsonl));
}

/** Encode raw text (which may already contain newlines) as a gzip member. */
function encodeText(text: string): Buffer {
  return gzipSync(Buffer.from(text));
}

/** Wait for a predicate, polling every 10ms up to `timeoutMs`. */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Sleep helper. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let workDir: string;
let tracePath: string;

beforeEach(() => {
  // macOS /tmp resolves to /private/tmp; realpathSync canonicalises so that
  // fs.watch's reported paths match what we pass in. Without this, watcher
  // teardown can race against the symlink resolution and leak listeners.
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-tail-test-")));
  tracePath = join(workDir, "session.mcptrace");
});

afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe("tailTrace — happy path (no follow)", () => {
  it("emits every record in a pre-existing trace and stops", async () => {
    const frames = [
      frame(1, "out", { jsonrpc: "2.0", id: 1, method: "initialize" }, 1_700_000_000_000),
      frame(2, "in", { jsonrpc: "2.0", id: 1, result: {} }, 1_700_000_000_005),
      frame(3, "out", { jsonrpc: "2.0", id: 2, method: "tools/list" }, 1_700_000_000_010),
    ];
    writeFileSync(tracePath, encode(frames));

    const out: TailRecord[] = [];
    const handle = await tailTrace({
      path: tracePath,
      onLine: (r) => out.push(r),
    });
    await handle.stop();

    expect(out).toHaveLength(3);
    expect((out[0] as StoredFrame).id).toBe(1);
    expect((out[2] as StoredFrame).frame).toMatchObject({ method: "tools/list" });
  });
});

describe("tailTrace — follow mode", () => {
  it("emits initial records, then new ones as the file grows", async () => {
    // Seed with two frames.
    const seed = [
      frame(1, "out", { jsonrpc: "2.0", id: 1, method: "initialize" }),
      frame(2, "in", { jsonrpc: "2.0", id: 1, result: {} }),
    ];
    writeFileSync(tracePath, encode(seed));

    const out: TailRecord[] = [];
    const handle = await tailTrace({
      path: tracePath,
      follow: true,
      onLine: (r) => out.push(r),
    });

    await waitFor(() => out.length >= 2);
    expect(out).toHaveLength(2);

    // macOS FSEvents-backed fs.watch needs a tick to subscribe after the
    // watcher is created. Without this grace pause the first append fires
    // before the kernel-side subscription is live and we silently lose it.
    await sleep(50);

    // Append a third frame as a fresh gzip member. createGunzip transparently
    // consumes concatenated members — same shape the recorder produces when
    // it flushes between writes.
    const more = [frame(3, "out", { jsonrpc: "2.0", id: 2, method: "tools/list" })];
    appendFileSync(tracePath, encode(more));

    await waitFor(() => out.length >= 3);
    expect((out[2] as StoredFrame).frame).toMatchObject({ method: "tools/list" });

    await handle.stop();
  });
});

describe("tailTrace — partial line handling", () => {
  it("buffers a partial JSON line until the terminating newline arrives", async () => {
    // First member: a complete frame plus the START of a second frame (no \n).
    const completeFrame = JSON.stringify(
      frame(1, "out", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    const partial = '{"id":2,"ts":2000,"direction":"in","frame":{"jsonrpc":"2.0","id":1,';
    writeFileSync(tracePath, encodeText(`${completeFrame}\n${partial}`));

    const out: TailRecord[] = [];
    const handle = await tailTrace({
      path: tracePath,
      follow: true,
      onLine: (r) => out.push(r),
    });

    await waitFor(() => out.length >= 1);
    expect(out).toHaveLength(1);
    await sleep(50); // see follow-mode test — macOS FSEvents subscribe delay.

    // Now append the REST of the second line plus newline. The partial bytes
    // should join up and parse cleanly — no parse error.
    const rest = '"result":{}}}\n';
    appendFileSync(tracePath, encodeText(rest));

    await waitFor(() => out.length >= 2);
    expect(out).toHaveLength(2);
    const second = out[1] as StoredFrame;
    expect("_parseError" in second).toBe(false);
    expect(second.id).toBe(2);

    await handle.stop();
  });
});

describe("tailTrace — since: end", () => {
  it("skips pre-existing content when since='end' and only emits later appends", async () => {
    const seed = [
      frame(1, "out", { jsonrpc: "2.0", id: 1, method: "initialize" }),
      frame(2, "in", { jsonrpc: "2.0", id: 1, result: {} }),
    ];
    writeFileSync(tracePath, encode(seed));

    const out: TailRecord[] = [];
    const handle = await tailTrace({
      path: tracePath,
      since: "end",
      follow: true,
      onLine: (r) => out.push(r),
    });

    // Tiny grace period so any (incorrect) initial emissions would have fired.
    await sleep(50);
    expect(out).toHaveLength(0);

    appendFileSync(tracePath, encode([frame(3, "out", { jsonrpc: "2.0", id: 2, method: "ping" })]));
    await waitFor(() => out.length >= 1);
    expect(out).toHaveLength(1);
    expect((out[0] as StoredFrame).id).toBe(3);

    await handle.stop();
  });
});

describe("tailTrace — malformed lines", () => {
  it("emits a _parseError record on a non-JSON line (no throw)", async () => {
    // Force a garbage line into the JSONL by gzipping raw text directly.
    const good = JSON.stringify(frame(1, "out", { jsonrpc: "2.0", id: 1, method: "x" }));
    writeFileSync(tracePath, encodeText(`${good}\nthis-is-not-json{\n`));

    const out: TailRecord[] = [];
    const handle = await tailTrace({
      path: tracePath,
      onLine: (r) => out.push(r),
    });
    await handle.stop();

    expect(out).toHaveLength(2);
    expect("_parseError" in out[1]!).toBe(true);
    expect((out[1] as { _raw: string })._raw).toBe("this-is-not-json{");
  });
});

describe("tailTrace — cleanup", () => {
  it("stop() closes the watcher and is idempotent", async () => {
    writeFileSync(tracePath, encode([frame(1, "out", { jsonrpc: "2.0", id: 1, method: "x" })]));

    const handle = await tailTrace({ path: tracePath, follow: true, onLine: () => {} });
    const before = process.listenerCount("uncaughtException");

    await handle.stop();
    // Calling stop again must not throw or double-close.
    await handle.stop();

    // No exception listener leak from watcher teardown.
    expect(process.listenerCount("uncaughtException")).toBe(before);

    // After stop, an append should NOT trigger any emission (we'd see it via
    // the watcher if it were still live, but we don't have an emit hook here;
    // the assertion above is the proxy for "watcher closed cleanly").
  });
});

describe("tailTrace — error paths", () => {
  it("rejects when the trace file does not exist", async () => {
    await expect(
      tailTrace({ path: join(workDir, "does-not-exist.mcptrace"), onLine: () => {} }),
    ).rejects.toThrow();
  });
});

describe("tailTrace — truncation/rotation", () => {
  it("reopens from byte 0 when the file shrinks below the current offset", async () => {
    const first = [
      frame(1, "out", { jsonrpc: "2.0", id: 1, method: "A" }),
      frame(2, "in", { jsonrpc: "2.0", id: 1, result: {} }),
    ];
    writeFileSync(tracePath, encode(first));

    const out: TailRecord[] = [];
    const handle = await tailTrace({
      path: tracePath,
      follow: true,
      onLine: (r) => out.push(r),
    });
    await waitFor(() => out.length >= 2);
    const seenBeforeRotate = out.length;
    await sleep(50); // see follow-mode test — macOS FSEvents subscribe delay.

    // Rotate: overwrite the file with a completely new, smaller trace. The
    // previous gzip state is invalid; tail must notice the shrink and start
    // fresh from byte 0.
    const second = [frame(10, "out", { jsonrpc: "2.0", id: 10, method: "B" })];
    writeFileSync(tracePath, encode(second));

    await waitFor(() => out.length > seenBeforeRotate);
    const last = out[out.length - 1] as StoredFrame;
    expect((last.frame as { method: string }).method).toBe("B");

    await handle.stop();
  });
});

describe("formatRecord / createPrinter", () => {
  it("formats timestamps as HH:MM:SS.SSS in local time", () => {
    // Pick a ts deterministic regardless of TZ: extract from the formatter
    // and check it has the right shape.
    const ts = formatTs(1_700_000_000_000);
    expect(ts).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it("stamps a latency hint on the response line when a request was seen", () => {
    const lines: string[] = [];
    const print = createPrinter((l) => lines.push(l));
    print(frame(1, "out", { jsonrpc: "2.0", id: 1, method: "tools/list" }, 1_000));
    print(frame(2, "in", { jsonrpc: "2.0", id: 1, result: {} }, 1_042));
    expect(lines).toHaveLength(2);
    // Strip ANSI for the assertion.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape pattern is exactly the control sequence we want to strip.
    const ansi = /\[[0-9;]*m/g;
    expect(lines[1]?.replace(ansi, "")).toContain("(42ms)");
  });

  it("formats a parse-error record with a red marker and no crash", () => {
    const rendered = formatRecord({ _raw: "x", _parseError: "Unexpected token x" });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape pattern is exactly the control sequence we want to strip.
    const plain = rendered.replace(/\[[0-9;]*m/g, "");
    expect(plain).toContain("parse error");
    expect(plain).toContain("Unexpected token x");
  });
});
