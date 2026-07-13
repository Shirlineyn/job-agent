// src/email/send.ts
import nodemailer from "nodemailer";
import { basename } from "node:path";
import type { Config } from "../config.js";

export type Mailer = { send(msg: { to: string; subject: string; body: string }): Promise<void> };

// Ленивый transport: пароль нужен только в момент реальной отправки (approve_email),
// а MCP-сервер должен подниматься и без него.
export function makeMailer(cfg: Config): Mailer {
  let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
  return {
    async send({ to, subject, body }): Promise<void> {
      const pass = process.env.SMTP_PASSWORD;
      if (!pass) throw new Error("SMTP_PASSWORD не задан в env — отправка невозможна");
      transport ??= nodemailer.createTransport({
        host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.port === 465,
        auth: { user: cfg.smtp.user, pass },
      });
      await transport.sendMail({
        from: `"${cfg.smtp.fromName}" <${cfg.smtp.user}>`,
        to, subject, text: body,
        attachments: cfg.resumePdfPath ? [{ filename: basename(cfg.resumePdfPath), path: cfg.resumePdfPath }] : undefined,
      });
    },
  };
}
