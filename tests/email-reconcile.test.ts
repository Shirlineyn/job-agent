import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { reconcileSentDrafts, type ImapReaderLike } from "../src/email/reconcile.js";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { ConfigSchema } from "../src/config.js";

const cfg = ConfigSchema.parse({});

function seedDraft(db: ReturnType<typeof openDb>, vac: string, to: string, subject: string) {
  repo.upsertVacancy(db, {
    id: vac,
    url: "u",
    // title уникален на вакансию: иначе дедуп (employer+title) схлопнул бы разные seed'ы
    title: vac,
    employer_id: null,
    employer_name: "Acme",
    salary_from: null,
    salary_to: null,
    currency: null,
    work_format: "remote",
    experience: null,
    published_at: null,
    raw_json: "{}",
    source: "hirehi",
  });
  repo.setStatus(db, vac, "queued");
  repo.insertEmailDraft(db, { vacancy_id: vac, to_email: to, subject, body: "B" });
}

function reader(sent: { to: string; subject: string; date: Date }[]): ImapReaderLike {
  return {
    connect: () => Promise.resolve(),
    list: () => Promise.resolve([{ path: "[Gmail]/Отправленные", specialUse: "\\Sent" }]),
    mailboxOpen: () => Promise.resolve(),
    search: () => Promise.resolve(sent.map((_, i) => i + 1)),
    fetchAll: (ids) =>
      Promise.resolve(
        ids.map((i) => {
          const m = sent[i - 1]!;
          return { envelope: { subject: m.subject, date: m.date, to: [{ address: m.to }] } };
        }),
      ),
    logout: () => Promise.resolve(),
  };
}

describe("reconcileSentDrafts", () => {
  beforeEach(() => {
    process.env.SMTP_PASSWORD = "app-pass";
  });
  afterEach(() => {
    delete process.env.SMTP_PASSWORD;
  });

  it("матч to+subject → письмо sent (время из конверта) + вакансия applied", async () => {
    const db = openDb(":memory:");
    seedDraft(db, "hirehi:1", "hr@a.ru", "S1");
    const r = await reconcileSentDrafts(db, cfg, {
      makeClient: () =>
        reader([{ to: "hr@a.ru", subject: "S1", date: new Date("2026-07-14T09:00:00Z") }]),
    });
    expect(r.reconciled).toBe(1);
    const e = repo.getEmailByVacancy(db, "hirehi:1")!;
    expect(e.status).toBe("sent");
    expect(e.sent_at).toContain("2026-07-14");
    expect(repo.getVacancy(db, "hirehi:1")!.status).toBe("applied");
  });

  it("разные темы на один адрес — матчится верный", async () => {
    const db = openDb(":memory:");
    seedDraft(db, "hirehi:1", "web@x.ru", "NLP Engineer");
    seedDraft(db, "hirehi:2", "web@x.ru", "python developer");
    const r = await reconcileSentDrafts(db, cfg, {
      makeClient: () =>
        reader([{ to: "web@x.ru", subject: "python developer", date: new Date("2026-07-14") }]),
    });
    expect(r.reconciled).toBe(1);
    expect(repo.getEmailByVacancy(db, "hirehi:2")!.status).toBe("sent");
    expect(repo.getEmailByVacancy(db, "hirehi:1")!.status).toBe("draft");
  });

  it("нет совпадения → остаётся draft", async () => {
    const db = openDb(":memory:");
    seedDraft(db, "hirehi:1", "hr@a.ru", "S1");
    const r = await reconcileSentDrafts(db, cfg, {
      makeClient: () =>
        reader([{ to: "hr@a.ru", subject: "ДРУГАЯ ТЕМА", date: new Date("2026-07-14") }]),
    });
    expect(r.reconciled).toBe(0);
    expect(repo.getEmailByVacancy(db, "hirehi:1")!.status).toBe("draft");
  });

  it("нет SMTP_PASSWORD → 0 без IMAP", async () => {
    delete process.env.SMTP_PASSWORD;
    const db = openDb(":memory:");
    seedDraft(db, "hirehi:1", "hr@a.ru", "S1");
    let connected = false;
    const r = await reconcileSentDrafts(db, cfg, {
      makeClient: () => ({
        ...reader([]),
        connect: () => {
          connected = true;
          return Promise.resolve();
        },
      }),
    });
    expect(r.reconciled).toBe(0);
    expect(connected).toBe(false);
  });

  it("нет черновиков → 0 без IMAP", async () => {
    const db = openDb(":memory:");
    let connected = false;
    const r = await reconcileSentDrafts(db, cfg, {
      makeClient: () => ({
        ...reader([]),
        connect: () => {
          connected = true;
          return Promise.resolve();
        },
      }),
    });
    expect(r.reconciled).toBe(0);
    expect(connected).toBe(false);
  });
});
