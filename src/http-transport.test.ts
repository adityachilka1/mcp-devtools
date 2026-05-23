import { describe, expect, it, vi } from "vitest";
import {
  type FetchLike,
  type FrameSink,
  type HttpResponseLike,
  HttpTransport,
} from "./http-transport.js";
import type { JsonRpcFrame } from "./jsonrpc.js";

function collectingSink(): { sink: FrameSink; frames: JsonRpcFrame[] } {
  const frames: JsonRpcFrame[] = [];
  return {
    sink: { onIncoming: (f) => frames.push(f) },
    frames,
  };
}

function jsonResponse(body: unknown, sessionId?: string): HttpResponseLike {
  const headerMap = new Map<string, string>([
    ["content-type", "application/json"],
    ...(sessionId ? ([["mcp-session-id", sessionId]] as [string, string][]) : []),
  ]);
  return {
    status: 200,
    ok: true,
    headers: { get: (n) => headerMap.get(n.toLowerCase()) ?? null },
    text: async () => JSON.stringify(body),
    body: null,
  };
}

function sseResponse(events: string[]): HttpResponseLike {
  const encoded = new TextEncoder().encode(`${events.join("\n\n")}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  const headerMap = new Map<string, string>([["content-type", "text/event-stream"]]);
  return {
    status: 200,
    ok: true,
    headers: { get: (n) => headerMap.get(n.toLowerCase()) ?? null },
    text: async () => "",
    body: stream,
  };
}

function accepted202(): HttpResponseLike {
  return {
    status: 202,
    ok: true,
    headers: { get: () => null },
    text: async () => "",
    body: null,
  };
}

describe("HttpTransport — request/response", () => {
  it("POSTs the outbound frame and emits the JSON response", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    ) satisfies FetchLike;
    const t = new HttpTransport({ url: "https://x/mcp", fetchImpl: fetchMock });
    const { sink, frames } = collectingSink();

    await t.sendOutbound({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, sink);

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(init?.headers?.["content-type"]).toBe("application/json");
    expect(init?.headers?.accept).toContain("text/event-stream");
    expect(frames).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  it("captures the Mcp-Session-Id on the first response and replays it after", async () => {
    const fetchMock = vi.fn() satisfies FetchLike;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, "abc-123"))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 2, result: {} }));

    const t = new HttpTransport({ url: "https://x/mcp", fetchImpl: fetchMock });
    const { sink } = collectingSink();

    await t.sendOutbound({ jsonrpc: "2.0", id: 1, method: "initialize" }, sink);
    expect(t.getSessionId()).toBe("abc-123");

    await t.sendOutbound({ jsonrpc: "2.0", id: 2, method: "tools/list" }, sink);
    const secondHeaders = fetchMock.mock.calls[1][1]?.headers ?? {};
    expect(secondHeaders["mcp-session-id"]).toBe("abc-123");
  });

  it("forwards extra headers (e.g. Authorization)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }),
    ) satisfies FetchLike;
    const t = new HttpTransport({
      url: "https://x/mcp",
      extraHeaders: { authorization: "Bearer secret" },
      fetchImpl: fetchMock,
    });
    await t.sendOutbound({ jsonrpc: "2.0", id: 1, method: "ping" }, collectingSink().sink);
    expect(fetchMock.mock.calls[0][1]?.headers?.authorization).toBe("Bearer secret");
  });

  it("throws on a non-2xx response for a request frame", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 500,
      ok: false,
      headers: { get: () => null },
      text: async () => "boom",
      body: null,
    })) satisfies FetchLike;
    const t = new HttpTransport({ url: "https://x/mcp", fetchImpl: fetchMock });
    await expect(
      t.sendOutbound({ jsonrpc: "2.0", id: 1, method: "ping" }, collectingSink().sink),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("HttpTransport — notifications", () => {
  it("accepts 202 for a notification and emits nothing", async () => {
    const fetchMock = vi.fn(async () => accepted202()) satisfies FetchLike;
    const t = new HttpTransport({ url: "https://x/mcp", fetchImpl: fetchMock });
    const { sink, frames } = collectingSink();
    await t.sendOutbound({ jsonrpc: "2.0", method: "notifications/initialized" }, sink);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(frames).toEqual([]);
  });
});

describe("HttpTransport — SSE response", () => {
  it("emits one frame per SSE data: event", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { p: 1 } })}`,
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}`,
      ]),
    ) satisfies FetchLike;

    const t = new HttpTransport({ url: "https://x/mcp", fetchImpl: fetchMock });
    const { sink, frames } = collectingSink();
    await t.sendOutbound({ jsonrpc: "2.0", id: 1, method: "tools/call" }, sink);

    expect(frames).toHaveLength(2);
    expect((frames[0] as any).method).toBe("notifications/progress");
    expect((frames[1] as any).id).toBe(1);
  });

  it("handles a multi-line data: payload (newlines are joined per spec)", async () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
    // Split the payload across two data: lines — SSE joins them with "\n".
    // To stay parseable, split on a comma (still valid JSON when rejoined).
    const split = payload.replace(",", "\ndata: ,");
    const fetchMock = vi.fn(async () =>
      sseResponse([`data: ${split.replace(/\ndata:/g, "\ndata:")}`]),
    ) satisfies FetchLike;
    const t = new HttpTransport({ url: "https://x/mcp", fetchImpl: fetchMock });
    const { sink, frames } = collectingSink();
    await t.sendOutbound({ jsonrpc: "2.0", id: 1, method: "x" }, sink);
    expect(frames).toHaveLength(1);
  });

  it("handles a JSON-array payload as multiple frames", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        `data: ${JSON.stringify([
          { jsonrpc: "2.0", id: 1, result: { a: 1 } },
          { jsonrpc: "2.0", id: 2, result: { b: 2 } },
        ])}`,
      ]),
    ) satisfies FetchLike;
    const t = new HttpTransport({ url: "https://x/mcp", fetchImpl: fetchMock });
    const { sink, frames } = collectingSink();
    await t.sendOutbound({ jsonrpc: "2.0", id: 1, method: "x" }, sink);
    expect(frames).toHaveLength(2);
  });

  it("surfaces a malformed SSE payload as a _parseError frame", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(["data: this is not json {"]),
    ) satisfies FetchLike;
    const t = new HttpTransport({ url: "https://x/mcp", fetchImpl: fetchMock });
    const { sink, frames } = collectingSink();
    await t.sendOutbound({ jsonrpc: "2.0", id: 1, method: "x" }, sink);
    expect(frames).toHaveLength(1);
    expect("_parseError" in frames[0]).toBe(true);
  });
});
