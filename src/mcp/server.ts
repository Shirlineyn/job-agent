// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import type { Database } from "better-sqlite3";
import * as repo from "../state/repo.js";
import { loadConfig, saveConfig, ConfigSchema } from "../config.js";
import { runSession, type Deps } from "../pipeline/run.js";

const j = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function startMcp(db: Database, mkDeps: () => Promise<Deps>, port: number): void {
  const mcp = new McpServer({ name: "hh-agent", version: "1.0.0" });

  mcp.tool("status", "Текущее состояние агента", {}, async () => {
    const cfg = loadConfig();
    return j({ mode: cfg.mode, paused: cfg.paused, appliedToday: repo.appliedToday(db), dailyLimit: cfg.dailyLimit,
      queued: repo.getByStatus(db, "queued").length, threshold: cfg.scoreThreshold });
  });
  mcp.tool("run_now", "Запустить сессию сейчас", { mode: z.enum(["live", "dry_run"]).optional() }, async ({ mode }) => {
    const deps = await mkDeps();
    return j(await runSession(deps, "manual", mode));
  });
  mcp.tool("pause", "Поставить автопилот на паузу", {}, async () => { saveConfig({ ...loadConfig(), paused: true }); return j({ paused: true }); });
  mcp.tool("resume", "Снять с паузы", {}, async () => { saveConfig({ ...loadConfig(), paused: false }); return j({ paused: false }); });
  mcp.tool("get_report", "Отчёт за день (YYYY-MM-DD, по умолчанию сегодня)", { date: z.string().optional() },
    async ({ date }) => j(repo.report(db, date ?? new Date().toISOString().slice(0, 10))));
  mcp.tool("get_queue", "Очередь на отклик со score и письмами", {}, async () =>
    j(repo.getByStatus(db, "queued").map(v => ({ id: v.id, title: v.title, employer: v.employer_name, score: v.score, letter: v.letter }))));
  mcp.tool("get_vacancy", "Вакансия целиком по id", { id: z.string() }, async ({ id }) => j(repo.getVacancy(db, id) ?? { error: "not found" }));
  mcp.tool("set_filters", "Изменить конфиг (частичный патч)", { patch: z.record(z.string(), z.unknown()) }, async ({ patch }) => {
    const next = ConfigSchema.parse({ ...loadConfig(), ...patch });
    saveConfig(next); return j(next);
  });
  mcp.tool("blacklist_add", "Добавить работодателя в чёрный список", { pattern: z.string(), reason: z.string().optional() },
    async ({ pattern, reason }) => { repo.addBlacklist(db, pattern, reason); return j({ blacklist: repo.getBlacklist(db) }); });
  mcp.tool("blacklist_remove", "Убрать из чёрного списка", { pattern: z.string() },
    async ({ pattern }) => { repo.removeBlacklist(db, pattern); return j({ blacklist: repo.getBlacklist(db) }); });

  const app = express();
  app.use(express.json());
  app.all("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.listen(port, "127.0.0.1", () => console.log(`[mcp] http://localhost:${port}/mcp`));
}
