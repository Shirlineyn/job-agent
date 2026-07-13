// tests/mcp-emails.test.ts
import { describe, it, expect, vi } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { approveEmail } from "../src/email/approve.js";
import { ConfigSchema } from "../src/config.js";
import type { VacancyInsert } from "../src/state/types.js";

const cfg = ConfigSchema.parse({ emailDailyLimit: 1 });
const vac = (id: string): VacancyInsert => ({
  // title varies per id — upsertVacancy's cross-source dedup drops a second row that
  // shares (employer_name, title) with an already-inserted non-"hh" vacancy.
  id, url: "https://x.test/" + id, title: "ML " + id, employer_id: "h:a", employer_name: "A",
  salary_from: null, salary_to: null, currency: null, work_format: null, experience: null,
  published_at: null, raw_json: null, source: "hirehi",
});

describe("approveEmail", () => {
  it("шлёт, помечает sent и переводит вакансию в applied", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, vac("hirehi:1"));
    repo.insertEmailDraft(db, { vacancy_id: "hirehi:1", to_email: "hr@a.ru", subject: "S", body: "B" });
    const mailer = { send: vi.fn().mockResolvedValue(undefined) };
    const e = repo.getEmailByVacancy(db, "hirehi:1")!;
    expect(await approveEmail(db, cfg, mailer, e.id)).toEqual({ ok: true });
    expect(mailer.send).toHaveBeenCalledWith({ to: "hr@a.ru", subject: "S", body: "B" });
    expect(repo.getEmailByVacancy(db, "hirehi:1")!.status).toBe("sent");
    expect(repo.getVacancy(db, "hirehi:1")!.status).toBe("applied");
  });
  it("дневной лимит блокирует отправку", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, vac("hirehi:1"));
    repo.upsertVacancy(db, vac("hirehi:2"));
    repo.insertEmailDraft(db, { vacancy_id: "hirehi:1", to_email: "a@a.ru", subject: "S", body: "B" });
    repo.insertEmailDraft(db, { vacancy_id: "hirehi:2", to_email: "b@b.ru", subject: "S", body: "B" });
    const mailer = { send: vi.fn().mockResolvedValue(undefined) };
    await approveEmail(db, cfg, mailer, repo.getEmailByVacancy(db, "hirehi:1")!.id);
    const r = await approveEmail(db, cfg, mailer, repo.getEmailByVacancy(db, "hirehi:2")!.id);
    expect(r).toMatchObject({ error: expect.stringContaining("limit") });
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });
  it("ошибка SMTP не помечает письмо sent", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, vac("hirehi:1"));
    repo.insertEmailDraft(db, { vacancy_id: "hirehi:1", to_email: "hr@a.ru", subject: "S", body: "B" });
    const mailer = { send: vi.fn().mockRejectedValue(new Error("535 auth failed")) };
    const r = await approveEmail(db, cfg, mailer, repo.getEmailByVacancy(db, "hirehi:1")!.id);
    expect(r).toMatchObject({ error: expect.stringContaining("535") });
    expect(repo.getEmailByVacancy(db, "hirehi:1")!.status).toBe("draft");
  });
});
