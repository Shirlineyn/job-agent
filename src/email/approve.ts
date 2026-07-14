// src/email/approve.ts
import type { Database } from "better-sqlite3";
import * as repo from "../state/repo.js";
import type { Config } from "../config.js";
import type { Mailer } from "./send.js";

// Единственная точка, из которой письмо реально уходит. Лимит — второй предохранитель
// после ручного просмотра; порядок строгий: send → sent → applied (упавший SMTP
// оставляет черновик draft, ничего не потеряно).
export async function approveEmail(
  db: Database,
  cfg: Config,
  mailer: Mailer,
  id: number,
): Promise<{ ok: true } | { error: string }> {
  const e = db.prepare(`SELECT * FROM emails WHERE id=?`).get(id) as
    | {
        id: number;
        vacancy_id: string;
        to_email: string;
        subject: string;
        body: string;
        status: string;
      }
    | undefined;
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
