// tests/pipeline-email-gate.test.ts
import { describe, it, expect, vi } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { runSession, type Deps } from "../src/pipeline/run.js";
import { ConfigSchema } from "../src/config.js";
import type { VacancyInsert } from "../src/state/types.js";

const card = (id: string, employerId: string, email?: string | null): VacancyInsert => ({
  id,
  url: "https://x.test/" + id,
  title: "ML " + id,
  employer_id: employerId,
  employer_name: "Emp " + employerId,
  salary_from: 300000,
  salary_to: null,
  currency: "RUR",
  work_format: "remote",
  experience: null,
  published_at: new Date().toISOString(),
  raw_json: JSON.stringify({ text: "текст про LLM", email: email ?? null }),
  source: "trudvsem",
});

function mkDeps(db: ReturnType<typeof openDb>, pplxImpl: (...a: never[]) => Promise<string>): Deps {
  return {
    db,
    cfg: ConfigSchema.parse({ mode: "dry_run", searchQueries: [], enabledSources: [] }),
    browser: {
      searchVacancies: vi.fn().mockResolvedValue([]),
      fetchVacancyText: vi.fn(),
      apply: vi.fn(),
      waitCaptchaCleared: vi.fn(),
    },
    // scoreVacancy (src/llm/scoring.ts) валидирует полную схему через zod — salary_match/seniority_match
    // обязательны, иначе parseScore бросит InvalidScoreJson и вакансия уйдёт в failed вместо queued/skipped
    // (санкционированное отклонение от упрощённого мока из брифа — образец из tests/pipeline-sources.test.ts).
    // Дополнительно (ещё одно отклонение, тем же мотивом): для hh-кейса очередь доходит до стадии 3
    // (apply) уже в dry_run — там claude вызывается с purpose "letter", и текст должен пройти
    // validateLetter (100-220 слов, подпись "Доронин"), иначе письмо провалится дважды и статус
    // будет "failed" вместо "queued" — по причине, не связанной с email-гейтом. Различаем purpose,
    // как это уже сделано в tests/pipeline.test.ts.
    claude: vi.fn(async (_c: unknown, o: { purpose: string }) =>
      o.purpose === "scoring"
        ? JSON.stringify({
            score: 80,
            reasons: [],
            red_flags: [],
            salary_match: "match",
            seniority_match: "match",
          })
        : "Здравствуйте! Я ИИ-агент, действующий по поручению Александра Доронина. " +
          "слово ".repeat(130) +
          "Доронин",
    ),
    pplx: vi.fn(pplxImpl) as never,
    notify: vi.fn(),
    resume: "резюме",
    sources: [
      {
        name: "trudvsem",
        search: vi.fn().mockResolvedValue([]),
        fetchText: vi.fn().mockResolvedValue("текст про LLM"),
      },
    ] as never,
  };
}

describe("email-гейт до скоринга", () => {
  it("почта из payload → скоринг выполняется, почта в кэше", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, card("trudvsem:1", "t:1", "hr@cpl.ru"));
    const deps = mkDeps(db, async () => "research");
    await runSession(deps, "manual", "dry_run");
    expect(repo.getVacancy(db, "trudvsem:1")!.status).toBe("queued");
    expect(repo.getCompanyEmail(db, "t:1")).toMatchObject({ email: "hr@cpl.ru" });
  });
  it("почта не найдена → skipped/no_email, скоринг НЕ вызывался", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, card("trudvsem:2", "t:2"));
    const deps = mkDeps(db, async () => '{"email": null}');
    await runSession(deps, "manual", "dry_run");
    const v = repo.getVacancy(db, "trudvsem:2")!;
    expect(v.status).toBe("skipped");
    expect(v.filter_reason).toBe("no_email");
    expect(deps.claude).not.toHaveBeenCalled();
  });
  it("hh-вакансии гейт не касается", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, { ...card("hh1", "e1", null), id: "hh1", source: "hh" });
    const deps = mkDeps(db, async () => '{"email": null}');
    // fetchVacancyText для hh
    (deps.browser.fetchVacancyText as ReturnType<typeof vi.fn>).mockResolvedValue(
      "текст hh-вакансии",
    );
    await runSession(deps, "manual", "dry_run");
    expect(repo.getVacancy(db, "hh1")!.status).toBe("queued"); // проскорена без гейта
  });
});
