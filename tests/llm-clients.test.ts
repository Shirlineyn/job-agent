import { describe, it, expect, vi } from "vitest";
import { withRetry, cost } from "../src/llm/log.js";

describe("cost", () => {
  it("prices plain input/output for claude-sonnet-5 ($3/$15 per 1M)", () => {
    expect(cost("claude-sonnet-5", 1_000_000, 1_000_000)).toBeCloseTo(3 + 15, 10);
  });
  it("prices cache write at 1.25x and cache read at 0.1x input price", () => {
    // input_tokens = некэшированный остаток; кэш-токены идут отдельными слагаемыми
    const usd = cost("claude-sonnet-5", 100, 200, 8000, 0);
    expect(usd).toBeCloseTo((100 * 3 + 8000 * 1.25 * 3 + 200 * 15) / 1_000_000, 12);
    const usdRead = cost("claude-sonnet-5", 100, 200, 0, 8000);
    expect(usdRead).toBeCloseTo((100 * 3 + 8000 * 0.1 * 3 + 200 * 15) / 1_000_000, 12);
  });
  it("defaults cache tokens to 0 (backwards compatible)", () => {
    expect(cost("claude-sonnet-5", 100, 200)).toBeCloseTo(cost("claude-sonnet-5", 100, 200, 0, 0), 12);
  });
});

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
