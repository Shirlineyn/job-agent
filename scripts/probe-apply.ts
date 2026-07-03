// Supervised inspection of the hh.ru apply form + any employer questionnaire.
// Run: npx tsx scripts/probe-apply.ts "https://hh.ru/vacancy/XXXXXXXX"
//
// ⚠️ ВНИМАНИЕ: скрипт КЛИКАЕТ «Откликнуться». На аккаунте с одним резюме hh может
// по этому клику СРАЗУ отправить отклик (необратимо). Скрипт сам submit НЕ жмёт, но
// за риск клика отвечает запускающий. Запускай под присмотром, на вакансии, на которую
// НЕ жалко откликнуться. Ничего не отправляет специально; дампит разметку формы в tmp/.
//
// Цель: снять реальную разметку формы отклика (letterToggle/letterInput/submit) и
// увидеть, как выглядит дополнительный опросник работодателя — чтобы строить обработчик
// опросника против настоящего DOM, а не угадывать селекторы.
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { HhBrowser } from "../src/browser/hh.js";

const url = process.argv[2];
if (!url || !/hh\.ru\/vacancy\/\d+/.test(url)) {
  console.error('Укажи URL вакансии: npx tsx scripts/probe-apply.ts "https://hh.ru/vacancy/123456"');
  process.exit(2);
}

async function main() {
  const browser = new HhBrowser();
  await browser.launch(join(homedir(), ".hh-agent", "profile"));
  const page = (browser as unknown as { page: Page }).page;
  const outDir = join(process.cwd(), "tmp");
  await mkdir(outDir, { recursive: true });

  console.log(`[probe-apply] открываю ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, 2500));
  console.log("[probe-apply] isLoggedOut:", await browser.isLoggedOut(), "| isCaptcha:", await browser.isCaptcha());

  const respond = page.locator('[data-qa="vacancy-response-link-top"]').first();
  const respondCount = await respond.count();
  console.log("[probe-apply] кнопка отклика найдена:", respondCount > 0);
  if (respondCount === 0) { console.log("[probe-apply] нет кнопки — уже откликались или отклик недоступен. Выхожу без клика."); await browser.close(); return; }

  console.log("[probe-apply] КЛИКАЮ «Откликнуться» (submit НЕ нажимаю)…");
  await respond.click();
  await new Promise(r => setTimeout(r, 3500));
  console.log("[probe-apply] после клика: isLoggedOut:", await browser.isLoggedOut(), "| isCaptcha:", await browser.isCaptcha());
  console.log("[probe-apply] URL сейчас:", page.url());

  // Слепок структуры: типы полей + все data-qa, релевантные форме/опроснику.
  const info = await page.evaluate(() => {
    const q = (sel: string) => document.querySelectorAll(sel).length;
    const dq = new Set<string>();
    document.querySelectorAll<HTMLElement>("[data-qa]").forEach(el => {
      const v = el.getAttribute("data-qa") || "";
      if (/response|letter|task|question|test|cover|submit|popup|relocat/i.test(v)) dq.add(v);
    });
    // «вопросы»: подписи/лейблы рядом с полями ввода в модалке отклика
    const labels: string[] = [];
    document.querySelectorAll<HTMLElement>("label, [data-qa*='question'], [data-qa*='task']").forEach(el => {
      const t = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (t && t.length > 3 && t.length < 200) labels.push(t);
    });
    return {
      textareas: q("textarea"),
      textInputs: q("input[type='text'], input:not([type])"),
      radios: q("input[type='radio']"),
      checkboxes: q("input[type='checkbox']"),
      selects: q("select"),
      letterInput: q('[data-qa="vacancy-response-popup-form-letter-input"]'),
      letterToggle: q('[data-qa="vacancy-response-letter-toggle"]'),
      submitBtn: q('[data-qa="vacancy-response-submit-popup"]'),
      alreadyApplied: /Вы откликнулись|Отклик доставлен|Резюме отправлено|Вы уже откликались/i.test(document.body.innerText),
      dataQa: [...dq].sort(),
      labels: labels.slice(0, 40),
    };
  });
  console.log("\n[probe-apply] === СОСТОЯНИЕ ФОРМЫ ===");
  console.log(JSON.stringify(info, null, 2));
  if (info.alreadyApplied) console.log("\n⚠️ ПОХОЖЕ, ОТКЛИК УЖЕ ОТПРАВЛЕН по клику (см. alreadyApplied=true) — учти это.");
  if (info.letterInput === 0 && info.textareas === 0) console.log("[probe-apply] поля письма не видно — возможно, отклик ушёл сразу, либо форма в отдельном роуте.");
  if (info.textareas + info.radios + info.checkboxes + info.selects > (info.letterInput || 0)) console.log("[probe-apply] похоже на ОПРОСНИК: есть поля помимо письма (см. labels/типы выше).");

  const html = await page.content();
  await writeFile(join(outDir, "apply-page.html"), html, "utf-8");
  console.log("\n[probe-apply] полный HTML сохранён → tmp/apply-page.html (для разбора селекторов). SUBMIT не нажимался.");
  await browser.close();
}

main().catch(async (err) => { console.error("[probe-apply] ERROR:", err); process.exit(1); });
