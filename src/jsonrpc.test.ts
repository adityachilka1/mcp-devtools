import { describe, it, expect } from "vitest";
import { parseFrames, classify } from "./jsonrpc.js";

describe("parseFrames", () => {
  it("parses a single complete frame", () => {
    const buf = Buffer.from(
      `{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n`,
    );
    const out = parseFrames(buf);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1, method: "tools/list" });
  });

  it("handles split frames across chunks", () => {
    const a = parseFrames(Buffer.from(`{"jsonrpc":"2.0",`));
    const b = parseFrames(Buffer.from(`"id":2,"result":{}}\n`));
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ id: 2, result: {} });
  });

  it("captures malformed lines instead of throwing", () => {
    const out = parseFrames(Buffer.from("not json\n"));
    expect(out[0]).toHaveProperty("_parseError");
  });
});

describe("classify", () => {
  it("identifies requests, responses, notifications", () => {
    expect(classify({ jsonrpc: "2.0", id: 1, method: "ping" }).kind)
      .toBe("request");
    expect(classify({ jsonrpc: "2.0", id: 1, result: {} }).kind)
      .toBe("response");
    expect(classify({ jsonrpc: "2.0", method: "notifications/x" }).kind)
      .toBe("notification");
  });
});
