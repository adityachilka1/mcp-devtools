/**
 * Embed the inspector into your own MCP server.
 *
 * Two APIs:
 *
 *   `devtools.wrap(transport, { port })`
 *     The recommended modern API. Wrap a transport BEFORE you pass it to
 *     `server.connect(transport)`. Works with the official
 *     `@modelcontextprotocol/sdk` (StdioServerTransport, SSEServerTransport,
 *     StreamableHTTPServerTransport) and any structurally-compatible custom
 *     transport. No runtime dependency on the SDK.
 *
 *     ```ts
 *     import { devtools } from "mcp-devtools/embed";
 *     import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
 *
 *     const transport = await devtools.wrap(new StdioServerTransport(), { port: 7456 });
 *     await server.connect(transport);
 *     ```
 *
 *   `devtools.attach(server, { port })`
 *     Legacy probe-based API kept for v0.1.x backward compatibility. Looks
 *     for `server._transport` and wraps it if present. Prefer `wrap` for new
 *     code — `attach` is removed in v0.2.
 */
import { EventEmitter } from "node:events";
import { TraceStore } from "./trace-store.js";
import { startUiServer } from "./ui-server.js";
import { log } from "./util/log.js";

export interface EmbedOptions {
  /** UI server port. Defaults to 7456. */
  port?: number;
}

/**
 * Structural shape of an MCP server transport. Matches the public surface of
 * `@modelcontextprotocol/sdk`'s transports without taking a runtime
 * dependency on the SDK.
 */
export interface McpTransportLike {
  onMessage?: ((msg: unknown) => void) | undefined;
  send: (msg: unknown) => Promise<void> | void;
}

/** Per-port UI singleton so multiple wraps on the same port share one UI. */
const uiByPort = new Map<number, { store: TraceStore; events: EventEmitter }>();

async function ensureUi(port: number) {
  const cached = uiByPort.get(port);
  if (cached) return cached;
  const store = new TraceStore();
  const events = new EventEmitter();
  await startUiServer({ port, store, events });
  const state = { store, events };
  uiByPort.set(port, state);
  return state;
}

const WRAPPED_FLAG = Symbol.for("mcp-devtools.wrapped");

/**
 * Wrap an MCP transport so every frame it sends and receives is recorded by
 * the inspector. Returns the same transport object (mutated). Safe to call
 * BEFORE `server.connect(transport)` — the SDK Server's assignment of
 * `transport.onMessage` is intercepted by our setter and routed through the
 * recorder.
 */
async function wrap<T extends McpTransportLike>(transport: T, opts: EmbedOptions = {}): Promise<T> {
  const flagged = transport as T & { [WRAPPED_FLAG]?: true };
  if (flagged[WRAPPED_FLAG]) {
    log.warn("embed.wrap: transport already wrapped; skipping double-wrap");
    return transport;
  }

  const port = opts.port ?? 7456;
  const state = await ensureUi(port);

  // ── outgoing (server → client) — wrap send() ─────────────────────────────
  const originalSend = transport.send.bind(transport);
  transport.send = ((msg: unknown) => {
    const id = state.store.record({ direction: "in", frame: msg as never });
    state.events.emit("frame", id);
    return originalSend(msg);
  }) as T["send"];

  // ── incoming (client → server) — intercept onMessage assignment ──────────
  // The SDK Server assigns `transport.onMessage = handler` inside its
  // `connect(transport)` call. We replace the property with a getter that
  // returns a wrapped handler, so the transport's underlying read loop
  // (calling `this.onMessage(msg)`) goes through our recording side-effect
  // before reaching the user's handler.
  let userHandler: ((msg: unknown) => void) | undefined = transport.onMessage;
  Object.defineProperty(transport, "onMessage", {
    configurable: true,
    enumerable: true,
    get() {
      if (!userHandler) return undefined;
      return (msg: unknown) => {
        const id = state.store.record({ direction: "out", frame: msg as never });
        state.events.emit("frame", id);
        return userHandler!(msg);
      };
    },
    set(handler: ((msg: unknown) => void) | undefined) {
      userHandler = handler;
    },
  });

  Object.defineProperty(transport, WRAPPED_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
  });

  log.info(`inspector → http://localhost:${port}/inspect`);
  return transport;
}

/**
 * Legacy probe-based attach. Kept for v0.1.x users who already wrote
 * `devtools.attach(server)` before `wrap` existed. Internally just calls
 * `wrap(server._transport)` if the field is present, otherwise spins up the
 * UI in standalone mode with a warning. Scheduled for removal in v0.2.
 *
 * @deprecated Use `devtools.wrap(transport)` before `server.connect(transport)` instead.
 */
async function attach(
  server: { _transport?: McpTransportLike },
  opts: EmbedOptions = {},
): Promise<void> {
  if (server._transport) {
    await wrap(server._transport, opts);
    return;
  }
  log.warn(
    "embed.attach: server has no `_transport`; recording disabled. " +
      "Use `devtools.wrap(transport)` before `server.connect(transport)` instead.",
  );
  await ensureUi(opts.port ?? 7456);
}

export const devtools = {
  wrap,
  attach,
};
