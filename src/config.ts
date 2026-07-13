// src/config.ts
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
  port: z.number().default(7010),
  resumePath: z.string().default(join(homedir(), ".hh-agent", "master.md")),
  searchQueries: z
    .array(z.string())
    .default(['"AI-инженер" OR "LLM" OR "ML-инженер"']),
  // Новые источники ищут по простым ключевым словам (их поиск не понимает hh-синтаксис "A OR B").
  enabledSources: z
    .array(z.enum(["hirehi", "habr", "getmatch", "trudvsem"]))
    .default(["hirehi", "habr", "getmatch", "trudvsem"]),
  sourceKeywords: z
    .array(z.string())
    .default(["LLM", "ML инженер", "AI инженер", "аналитик данных", "python"]),
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
  // dailyLimit — главный предохранитель: целое 1..50, чтобы битый конфиг не открыл шлюз.
  dailyLimit: z.number().int().min(1).max(50).default(10),
  // Прямые письма HR: отправка только вручную через approve_email, лимит — второй предохранитель.
  emailDailyLimit: z.number().int().min(1).max(30).default(10),
  smtp: z
    .object({
      host: z.string().default("smtp.gmail.com"),
      port: z.number().default(465),
      user: z.string().default("doronin.alex001@gmail.com"),
      fromName: z.string().default("Александр Доронин"),
    })
    .default({ host: "smtp.gmail.com", port: 465, user: "doronin.alex001@gmail.com", fromName: "Александр Доронин" }),
  resumePdfPath: z.string().nullable().default(null),
  // Ссылка на открытый код пайплайна в холодных письмах (вариант «агент как доказательство»).
  // null, пока репозиторий не опубликован (иначе получатель кликнет в 404); после публикации —
  // выставить URL, и email-письма начнут ссылаться на него.
  repoUrl: z.string().nullable().default(null),
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
  // Атомарная запись (tmp + rename): краш посреди writeFileSync не оставит порванный
  // config.json, который иначе валит каждый последующий loadConfig (и cron-цикл).
  const path = configPath(dir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, path);
}
