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
import type { JobSource } from "../sources/types.js";

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
export type Deps = { db: Database; cfg: Config; browser: BrowserPort; claude: typeof callClaude; pplx: typeof callPerplexity; notify: (msg: string) => void; resume: string; sources: JobSource[] };
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
      console.error(`[run ${runId}] browser error #${browserErrorStreak + 1}: ${String(e).replace(/\s+/g, " ").slice(0, 220)}`);
      await sleep(2000, 5000);   // бэкофф: дать сети/hh восстановиться после краткого блипа
      // порог 5 (не 3): прогон фетчит десятки страниц, 3 подряд — часто просто моргание сети,
      // а не поломка; 5 подряд без единого успеха между — уже похоже на реальный сбой.
      if (++browserErrorStreak >= 5) { s.stopReason = "error_streak"; deps.notify("hh-agent: 5 ошибок подряд, останавливаюсь"); return "stop"; }
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

  // 1b) ingest из HTTP-источников: браузер не нужен, ошибка одного источника — не повод
  // останавливать прогон (hh-часть уже отработала, остальные источники независимы). Стадия
  // выполняется вне зависимости от stopReason стадии 1 (даже после captcha/logged_out) —
  // именно поэтому она вставлена между стадиями 1 и 2 без обёртки в if (stopReason === "completed").
  for (const src of deps.sources) {
    try {
      const cards = await src.search(cfg.sourceKeywords, cfg);
      for (const c of cards) if (repo.upsertVacancy(db, c)) s.discovered++;
    } catch (e) {
      s.errors++;
      console.error(`[run ${runId}] source ${src.name} failed: ${String(e).slice(0, 200)}`);
    }
  }

  // 2) filter + score. Потолок скоринга за прогон = 10 × dailyLimit — этого хватает набрать
  // очередь на дневной лимит, но не сканим весь бэклог разом (капча/бюджет); остаток остаётся
  // discovered на следующий прогон. Исчерпали бэклог раньше потолка — просто идём в apply
  // с тем, что набрали (одно-проходно, без до-скана до ровного числа).
  if (s.stopReason === "completed") {
    const blacklist = repo.getBlacklist(db);
    const scoreCap = 10 * cfg.dailyLimit;
    let scoredThisRun = 0;
    // Предохранитель для не-hh fetchText, отдельно по каждому источнику: если источник лёг,
    // каждая его discovered-строка иначе висит по 30-60с таймаута ПОСЛЕДОВАТЕЛЬНО без
    // ограничителя (в отличие от hh-ветки, где guarded уже останавливает прогон после 5 подряд
    // ошибок браузера). Здесь источники независимы — стопать весь прогон из-за одного лежащего
    // источника не нужно, но и жечь минуты на заведомо мёртвый источник тоже нельзя: после 3
    // подряд ошибок конкретного источника пропускаем остальные его строки без сетевого вызова
    // (вакансии остаются discovered и попробуются в следующем прогоне). Успешный fetchText
    // сбрасывает счётчик именно своего источника.
    const sourceErrorStreak = new Map<string, number>();
    for (const v of repo.getByStatus(db, "discovered")) {
      if (scoredThisRun >= scoreCap) break;
      const verdict = applyHardFilters(v, cfg.filters, blacklist);
      if (!verdict.pass) { repo.setStatus(db, v.id, "filtered_out", { filter_reason: verdict.reason }); s.filteredOut++; continue; }
      let text: string;
      if (v.source === "hh") {
        const t = await guarded(() => deps.browser.fetchVacancyText(v.url));
        if (t === "stop") break;
        if (t === "skip") { repo.setStatus(db, v.id, "failed"); continue; }
        text = t;
      } else {
        if ((sourceErrorStreak.get(v.source) ?? 0) >= 3) continue;   // источник лежит — не долбим таймаутами дальше
        const src = deps.sources.find(x => x.name === v.source);
        if (!src) { repo.setStatus(db, v.id, "failed", { filter_reason: "source_disabled" }); continue; }
        try {
          text = await src.fetchText(v);
          sourceErrorStreak.set(v.source, 0);
        } catch (e) {
          s.errors++;
          sourceErrorStreak.set(v.source, (sourceErrorStreak.get(v.source) ?? 0) + 1);
          // транзиентная ошибка — оставляем discovered на следующий прогон
          if (!isTransient(e)) repo.setStatus(db, v.id, "failed");
          continue;
        }
      }
      scoredThisRun++;
      try {
        const score = await scoreVacancy(ctx(v.id), deps.claude, cfg, deps.resume, text);
        s.scored++; llmErrors = 0;   // успех сбрасывает счётчик ПОДРЯД идущих ошибок
        // Мержим, а не заменяем: raw_json может нести полезную нагрузку из источника
        // (например, trudvsem кладёт туда email работодателя для будущего email-flow) —
        // затирание raw_json целиком уничтожало бы её безвозвратно.
        const mergedRaw = { ...(JSON.parse(v.raw_json ?? "{}") as object), text };
        repo.setStatus(db, v.id, score.score >= cfg.scoreThreshold ? "queued" : "skipped",
          { score: score.score, score_reasons: JSON.stringify(score), raw_json: JSON.stringify(mergedRaw) });
      } catch (e) { s.errors++; if (!isTransient(e)) repo.setStatus(db, v.id, "failed"); if (++llmErrors >= 5) { s.stopReason = "error_streak"; break; } }
    }
  }

  // 3) apply (перемешанная очередь, лимит из БД)
  if (s.stopReason === "completed") {
    for (const v of repo.getByStatus(db, "queued").sort(() => Math.random() - 0.5)) {
      // Отклик умеем делать только на hh (браузер). Не-hh queued ждут email-flow (отдельный план).
      if (v.source !== "hh") continue;
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
          llmErrors = 0;   // успешная генерация письма сбрасывает счётчик подряд-ошибок
        }
        // dry-run: письмо сохранено, браузер не трогаем (повторная навигация по одним
        // и тем же вакансиям каждую сессию — заметный анти-бот паттерн, а проверка не нужна).
        if (mode === "dry_run") continue;
        const result = await guarded(() => deps.browser.apply(v.url, letter, false,
          (qs) => answerQuestionnaire(ctx(v.id), deps.claude, cfg, deps.resume, qs)));
        if (result === "stop") break;
        if (result === "skip" || result === "no_button") { repo.setStatus(db, v.id, "failed"); continue; }
        if (result === "applied") { repo.setStatus(db, v.id, "applied", { applied_at: new Date().toISOString() }); s.applied++; llmErrors = 0; await sleep(...cfg.applyPauseMs); }
      } catch (e) { s.errors++; if (!isTransient(e)) repo.setStatus(db, v.id, "failed"); if (++llmErrors >= 5) { s.stopReason = "error_streak"; break; } }
    }
  }

  repo.finishRun(db, runId, { discovered: s.discovered, filtered_out: s.filteredOut, scored: s.scored, applied: s.applied, errors: s.errors, stop_reason: s.stopReason });
  return s;
}
