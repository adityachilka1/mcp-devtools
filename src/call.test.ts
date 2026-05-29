/**
 * Tests for `mcp-devtools call <tool>` — single-shot tool invocation.
 *
 * Strategy: most tests use the exported in-process driver `runCallOverStreams`
 * which takes a Readable/Writable pair plus an `onFrame` callback. We back it
 * with a tiny fake MCP server function that responds to `initialize` /
 * `tools/call` synchronously. That lets us cover happy path, tool errors,
 * timeouts, id mismatches without ever spawning a real process.
 *
 * The two integration-flavored tests (spawn-an-actual-node-child for stdio,
 * mock fetch for http) live at the bottom.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CallOptions, type CallResult, callTool, runCallOverStreams } from "./call.js";
import type { FetchLike, HttpResponseLike } from "./http-transport.js";
import type { JsonRpcFrame, JsonRpcRequest } from "./jsonrpc.js";

/**
 * Tiny fake server that reads NDJSON requests on `clientToServer` and writes
 * NDJSON responses to `serverToClient`. `respond` is a function the test
 * supplies — given a parsed request, it returns a JSON-RPC response (or null
 * to ignore, simulating a hang).
 */
function fakeServer(opts: {
  clientToServer: PassThrough;
  serverToClient: PassThrough;
  respond: (req: JsonRpcRequest) => object | null | undefined;
}) {
  let buf = "";
  opts.clientToServer.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        try {
          const parsed = JSON.parse(line) as JsonRpcRequest;
          // Notifications have no id — respond only to requests.
          const reply = opts.respond(parsed);
          if (reply) {
            opts.serverToClient.write(`${JSON.stringify(reply)}\n`);
          }
        } catch {
          // ignore parse errors in test
        }
      }
      nl = buf.indexOf("\n");
    }
  });
}

describe("runCallOverStreams — happy path (Test 1)", () => {
  it("sends initialize + initialized + tools/call and resolves with the result", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const seenMethods: string[] = [];
    fakeServer({
      clientToServer: c2s,
      serverToClient: s2c,
      respond: (req) => {
        seenMethods.push(req.method);
        if (req.method === "initialize") {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: { protocolVersion: "2025-03-26", serverInfo: {}, capabilities: {} },
          };
        }
        if (req.method === "tools/call") {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: { content: [{ type: "text", text: "hello" }] },
          };
        }
        return null;
      },
    });

    const result = await runCallOverStreams({
      toolName: "echo",
      args: { text: "hello" },
      stdin: s2c,
      stdout: c2s,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(result.toolName).toBe("echo");
    expect(result.result).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect(result.error).toBeUndefined();
    expect(seenMethods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });
});

describe("runCallOverStreams — tool error (Test 2)", () => {
  it("returns ok:false with the error envelope when the server returns an error", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    fakeServer({
      clientToServer: c2s,
      serverToClient: s2c,
      respond: (req) => {
        if (req.method === "initialize") {
          return { jsonrpc: "2.0", id: req.id, result: {} };
        }
        if (req.method === "tools/call") {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32602, message: "Invalid params" },
          };
        }
        return null;
      },
    });

    const result = await runCallOverStreams({
      toolName: "echo",
      args: { text: "x" },
      stdin: s2c,
      stdout: c2s,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(-32602);
    expect(result.error?.message).toBe("Invalid params");
    expect(result.result).toBeUndefined();
  });
});

describe("runCallOverStreams — timeout (Test 3)", () => {
  it("rejects with a timeout error when the server never responds to tools/call", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    fakeServer({
      clientToServer: c2s,
      serverToClient: s2c,
      respond: (req) => {
        if (req.method === "initialize") {
          return { jsonrpc: "2.0", id: req.id, result: {} };
        }
        // Hang on tools/call.
        return null;
      },
    });

    const result = await runCallOverStreams({
      toolName: "echo",
      stdin: s2c,
      stdout: c2s,
      timeoutMs: 150,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/timeout/i);
    expect(result.durationMs).toBeGreaterThanOrEqual(150);
  });
});

