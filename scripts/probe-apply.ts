// Supervised, multi-step inspection of the hh.ru apply flow: respond → (region/relocation
// menu, auto-passed, no AI) → letter form + employer questionnaire (анкета). Captures the
// real DOM at every step to tmp/apply-step{N}.html so we build handlers against real markup.
// The final submit is NEVER clicked.
//
// Run: npx tsx scripts/probe-apply.ts "https://hh.ru/vacancy/XXXXXXXX"
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

// Считаем всё из Node через локаторы + плоские $$eval (без page.evaluate с вложенными
// именованными хелперами — иначе tsx/esbuild ломает контекст браузера через __name).
async function snapshot(page: Page) {
  const c = (sel: string) => page.locator(sel).count();
  const [textarea, textInput, radio, checkbox, select, letterInput, letterToggle, submit] = await Promise.all([
    c("textarea"), c("input[type='text'], input:not([type])"), c("input[type='radio']"),
    c("input[type='checkbox']"), c("select"),
    c('[data-qa="vacancy-response-popup-form-letter-input"]'),
    c('[data-qa="vacancy-response-letter-toggle"]'),
    c('[data-qa="vacancy-response-submit-popup"]'),
  ]);
  const dataQaRaw = await page.$$eval("[data-qa]", els => els.map(e => e.getAttribute("data-qa") || ""));
  const dataQa = [...new Set(dataQaRaw.filter(v => /response|letter|task|question|test|cover|submit|popup|relocat|region|area|city|confirm/i.test(v)))].sort();
  const labelsRaw = await page.$$eval("label, [data-qa*='question'], [data-qa*='task'], fieldset legend",
    els => els.map(e => (e.textContent || "").replace(/\s+/g, " ").trim()));
  const labels = [...new Set(labelsRaw.filter(t => t.length > 3 && t.length < 220))].slice(0, 40);
  const btnsRaw = await page.$$eval("button, [role='button'], a[data-qa]",
    els => els.map(e => ((e.textContent || "").replace(/\s+/g, " ").trim() + "\t" + (e.getAttribute("data-qa") || ""))));
  const buttons = [...new Set(btnsRaw.map(x => { const [t, d] = x.split("\t"); return t && t.length < 40 ? (d ? `${t} [${d}]` : t) : ""; }).filter(Boolean))].slice(0, 25);
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return {
    url: page.url(), textarea, textInput, radio, checkbox, select, letterInput, letterToggle, submit,
    alreadyApplied: /Вы откликнулись|Отклик доставлен|Резюме отправлено|Вы уже откликались/i.test(bodyText),
    dataQa, buttons, labels,
  };
}

function reachedForm(s: Awaited<ReturnType<typeof snapshot>>): boolean {
  return s.letterInput > 0 || s.textarea > 0 || s.radio > 0 || s.select > 0;
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
  if (await respond.count() === 0) { console.log("[probe-apply] нет кнопки отклика — уже откликались/недоступно. Выхожу."); await browser.close(); return; }
  console.log("[probe-apply] КЛИКАЮ «Откликнуться» (финальный submit НЕ нажимаю)…");
  await respond.click();

  for (let step = 1; step <= 4; step++) {
    await new Promise(r => setTimeout(r, 3000));
    const s = await snapshot(page);
    await writeFile(join(outDir, `apply-step${step}.html`), await page.content(), "utf-8");
    console.log(`\n[probe-apply] ─── ШАГ ${step} ───`);
    console.log(JSON.stringify(s, null, 2));
    if (s.alreadyApplied) { console.log("⚠️ отклик, похоже, уже отправлен."); break; }
    if (reachedForm(s)) { console.log(`[probe-apply] дошли до формы/анкеты (шаг ${step}) — снимаю и останавливаюсь ДО submit.`); break; }

    const relocate = page.locator('[data-qa="relocation-warning-confirm"]');
    if (await relocate.count() > 0) { console.log("[probe-apply] relocation confirm найден — жму."); await relocate.click(); continue; }
    const advance = page.locator('button:visible, [role="button"]:visible').filter({ hasText: /продолжить|далее|подтвердить|выбрать|откликнуться/i });
    const n = await advance.count();
    let clicked = false;
    for (let i = 0; i < n; i++) {
      const el = advance.nth(i);
      const dq = await el.getAttribute("data-qa");
      if (dq && dq.includes("submit-popup")) continue;   // финальный submit — не жмём
      console.log(`[probe-apply] жму advance: «${(await el.textContent())?.trim()}» [${dq ?? "no-dqa"}]`);
      await el.click(); clicked = true; break;
    }
    if (!clicked) { console.log("[probe-apply] нет кнопки прохода дальше — стоп на текущем шаге."); break; }
  }

  console.log("\n[probe-apply] снимки → tmp/apply-step*.html. Финальный submit НЕ нажимался.");
  await browser.close();
}

main().catch(async (err) => { console.error("[probe-apply] ERROR:", err); process.exit(1); });
