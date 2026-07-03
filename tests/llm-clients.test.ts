import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/llm/log.js";

describe("withRetry", () => {
  it("retries retryable errors up to 3 attempts then succeeds", async () => {
    let n = 0;
    const fn = vi.fn(async () => { if (++n < 3) throw Object.assign(new Error("overloaded"), { status: 529 }); return "ok"; });
    expect(await withRetry(fn, () => {})).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("throws after 3 failures", async () => {
    const fn = vi.fn(async () => { throw Object.assign(new Error("boom"), { status: 500 }); });
    await expect(withRetry(fn, () => {})).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("does not retry 400", async () => {
    const fn = vi.fn(async () => { throw Object.assign(new Error("bad"), { status: 400 }); });
    await expect(withRetry(fn, () => {})).rejects.toThrow("bad");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