describe("runCallOverStreams — args omitted (Test 4)", () => {
  it("sends arguments: {} on tools/call when args is undefined", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const captured: JsonRpcRequest[] = [];
    fakeServer({
      clientToServer: c2s,
      serverToClient: s2c,
      respond: (req) => {
        captured.push(req);
        if (req.method === "initialize") {
          return { jsonrpc: "2.0", id: req.id, result: {} };
        }
        if (req.method === "tools/call") {
          return { jsonrpc: "2.0", id: req.id, result: { ok: true } };
        }
        return null;
      },
    });

    const result = await runCallOverStreams({
      toolName: "ping",
      stdin: s2c,
      stdout: c2s,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    const call = captured.find((c) => c.method === "tools/call");
    expect(call).toBeDefined();
    expect((call?.params as { name: string; arguments: unknown }).name).toBe("ping");
    expect((call?.params as { name: string; arguments: unknown }).arguments).toEqual({});
  });
});

describe("callTool — http transport (Test 5)", () => {
  it("POSTs initialize then tools/call to the URL with extra headers", async () => {
    function jsonRes(body: unknown): HttpResponseLike {
      return {
        status: 200,
        ok: true,
        headers: {
          get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null),
        },
        text: async () => JSON.stringify(body),
        body: null,
      };
    }
    function accepted(): HttpResponseLike {
      return {
        status: 202,
        ok: true,
        headers: { get: () => null },
        text: async () => "",
        body: null,
      };
    }
    const fetchMock = vi.fn() satisfies FetchLike;
    fetchMock
      // initialize
      .mockResolvedValueOnce(jsonRes({ jsonrpc: "2.0", id: 1, result: {} }))
      // notifications/initialized → 202
      .mockResolvedValueOnce(accepted())
      // tools/call
      .mockResolvedValueOnce(jsonRes({ jsonrpc: "2.0", id: 2, result: { content: "ok" } }));

    const result = await callTool({
      upstream: "https://example.com/mcp",
      transport: "http",
      toolName: "echo",
      args: { text: "hi" },
      headers: { authorization: "Bearer secret" },
      timeoutMs: 2000,
      // @ts-expect-error — fetchImpl is an internal-test hook on the http path
      fetchImpl: fetchMock,
    } as CallOptions & { fetchImpl: FetchLike });

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ content: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // All requests should carry the auth header.
    for (const call of fetchMock.mock.calls) {
      const init = call[1];
      expect(init?.method).toBe("POST");
      expect(init?.headers?.authorization).toBe("Bearer secret");
    }
    // The third request must be tools/call with the right body.
    const body = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(body.method).toBe("tools/call");
    expect(body.params).toEqual({ name: "echo", arguments: { text: "hi" } });
  });
});

describe("runCallOverStreams — durationMs (Test 6)", () => {
  it("reports a positive (or zero) durationMs", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    fakeServer({
      clientToServer: c2s,
      serverToClient: s2c,
      respond: (req) => {
        if (req.method === "initialize") {
          return { jsonrpc: "2.0", id: req.id, result: {} };
        }
        if (req.method === "tools/call") {
          return { jsonrpc: "2.0", id: req.id, result: {} };
        }
        return null;
      },
    });

    const result = await runCallOverStreams({
      toolName: "ping",
      stdin: s2c,
      stdout: c2s,
      timeoutMs: 2000,
    });

    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.durationMs)).toBe(true);
  });
});

