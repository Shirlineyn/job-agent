import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { basename } from "node:path";
import type { Config } from "../config.js";

export interface GmailDraft {
  id: number;
  to: string;
  subject: string;
  body: string;
}

export interface AppendOpts {
  // Вызывается СРАЗУ после успешного APPEND каждого черновика — чтобы персистить прогресс
  // поштучно: если IMAP упадёт на середине пачки, уже добавленные помечены и повторный
  // вызов их не продублирует.
  onAppended?: (id: number) => void;
  makeClient?: ImapClientFactory;
}

// Клиент IMAP инъектируется в тестах; в проде — реальный ImapFlow.
export type ImapClientFactory = (opts: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}) => ImapClientLike;

export interface ImapClientLike {
  connect(): Promise<unknown>;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  append(path: string, content: Buffer | string, flags?: string[]): Promise<unknown>;
  logout(): Promise<unknown>;
}

const defaultFactory: ImapClientFactory = (opts) => new ImapFlow({ ...opts, logger: false });

// Кладёт письма в папку «Черновики» Gmail через IMAP APPEND. Тот же app-пароль, что и SMTP
// (из env SMTP_PASSWORD). Ленивое подключение: пароль нужен только в момент вызова, поэтому
// MCP-сервер поднимается и без него. Возвращает число реально добавленных черновиков.
export async function appendToGmailDrafts(
  cfg: Config,
  drafts: GmailDraft[],
  opts: AppendOpts = {},
): Promise<number> {
  if (drafts.length === 0) return 0;
  const pass = process.env.SMTP_PASSWORD;
  if (!pass) throw new Error("SMTP_PASSWORD не задан в env — черновики в Gmail недоступны");

  const client = (opts.makeClient ?? defaultFactory)({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: cfg.smtp.user, pass },
  });
  await client.connect();
  try {
    // У Gmail папка черновиков локализована («[Gmail]/Черновики» и т.п.) — ищем по спец-роли \Drafts.
    let box = "[Gmail]/Drafts";
    const found = (await client.list()).find((m) => (m.specialUse ?? "") === "\\Drafts");
    if (found) box = found.path;

    let appended = 0;
    for (const d of drafts) {
      const mime = await new MailComposer({
        from: `"${cfg.smtp.fromName}" <${cfg.smtp.user}>`,
        to: d.to,
        subject: d.subject,
        text: d.body,
        attachments: cfg.resumePdfPath
          ? [{ filename: basename(cfg.resumePdfPath), path: cfg.resumePdfPath }]
          : [],
      })
        .compile()
        .build();
      await client.append(box, mime, ["\\Draft"]);
      opts.onAppended?.(d.id); // персистим ЭТОТ успех до следующего APPEND
      appended++;
    }
    return appended;
  } finally {
    await client.logout();
  }
}
