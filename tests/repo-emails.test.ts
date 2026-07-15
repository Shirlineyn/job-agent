// tests/repo-emails.test.ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import type { VacancyInsert } from "../src/state/types.js";

const vac = (id: string): VacancyInsert => ({
  id,
  url: "https://x.test/" + id,
  title: "ML",
  employer_id: "hirehi:acme",
  employer_name: "Acme",
  salary_from: null,
  salary_to: null,
  currency: null,
  work_format: null,
  experience: null,
  published_at: null,
  raw_json: null,
  source: "hirehi",
});

describe("кэш почты компании", () => {
  it("save/get found и not_found", () => {
    const db = openDb(":memory:");
    repo.saveCompanyEmail(db, "e1", "Acme", "hr@acme.ru", "perplexity");
    expect(repo.getCompanyEmail(db, "e1")).toMatchObject({ email: "hr@acme.ru", status: "found" });
    repo.saveCompanyEmail(db, "e2", "Beta", null, null);
    expect(repo.getCompanyEmail(db, "e2")).toMatchObject({ email: null, status: "not_found" });
    expect(repo.getCompanyEmail(db, "нет")).toBeNull();
  });
  it("не затирает research при сохранении почты", () => {
    const db = openDb(":memory:");
    repo.saveCompanyResearch(db, "e1", "Acme", "справка");
    repo.saveCompanyEmail(db, "e1", "Acme", "hr@acme.ru", "perplexity");
    expect(repo.getCompanyResearch(db, "e1")?.research).toBe("справка");
  });
});

describe("черновики писем", () => {
  it("insert → get → update → sent; повторный insert не дублирует", () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, vac("hirehi:1"));
    expect(
      repo.insertEmailDraft(db, {
        vacancy_id: "hirehi:1",
        to_email: "hr@acme.ru",
        subject: "S",
        body: "B",
      }),
    ).toBe(true);
    expect(
      repo.insertEmailDraft(db, {
        vacancy_id: "hirehi:1",
        to_email: "hr@acme.ru",
        subject: "S2",
        body: "B2",
      }),
    ).toBe(false);
    const e = repo.getEmailByVacancy(db, "hirehi:1")!;
    expect(e.subject).toBe("S"); // повторный прогон не перетёр черновик
    repo.updateEmailDraft(db, e.id, { body: "правленый" });
    expect(repo.getEmailByVacancy(db, "hirehi:1")!.body).toBe("правленый");
    expect(repo.emailsSentToday(db)).toBe(0);
    repo.markEmailSent(db, e.id);
    expect(repo.getEmailsByStatus(db, "sent")).toHaveLength(1);
    expect(repo.emailsSentToday(db)).toBe(1);
  });
});

describe("llm_calls после пересоздания", () => {
  it("принимает purpose=email_search и сохраняет старые записи", () => {
    const db = openDb(":memory:");
    repo.insertLlmCall(db, {
      vacancy_id: null,
      run_id: null,
      provider: "perplexity",
      purpose: "email_search",
      model: "sonar",
      request: "{}",
      response: null,
      error: null,
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_tokens: null,
      cache_read_tokens: null,
      cost_usd: 0,
      latency_ms: 1,
    });
  });
});
