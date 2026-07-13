// src/state/repo.ts
import type { Database } from "better-sqlite3";
import type { VacancyInsert, VacancyRow, VacancyStatus, LlmCallInsert, RunPatch, EmailInsert, EmailRow, EmailStatus } from "./types.js";
import { dedupKey } from "./dedup.js";

// Whitelist of columns that can be updated via setStatus
const UPDATABLE_COLS = new Set<keyof VacancyRow>([
  "url", "title", "employer_id", "employer_name", "salary_from", "salary_to", "currency",
  "work_format", "experience", "published_at", "discovered_at", "score", "score_reasons",
  "filter_reason", "letter", "applied_at", "raw_json"
]);

export function upsertVacancy(db: Database, v: VacancyInsert): boolean {
  const key = dedupKey(v.employer_name, v.title);
  // hh — первичный источник: его вставляем всегда. Дубликат из нового источника
  // (та же вакансия у того же работодателя, найденная где-то ещё) не вставляем —
  // отклик по ней уже возможен через hh, а двойной скоринг жжёт бюджет.
  if (v.source !== "hh") {
    const dup = db.prepare(`SELECT 1 FROM vacancies WHERE dedup_key=? LIMIT 1`).get(key);
    if (dup) return false;
  }
  const insertVacancy = db.prepare(`INSERT OR IGNORE INTO vacancies
    (id,url,title,employer_id,employer_name,salary_from,salary_to,currency,work_format,experience,published_at,raw_json,source,dedup_key)
    VALUES (@id,@url,@title,@employer_id,@employer_name,@salary_from,@salary_to,@currency,@work_format,@experience,@published_at,@raw_json,@source,@key)`);

  // vacancies.employer_id has a FK to companies(employer_id) (see docs/db-schema.md),
  // but vacancies are discovered (and must be inserted) before any company research
  // happens — the companies row is normally created later, during the research step.
  // To satisfy the FK at discovery time we ensure a stub companies row exists first;
  // saveCompanyResearch() later fills in `research`/`researched_at` for the same row.
  const run = db.transaction((row: VacancyInsert & { key: string }) => {
    if (row.employer_id != null) {
      db.prepare(`INSERT OR IGNORE INTO companies (employer_id, name) VALUES (@employer_id, @employer_name)`).run(row);
    }
    return insertVacancy.run(row);
  });
  return run({ ...v, key }).changes > 0;
}

export function setStatus(db: Database, id: string, status: VacancyStatus, extra: Partial<VacancyRow> = {}): void {
  for (const k of Object.keys(extra)) {
    if (!UPDATABLE_COLS.has(k as keyof VacancyRow)) {
      throw new Error(`setStatus: unknown column ${k}`);
    }
  }
  const cols = Object.keys(extra).map(k => `${k}=@${k}`).join(",");
  db.prepare(`UPDATE vacancies SET status=@status, updated_at=datetime('now')${cols ? "," + cols : ""} WHERE id=@id`)
    .run({ id, status, ...extra });
}

export function getByStatus(db: Database, status: VacancyStatus): VacancyRow[] {
  return db.prepare(`SELECT * FROM vacancies WHERE status=? ORDER BY discovered_at`).all(status) as VacancyRow[];
}

export function getVacancy(db: Database, id: string): VacancyRow | undefined {
  return db.prepare(`SELECT * FROM vacancies WHERE id=?`).get(id) as VacancyRow | undefined;
}

export function appliedToday(db: Database): number {
  // applied_at is stored as UTC ISO; daily limit uses local (Moscow) days
  const r = db.prepare(`SELECT COUNT(*) n FROM vacancies WHERE status='applied' AND date(applied_at,'localtime')=date('now','localtime')`).get() as { n: number };
  return r.n;
}

export function insertLlmCall(db: Database, c: LlmCallInsert): void {
  db.prepare(`INSERT INTO llm_calls (vacancy_id,run_id,provider,purpose,model,request,response,error,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd,latency_ms)
    VALUES (@vacancy_id,@run_id,@provider,@purpose,@model,@request,@response,@error,@input_tokens,@output_tokens,@cache_creation_tokens,@cache_read_tokens,@cost_usd,@latency_ms)`).run(c);
}

export function startRun(db: Database, trigger: "schedule" | "manual", mode: "live" | "dry_run"): number {
  return Number(db.prepare(`INSERT INTO runs (trigger,mode) VALUES (?,?)`).run(trigger, mode).lastInsertRowid);
}

export function finishRun(db: Database, id: number, p: RunPatch): void {
  db.prepare(`UPDATE runs SET finished_at=datetime('now'),
    discovered=COALESCE(@discovered,discovered), filtered_out=COALESCE(@filtered_out,filtered_out),
    scored=COALESCE(@scored,scored), applied=COALESCE(@applied,applied),
    errors=COALESCE(@errors,errors), stop_reason=COALESCE(@stop_reason,stop_reason) WHERE id=@id`)
    .run({ discovered: null, filtered_out: null, scored: null, applied: null, errors: null, stop_reason: null, ...p, id });
}

