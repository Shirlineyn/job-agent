import { ImapFlow } from "imapflow";
import type { Database } from "better-sqlite3";
import * as repo from "../state/repo.js";
import type { Config } from "../config.js";
import { logger } from "../logger.js";

const log = logger("reconcile");

export interface ReaderMsg {
  envelope?: {
    subject?: string | null;
    date?: Date | null;
    to?: { address?: string | null }[];
  } | null;
}

export interface ImapReaderLike {
  connect(): Promise<unknown>;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  mailboxOpen(path: string): Promise<unknown>;
  // ImapFlow.search возвращает number[] | false (false при неоткрытом ящике/ошибке).
  search(query: { since: Date }): Promise<number[] | false>;
  fetchAll(source: number[], query: { envelope: true }): Promise<ReaderMsg[]>;
  logout(): Promise<unknown>;
}

export type ImapReaderFactory = (opts: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}) => ImapReaderLike;

const defaultFactory: ImapReaderFactory = (opts) => new ImapFlow({ ...opts, logger: false });

const DAY_MS = 86_400_000;

// Сверяет draft-письма с папкой «Отправленные» Gmail по получателю+теме и помечает
// совпавшие как sent (+ вакансию applied). Идемпотентно, ничего не удаляет и не шлёт.
// Fail-safe: нет черновиков/пароля/папки «Отправленные» — 0 без единого IMAP-захода.
export async function reconcileSentDrafts(
  db: Database,
  cfg: Config,
  opts: { makeClient?: ImapReaderFactory; sinceDays?: number } = {},
): Promise<{ reconciled: number; ids: number[] }> {
  const drafts = repo.getEmailsByStatus(db, "draft");
  if (drafts.length === 0) return { reconciled: 0, ids: [] };
  const pass = process.env.SMTP_PASSWORD;
  if (!pass) return { reconciled: 0, ids: [] };

  const sinceDays = opts.sinceDays ?? 60;
  const client = (opts.makeClient ?? defaultFactory)({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: cfg.smtp.user, pass },
  });
  await client.connect();
  try {
    const sentBox = (await client.list()).find((m) => (m.specialUse ?? "") === "\\Sent");
    if (!sentBox) return { reconciled: 0, ids: [] };
    await client.mailboxOpen(sentBox.path);
    const since = new Date(Date.now() - sinceDays * DAY_MS);
    const seqs = await client.search({ since });
    if (!seqs || seqs.length === 0) return { reconciled: 0, ids: [] };
    const msgs = await client.fetchAll(seqs, { envelope: true });

    const ids: number[] = [];
    for (const d of drafts) {
      const hit = msgs.find((m) => {
        const env = m.envelope;
        if (!env) return false;
        if (env.subject !== d.subject) return false;
        return (env.to ?? []).some(
          (a) => (a.address ?? "").toLowerCase() === d.to_email.toLowerCase(),
        );
      });
      if (!hit) continue;
      const sentAt = hit.envelope?.date ? hit.envelope.date.toISOString() : undefined;
      repo.markEmailSent(db, d.id, sentAt);
      repo.setStatus(db, d.vacancy_id, "applied", {
        applied_at: sentAt ?? new Date().toISOString(),
      });
      ids.push(d.id);
    }
    if (ids.length > 0) log.info(`сверено с Gmail: ${ids.length} писем помечены sent`);
    return { reconciled: ids.length, ids };
  } finally {
    await client.logout();
  }
}
