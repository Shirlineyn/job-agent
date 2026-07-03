// Supervised questionnaire dry-fill: ТЫ кликаешь «Откликнуться» сам, скрипт ловит анкету,
// Claude отвечает из резюме, скрипт заполняет radio + «Свой вариант». SUBMIT НЕ ЖМЁТ.
// Run: npx tsx scripts/probe-questionnaire.ts "https://hh.ru/vacancy/XXXXXXXX"
import "dotenv/config";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { HhBrowser } from "../src/browser/hh.js";
import { openDb } from "../src/state/db.js";
import { loadConfig } from "../src/config.js";
import { callClaude } from "../src/llm/anthropic.js";
import { answerQuestionnaire } from "../src/llm/questionnaire.js";

const url = process.argv[2] || "https://hh.ru/vacancy/134833154";

async function main() {
  const cfg = loadConfig();
  const resume = readFileSync(cfg.resumePath, "utf8");
  const mem = openDb(":memory:");
  const browser = new HhBrowser();
  await browser.launch(join(homedir(), ".hh-agent", "profile"));
  const page = (browser as unknown as { page: Page }).page;

  console.log(`[qn] открываю ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  console.log("[qn] >>> НАЖМИ «Откликнуться» САМ в окне браузера. Жду появления анкеты (до 150с)…");

  const t0 = Date.now();
  while (Date.now() - t0 < 150_000) {
    await new Promise(r => setTimeout(r, 2500));
    if (await browser.isLoggedOut()) { console.log("[qn] разлогинило — залогинься и перезапусти."); await browser.close(); return; }
    if (await browser.hasQuestionnaire()) break;
  }
  if (!(await browser.hasQuestionnaire())) { console.log("[qn] анкета не появилась за 150с (не кликнул / другая вакансия). Выхожу без изменений."); await browser.close(); return; }

  const questions = await browser.extractQuestionnaire();
  console.log(`[qn] анкета найдена: ${questions.length} вопрос(ов). Спрашиваю Claude…`);
  const answers = await answerQuestionnaire({ db: mem, runId: null, vacancyId: null }, callClaude, cfg, resume, questions);

  console.log("\n[qn] === ЧТО ВЫБРАЛ CLAUDE ===");
  for (const q of questions) {
    const a = answers.find(x => x.i === questions.indexOf(q));
    let chosen = "(нет ответа)";
    if (a?.type === "option") chosen = q.options.find(o => o.value === a.value)?.text ?? `value=${a.value}`;
    else if (a?.type === "custom") chosen = `Свой вариант: ${a.text}`;
    console.log(`  • ${q.question}\n      → ${chosen}`);
  }

  console.log("\n[qn] заполняю форму (submit НЕ жму)…");
  await browser.fillQuestionnaire(answers, questions);
  console.log("[qn] готово. Проверь окно браузера — анкета заполнена, отклик НЕ отправлен. Окно закроется через 40с.");
  await new Promise(r => setTimeout(r, 40_000));
  await browser.close();
}

main().catch(async (err) => { console.error("[qn] ERROR:", err); process.exit(1); });
