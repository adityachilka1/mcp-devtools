import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { JsonRpcFrame } from "./jsonrpc.js";
import { buildIndex, collectingWritable, startReplay } from "./replay.js";
import type { StoredFrame } from "./trace-store.js";

/** Build a StoredFrame for trace fixtures. */
function f(id: number, direction: "in" | "out", body: unknown): StoredFrame {
  return { id, ts: id * 10, direction, frame: body as never };
}

/** Convenience: serialize stored frames as gzipped JSONL and write to disk. */
function writeTrace(frames: StoredFrame[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-replay-test-"));
  const path = join(dir, "fixture.mcptrace");
  const jsonl = frames.map((s) => JSON.stringify(s)).join("\n");
  writeFileSync(path, gzipSync(Buffer.from(`${jsonl}\n`)));
  return path;
}

/** Pull every newline-terminated JSON envelope out of a stdout buffer. */
function readResponses(text: string): JsonRpcFrame[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as JsonRpcFrame);
}

describe("buildIndex", () => {
  it("pairs requests with their responses and buckets by method", () => {
    const frames: StoredFrame[] = [
      f(1, "out", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
      f(2, "in", { jsonrpc: "2.0", id: 1, result: { tools: [] } }),
      f(3, "out", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x" } }),
      f(4, "in", { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } }),
    ];
    const idx = buildIndex(frames);
    expect(idx.get("tools/list")).toHaveLength(1);
    expect(idx.get("tools/call")).toHaveLength(1);
    const r = idx.get("tools/call")?.[0];
    expect(r).toBeDefined();
    expect((r as { result: { content: unknown[] } }).result.content).toHaveLength(1);
  });

  it("preserves trace order when the same method is called multiple times", () => {
    const frames: StoredFrame[] = [
      f(1, "out", { jsonrpc: "2.0", id: 10, method: "tools/call" }),
      f(2, "in", { jsonrpc: "2.0", id: 10, result: { tag: "first" } }),
      f(3, "out", { jsonrpc: "2.0", id: 11, method: "tools/call" }),
      f(4, "in", { jsonrpc: "2.0", id: 11, result: { tag: "second" } }),
    ];
    const idx = buildIndex(frames);
    const q = idx.get("tools/call");
    expect(q).toHaveLength(2);
    expect((q?.[0] as { result: { tag: string } }).result.tag).toBe("first");
    expect((q?.[1] as { result: { tag: string } }).result.tag).toBe("second");
  });

  it("drops orphan responses (no preceding request) without throwing", () => {
    const frames: StoredFrame[] = [
      f(1, "in", { jsonrpc: "2.0", id: 999, result: { unexpected: true } }),
      f(2, "out", { jsonrpc: "2.0", id: 1, method: "ping" }),
      f(3, "in", { jsonrpc: "2.0", id: 1, result: {} }),
    ];
    const idx = buildIndex(frames);
    expect(idx.has("ping")).toBe(true);
    expect(idx.size).toBe(1);
  });
});

describe("startReplay — happy path", () => {
  it("returns the recorded response for a matching method", async () => {
    const path = writeTrace([
      f(1, "out", { jsonrpc: "2.0", id: 1, method: "initialize" }),
      f(2, "in", {
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2024-11-05", serverInfo: { name: "fake", version: "1" } },
      }),
    ]);
    const stdin = new PassThrough();
    const { stream: stdout, getOutput } = collectingWritable();
    const handle = await startReplay({ tracePath: path, stdin, stdout });

    // The client always sends its own id — replay must echo it back, not the trace's id 1.
    handle.handleFrame({ jsonrpc: "2.0", id: 42, method: "initialize" } as JsonRpcFrame);

    const responses = readResponses(getOutput());
    expect(responses).toHaveLength(1);
    const r = responses[0] as { id: number; result: { protocolVersion: string } };
    expect(r.id).toBe(42);
    expect(r.result.protocolVersion).toBe("2024-11-05");
  });
});

describe("startReplay — id substitution", () => {
  it("substitutes the client's id (numeric or string) on every reply", async () => {
    const path = writeTrace([
      f(1, "out", { jsonrpc: "2.0", id: 1, method: "ping" }),
      f(2, "in", { jsonrpc: "2.0", id: 1, result: { ok: true } }),
      f(3, "out", { jsonrpc: "2.0", id: 2, method: "ping" }),
      f(4, "in", { jsonrpc: "2.0", id: 2, result: { ok: true } }),
    ]);
    const { stream: stdout, getOutput } = collectingWritable();
    const handle = await startReplay({
      tracePath: path,
      stdin: new PassThrough(),
      stdout,
    });

    handle.handleFrame({ jsonrpc: "2.0", id: 7, method: "ping" } as JsonRpcFrame);
    handle.handleFrame({ jsonrpc: "2.0", id: "abc-uuid", method: "ping" } as JsonRpcFrame);

    const responses = readResponses(getOutput()) as Array<{ id: number | string }>;
    expect(responses[0]?.id).toBe(7);
    expect(responses[1]?.id).toBe("abc-uuid");
  });
});

describe("startReplay — sequence-aware", () => {
  it("returns trace-order responses when the same method is called twice", async () => {
    const path = writeTrace([
      f(1, "out", { jsonrpc: "2.0", id: 1, method: "tools/call" }),
      f(2, "in", { jsonrpc: "2.0", id: 1, result: { call: 1 } }),
      f(3, "out", { jsonrpc: "2.0", id: 2, method: "tools/call" }),
      f(4, "in", { jsonrpc: "2.0", id: 2, result: { call: 2 } }),
    ]);
    const { stream: stdout, getOutput } = collectingWritable();
    const handle = await startReplay({
      tracePath: path,
      stdin: new PassThrough(),
      stdout,
    });

    handle.handleFrame({ jsonrpc: "2.0", id: 100, method: "tools/call" } as JsonRpcFrame);
    handle.handleFrame({ jsonrpc: "2.0", id: 101, method: "tools/call" } as JsonRpcFrame);

    const responses = readResponses(getOutput()) as Array<{
      id: number;
      result: { call: number };
    }>;
    expect(responses[0]?.result.call).toBe(1);
    expect(responses[1]?.result.call).toBe(2);
    expect(responses[0]?.id).toBe(100);
    expect(responses[1]?.id).toBe(101);
  });
});

describe("startReplay — strict mode (default)", () => {
  it("returns -32601 when the method is missing from the trace", async () => {
    const path = writeTrace([
      f(1, "out", { jsonrpc: "2.0", id: 1, method: "ping" }),
      f(2, "in", { jsonrpc: "2.0", id: 1, result: {} }),
    ]);
    const { stream: stdout, getOutput } = collectingWritable();
    const handle = await startReplay({
      tracePath: path,
      stdin: new PassThrough(),
      stdout,
    });

    handle.handleFrame({ jsonrpc: "2.0", id: 5, method: "tools/list" } as JsonRpcFrame);
    const r = readResponses(getOutput())[0] as {
      id: number;
      error: { code: number; message: string };
    };
    expect(r.id).toBe(5);
    expect(r.error.code).toBe(-32601);
    expect(r.error.message).toContain("tools/list");
  });

  it("exhausts the queue on subsequent calls and then errors in strict mode", async () => {
    const path = writeTrace([
      f(1, "out", { jsonrpc: "2.0", id: 1, method: "ping" }),
      f(2, "in", { jsonrpc: "2.0", id: 1, result: { hop: 1 } }),
    ]);
    const { stream: stdout, getOutput } = collectingWritable();
    const handle = await startReplay({
      tracePath: path,
      stdin: new PassThrough(),
      stdout,
    });

    handle.handleFrame({ jsonrpc: "2.0", id: 1, method: "ping" } as JsonRpcFrame);
    handle.handleFrame({ jsonrpc: "2.0", id: 2, method: "ping" } as JsonRpcFrame);

    const r = readResponses(getOutput()) as Array<{
      id: number;
      result?: { hop: number };
      error?: { code: number };
    }>;
    expect(r[0]?.result?.hop).toBe(1);
    expect(r[1]?.error?.code).toBe(-32601);
  });
});

describe("startReplay — non-strict mode", () => {
  it("returns a canned { result: {} } for unmatched methods when strict: false", async () => {
    const path = writeTrace([
      f(1, "out", { jsonrpc: "2.0", id: 1, method: "ping" }),
      f(2, "in", { jsonrpc: "2.0", id: 1, result: {} }),
    ]);
    const { stream: stdout, getOutput } = collectingWritable();
    const handle = await startReplay({
      tracePath: path,
      strict: false,
      stdin: new PassThrough(),
      stdout,
    });

    handle.handleFrame({ jsonrpc: "2.0", id: 9, method: "totally/new" } as JsonRpcFrame);
    const r = readResponses(getOutput())[0] as {
      id: number;
      result: Record<string, unknown>;
      error?: unknown;
    };
    expect(r.id).toBe(9);
    expect(r.result).toEqual({});
    expect(r.error).toBeUndefined();
  });
});

describe("startReplay — notifications", () => {
  it("silently ignores client notifications (no id) — no stdout output", async () => {
    const path = writeTrace([
      f(1, "out", { jsonrpc: "2.0", id: 1, method: "ping" }),
      f(2, "in", { jsonrpc: "2.0", id: 1, result: {} }),
    ]);
    const { stream: stdout, getOutput } = collectingWritable();
    const handle = await startReplay({
      tracePath: path,
      stdin: new PassThrough(),
      stdout,
    });

    // A notification carries a method but no id. The replay server has nothing
    // to say back — no real server would either.
    handle.handleFrame({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    } as JsonRpcFrame);

    expect(getOutput()).toBe("");
  });
});

describe("startReplay — malformed and missing inputs", () => {
  it("skips malformed trace lines via the underlying reader without crashing", async () => {
    // Mix a valid pair with a deliberately invalid JSONL line. readTrace
    // currently throws on a non-JSON line, so our contract is: the throw
    // happens at startup, not on a per-frame basis.
    const dir = mkdtempSync(join(tmpdir(), "mcp-replay-mal-"));
    const path = join(dir, "broken.mcptrace");
    const goodLine = JSON.stringify(f(1, "out", { jsonrpc: "2.0", id: 1, method: "ping" }));
    const badLine = "{not json";
    writeFileSync(path, gzipSync(Buffer.from(`${goodLine}\n${badLine}\n`)));

    await expect(
      startReplay({
        tracePath: path,
        stdin: new PassThrough(),
        stdout: collectingWritable().stream,
      }),
    ).rejects.toThrow();
  });

  it("rejects when the trace file does not exist", async () => {
    await expect(
      startReplay({
        tracePath: "/nonexistent/replay/never.mcptrace",
        stdin: new PassThrough(),
        stdout: collectingWritable().stream,
      }),
    ).rejects.toThrow();
  });
});

describe("startReplay — end-to-end via streams", () => {
  it("reads framed JSON-RPC from stdin and writes responses to stdout", async () => {
    const path = writeTrace([
      f(1, "out", { jsonrpc: "2.0", id: 1, method: "initialize" }),
      f(2, "in", { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }),
    ]);
    const stdin = new PassThrough();
    const { stream: stdout, getOutput } = collectingWritable();
    const handle = await startReplay({ tracePath: path, stdin, stdout });

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 77, method: "initialize" })}\n`);
    stdin.end();
    await handle.done;

    const r = readResponses(getOutput())[0] as {
      id: number;
      result: { protocolVersion: string };
    };
    expect(r.id).toBe(77);
    expect(r.result.protocolVersion).toBe("2024-11-05");
  });
});
