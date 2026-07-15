// tests/pipeline-email-drafts.test.ts
import { describe, it, expect, vi } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { runSession, type Deps } from "../src/pipeline/run.js";
import { ConfigSchema } from "../src/config.js";
import type { VacancyInsert } from "../src/state/types.js";

const queuedVac = (db: ReturnType<typeof openDb>, id: string): void => {
  const v: VacancyInsert = {
    id,
    url: "https://x.test/" + id,
    title: "LLM Engineer",
    employer_id: "h:acme",
    employer_name: "Acme",
    salary_from: null,
    salary_to: null,
    currency: null,
    work_format: "remote",
    experience: null,
    published_at: null,
    raw_json: JSON.stringify({ text: "текст" }),
    source: "hirehi",
  };
  repo.upsertVacancy(db, v);
  repo.setStatus(db, id, "queued", {
    score: 90,
    score_reasons: JSON.stringify({ score: 90, reasons: [], red_flags: [] }),
  });
};

function mkDeps(db: ReturnType<typeof openDb>): Deps {
  return {
    db,
    cfg: ConfigSchema.parse({ mode: "dry_run", searchQueries: [], enabledSources: [] }),
    browser: {
      searchVacancies: vi.fn().mockResolvedValue([]),
      fetchVacancyText: vi.fn(),
      apply: vi.fn(),
      waitCaptchaCleared: vi.fn(),
    },
    // Упрощённый мок из брифа ("Здравствуйте! Я Александр...") не проходит validateLetter
    // (src/llm/letter.ts: 100-220 слов, подпись "Доронин") — санкционированная замена мока,
    // не production-кода, по тому же образцу, что в tests/pipeline-email-gate.test.ts. В этом
    // тесте вакансия попадает в очередь напрямую (queuedVac), минуя стадию скоринга, поэтому
    // единственный вызов claude здесь — с purpose "letter"; дифференциация по purpose не нужна.
    claude: vi
      .fn()
      .mockResolvedValue(
        "Здравствуйте! Я ИИ-агент, действующий по поручению Александра Доронина. " +
          "слово ".repeat(130) +
          "Доронин",
      ) as never,
    pplx: vi.fn().mockResolvedValue("справка о компании") as never,
    notify: vi.fn(),
    resume: "резюме",
    sources: [] as never,
  };
}

describe("черновики писем", () => {
  it("для queued не-hh с почтой создаётся draft с темой и телом", async () => {
    const db = openDb(":memory:");
    queuedVac(db, "hirehi:1");
    repo.saveCompanyEmail(db, "h:acme", "Acme", "hr@acme.ru", "perplexity");
    const deps = mkDeps(db);
    await runSession(deps, "manual", "dry_run");
    const e = repo.getEmailByVacancy(db, "hirehi:1")!;
    expect(e.to_email).toBe("hr@acme.ru");
    expect(e.subject).toContain("LLM Engineer");
    expect(e.status).toBe("draft");
    expect(e.body.length).toBeGreaterThan(10);
    expect(repo.getVacancy(db, "hirehi:1")!.letter).toBe(e.body);
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("1"));
  });
  it("повторный прогон не пересоздаёт и не перетирает черновик", async () => {
    const db = openDb(":memory:");
    queuedVac(db, "hirehi:2");
    repo.saveCompanyEmail(db, "h:acme", "Acme", "hr@acme.ru", "perplexity");
    const deps = mkDeps(db);
    await runSession(deps, "manual", "dry_run");
    const before = repo.getEmailByVacancy(db, "hirehi:2")!;
    repo.updateEmailDraft(db, before.id, { body: "правленый вручную" });
    await runSession(deps, "manual", "dry_run");
    expect(repo.getEmailByVacancy(db, "hirehi:2")!.body).toBe("правленый вручную");
    expect(repo.getEmailsByStatus(db, "draft")).toHaveLength(1);
  });
});
