// tests/pipeline.test.ts
import { describe, it, expect, vi } from "vitest";
import { runSession, type Deps } from "../src/pipeline/run.js";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { loadConfig } from "../src/config.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const card = (id: string) => ({ id, url: `https://hh.ru/vacancy/${id}`, title: "AI engineer", employer_id: "e" + id,
  employer_name: "Acme" + id, salary_from: 250000, salary_to: null, currency: "RUR", work_format: "remote" as const,
  experience: "between1And3", published_at: new Date().toISOString(), raw_json: "{}" });

function deps(overrides: Partial<Deps> = {}): Deps {
  const db = openDb(":memory:");
  const cfg = { ...loadConfig(mkdtempSync(join(tmpdir(), "hh-"))), applyPauseMs: [0, 0] as [number, number] };
  return {
    db, cfg, resume: "резюме",
    browser: {
      searchVacancies: vi.fn(async () => [card("1"), card("2")]),
      fetchVacancyText: vi.fn(async () => "vacancy text"),
      apply: vi.fn(async () => "applied" as const),
      waitCaptchaCleared: vi.fn(async () => true),
    },
    claude: vi.fn(async (_c, o) => o.purpose === "scoring"
      ? '{"score":80,"reasons":["fit"],"red_flags":[],"salary_match":"match","seniority_match":"match"}'
      : "Здравствуйте! Я ИИ-агент, действующий по поручению Александра Доронина. " + "слово ".repeat(130) + "Доронин") as never,
    pplx: vi.fn(async () => "справка о компании") as never,
    notify: vi.fn(),
    ...overrides,
  };
}

describe("runSession", () => {
  it("dry_run applies nothing but pipelines everything", async () => {
    const d = deps();
    (d.browser.apply as ReturnType<typeof vi.fn>).mockResolvedValue("dry_run");
    const s = await runSession(d, "manual");           // cfg.mode = dry_run по умолчанию
    expect(s.discovered).toBe(2);
    expect(s.applied).toBe(0);
    expect(repo.getByStatus(d.db, "queued").length).toBe(2); // остались в очереди
  });
  it("live mode applies up to daily limit and records applied", async () => {
    const d = deps();
    const s = await runSession(d, "manual", "live");
    expect(s.applied).toBe(2);
    expect(repo.appliedToday(d.db)).toBe(2);
  });
  it("skips below-threshold vacancies", async () => {
    const d = deps({ claude: vi.fn(async () => '{"score":30,"reasons":[],"red_flags":["галера"],"salary_match":"unknown","seniority_match":"match"}') as never });
    const s = await runSession(d, "manual", "live");
    expect(s.applied).toBe(0);
    expect(repo.getByStatus(d.db, "skipped").length).toBe(2);
  });
  it("marks vacancy failed when scoring errors", async () => {
    const d = deps({ claude: vi.fn(async () => { throw new Error("api down"); }) as never });
    const s = await runSession(d, "manual", "live");
    expect(s.errors).toBeGreaterThan(0);
    expect(repo.getByStatus(d.db, "failed").length).toBe(2);
    expect(repo.getByStatus(d.db, "discovered").length).toBe(0);
  });
});
