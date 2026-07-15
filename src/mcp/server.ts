// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import type { Database } from "better-sqlite3";
import * as repo from "../state/repo.js";
import { loadConfig, saveConfig, ConfigSchema } from "../config.js";
import { runSession, type Deps } from "../pipeline/run.js";
import { tryAcquireRunLock, releaseRunLock } from "../run-lock.js";
import { notify } from "../notify.js";
import { makeMailer } from "../email/send.js";
import { approveEmail } from "../email/approve.js";
import { appendToGmailDrafts } from "../email/gmailDraft.js";
import { logger } from "../logger.js";

const log = logger("mcp");

const j = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

// A session runs 10+ minutes (dry-run) to 30-70 minutes (live). Holding the request
// transport open that long breaks every other MCP call and outlives client timeouts,
// so run_now is fire-and-forget: it kicks off the session and returns immediately;
// progress is observed via status / get_report.
function buildServer(db: Database, mkDeps: () => Promise<Deps>): McpServer {
  const mcp = new McpServer({ name: "hh-agent", version: "1.0.0" });

  mcp.registerTool(
    "status",
    { description: "Текущее состояние агента", inputSchema: {} },
    async () => {
      const cfg = loadConfig();
      return j({
        mode: cfg.mode,
        paused: cfg.paused,
        appliedToday: repo.appliedToday(db),
        dailyLimit: cfg.dailyLimit,
        queued: repo.getByStatus(db, "queued").length,
        threshold: cfg.scoreThreshold,
      });
    },
  );
  mcp.registerTool(
    "run_now",
    {
      description:
        "Запустить сессию сейчас (асинхронно — следи за прогрессом через status/get_report)",
      inputSchema: { mode: z.enum(["live", "dry_run"]).optional() },
    },
    async ({ mode }) => {
      if (!tryAcquireRunLock()) return j({ error: "session already running" });
      try {
        const deps = await mkDeps();
        void runSession(deps, "manual", mode)
          .then((s) => {
            notify(
              `hh-agent: сессия завершена — откликов ${s.applied}, ошибок ${s.errors} (${s.stopReason})`,
            );
          })
          .catch((e: unknown) => {
            notify(`hh-agent: сессия упала: ${String(e)}`);
          })
          .finally(releaseRunLock);
        return j({ started: true, mode: mode ?? loadConfig().mode });
      } catch (e) {
        releaseRunLock();
        return j({ error: String(e) });
      }
    },
  );
  mcp.registerTool(
    "pause",
    { description: "Поставить автопилот на паузу", inputSchema: {} },
    async () => {
      saveConfig({ ...loadConfig(), paused: true });
      return j({ paused: true });
    },
  );
  mcp.registerTool("resume", { description: "Снять с паузы", inputSchema: {} }, async () => {
    saveConfig({ ...loadConfig(), paused: false });
    return j({ paused: false });
  });
  mcp.registerTool(
    "get_report",
    {
      description: "Отчёт за день (YYYY-MM-DD, по умолчанию сегодня)",
      inputSchema: { date: z.string().optional() },
    },
    async ({ date }) => j(repo.report(db, date ?? new Date().toISOString().slice(0, 10))),
  );
  mcp.registerTool(
    "get_queue",
    { description: "Очередь на отклик со score и письмами", inputSchema: {} },
    async () =>
      j(
        repo.getByStatus(db, "queued").map((v) => ({
          id: v.id,
          title: v.title,
          employer: v.employer_name,
          score: v.score,
          letter: v.letter,
        })),
      ),
  );
  mcp.registerTool(
    "get_vacancy",
    { description: "Вакансия целиком по id", inputSchema: { id: z.string() } },
    async ({ id }) => j(repo.getVacancy(db, id) ?? { error: "not found" }),
  );
  mcp.registerTool(
    "set_filters",
    {
      description: "Изменить конфиг (частичный патч; вложенный filters заменяется целиком)",
      inputSchema: { patch: z.record(z.string(), z.unknown()) },
    },
    async ({ patch }) => {
      const next = ConfigSchema.parse({ ...loadConfig(), ...patch });
      saveConfig(next);
      return j(next);
    },
  );
  mcp.registerTool(
    "blacklist_add",
    {
      description: "Добавить работодателя в чёрный список",
      inputSchema: { pattern: z.string(), reason: z.string().optional() },
    },
    async ({ pattern, reason }) => {
      repo.addBlacklist(db, pattern, reason);
      return j({ blacklist: repo.getBlacklist(db) });
    },
  );
  mcp.registerTool(
    "blacklist_remove",
    { description: "Убрать из чёрного списка", inputSchema: { pattern: z.string() } },
    async ({ pattern }) => {
      repo.removeBlacklist(db, pattern);
      return j({ blacklist: repo.getBlacklist(db) });
    },
  );

  mcp.registerTool(
    "get_email_queue",
    { description: "Черновики писем HR, ждущие подтверждения", inputSchema: {} },
    async () =>
      j(
        repo.getEmailsByStatus(db, "draft").map((e) => {
          const v = repo.getVacancy(db, e.vacancy_id);
          return {
            id: e.id,
            vacancy_id: e.vacancy_id,
            title: v?.title,
            employer: v?.employer_name,
            score: v?.score,
            url: v?.url,
            to: e.to_email,
            subject: e.subject,
            body: e.body,
          };
        }),
      ),
  );
  mcp.registerTool(
    "update_email",
    {
      description: "Поправить тему/текст черновика перед отправкой",
      inputSchema: { id: z.number(), subject: z.string().optional(), body: z.string().optional() },
    },
    async ({ id, subject, body }) => {
      repo.updateEmailDraft(db, id, { subject, body });
      return j({ updated: id });
    },
  );
  mcp.registerTool(
    "approve_email",
    {
      description: "Подтвердить и ОТПРАВИТЬ письмо (реальная отправка на почту HR)",
      inputSchema: { id: z.number() },
    },
    async ({ id }) => {
      const cfg = loadConfig();
      return j(await approveEmail(db, cfg, makeMailer(cfg), id));
    },
  );
  mcp.registerTool(
    "reject_email",
    { description: "Отклонить черновик (вакансия → skipped)", inputSchema: { id: z.number() } },
    async ({ id }) => {
      const e = repo.getEmailsByStatus(db, "draft").find((x) => x.id === id);
      if (!e) return j({ error: `draft ${id} not found` });
      repo.markEmailRejected(db, id);
      repo.setStatus(db, e.vacancy_id, "skipped", { filter_reason: "email_rejected" });
      return j({ rejected: id });
    },
  );
  mcp.registerTool(
    "draft_to_gmail",
    {
      description: "Положить неотправленные черновики в папку «Черновики» Gmail (отправляешь сам)",
      inputSchema: {},
    },
    async () => {
      const cfg = loadConfig();
      const pending = repo.getUndraftedEmails(db);
      if (pending.length === 0) return j({ drafted: 0, note: "нет новых черновиков" });
      const done: string[] = [];
      try {
        // markGmailDrafted вызывается поштучно (onAppended) — сбой на середине не приведёт
        // к повторной выгрузке уже добавленных при следующем draft_to_gmail.
        const n = await appendToGmailDrafts(
          cfg,
          pending.map((e) => ({ id: e.id, to: e.to_email, subject: e.subject, body: e.body })),
          {
            onAppended: (id) => {
              repo.markGmailDrafted(db, id);
              const e = pending.find((p) => p.id === id);
              if (e) done.push(e.to_email);
            },
          },
        );
        return j({ drafted: n, to: done });
      } catch (err) {
        return j({ error: String(err), drafted: done.length, to: done });
      }
    },
  );

  return mcp;
}

export function startMcp(db: Database, mkDeps: () => Promise<Deps>, port: number): void {
  const app = express();
  app.use(express.json());
  // Fresh McpServer + transport per request: the SDK throws "Already connected to a
  // transport" if one server is reused across concurrent open transports (a session
  // held one open for the whole run). Origin/Host validation blocks DNS-rebinding —
  // a browser page rebinding to 127.0.0.1 must not be able to call set_filters/run_now.
  app.all("/mcp", async (req, res) => {
    const mcp = buildServer(db, mkDeps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.listen(port, "127.0.0.1", () => {
    log.info(`http://localhost:${port}/mcp`);
  });
}