export function getBlacklist(db: Database): string[] {
  return (db.prepare(`SELECT pattern FROM blacklist`).all() as { pattern: string }[]).map(r => r.pattern);
}
export function addBlacklist(db: Database, pattern: string, reason?: string): void {
  db.prepare(`INSERT OR IGNORE INTO blacklist (pattern,reason) VALUES (?,?)`).run(pattern, reason ?? null);
}
export function removeBlacklist(db: Database, pattern: string): void {
  db.prepare(`DELETE FROM blacklist WHERE pattern=?`).run(pattern);
}

export function getCompanyResearch(db: Database, employerId: string): { research: string; researchedAt: string } | null {
  const r = db.prepare(`SELECT research, researched_at FROM companies WHERE employer_id=? AND research IS NOT NULL`).get(employerId) as
    { research: string; researched_at: string } | undefined;
  return r ? { research: r.research, researchedAt: r.researched_at } : null;
}
export function saveCompanyResearch(db: Database, employerId: string, name: string, research: string): void {
  db.prepare(`INSERT INTO companies (employer_id,name,research,researched_at) VALUES (?,?,?,datetime('now'))
    ON CONFLICT(employer_id) DO UPDATE SET research=excluded.research, researched_at=excluded.researched_at`).run(employerId, name, research);
}

export function getCompanyEmail(db: Database, employerId: string):
  { email: string | null; status: "found" | "not_found"; checkedAt: string } | null {
  const r = db.prepare(`SELECT contact_email, email_status, email_checked_at FROM companies
    WHERE employer_id=? AND email_status IS NOT NULL`).get(employerId) as
    { contact_email: string | null; email_status: "found" | "not_found"; email_checked_at: string } | undefined;
  return r ? { email: r.contact_email, status: r.email_status, checkedAt: r.email_checked_at } : null;
}

export function saveCompanyEmail(db: Database, employerId: string, name: string,
  email: string | null, source: "source_payload" | "perplexity" | null): void {
  db.prepare(`INSERT INTO companies (employer_id, name, contact_email, email_status, email_checked_at, email_source)
    VALUES (?,?,?,?,datetime('now'),?)
    ON CONFLICT(employer_id) DO UPDATE SET contact_email=excluded.contact_email,
      email_status=excluded.email_status, email_checked_at=excluded.email_checked_at, email_source=excluded.email_source`)
    .run(employerId, name, email, email ? "found" : "not_found", source);
}

export function insertEmailDraft(db: Database, e: EmailInsert): boolean {
  const r = db.prepare(`INSERT OR IGNORE INTO emails (vacancy_id,to_email,subject,body)
    VALUES (@vacancy_id,@to_email,@subject,@body)`).run(e);
  return r.changes > 0;
}
export function getEmailByVacancy(db: Database, vacancyId: string): EmailRow | undefined {
  return db.prepare(`SELECT * FROM emails WHERE vacancy_id=?`).get(vacancyId) as EmailRow | undefined;
}
export function getEmailsByStatus(db: Database, status: EmailStatus): EmailRow[] {
  return db.prepare(`SELECT * FROM emails WHERE status=? ORDER BY created_at`).all(status) as EmailRow[];
}
export function updateEmailDraft(db: Database, id: number, patch: { subject?: string; body?: string }): void {
  db.prepare(`UPDATE emails SET subject=COALESCE(@subject,subject), body=COALESCE(@body,body)
    WHERE id=@id AND status='draft'`).run({ subject: null, body: null, ...patch, id });
}
export function markEmailSent(db: Database, id: number): void {
  db.prepare(`UPDATE emails SET status='sent', sent_at=datetime('now') WHERE id=?`).run(id);
}
export function markEmailRejected(db: Database, id: number): void {
  db.prepare(`UPDATE emails SET status='rejected' WHERE id=?`).run(id);
}
export function emailsSentToday(db: Database): number {
  const r = db.prepare(`SELECT COUNT(*) n FROM emails WHERE status='sent'
    AND date(sent_at,'localtime')=date('now','localtime')`).get() as { n: number };
  return r.n;
}

export function report(db: Database, date: string): unknown {
  return {
    runs: db.prepare(`SELECT * FROM runs WHERE date(started_at)=?`).all(date),
    applied: db.prepare(`SELECT id,title,employer_name,score,applied_at FROM vacancies WHERE date(applied_at)=?`).all(date),
    costUsd: (db.prepare(`SELECT COALESCE(SUM(cost_usd),0) c FROM llm_calls WHERE date(created_at)=?`).get(date) as { c: number }).c,
  };
}
