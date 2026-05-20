import { describe, expect, it } from "vitest";
import { validatePort } from "./validate-port.js";

describe("validatePort", () => {
  it("accepts valid non-privileged ports", () => {
    expect(validatePort(7456)).toEqual({ ok: true, value: 7456 });
  });

  it("rejects values above the max range", () => {
    expect(validatePort(99999)).toEqual({
      ok: false,
      message: "error: --port must be between 1024 and 65535 (got 99999)",
    });
  });

  it("rejects privileged ports with a hint", () => {
    expect(validatePort(80)).toEqual({
      ok: false,
      message:
        "error: --port must be between 1024 and 65535 (got 80); ports below 1024 usually require root, pick a higher port",
    });
  });
});
