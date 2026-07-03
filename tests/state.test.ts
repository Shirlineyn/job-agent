// tests/state.test.ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";

const mkDb = () => openDb(":memory:");
const v = (id: string) => ({
  id, url: `https://hh.ru/vacancy/${id}`, title: "AI engineer",
  employer_id: "e1", employer_name: "Acme", salary_from: 200000, salary_to: null,
  currency: "RUR", work_format: "remote" as const, experience: "1-3",
  published_at: "2026-07-01", raw_json: "{}",
});

describe("repo", () => {
  it("upsert is idempotent by vacancy id", () => {
    const db = mkDb();
    expect(repo.upsertVacancy(db, v("1"))).toBe(true);
    expect(repo.upsertVacancy(db, v("1"))).toBe(false);
  });
  it("appliedToday counts only today's applied", () => {
    const db = mkDb();
    repo.upsertVacancy(db, v("1"));
    repo.setStatus(db, "1", "applied", { applied_at: new Date().toISOString() });
    expect(repo.appliedToday(db)).toBe(1);
  });
  it("run lifecycle and blacklist roundtrip", () => {
    const db = mkDb();
    const runId = repo.startRun(db, "manual", "dry_run");
    repo.finishRun(db, runId, { applied: 2, stop_reason: "completed" });
    repo.addBlacklist(db, "Галера ООО");
    expect(repo.getBlacklist(db)).toContain("Галера ООО");
  });
});