describe("callTool — invalid upstream (Test 7)", () => {
  it("rejects with a clear error when upstream is empty (stdio)", async () => {
    const result = await callTool({
      upstream: "",
      toolName: "x",
      timeoutMs: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/upstream/i);
  });

  it("rejects with a clear error when upstream is whitespace-only (stdio)", async () => {
    const result = await callTool({
      upstream: "   ",
      toolName: "x",
      timeoutMs: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/upstream/i);
  });

  it("rejects with a clear error when http transport gets a non-URL upstream", async () => {
    const result = await callTool({
      upstream: "node ./server.js", // not a URL
      transport: "http",
      toolName: "x",
      timeoutMs: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/url/i);
  });
});

describe("runCallOverStreams — id mismatch (Test 8)", () => {
  it("ignores responses with a non-matching id and times out instead", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    fakeServer({
      clientToServer: c2s,
      serverToClient: s2c,
      respond: (req) => {
        if (req.method === "initialize") {
          return { jsonrpc: "2.0", id: req.id, result: {} };
        }
        if (req.method === "tools/call") {
          // Return a response with a DIFFERENT id — should NOT be accepted.
          return { jsonrpc: "2.0", id: 9999, result: { wrong: true } };
        }
        return null;
      },
    });

    const result = await runCallOverStreams({
      toolName: "echo",
      stdin: s2c,
      stdout: c2s,
      timeoutMs: 150,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/timeout/i);
    // Critical: we must NOT have accepted the wrong-id response.
    expect((result.result as { wrong?: boolean } | undefined)?.wrong).toBeUndefined();
  });
});

describe("runCallOverStreams — frame parsing edge cases (Test 9)", () => {
  it("handles a response split across two chunks", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    let initId: number | string | undefined;
    let callId: number | string | undefined;
    c2s.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line) as JsonRpcRequest;
          if (req.method === "initialize") {
            initId = req.id;
            s2c.write(`${JSON.stringify({ jsonrpc: "2.0", id: initId, result: {} })}\n`);
          } else if (req.method === "tools/call") {
            callId = req.id;
            const full = `${JSON.stringify({ jsonrpc: "2.0", id: callId, result: { hi: 1 } })}\n`;
            // Split the response across two writes.
            s2c.write(full.slice(0, 5));
            setTimeout(() => s2c.write(full.slice(5)), 10);
          }
        } catch {
          /* ignore */
        }
      }
    });

    const result = await runCallOverStreams({
      toolName: "echo",
      stdin: s2c,
      stdout: c2s,
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ hi: 1 });
  });
});

describe("runCallOverStreams — default timeout (Test 10)", () => {
  it("uses 10_000ms when timeoutMs is omitted", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    fakeServer({
      clientToServer: c2s,
      serverToClient: s2c,
      respond: (req) => {
        if (req.method === "initialize") {
          return { jsonrpc: "2.0", id: req.id, result: {} };
        }
        if (req.method === "tools/call") {
          return { jsonrpc: "2.0", id: req.id, result: { ok: true } };
        }
        return null;
      },
    });

    // No timeoutMs passed. Server replies fast so we should resolve well
    // before 10s — this just covers the "no timeout option" code path.
    const result = await runCallOverStreams({
      toolName: "ping",
      stdin: s2c,
      stdout: c2s,
    });
    expect(result.ok).toBe(true);
  });
});

// ── Stdio spawn integration test ─────────────────────────────────────────────

describe("callTool — stdio spawn (integration)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-call-test-")));
  });
  afterEach(() => {
    // /tmp test fixtures cleaned by OS — no need to rm.
  });

  it("spawns a node fake server and calls echo", async () => {
    const serverPath = join(tmpDir, "fake-server.js");
    writeFileSync(
      serverPath,
      `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      try {
        const req = JSON.parse(line);
        if (req.method === "initialize") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: req.id,
            result: { protocolVersion: "2025-03-26", serverInfo: {}, capabilities: {} }
          }) + "\\n");
        } else if (req.method === "tools/call") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: req.id,
            result: { content: req.params.arguments.text }
          }) + "\\n");
        }
      } catch (e) {}
    }
    nl = buf.indexOf("\\n");
  }
});
`,
    );

    const result = await callTool({
      upstream: `node ${serverPath}`,
      toolName: "echo",
      args: { text: "hi-from-spawn" },
      timeoutMs: 3000,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ content: "hi-from-spawn" });
  });

  it("returns ok:false with a clear error when the spawn command is not found", async () => {
    const result = await callTool({
      upstream: "/nonexistent-binary-zzzz-12345",
      toolName: "x",
      timeoutMs: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/spawn|ENOENT|not found/i);
  });
});

// Reference unused import so TS doesn't complain in strict mode.
void spawn;
