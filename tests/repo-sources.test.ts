// tests/repo-sources.test.ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { dedupKey } from "../src/state/dedup.js";
import type { VacancyInsert } from "../src/state/types.js";

const mk = (over: Partial<VacancyInsert>): VacancyInsert => ({
  id: "hh1", url: "https://hh.ru/vacancy/1", title: "ML Engineer", employer_id: "e1",
  employer_name: "Acme", salary_from: null, salary_to: null, currency: null,
  work_format: null, experience: null, published_at: null, raw_json: null,
  source: "hh", ...over,
});

describe("dedupKey", () => {
  it("нормализует регистр, кавычки и пробелы", () => {
    expect(dedupKey('ООО  «Акме»', ' ML   Engineer ')).toBe("ооо акме|ml engineer");
  });
});

describe("upsertVacancy с source", () => {
  it("сохраняет source и dedup_key", () => {
    const db = openDb(":memory:");
    expect(repo.upsertVacancy(db, mk({}))).toBe(true);
    const v = repo.getVacancy(db, "hh1")!;
    expect(v.source).toBe("hh");
    expect(v.dedup_key).toBe("acme|ml engineer");
  });
  it("не вставляет не-hh дубликат той же вакансии от того же работодателя", () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, mk({}));
    const dup = mk({ id: "hirehi:9", source: "hirehi", url: "https://hirehi.ru/j/9" });
    expect(repo.upsertVacancy(db, dup)).toBe(false);
    expect(repo.getVacancy(db, "hirehi:9")).toBeUndefined();
  });
  it("hh вставляется всегда, даже если не-hh пришёл раньше", () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, mk({ id: "hirehi:9", source: "hirehi" }));
    expect(repo.upsertVacancy(db, mk({ id: "hh2" }))).toBe(true);
  });
});
