// src/pipeline/run.ts
import type { Database } from "better-sqlite3";
import * as repo from "../state/repo.js";
import { applyHardFilters } from "../filters.js";
import { scoreVacancy } from "../llm/scoring.js";
import { researchCompany } from "../llm/research.js";
import { writeLetter } from "../llm/letter.js";
import { answerQuestionnaire } from "../llm/questionnaire.js";
import { CaptchaDetected, LoggedOut, type HhBrowser } from "../browser/hh.js";
import { sleep } from "../browser/humanize.js";
import type { Config } from "../config.js";
import type { callClaude } from "../llm/anthropic.js";
import type { callPerplexity } from "../llm/perplexity.js";

// Транзиентный сбой (API-хиккап: Perplexity/Anthropic 403/408/429/5xx, timeout, сеть)
// стоит повторить в СЛЕДУЮЩЕЙ сессии, а не помечать вакансию failed навсегда. Контентные
// ошибки (письмо не прошло валидацию дважды, невалидный JSON скоринга) — не транзиентные.
function isTransient(e: unknown): boolean {
  const msg = String(e);
  if (/letter failed validation|InvalidScoreJson|no json object/i.test(msg)) return false;
  return /(?:^|\D)(403|408|429|5\d\d)(?:\D|$)/.test(msg)
    || /timeout|timed out|ECONN|socket hang|network|fetch failed|aborted/i.test(msg);
}

export type BrowserPort = Pick<HhBrowser, "searchVacancies" | "fetchVacancyText" | "apply" | "waitCaptchaCleared">;
export type Deps = { db: Database; cfg: Config; browser: BrowserPort; claude: typeof callClaude; pplx: typeof callPerplexity; notify: (msg: string) => void; resume: string };
export type RunSummary = { runId: number; discovered: number; filteredOut: number; scored: number; applied: number; errors: number; stopReason: string };

export async function runSession(deps: Deps, trigger: "schedule" | "manual", modeOverride?: "live" | "dry_run"): Promise<RunSummary> {
  const { db, cfg } = deps;
  const mode = modeOverride ?? cfg.mode;
  const runId = repo.startRun(db, trigger, mode);
  const s: RunSummary = { runId, discovered: 0, filteredOut: 0, scored: 0, applied: 0, errors: 0, stopReason: "completed" };
  let llmErrors = 0, browserErrorStreak = 0;
  const ctx = (vacancyId: string | null) => ({ db, runId, vacancyId });

  const guarded = async <T>(fn: () => Promise<T>): Promise<T | "stop" | "skip"> => {
    try { const r = await fn(); browserErrorStreak = 0; return r; }
    catch (e) {
      if (e instanceof CaptchaDetected) {
        deps.notify("hh-agent: капча! Пройди её в открытом окне браузера (жду до 30 минут)");
        if (await deps.browser.waitCaptchaCleared(30 * 60_000)) return "skip";
        s.stopReason = "captcha"; return "stop";
      }
      if (e instanceof LoggedOut) { deps.notify("hh-agent: разлогинило на hh.ru — залогинься в окне браузера"); s.stopReason = "logged_out"; return "stop"; }
      s.errors++;
      if (++browserErrorStreak >= 3) { s.stopReason = "error_streak"; deps.notify("hh-agent: 3 ошибки подряд, останавливаюсь"); return "stop"; }
      return "skip";
    }
  };

  // 1) discover
  outer: for (const q of cfg.searchQueries) {
    const found = await guarded(() => deps.browser.searchVacancies(q, cfg.area));
    if (found === "stop") break outer;
    if (found === "skip") continue;
    for (const card of found) if (repo.upsertVacancy(db, card)) s.discovered++;
  }
  // hh-рекомендации: пустой запрос + дефолтный (релевантный/персональный под резюме) порядок —
  // свежие И релевантные; на практике основной источник (keyword-поиск даёт мало нового). Только
  // если discover ещё не остановился по капче/разлогину.
  if (s.stopReason === "completed") {
    const rec = await guarded(() => deps.browser.searchVacancies("", cfg.area, "default"));
    if (rec !== "stop" && rec !== "skip") for (const card of rec) if (repo.upsertVacancy(db, card)) s.discovered++;
  }

  // 2) filter + score
  if (s.stopReason === "completed") {
    const blacklist = repo.getBlacklist(db);
    for (const v of repo.getByStatus(db, "discovered")) {
      const verdict = applyHardFilters(v, cfg.filters, blacklist);
      if (!verdict.pass) { repo.setStatus(db, v.id, "filtered_out", { filter_reason: verdict.reason }); s.filteredOut++; continue; }
      const text = await guarded(() => deps.browser.fetchVacancyText(v.url));
      if (text === "stop") break;
      if (text === "skip") { repo.setStatus(db, v.id, "failed"); continue; }
      try {
        const score = await scoreVacancy(ctx(v.id), deps.claude, cfg, deps.resume, text);
        s.scored++;
        repo.setStatus(db, v.id, score.score >= cfg.scoreThreshold ? "queued" : "skipped",
          { score: score.score, score_reasons: JSON.stringify(score), raw_json: JSON.stringify({ text }) });
      } catch (e) { s.errors++; if (!isTransient(e)) repo.setStatus(db, v.id, "failed"); if (++llmErrors >= 5) { s.stopReason = "error_streak"; break; } }
    }
  }

  // 3) apply (перемешанная очередь, лимит из БД)
  if (s.stopReason === "completed") {
    for (const v of repo.getByStatus(db, "queued").sort(() => Math.random() - 0.5)) {
      if (repo.appliedToday(db) >= cfg.dailyLimit) { s.stopReason = "daily_limit"; break; }
      try {
        // Письмо генерируем только один раз: если оно уже есть (прошлая dry-run сессия),
        // не переписываем — иначе жжём LLM-бюджет и затираем уже проверенный пользователем текст.
        let letter = v.letter;
        if (!letter) {
          const research = await researchCompany(ctx(v.id), deps.pplx, cfg, v.employer_id ?? v.employer_name, v.employer_name);
          const text = (JSON.parse(v.raw_json ?? "{}") as { text?: string }).text ?? v.title;
          letter = await writeLetter(ctx(v.id), deps.claude, cfg, { resume: deps.resume, vacancyText: text, research, score: JSON.parse(v.score_reasons ?? "{}") });
          repo.setStatus(db, v.id, "queued", { letter });
        }
        // dry-run: письмо сохранено, браузер не трогаем (повторная навигация по одним
        // и тем же вакансиям каждую сессию — заметный анти-бот паттерн, а проверка не нужна).
        if (mode === "dry_run") continue;
        const result = await guarded(() => deps.browser.apply(v.url, letter, false,
          (qs) => answerQuestionnaire(ctx(v.id), deps.claude, cfg, deps.resume, qs)));
        if (result === "stop") break;
        if (result === "skip" || result === "no_button") { repo.setStatus(db, v.id, "failed"); continue; }
        if (result === "applied") { repo.setStatus(db, v.id, "applied", { applied_at: new Date().toISOString() }); s.applied++; await sleep(...cfg.applyPauseMs); }
      } catch (e) { s.errors++; if (!isTransient(e)) repo.setStatus(db, v.id, "failed"); if (++llmErrors >= 5) { s.stopReason = "error_streak"; break; } }
    }
  }

  repo.finishRun(db, runId, { discovered: s.discovered, filtered_out: s.filteredOut, scored: s.scored, applied: s.applied, errors: s.errors, stop_reason: s.stopReason });
  return s;
}
