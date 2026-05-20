import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isQuiet, log, setQuiet } from "./log.js";

describe("log", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setQuiet(false);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    setQuiet(false);
  });

  it("info writes by default", () => {
    log.info("hello");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0]?.[0]).toContain("hello");
  });

  it("info is silent under setQuiet(true)", () => {
    setQuiet(true);
    expect(isQuiet()).toBe(true);
    log.info("hello");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("warn and err are never silenced", () => {
    setQuiet(true);
    log.warn("careful");
    log.err("boom");
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it("setQuiet is idempotent and reversible", () => {
    setQuiet(true);
    setQuiet(true);
    expect(isQuiet()).toBe(true);
    setQuiet(false);
    expect(isQuiet()).toBe(false);
    log.info("back on");
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
