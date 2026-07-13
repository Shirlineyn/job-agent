import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../src/config.js";

describe("config sources", () => {
  it("дефолты: все 4 источника, непустые ключевые слова", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.enabledSources).toEqual(["hirehi", "habr", "getmatch", "trudvsem"]);
    expect(cfg.sourceKeywords.length).toBeGreaterThan(0);
  });
  it("неизвестный источник отклоняется", () => {
    expect(() => ConfigSchema.parse({ enabledSources: ["linkedin"] })).toThrow();
  });
});
