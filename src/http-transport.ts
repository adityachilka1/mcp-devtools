/**
 * Streamable HTTP transport for the MCP proxy.
 *
 * The user-facing side stays stdio (the agent / Claude Desktop / Cursor talks
 * to mcp-devtools over stdin/stdout as usual). Upstream is HTTP + SSE per the
 * MCP spec — the proxy forwards each JSON-RPC frame as an HTTP POST and
 * relays the response back to stdout, regardless of whether the server
 * returns a single `application/json` payload or an SSE stream.
 *
 * Session lifecycle (per spec):
 *   1. The first `initialize` request omits the session header.
 *   2. The server's response includes an `Mcp-Session-Id` header — we capture
 *      it and replay it on every subsequent request.
 *   3. Notifications (frames without an `id`) expect HTTP 202 with no body.
 *
 * What we deliberately leave for a follow-up:
 *   - The long-lived GET SSE channel (server-initiated messages outside any
 *     request). Not all servers implement it, and the issue's acceptance
 *     bar only requires the request/response path.
 *   - DELETE-based session termination on shutdown.
 */

import type { JsonRpcFrame } from "./jsonrpc.js";

/**
 * Minimal "shape" of the global fetch we need. Pinned so the unit tests can
 * inject a mock without dragging the whole DOM lib into our types.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<HttpResponseLike>;

export interface HttpResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | null;
}

export interface HttpTransportOptions {
  /** Upstream URL — e.g. `https://example.com/mcp`. */
  url: string;
  /** Extra request headers (e.g. `Authorization: Bearer ...`). */
  extraHeaders?: Record<string, string>;
  /** Inject a custom fetch for testing. Defaults to the global. */
  fetchImpl?: FetchLike;
}

export interface FrameSink {
  /** Called once for every incoming frame from the upstream. */
  onIncoming(frame: JsonRpcFrame): void;
}

/**
 * Client-side handle. Call `sendOutbound(frame)` for each parsed stdin frame;
 * the transport will POST it, read the response (JSON or SSE), and forward
 * every server-side frame via `sink.onIncoming(...)`.
 */
export class HttpTransport {
  private readonly url: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private sessionId: string | null = null;

  constructor(opts: HttpTransportOptions) {
    this.url = opts.url;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!this.fetchImpl) {
      throw new Error("HttpTransport: global fetch not available (need Node 20+)");
    }
  }

  /** Exposed for tests. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  async sendOutbound(frame: JsonRpcFrame, sink: FrameSink): Promise<void> {
    const isNotification = !("id" in frame) || (frame as { id?: unknown }).id == null;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.extraHeaders,
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(frame),
    });

    // Capture server-issued session id on the first successful response.
    const issued = res.headers.get("mcp-session-id");
    if (issued && !this.sessionId) {
      this.sessionId = issued;
    }

    if (isNotification) {
      // Spec: notifications return 202 Accepted with no body. We don't
      // throw on non-202 — some implementations return 200 — but we also
      // don't try to parse anything.
      return;
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from upstream MCP server`);
    }

    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("text/event-stream")) {
      await consumeSseStream(res, (data) => emitJsonFromSseData(data, sink));
      return;
    }
    // Plain JSON response.
    const text = await res.text();
    if (text.trim() === "") return;
    emitJsonFromSseData(text, sink);
  }
}

/**
 * Drain an SSE stream, calling `onData` for every complete `data:` block.
 * We ignore `event:` / `id:` / `retry:` fields — MCP carries the payload
 * exclusively in `data:` lines, and the JSON-RPC envelope makes message
 * type clear without needing the SSE event name.
 */
async function consumeSseStream(
  res: HttpResponseLike,
  onData: (data: string) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Events end at a blank line — \n\n or \r\n\r\n.
    let sepIdx = findEventSeparator(buffer);
    while (sepIdx !== -1) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      const data = collectDataLines(rawEvent);
      if (data) onData(data);
      sepIdx = findEventSeparator(buffer);
    }
  }
  // Final buffered event (servers that don't send the trailing blank line).
  const data = collectDataLines(buffer);
  if (data) onData(data);
}

function findEventSeparator(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function collectDataLines(event: string): string {
  const parts: string[] = [];
  for (const line of event.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      // SSE allows a single space after the colon — strip it.
      parts.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return parts.join("\n");
}

/**
 * Parse one or more JSON frames out of a `data:` payload and forward each
 * to the sink. MCP servers may batch responses inside a single SSE event
 * by sending a JSON array — we handle both shapes.
 */
function emitJsonFromSseData(data: string, sink: FrameSink): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    sink.onIncoming({ _raw: data, _parseError: (err as Error).message });
    return;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      sink.onIncoming(item as JsonRpcFrame);
    }
    return;
  }
  sink.onIncoming(parsed as JsonRpcFrame);
}
