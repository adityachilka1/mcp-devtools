import { EventEmitter } from "node:events";
/**
 * Open a previously recorded `.mcptrace` file in the inspector UI.
 * Replays frames into a fresh TraceStore in chronological order and serves
 * the UI in read-only mode.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { TraceStore } from "./trace-store.js";
import { startUiServer } from "./ui-server.js";
import { log } from "./util/log.js";
import { openBrowserAt } from "./util/open.js";

export interface TraceViewerOptions {
  tracePath: string;
  port: number;
}

export async function openTrace({ tracePath, port }: TraceViewerOptions) {
  const store = new TraceStore();
  const events = new EventEmitter();

  const rl = createInterface({
    input: createReadStream(tracePath).pipe(createGunzip()),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    store.record({ direction: row.direction, frame: row.frame });
  }

  await startUiServer({ port, store, events });
  log.info(`viewing ${tracePath} → http://localhost:${port}/inspect`);
  await openBrowserAt(`http://localhost:${port}/inspect`);
}
