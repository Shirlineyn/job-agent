import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// мокаем nodemailer ДО импорта модуля
const sendMail = vi.fn().mockResolvedValue({ messageId: "x" });
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }));

import nodemailer from "nodemailer";
import { makeMailer } from "../src/email/send.js";
import { ConfigSchema } from "../src/config.js";

const ORIGINAL_SMTP_PASSWORD = process.env.SMTP_PASSWORD;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_SMTP_PASSWORD === undefined) {
    delete process.env.SMTP_PASSWORD;
  } else {
    process.env.SMTP_PASSWORD = ORIGINAL_SMTP_PASSWORD;
  }
});

describe("makeMailer", () => {
  it("бросает без SMTP_PASSWORD при send, но конструируется без него", async () => {
    delete process.env.SMTP_PASSWORD;
    const m = makeMailer(ConfigSchema.parse({}));
    await expect(m.send({ to: "hr@x.ru", subject: "s", body: "b" })).rejects.toThrow(
      /SMTP_PASSWORD/,
    );
  });
  it("шлёт письмо с From-именем и plain-text телом", async () => {
    process.env.SMTP_PASSWORD = "app-pass";
    const m = makeMailer(ConfigSchema.parse({}));
    await m.send({ to: "hr@x.ru", subject: "Отклик", body: "Здравствуйте" });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: "doronin.alex001@gmail.com", pass: "app-pass" },
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "hr@x.ru",
        subject: "Отклик",
        text: "Здравствуйте",
        from: '"Александр Доронин" <doronin.alex001@gmail.com>',
      }),
    );
  });
});
