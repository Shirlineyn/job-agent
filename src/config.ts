// src/config.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
  port: z.number().default(7010),
  resumePath: z.string().default(join(homedir(), ".hh-agent", "master.md")),
  searchQueries: z
    .array(z.string())
    .default(['"AI-инженер" OR "LLM" OR "ML-инженер"']),
  area: z.number().default(1),
  filters: z
    .object({
      salaryMin: z.number().default(200000),
      allowUnknownSalary: z.boolean().default(true),
      workFormats: z
        .array(z.enum(["office", "hybrid", "remote", "unknown"]))
        .default(["office", "hybrid", "remote", "unknown"]),
      freshDays: z.number().default(7),
      maxExperience: z
        .array(z.string())
        .default(["noExperience", "between1And3", "between3And6"]),
    })
    .default({
      salaryMin: 200000,
      allowUnknownSalary: true,
      workFormats: ["office", "hybrid", "remote", "unknown"],
      freshDays: 7,
      maxExperience: ["noExperience", "between1And3", "between3And6"],
    }),
  scoreThreshold: z.number().default(65),
  dailyLimit: z.number().default(10),
  schedule: z.array(z.string()).default(["0 10 * * *", "30 15 * * *"]),
  applyPauseMs: z.tuple([z.number(), z.number()]).default([180000, 420000]),
  anthropicModel: z.string().default("claude-sonnet-5"),
  perplexityModel: z.string().default("sonar"),
  mode: z.enum(["live", "dry_run"]).default("dry_run"),
  paused: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

function defaultDir(): string {
  return join(homedir(), ".hh-agent");
}

function configPath(dir: string): string {
  return join(dir, "config.json");
}

export function loadConfig(dir: string = defaultDir()): Config {
  mkdirSync(dir, { recursive: true });
  const path = configPath(dir);
  try {
    const raw = readFileSync(path, "utf8");
    return ConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const defaults = ConfigSchema.parse({});
      writeFileSync(path, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    throw err;
  }
}

export function saveConfig(cfg: Config, dir: string = defaultDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2));
}
