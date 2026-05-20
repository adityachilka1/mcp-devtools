/**
 * Minimal JSON-RPC 2.0 frame parser for MCP's newline-delimited stdio transport.
 *
 * MCP servers speak newline-delimited JSON over stdio (the official spec). We
 * read incoming bytes into a buffer and emit one parsed frame per line. We
 * deliberately do NOT validate the JSON-RPC structure — the upstream server
 * already does that, and we don't want the proxy to choke on a server bug.
 */

export type JsonRpcFrame =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification
  | { _raw: string; _parseError: string };

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

let pending = "";

export function parseFrames(chunk: Buffer): JsonRpcFrame[] {
  pending += chunk.toString("utf8");
  const frames: JsonRpcFrame[] = [];
  let nl = pending.indexOf("\n");
  while (nl !== -1) {
    const line = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    if (line) {
      try {
        frames.push(JSON.parse(line));
      } catch (err) {
        frames.push({ _raw: line, _parseError: (err as Error).message });
      }
    }
    nl = pending.indexOf("\n");
  }
  return frames;
}

/** Helper used by the UI to classify a frame for display. */
export function classify(
  f: JsonRpcFrame,
):
  | { kind: "request"; method: string; id: number | string }
  | { kind: "response"; id: number | string; isError: boolean }
  | { kind: "notification"; method: string }
  | { kind: "malformed" } {
  if ("_parseError" in f) return { kind: "malformed" };
  if ("id" in f && "method" in f) {
    return { kind: "request", method: f.method, id: f.id };
  }
  if ("id" in f) {
    return { kind: "response", id: f.id, isError: "error" in f };
  }
  if ("method" in f) return { kind: "notification", method: f.method };
  return { kind: "malformed" };
}
