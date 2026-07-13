import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appendToGmailDrafts, type ImapClientLike } from "../src/email/gmailDraft.js";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { ConfigSchema } from "../src/config.js";
import type { VacancyInsert } from "../src/state/types.js";

const cfg = ConfigSchema.parse({});

function fakeClient() {
  const appends: { box: string; flags?: string[] }[] = [];
  const client: ImapClientLike & { appends: typeof appends } = {
    appends,
    connect: vi.fn().mockResolvedValue(undefined),
    // Gmail отдаёт локализованную папку черновиков со спец-ролью \Drafts
    list: vi.fn().mockResolvedValue([
      { path: "INBOX" },
      { path: "[Gmail]/Черновики", specialUse: "\\Drafts" },
    ]),
    append: vi.fn((box: string, _c: unknown, flags?: string[]) => { appends.push({ box, flags }); return Promise.resolve(); }),
    logout: vi.fn().mockResolvedValue(undefined),
  };
  return client;
}

describe("appendToGmailDrafts", () => {
  beforeEach(() => { process.env.SMTP_PASSWORD = "app-pass"; });
  afterEach(() => { delete process.env.SMTP_PASSWORD; });

  it("кладёт письма в локализованную папку черновиков с флагом \\Draft", async () => {
    const client = fakeClient();
    const n = await appendToGmailDrafts(cfg, [
      { to: "hr@a.ru", subject: "S1", body: "B1" },
      { to: "hr@b.ru", subject: "S2", body: "B2" },
    ], () => client);
    expect(n).toBe(2);
    expect(client.appends).toHaveLength(2);
    expect(client.appends[0].box).toBe("[Gmail]/Черновики");
    expect(client.appends[0].flags).toContain("\\Draft");
    expect(client.logout).toHaveBeenCalled();
  });

  it("пустой список — без подключения", async () => {
    const make = vi.fn();
    expect(await appendToGmailDrafts(cfg, [], make as never)).toBe(0);
    expect(make).not.toHaveBeenCalled();
  });

  it("без SMTP_PASSWORD бросает понятную ошибку", async () => {
    delete process.env.SMTP_PASSWORD;
    await expect(appendToGmailDrafts(cfg, [{ to: "x@y.ru", subject: "s", body: "b" }], () => fakeClient()))
      .rejects.toThrow(/SMTP_PASSWORD/);
  });

  it("logout вызывается даже при ошибке append", async () => {
    const client = fakeClient();
    client.append = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(appendToGmailDrafts(cfg, [{ to: "x@y.ru", subject: "s", body: "b" }], () => client)).rejects.toThrow("boom");
    expect(client.logout).toHaveBeenCalled();
  });
});

describe("repo: очередь выгрузки в Gmail", () => {
  const vac = (id: string): VacancyInsert => ({
    id, url: "https://x/" + id, title: "ML " + id, employer_id: "h:" + id, employer_name: "A " + id,
    salary_from: null, salary_to: null, currency: null, work_format: null, experience: null,
    published_at: null, raw_json: null, source: "hirehi",
  });

  it("getUndraftedEmails отдаёт только неотмеченные, markGmailDrafted их убирает", () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, vac("hirehi:1"));
    repo.upsertVacancy(db, vac("hirehi:2"));
    repo.insertEmailDraft(db, { vacancy_id: "hirehi:1", to_email: "a@a.ru", subject: "S", body: "B" });
    repo.insertEmailDraft(db, { vacancy_id: "hirehi:2", to_email: "b@b.ru", subject: "S", body: "B" });
    expect(repo.getUndraftedEmails(db)).toHaveLength(2);
    const first = repo.getEmailByVacancy(db, "hirehi:1")!;
    repo.markGmailDrafted(db, first.id);
    const left = repo.getUndraftedEmails(db);
    expect(left).toHaveLength(1);
    expect(left[0].vacancy_id).toBe("hirehi:2");
    expect(repo.getEmailByVacancy(db, "hirehi:1")!.gmail_drafted_at).not.toBeNull();
  });
});
