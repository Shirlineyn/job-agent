import { chromium, type BrowserContext, type Page } from "playwright";
import { sleep, jitter } from "./humanize.js";
import type { VacancyInsert, WorkFormat } from "../state/types.js";

const SEL = {
  card: '[data-qa="vacancy-serp__vacancy"]',
  title: '[data-qa="serp-item__title"]',
  employer: '[data-qa="vacancy-serp__vacancy-employer"]',
  compensation: '[data-qa*="compensation"]',
  description: '[data-qa="vacancy-description"]',
  captcha: '[data-qa="captcha"]',
  login: '[data-qa="login"]',
  respond: '[data-qa="vacancy-response-link-top"]',
  letterToggle: '[data-qa="vacancy-response-letter-toggle"]',
  letterInput: '[data-qa="vacancy-response-popup-form-letter-input"]',
  submit: '[data-qa="vacancy-response-submit-popup"]',
};

export class HhBrowser {
  private ctx!: BrowserContext;
  private page!: Page;

  async launch(profileDir: string): Promise<void> {
    this.ctx = await chromium.launchPersistentContext(profileDir, { headless: false, viewport: null });
    this.page = this.ctx.pages()[0] ?? await this.ctx.newPage();
  }
  async close(): Promise<void> { await this.ctx.close(); }

  async isCaptcha(): Promise<boolean> {
    return this.page.url().includes("captcha") || await this.page.locator(SEL.captcha).count() > 0;
  }
  async isLoggedOut(): Promise<boolean> {
    return await this.page.locator(SEL.login).count() > 0;
  }
  private async guard(): Promise<void> {
    if (await this.isCaptcha()) throw new CaptchaDetected();
    if (await this.isLoggedOut()) throw new LoggedOut();
  }

  async searchVacancies(query: string, area: number): Promise<VacancyInsert[]> {
    const url = `https://hh.ru/search/vacancy?text=${encodeURIComponent(query)}&area=${area}&order_by=publication_time&items_on_page=50`;
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(1500, 4000);
    await this.guard();
    return this.page.$$eval(SEL.card, (cards, sel) => cards.map(c => {
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
        work_format: (/удал[её]нн/i.test(c.textContent ?? "") ? "remote" : /гибрид/i.test(c.textContent ?? "") ? "hybrid" : "unknown") as WorkFormat,
        experience: null, published_at: null,          // уточняются на странице вакансии
        raw_json: JSON.stringify({ card: c.textContent?.slice(0, 2000) }),
      };
    }), SEL).then(list => list.filter(v => v.id));
  }

  async fetchVacancyText(url: string): Promise<string> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(2000, 5000);
    await this.guard();
    const title = await this.page.locator("h1").first().textContent() ?? "";
    const body = await this.page.locator(SEL.description).textContent() ?? "";
    const meta = await this.page.locator('[data-qa="vacancy-experience"], [data-qa*="work-formats"]').allTextContents();
    return `${title}\n${meta.join("\n")}\n${body}`.trim();
  }

  async apply(url: string, letter: string, dryRun: boolean): Promise<"applied" | "dry_run" | "no_button"> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(2000, 5000);
    await this.guard();
    const btn = this.page.locator(SEL.respond).first();
    if (await btn.count() === 0) return "no_button";     // уже откликались или отклик недоступен
    await btn.click();
    await sleep(1500, 3500);
    await this.guard();
    // Возможен экран "отклик в другой стране/регионе" — подтверждаем, если появился
    const relocate = this.page.locator('[data-qa="relocation-warning-confirm"]');
    if (await relocate.count() > 0) { await relocate.click(); await sleep(1000, 2000); }
    const toggle = this.page.locator(SEL.letterToggle);
    if (await toggle.count() > 0) { await toggle.click(); await sleep(500, 1500); }
    const input = this.page.locator(SEL.letterInput);
    if (await input.count() > 0) await input.pressSequentially(letter, { delay: jitter(15, 60) });
    if (dryRun) return "dry_run";                         // всё сделали, кроме отправки
    await this.page.locator(SEL.submit).click();
    await sleep(1500, 3000);
    await this.guard();
    return "applied";
  }

  async waitCaptchaCleared(timeoutMs: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise(r => setTimeout(r, 20_000));
      if (!(await this.isCaptcha())) return true;
    }
    return false;
  }
}

export class CaptchaDetected extends Error { constructor() { super("captcha detected"); } }
export class LoggedOut extends Error { constructor() { super("logged out"); } }
