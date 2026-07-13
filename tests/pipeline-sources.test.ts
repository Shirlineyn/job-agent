// tests/pipeline-sources.test.ts
import { describe, it, expect, vi } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { runSession, type Deps } from "../src/pipeline/run.js";
import { ConfigSchema } from "../src/config.js";
import type { JobSource } from "../src/sources/types.js";
import type { VacancyInsert } from "../src/state/types.js";

const card = (id: string, source: string, title: string): VacancyInsert => ({
  id, url: `https://x.test/${id}`, title, employer_id: `${source}:acme`, employer_name: "Acme " + id,
  salary_from: 300000, salary_to: null, currency: "RUR", work_format: "remote",
  experience: null, published_at: new Date().toISOString(), raw_json: JSON.stringify({ text: "текст вакансии про LLM" }), source,
});

function fakeSource(name: string, cards: VacancyInsert[]): JobSource {
  return {
    name: name as never,
    search: vi.fn().mockResolvedValue(cards),
    fetchText: vi.fn().mockResolvedValue("полный текст про LLM и Python"),
  };
}

function mkDeps(db: ReturnType<typeof openDb>, sources: JobSource[]): Deps {
  return {
    db, cfg: ConfigSchema.parse({ mode: "dry_run", searchQueries: [], scoreThreshold: 65 }),
    browser: {
      searchVacancies: vi.fn().mockResolvedValue([]),
      fetchVacancyText: vi.fn(), apply: vi.fn(), waitCaptchaCleared: vi.fn(),
    } as never,
    // scoreVacancy (src/llm/scoring.ts) валидирует полную схему через zod — salary_match/seniority_match
    // обязательны, иначе parseScore бросит InvalidScoreJson и вакансия уйдёт в failed вместо queued/skipped.
    claude: vi.fn().mockResolvedValue(JSON.stringify({
      score: 80, reasons: ["ok"], red_flags: [], salary_match: "match", seniority_match: "match",
    })) as never,
    pplx: vi.fn().mockResolvedValue("research") as never,
    notify: vi.fn(), resume: "резюме", sources,
  };
}

describe("runSession с новыми источниками", () => {
  it("инжестит карточки из источников и скорит их без браузера", async () => {
    const db = openDb(":memory:");
    const src = fakeSource("hirehi", [card("hirehi:1", "hirehi", "LLM Engineer")]);
    const deps = mkDeps(db, [src]);
    const s = await runSession(deps, "manual", "dry_run");
    expect(s.discovered).toBe(1);
    expect(src.search).toHaveBeenCalled();
    const v = repo.getVacancy(db, "hirehi:1")!;
    expect(["queued", "skipped"]).toContain(v.status);   // проскорена, браузер не трогали
    expect((deps.browser.fetchVacancyText as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
  it("падение одного источника не валит прогон", async () => {
    const db = openDb(":memory:");
    const bad: JobSource = { name: "habr", search: vi.fn().mockRejectedValue(new Error("503")), fetchText: vi.fn() };
    const ok = fakeSource("hirehi", [card("hirehi:2", "hirehi", "ML Engineer")]);
    const s = await runSession(mkDeps(db, [bad, ok]), "manual", "dry_run");
    expect(s.discovered).toBe(1);
    expect(s.errors).toBeGreaterThan(0);
    expect(s.stopReason).toBe("completed");
  });
  it("регрессия: скоринг мержит raw_json, не затирая email из trudvsem", async () => {
    const db = openDb(":memory:");
    const tvCard: VacancyInsert = {
      ...card("trudvsem:1", "trudvsem", "Разработчик Python"),
      raw_json: JSON.stringify({ text: "текст вакансии trudvsem", email: "hr@x.ru" }),
    };
    const src = fakeSource("trudvsem", [tvCard]);
    const deps = mkDeps(db, [src]);
    const s = await runSession(deps, "manual", "dry_run");
    expect(s.scored).toBe(1);
    const v = repo.getVacancy(db, "trudvsem:1")!;
    const raw = JSON.parse(v.raw_json ?? "{}") as { text?: string; email?: string };
    expect(raw.email).toBe("hr@x.ru");
    expect(raw.text).toBeTruthy();
  });
  it("не-hh вакансии не попадают в браузерный apply", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, card("hirehi:3", "hirehi", "AI Engineer"));
    repo.setStatus(db, "hirehi:3", "queued", { score: 90, score_reasons: "{}", raw_json: JSON.stringify({ text: "t" }) });
    const deps = mkDeps(db, []);
    await runSession(deps, "manual", "live");
    expect((deps.browser.apply as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
