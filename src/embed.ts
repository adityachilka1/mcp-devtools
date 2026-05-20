/**
 * Embed mode: attach the inspector UI to an MCP server you already have.
 *
 *   import { devtools } from "mcp-devtools/embed";
 *   devtools.attach(server, { port: 7456 });
 *
 * Works by wrapping the server's transport so that every send/receive is also
 * recorded in the local TraceStore that backs the UI.
 *
 * Note: we intentionally use a structural type for the server parameter so we
 * don't take a hard runtime dependency on the @modelcontextprotocol/sdk
 * package — the inspector works with any object that exposes a transport with
 * `onMessage` and `send` hooks.
 */
import { EventEmitter } from "node:events";
import { TraceStore } from "./trace-store.js";
import { startUiServer } from "./ui-server.js";
import { log } from "./util/log.js";

export interface EmbedOptions {
  port?: number;
  openBrowser?: boolean;
}

/** Structural interface — works with the official SDK's `Server` or any custom one. */
export interface AttachableServer {
  // The SDK exposes the transport on a (currently private) `_transport` field.
  // We probe for it gracefully and degrade to no-op if it isn't there.
  _transport?: {
    onMessage: (m: unknown) => void;
    send: (m: unknown) => void;
  };
}

export const devtools = {
  async attach(server: AttachableServer, opts: EmbedOptions = {}): Promise<void> {
    const port = opts.port ?? 7456;
    const store = new TraceStore();
    const events = new EventEmitter();

    const transport = server._transport;
    if (transport) {
      const realOnMessage = transport.onMessage.bind(transport);
      transport.onMessage = (msg: unknown) => {
        const id = store.record({ direction: "out", frame: msg as never });
        events.emit("frame", id);
        return realOnMessage(msg);
      };
      const realSend = transport.send.bind(transport);
      transport.send = (msg: unknown) => {
        const id = store.record({ direction: "in", frame: msg as never });
        events.emit("frame", id);
        return realSend(msg);
      };
    } else {
      log.warn("embed: server has no `_transport`; recording is disabled");
    }

    await startUiServer({ port, store, events });
    log.info(`mcp-devtools embed → http://localhost:${port}/inspect`);
  },
};
