import type { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
/**
 * Local UI server. Serves the static browser bundle from `ui/` and exposes a
 * WebSocket at `/ws` that streams new frames to the inspector in real time.
 */
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import websocketPlugin from "@fastify/websocket";
import fastify from "fastify";
import { type CostAnnotator, noopAnnotator } from "./cost-annotator.js";
import type { TraceStore } from "./trace-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface UiServerOptions {
  port: number;
  store: TraceStore;
  events: EventEmitter;
  /** Optional cost-attribution lens. Defaults to a no-op (every cost null). */
  annotator?: CostAnnotator;
}

export async function startUiServer({ port, store, events, annotator }: UiServerOptions) {
  const app = fastify({ logger: false });
  const annot = annotator ?? noopAnnotator();

  await app.register(websocketPlugin);
  // After the build, this file lives in `dist/ui-server.js` and `ui/` lives
  // beside `dist/` at the package root, so `../ui` resolves correctly.
  await app.register(fastifyStatic, {
    root: join(__dirname, "..", "ui"),
    prefix: "/inspect/",
  });

  app.get("/api/frames", async (req) => {
    const since = Number((req.query as { since?: string }).since ?? 0);
    return annot.annotate(store.since(since));
  });

  // @fastify/websocket v11: handler receives the WebSocket directly.
  app.get("/ws", { websocket: true }, (socket /* WebSocket */) => {
    const send = (id: number) => {
      const payload = JSON.stringify({
        type: "frame",
        frames: annot.annotate(store.since(id - 1)),
      });
      socket.send(payload);
    };
    const onFrame = (id: number) => send(id);
    events.on("frame", onFrame);
    socket.on("close", () => events.off("frame", onFrame));
  });

  await app.listen({ port, host: "127.0.0.1" });
  return app;
}
