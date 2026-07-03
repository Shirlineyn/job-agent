// tests/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config", () => {
  it("creates defaults with dry_run mode and limit 10", () => {
    const dir = mkdtempSync(join(tmpdir(), "hh-"));
    const cfg = loadConfig(dir);
    expect(cfg.mode).toBe("dry_run");
    expect(cfg.dailyLimit).toBe(10);
    expect(cfg.scoreThreshold).toBe(65);
  });
  it("roundtrips saved changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "hh-"));
    const cfg = loadConfig(dir);
    saveConfig({ ...cfg, scoreThreshold: 70 }, dir);
    expect(loadConfig(dir).scoreThreshold).toBe(70);
  });
});
