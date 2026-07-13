import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../src/config.js";

describe("email config", () => {
  it("дефолты smtp и лимита", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.smtp.host).toBe("smtp.gmail.com");
    expect(cfg.smtp.port).toBe(465);
    expect(cfg.emailDailyLimit).toBe(10);
    expect(cfg.resumePdfPath).toBeNull();
  });
  it("emailDailyLimit ограничен сверху", () => {
    expect(() => ConfigSchema.parse({ emailDailyLimit: 100 })).toThrow();
  });
});
