// Supervised full dry-fill: скрипт кликает «Откликнуться» сам → заполняет анкету (Claude) →
// жмёт «Добавить» и вставляет сопроводительное письмо (Claude+рисёрч). SUBMIT НЕ ЖМЁТ.
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
import { callPerplexity } from "../src/llm/perplexity.js";
import { answerQuestionnaire } from "../src/llm/questionnaire.js";
import { scoreVacancy } from "../src/llm/scoring.js";
import { researchCompany } from "../src/llm/research.js";
import { writeLetter } from "../src/llm/letter.js";

const url = process.argv[2] || "https://hh.ru/vacancy/134833154";
const LETTER_TOGGLE = '[data-qa="vacancy-response-letter-toggle"]';
const LETTER_INPUT = '[data-qa="vacancy-response-popup-form-letter-input"]';

async function main() {
  const cfg = loadConfig();
  const resume = readFileSync(cfg.resumePath, "utf8");
  const mem = openDb(":memory:");
  const ctx = { db: mem, runId: null, vacancyId: null };
  const browser = new HhBrowser();
  await browser.launch(join(homedir(), ".hh-agent", "profile"));
  const page = (browser as unknown as { page: Page }).page;

  console.log(`[qn] открываю ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 2500));

  // текст вакансии + работодатель берём СО СТРАНИЦЫ вакансии (до клика — потом уйдём на форму)
  const title =
    (await page
      .locator("h1")
      .first()
      .textContent()
      .catch(() => "")) || "";
  const body =
    (await page
      .locator('[data-qa="vacancy-description"]')
      .textContent()
      .catch(() => "")) || "";
  const employer =
    (await page
      .locator('[data-qa="vacancy-company-name"]')
      .first()
      .textContent()
      .catch(() => "")) || "работодатель";
  const vacancyText = `${title}\n${body}`.trim();

  const respond = page.locator('[data-qa="vacancy-response-link-top"]').first();
  if ((await respond.count()) === 0) {
    console.log("[qn] нет кнопки отклика — уже откликались/недоступно.");
    await browser.close();
    return;
  }
  console.log("[qn] кликаю «Откликнуться» сам (submit НЕ жму)…");
  await respond.click();

  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await browser.isLoggedOut()) {
      console.log("[qn] разлогинило — залогинься (scripts/login.ts) и перезапусти.");
      await browser.close();
      return;
    }
    if (await browser.hasQuestionnaire()) break;
    const relocate = page.locator('[data-qa="relocation-warning-confirm"]');
    if ((await relocate.count()) > 0) {
      console.log("[qn] релокейт-подтверждение — жму.");
      await relocate.click();
    }
  }

  // --- FLOW-1 (без анкеты): клик отклика УЖЕ отправил отклик, письмо прикладывается после ---
  // Скрипт НЕ жмёт submit сам (контракт probe). Показываем письмо для ручной вставки.
  if ((await page.locator('[data-qa="responded-success-attach-cover-letter"]').count()) > 0) {
    console.log(
      "\n[qn] ⚠⚠ ВАКАНСИЯ БЕЗ АНКЕТЫ: клик «Откликнуться» уже ОТПРАВИЛ отклик (hh, одно резюме).",
    );
    console.log("[qn] Отклик отправлен. Письмо СКРИПТ не прикладывает (контракт: не жму submit).");
    const score = await scoreVacancy(ctx, callClaude, cfg, resume, vacancyText);
    let research = "";
    try {
      research = await researchCompany(ctx, callPerplexity, cfg, employer.trim(), employer.trim());
    } catch (e) {
      console.log("[qn] рисёрч упал (", String(e).slice(0, 60), ") — письмо без справки.");
    }
    const letter = await writeLetter(ctx, callClaude, cfg, {
      resume,
      vacancyText,
      research,
      score,
    });
    console.log(
      "\n[qn] === ПИСЬМО (вставь вручную через «Приложить сопроводительное письмо») ===\n" +
        letter +
        "\n",
    );
    console.log("[qn] Окно открыто 60с для ручных действий.");
    await new Promise((r) => setTimeout(r, 60_000));
    await browser.close();
    return;
  }

  // --- АНКЕТА (если есть) ---
  if (await browser.hasQuestionnaire()) {
    const questions = await browser.extractQuestionnaire();
    console.log(`[qn] анкета: ${questions.length} вопрос(ов). Спрашиваю Claude…`);
    const answers = await answerQuestionnaire(ctx, callClaude, cfg, resume, questions);
    console.log("\n[qn] === ОТВЕТЫ НА АНКЕТУ ===");
    questions.forEach((q, i) => {
      const a = answers.find((x) => x.i === i);
      const chosen =
        a?.type === "option"
          ? (q.options.find((o) => o.value === a.value)?.text ?? `value=${a.value}`)
          : a?.type === "custom"
            ? `Свой вариант: ${a.text}`
            : "(нет ответа)";
      console.log(`  • ${q.question}\n      → ${chosen}`);
    });
    await browser.fillQuestionnaire(answers, questions);
    console.log("[qn] анкета заполнена.");
  } else {
    console.log("[qn] анкеты нет на этой форме — только письмо.");
  }

  // --- ПИСЬМО: жмём «Добавить» (toggle), генерируем и вставляем ---
  console.log("[qn] генерирую сопроводительное письмо (score → рисёрч → письмо)…");
  const score = await scoreVacancy(ctx, callClaude, cfg, resume, vacancyText);
  let research = "";
  try {
    research = await researchCompany(ctx, callPerplexity, cfg, employer.trim(), employer.trim());
  } catch (e) {
    console.log("[qn] рисёрч упал (", String(e).slice(0, 60), ") — пишу письмо без справки.");
  }
  const letter = await writeLetter(ctx, callClaude, cfg, { resume, vacancyText, research, score });
  console.log("\n[qn] === ПИСЬМО ===\n" + letter + "\n");

  const toggle = page.locator(LETTER_TOGGLE);
  if ((await toggle.count()) > 0) {
    console.log("[qn] жму «Добавить» (letter-toggle)…");
    await toggle.click();
    await new Promise((r) => setTimeout(r, 1200));
  }
  const input = page.locator(LETTER_INPUT);
  if ((await input.count()) > 0) {
    await input.fill(letter);
    console.log("[qn] письмо вставлено в поле.");
  } else
    console.log("[qn] поле письма не появилось после «Добавить» — проверь селектор LETTER_INPUT.");

  console.log(
    "\n[qn] ГОТОВО: анкета + письмо заполнены, отклик НЕ отправлен. Проверь окно. Закроется через 45с.",
  );
  await new Promise((r) => setTimeout(r, 45_000));
  await browser.close();
}

main().catch(async (err) => {
  console.error("[qn] ERROR:", err);
  process.exit(1);
});
