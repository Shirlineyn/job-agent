import { describe, it, expect } from "vitest";
import { jitter } from "../src/browser/humanize.js";

describe("jitter", () => {
  it("stays in range across samples", () => {
    for (let i = 0; i < 1000; i++) {
      const v = jitter(100, 200);
      expect(v).toBeGreaterThanOrEqual(100);
      expect(v).toBeLessThanOrEqual(200);
    }
  });
});
