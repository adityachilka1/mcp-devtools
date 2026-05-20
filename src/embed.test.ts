/**
 * embed.wrap() unit tests.
 *
 * We don't spin up the real Fastify UI in these tests — that's covered by the
 * proxy/recorder e2e. Here we just verify the transport-wrapping contract:
 *   1. send() is intercepted on the same transport object
 *   2. onMessage assigned AFTER wrap() flows through the recorder
 *   3. onMessage assigned BEFORE wrap() also flows through
 *   4. Double-wrap is a no-op (idempotent)
 */
import { describe, expect, it, vi } from "vitest";

// Stub ui-server so we don't actually bind a port during tests.
vi.mock("./ui-server.js", () => ({
  startUiServer: vi.fn().mockResolvedValue(undefined),
}));

import { type McpTransportLike, devtools } from "./embed.js";

function makeFakeTransport(): McpTransportLike & {
  sent: unknown[];
  deliver: (msg: unknown) => void;
} {
  const sent: unknown[] = [];
  let assigned: ((msg: unknown) => void) | undefined;
  return {
    sent,
    send: (msg) => {
      sent.push(msg);
    },
    get onMessage() {
      return assigned;
    },
    set onMessage(h) {
      assigned = h;
    },
    deliver(msg) {
      // Simulates the underlying transport's read loop calling `this.onMessage(msg)`.
      this.onMessage?.(msg);
    },
  };
}

describe("devtools.wrap", () => {
  it("intercepts send() — outgoing frames go through the recorder", async () => {
    const t = makeFakeTransport();
    const wrapped = await devtools.wrap(t, { port: 9999 });

    wrapped.send({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ id: 1 });
  });

  it("intercepts onMessage assigned AFTER wrap() (SDK Server's connect() pattern)", async () => {
    const t = makeFakeTransport();
    await devtools.wrap(t, { port: 9999 });

    const userHandler = vi.fn();
    t.onMessage = userHandler; // SDK Server does this in connect()

    t.deliver({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(userHandler).toHaveBeenCalledTimes(1);
    expect(userHandler).toHaveBeenCalledWith(expect.objectContaining({ method: "tools/list" }));
  });

  it("intercepts onMessage assigned BEFORE wrap()", async () => {
    const t = makeFakeTransport();
    const userHandler = vi.fn();
    t.onMessage = userHandler;
    await devtools.wrap(t, { port: 9999 });

    t.deliver({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(userHandler).toHaveBeenCalledTimes(1);
  });

  it("double-wrap is a no-op, doesn't double-record", async () => {
    const t = makeFakeTransport();
    await devtools.wrap(t, { port: 9999 });
    await devtools.wrap(t, { port: 9999 }); // second wrap — should warn + skip

    const userHandler = vi.fn();
    t.onMessage = userHandler;
    t.deliver({ jsonrpc: "2.0", id: 3, method: "x" });
    expect(userHandler).toHaveBeenCalledTimes(1); // handler called once, not twice

    t.send({ jsonrpc: "2.0", id: 3, result: 1 });
    expect(t.sent).toHaveLength(1); // send recorded once
  });
});
