// One-off live selector verification probe against real hh.ru pages.
// Run: npx tsx scripts/probe.ts
//
// Note: hh.ru search/vacancy pages are publicly viewable without login.
// For THIS PROBE ONLY we bypass HhBrowser's logout guard (which throws
// LoggedOut) so we can still verify parsing against the public pages.
// src/browser/hh.ts itself is left untouched — guard()/isLoggedOut()
// behavior is not weakened there.
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { HhBrowser } from "../src/browser/hh.js";
import type { VacancyInsert } from "../src/state/types.js";

const SEL = {
  card: '[data-qa="vacancy-serp__vacancy"]',
  title: '[data-qa="serp-item__title"]',
  employer: '[data-qa="vacancy-serp__vacancy-employer"]',
  compensation: '[data-qa*="compensation"]',
  description: '[data-qa="vacancy-description"]',
};

// Duplicate of HhBrowser's card extraction, used only when isLoggedOut()
// causes guard() to throw before searchVacancies() can return.
async function extractCardsDirect(page: Page): Promise<VacancyInsert[]> {
  return page.$$eval(SEL.card, (cards, sel) => cards.map(c => {
    const a = c.querySelector<HTMLAnchorElement>(sel.title);
    const href = a?.href ?? "";
    const salaryText = c.querySelector(sel.compensation)?.textContent ?? "";
    const nums = [...salaryText.matchAll(/[\d\s ]{4,}/g)].map(m => Number(m[0].replace(/\D/g, "")));
    return {
      id: href.match(/vacancy\/(\d+)/)?.[1] ?? "",
      url: href.split("?")[0],
      title: a?.textContent?.trim() ?? "",
      employer_id: c.querySelector<HTMLAnchorElement>(sel.employer)?.href?.match(/employer\/(\d+)/)?.[1] ?? null,
      employer_name: c.querySelector(sel.employer)?.textContent?.trim() ?? "",
      salary_from: nums[0] ?? null, salary_to: nums[1] ?? nums[0] ?? null,
      currency: salaryText.includes("₽") ? "RUR" : salaryText ? "OTHER" : null,
      work_format: (/удал[её]нн/i.test(c.textContent ?? "") ? "remote" : /гибрид/i.test(c.textContent ?? "") ? "hybrid" : "unknown") as VacancyInsert["work_format"],
      experience: null, published_at: null,
      raw_json: JSON.stringify({ card: c.textContent?.slice(0, 2000) }),
    };
  }), SEL).then(list => list.filter(v => v.id));
}

async function main() {
  const profileDir = join(homedir(), ".hh-agent", "profile");
  const browser = new HhBrowser();
  await browser.launch(profileDir);
  const page = (browser as unknown as { page: Page }).page;

  console.log("[probe] isLoggedOut():", await browser.isLoggedOut());
  console.log("[probe] isCaptcha():", await browser.isCaptcha());

  let cards: VacancyInsert[] = [];
  try {
    cards = await browser.searchVacancies('"AI-инженер" OR "LLM"', 1);
  } catch (err) {
    console.log(`[probe] searchVacancies() threw (${(err as Error).message}) — bypassing guard for probe purposes only.`);
    cards = await extractCardsDirect(page);
  }

  console.log(`[probe] cards found: ${cards.length}`);
  console.log("[probe] first 3 cards:");
  console.log(JSON.stringify(cards.slice(0, 3), null, 2));

  const searchHtml = await page.content();
  await writeFile(join(process.cwd(), "tests/fixtures/search-page.html"), searchHtml, "utf-8");
  console.log("[probe] saved tests/fixtures/search-page.html");

  if (cards.length > 0) {
    const first = cards[0];
    console.log(`[probe] fetching vacancy text for: ${first.url}`);
    let text = "";
    try {
      text = await browser.fetchVacancyText(first.url);
    } catch (err) {
      console.log(`[probe] fetchVacancyText() threw (${(err as Error).message}) — extracting directly for probe purposes only.`);
      const title = await page.locator("h1").first().textContent() ?? "";
      const body = await page.locator(SEL.description).textContent() ?? "";
      const meta = await page.locator('[data-qa="vacancy-experience"], [data-qa*="work-formats"]').allTextContents();
      text = `${title}\n${meta.join("\n")}\n${body}`.trim();
    }
    console.log(`[probe] vacancy text length: ${text.length}`);
    console.log("[probe] vacancy text preview (first 500 chars):");
    console.log(text.slice(0, 500));

    const vacancyHtml = await page.content();
    await writeFile(join(process.cwd(), "tests/fixtures/vacancy-page.html"), vacancyHtml, "utf-8");
    console.log("[probe] saved tests/fixtures/vacancy-page.html");
  } else {
    console.log("[probe] no cards found — skipping fetchVacancyText.");
  }

  await browser.close();
}

main().catch(async (err) => {
  console.error("[probe] ERROR:", err);
  process.exit(1);
});
