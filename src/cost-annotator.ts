/**
 * Pairs `tools/call` requests with their responses and stamps each pair with
 * a USD cost estimate using the configured pricing table.
 *
 * Frames are buffered in the trace-store as JSON-RPC envelopes — the
 * annotator is a thin lens over that store that doesn't mutate it. The UI
 * server runs frames through the annotator on the way out so that the
 * inspector can show a cost badge per row + an aggregate total at the top.
 */
import type { JsonRpcFrame } from "./jsonrpc.js";
import { type CostEstimate, type PricingTable, emptyPricing, estimateCost } from "./pricing.js";
import type { StoredFrame } from "./trace-store.js";

export interface AnnotatedFrame extends StoredFrame {
  /** Present only on `tools/call` response frames. */
  cost?: CostEstimate & { usd: number | null };
}

export interface CostAnnotatorOptions {
  pricing: PricingTable;
  /** Active model id for this session. Undefined → every cost is null. */
  modelId?: string;
}

export class CostAnnotator {
  private pricing: PricingTable;
  private modelId: string | undefined;
  // Map request-frame id → { ts, bytes } so we can pair responses up.
  private pending = new Map<string | number, { ts: number; bytes: number }>();

  constructor(opts: CostAnnotatorOptions) {
    this.pricing = opts.pricing;
    this.modelId = opts.modelId;
  }

  setModel(id: string | undefined): void {
    this.modelId = id;
  }

  setPricing(p: PricingTable): void {
    this.pricing = p;
  }

  /**
   * Walk the frames, pair `tools/call` requests with their responses, and
   * attach a cost estimate to each response. Pure with respect to its
   * input — never mutates the underlying StoredFrame objects.
   */
  annotate(frames: StoredFrame[]): AnnotatedFrame[] {
    // Note: the pending map is instance-scoped, not per-call — successive
    // calls with overlapping windows correctly pair requests in one batch
    // with responses in a later batch (the live WS stream does this).
    const out: AnnotatedFrame[] = [];
    for (const f of frames) {
      const frame = f.frame as JsonRpcFrame;
      if (isToolsCallRequest(frame)) {
        this.pending.set(frame.id, { ts: f.ts, bytes: byteSize(frame) });
        out.push(f);
        continue;
      }
      if (isResponse(frame) && this.pending.has(frame.id)) {
        const req = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        if (!req) {
          out.push(f);
          continue;
        }
        const elapsedSeconds = Math.max(0, (f.ts - req.ts) / 1000);
        const estimate = this.modelId
          ? estimateCost(this.pricing, {
              modelId: this.modelId,
              inputBytes: req.bytes,
              outputBytes: byteSize(frame),
              elapsedSeconds,
            })
          : ({ cost: null, basis: "unknown-model" } satisfies CostEstimate);
        out.push({ ...f, cost: { ...estimate, usd: estimate.cost } });
        continue;
      }
      out.push(f);
    }
    return out;
  }
}

/** Convenience: a no-op annotator used when no pricing is configured. */
export function noopAnnotator(): CostAnnotator {
  return new CostAnnotator({ pricing: emptyPricing() });
}

function isToolsCallRequest(f: JsonRpcFrame): f is JsonRpcFrame & { id: string | number } {
  return (
    typeof (f as { method?: unknown }).method === "string" &&
    (f as { method?: string }).method === "tools/call" &&
    (f as { id?: unknown }).id != null
  );
}

function isResponse(f: JsonRpcFrame): f is JsonRpcFrame & { id: string | number } {
  // JSON-RPC response: has `id` but no `method`.
  return (
    (f as { id?: unknown }).id != null && typeof (f as { method?: unknown }).method !== "string"
  );
}

function byteSize(frame: JsonRpcFrame): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}
