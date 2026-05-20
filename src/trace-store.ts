/**
 * In-memory ring buffer for MCP frames. The store keeps the last N frames
 * (default: 10,000) so a long-running session doesn't blow up RAM. Frames are
 * also written incrementally to an on-disk JSONL file under `~/.mcp-devtools/`
 * so that opening a stale tab still shows the full history.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonRpcFrame } from "./jsonrpc.js";

export interface StoredFrame {
  id: number;
  direction: "in" | "out";
  ts: number;
  frame: JsonRpcFrame;
}

export interface RecordInput {
  direction: "in" | "out";
  frame: JsonRpcFrame;
}

const MAX_FRAMES = 10_000;

export class TraceStore {
  private buf: StoredFrame[] = [];
  private nextId = 1;
  private logPath: string;
  private initialized = false;

  constructor(opts?: { logDir?: string }) {
    const dir = opts?.logDir ?? join(homedir(), ".mcp-devtools");
    this.logPath = join(dir, `session-${Date.now()}.jsonl`);
  }

  record(input: RecordInput): number {
    const entry: StoredFrame = {
      id: this.nextId++,
      direction: input.direction,
      ts: Date.now(),
      frame: input.frame,
    };
    this.buf.push(entry);
    if (this.buf.length > MAX_FRAMES) this.buf.shift();
    void this.persist(entry);
    return entry.id;
  }

  /** All frames in chronological order. */
  all(): StoredFrame[] {
    return this.buf.slice();
  }

  /** Frames since (exclusive) the given id. Used by the UI's live stream. */
  since(id: number): StoredFrame[] {
    return this.buf.filter((f) => f.id > id);
  }

  private async persist(entry: StoredFrame): Promise<void> {
    if (!this.initialized) {
      await mkdir(join(homedir(), ".mcp-devtools"), { recursive: true });
      this.initialized = true;
    }
    await appendFile(this.logPath, `${JSON.stringify(entry)}\n`).catch(() => {
      /* never throw from the recorder — the proxy must keep running */
    });
  }
}
