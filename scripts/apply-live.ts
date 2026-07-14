// Ограниченный apply на КОНКРЕТНЫЕ вакансии по id (не «все queued»). Двухфазно, чтобы
// письма можно было проверить ПЕРЕД отправкой:
//   npx tsx scripts/apply-live.ts letters <id> [<id> ...]  → сгенерить письма (рисёрч+письмо),
//                                                             сохранить в БД, показать. НЕ отправляет.
//   npx tsx scripts/apply-live.ts submit  <id> [<id> ...]  → LIVE: реально отправить отклики,
//                                                             используя сохранённые письма (генерит, если нет).
// Уважает dailyLimit. Стоп на капче/разлогине. Анкету заполняет через answerQuestionnaire.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { HhBrowser, CaptchaDetected, LoggedOut } from "../src/browser/hh.js";
import { openDb } from "../src/state/db.js";
import { loadConfig, type Config } from "../src/config.js";
import * as repo from "../src/state/repo.js";
import type { VacancyRow } from "../src/state/types.js";
import { callClaude } from "../src/llm/anthropic.js";
import { callPerplexity } from "../src/llm/perplexity.js";
import { researchCompany } from "../src/llm/research.js";
import { writeLetter } from "../src/llm/letter.js";
import { answerQuestionnaire } from "../src/llm/questionnaire.js";

const cmd = process.argv[2];
const ids = process.argv.slice(3);

// Транзиентные сбои провайдеров (403/429/5xx/timeout/сеть) — периодические edge-хиккапы
// (видели у Perplexity и у Anthropic). Повторяем с бэкоффом; контентные ошибки пробрасываем.
async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!/40[38]|429|5\d\d|timeout|timed out|network|fetch failed|ECONN/i.test(String(e)))
        throw e;
      console.log(`  транзиент (${String(e).slice(0, 40)}), повтор ${i + 1}/${tries - 1}…`);
      await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    }
  }
  throw last;
}

async function genLetter(
  db: Database,
  cfg: Config,
  resume: string,
  v: VacancyRow,
  runId: number,
): Promise<string> {
  const ctx = { db, runId, vacancyId: v.id };
  let research = "";
  try {
    research = await retry(() =>
      researchCompany(ctx, callPerplexity, cfg, v.employer_id ?? v.employer_name, v.employer_name),
    );
  } catch (e) {
    console.log("  рисёрч упал (", String(e).slice(0, 50), ") — письмо без справки.");
  }
  const text = (JSON.parse(v.raw_json ?? "{}") as { text?: string }).text ?? v.title;
  const score = JSON.parse(v.score_reasons ?? "{}");
  return retry(() =>
    writeLetter(ctx, callClaude, cfg, { resume, vacancyText: text, research, score }),
  );
}

function pause(cfg: Config): Promise<void> {
  const [lo, hi] = cfg.applyPauseMs ?? [8000, 15000];
  return new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)));
}

async function main() {
  if (cmd !== "letters" && cmd !== "submit") {
    console.log("usage: apply-live.ts letters|submit <id> [<id> ...]");
    process.exit(1);
  }
  if (ids.length === 0) {
    console.log("укажи id вакансий");
    process.exit(1);
  }
  const cfg = loadConfig();
  const resume = readFileSync(cfg.resumePath, "utf8");
  const db = openDb(join(homedir(), ".hh-agent", "state.db"));

  if (cmd === "letters") {
    const runId = repo.startRun(db, "manual", "dry_run");
    const failed: string[] = [];
    for (const id of ids) {
      const v = repo.getVacancy(db, id);
      if (!v) {
        console.log(`[${id}] нет в БД`);
        continue;
      }
      console.log(`\n=== [${v.score}] ${v.employer_name} — ${v.title} ===`);
      try {
        const letter = await genLetter(db, cfg, resume, v, runId);
        repo.setStatus(db, id, "queued", { letter });
        console.log(letter);
      } catch (e) {
        console.log(`  ✖ письмо не сгенерилось: ${String(e).slice(0, 80)}`);
        failed.push(id);
      }
    }
    repo.finishRun(db, runId, { stop_reason: "letters_only" });
    console.log(
      failed.length
        ? `\n⚠ Не сгенерились: ${failed.join(" ")} — перезапусти letters на них.`
        : "\nВсе письма сгенерированы и сохранены.",
    );
    console.log("Отправка: apply-live.ts submit <id> ...");
    return;
  }

  // submit — LIVE, реальные отклики
  console.log(
    `⚠ LIVE — реальные отклики. Вакансий: ${ids.length}. dailyLimit=${cfg.dailyLimit}, уже сегодня=${repo.appliedToday(db)}.`,
  );
  const runId = repo.startRun(db, "manual", "live");
  const browser = new HhBrowser();
  await browser.launch(join(homedir(), ".hh-agent", "profile"));
  let applied = 0,
    stop = "completed";
  try {
    for (const id of ids) {
      if (repo.appliedToday(db) >= cfg.dailyLimit) {
        console.log("дневной лимит достигнут — стоп.");
        stop = "daily_limit";
        break;
      }
      const v = repo.getVacancy(db, id);
      if (!v) {
        console.log(`[${id}] нет в БД`);
        continue;
      }
      const ctx = { db, runId, vacancyId: id };
      let letter = v.letter;
      if (!letter) {
        console.log(`[${id}] письма нет — генерирую…`);
        try {
          letter = await genLetter(db, cfg, resume, v, runId);
          repo.setStatus(db, id, "queued", { letter });
        } catch (e) {
          console.log(
            `  ✖ письмо не сгенерилось (${String(e).slice(0, 60)}) — пропускаю, отклик НЕ шлю.`,
          );
          continue;
        }
      }
      console.log(`\n→ [${v.score}] ${v.employer_name} — ${v.title}`);
      // Транзиентный сбой (403 в answerQuestionnaire, сеть) НЕ должен ронять весь батч —
      // пропускаем вакансию (остаётся в очереди на ретрай). Капча/разлогин → общий стоп.
      try {
        const result = await browser.apply(v.url, letter, false, (qs) =>
          answerQuestionnaire(ctx, callClaude, cfg, resume, qs),
        );
        if (result === "applied") {
          repo.setStatus(db, id, "applied", { applied_at: new Date().toISOString() });
          applied++;
          console.log("  ✔ отправлено.");
          await pause(cfg);
        } else {
          repo.setStatus(db, id, "failed");
          console.log("  ✖ не отправлено:", result);
        }
      } catch (e) {
        if (e instanceof CaptchaDetected || e instanceof LoggedOut) throw e;
        console.log(
          `  ✖ ошибка на отклике (${String(e).slice(0, 60)}) — пропускаю, вакансия остаётся в очереди`,
        );
      }
    }
  } catch (e) {
    if (e instanceof CaptchaDetected) {
      stop = "captcha";
      console.log("КАПЧА — стоп. Пройди в окне и перезапусти.");
    } else if (e instanceof LoggedOut) {
      stop = "logged_out";
      console.log("РАЗЛОГИН — стоп. Залогинься (scripts/login.ts).");
    } else {
      stop = "error";
      console.log("ERROR:", e);
    }
  }
  repo.finishRun(db, runId, { applied, stop_reason: stop });
  console.log(`\nИтог: отправлено ${applied} из ${ids.length}. stop=${stop}`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
