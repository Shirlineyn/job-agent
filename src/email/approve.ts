// src/email/approve.ts
import type { Database } from "better-sqlite3";
import * as repo from "../state/repo.js";
import type { Config } from "../config.js";
import type { Mailer } from "./send.js";
import { reconcileSentDrafts } from "./reconcile.js";

// Единственная точка, из которой письмо реально уходит. Лимит — второй предохранитель
// после ручного просмотра; порядок строгий: send → sent → applied (упавший SMTP
// оставляет черновик draft, ничего не потеряно).
export async function approveEmail(
  db: Database,
  cfg: Config,
  mailer: Mailer,
  id: number,
  reconcile: (db: Database, cfg: Config) => Promise<unknown> = reconcileSentDrafts,
): Promise<{ ok: true } | { error: string }> {
  // Барьер от дубля: перед отправкой сверяемся с «Отправленными» Gmail (письмо могли
  // отправить вручную из черновиков). Ошибка сверки — fail-closed: не шлём вслепую.
  try {
    await reconcile(db, cfg);
  } catch (err) {
    return { error: `сверка с Gmail не удалась (${String(err)}), повтори позже` };
  }
  const e = repo.getEmailById(db, id);
  if (!e) return { error: `email ${id} not found` };
  if (e.status !== "draft") return { error: `email ${id} is ${e.status}, not draft` };
  if (repo.emailsSentToday(db) >= cfg.emailDailyLimit)
    return { error: "daily email limit reached" };
  try {
    await mailer.send({ to: e.to_email, subject: e.subject, body: e.body });
  } catch (err) {
    return { error: String(err) };
  }
  repo.markEmailSent(db, e.id);
  repo.setStatus(db, e.vacancy_id, "applied", { applied_at: new Date().toISOString() });
  return { ok: true };
}
