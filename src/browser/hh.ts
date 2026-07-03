import { chromium, type BrowserContext, type Page } from "playwright";
import { sleep } from "./humanize.js";
import type { VacancyInsert, WorkFormat } from "../state/types.js";
import type { QuestionnaireItem, QuestionnaireAnswer } from "../llm/questionnaire.js";

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
  // Вакансия БЕЗ анкеты: клик «Откликнуться» сразу отправляет отклик («Резюме доставлено»),
  // а письмо прикладывается ПОСЛЕ — через отдельную кнопку и свой попап со своим submit.
  attachLetter: '[data-qa="responded-success-attach-cover-letter"]',
  letterPopupSubmit: '[data-qa="vacancy-response-letter-submit"]',
  // «Резюме доставлено»: ссылка «Чат» есть даже когда кнопки приложить письмо нет — надёжный признак отправки.
  deliveredChat: '[data-qa="vacancy-response-link-view-topic"]',
};

export class HhBrowser {
  private ctx!: BrowserContext;
  private page!: Page;
  private closed = false;

  async launch(profileDir: string): Promise<void> {
    this.ctx = await chromium.launchPersistentContext(profileDir, { headless: false, viewport: null });
    this.ctx.on("close", () => { this.closed = true; });
    this.page = this.ctx.pages()[0] ?? await this.ctx.newPage();
  }
  async close(): Promise<void> { await this.ctx.close(); }

  isAlive(): boolean { return !this.closed && this.ctx !== undefined; }

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

  async apply(
    url: string, letter: string, dryRun: boolean,
    answerFn?: (questions: QuestionnaireItem[]) => Promise<QuestionnaireAnswer[]>,
  ): Promise<"applied" | "dry_run" | "no_button"> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(2000, 5000);
    await this.guard();
    const btn = this.page.locator(SEL.respond).first();
    if (await btn.count() === 0) return "no_button";     // уже откликались или отклик недоступен
    // dry-run: останавливаемся ДО клика по «Откликнуться». На hh у аккаунтов с одним
    // резюме клик по кнопке может сам отправить отклик — единственный надёжный рубеж
    // это не нажимать её вовсе. Письмо уже лежит в БД и видно через get_queue.
    if (dryRun) return "dry_run";
    await btn.click();
    await sleep(2000, 3500);   // дать отклику уйти и странице перерисоваться

    // После клика по «Откликнуться» hh ведёт себя двояко:
    //  • attach — вакансия БЕЗ анкеты: клик УЖЕ отправил отклик («Резюме доставлено»),
    //             письмо прикладывается после через «Приложить сопроводительное письмо».
    //  • form   — форма отклика с анкетой и/или полем письма; submit отдельный (не отправлено).
    // Отправку ловим по НЕСКОЛЬКИМ признакам сразу — одиночный data-qa оказался timing-флэки
    // (отправленный отклик уходил в no_button → failed). Порядок: сначала форма (её надо
    // засабмитить самим), затем признаки отправки, в т.ч. исчезновение самой кнопки отклика.
    const isDelivered = async (): Promise<boolean> => {
      if (await this.page.locator(SEL.attachLetter).count() > 0) return true;
      if (await this.page.locator(SEL.deliveredChat).count() > 0) return true;
      const t = await this.page.locator("body").innerText().catch(() => "");
      return /Резюме доставлено|Резюме отправлено|Вы откликнулись|Отклик доставлен|Отклик отправлен|Ваш отклик|Вы уже откликались/i.test(t);
    };

    let scenario: "attach" | "form" | "unknown" = "unknown";
    for (let i = 0; i < 20; i++) {
      await this.guard();
      const relocate = this.page.locator('[data-qa="relocation-warning-confirm"]');
      if (await relocate.count() > 0) { await relocate.click(); await sleep(1000, 2000); continue; }
      if (await this.hasQuestionnaire()
          || await this.page.locator(SEL.letterToggle).count() > 0
          || await this.page.locator(SEL.letterInput).count() > 0
          || await this.page.locator(SEL.submit).count() > 0) { scenario = "form"; break; }
      if (await isDelivered()) { scenario = "attach"; break; }
      // крайний признак: кнопка отклика исчезла, а формы нет — клик отправил отклик. Не раньше
      // нескольких итераций, чтобы не спутать с ещё не отрисованной формой.
      if (i >= 4 && await this.page.locator(SEL.respond).count() === 0) { scenario = "attach"; break; }
      await sleep(700, 1200);
    }

    if (scenario === "attach") {
      // Отклик уже отправлен самим кликом — прикладываем письмо best-effort (если hh дал кнопку).
      // Отклик засчитан в любом случае → "applied", иначе пайплайн пометит failed и собьёт лимит.
      try {
        const attach = this.page.locator(SEL.attachLetter);
        if (await attach.count() > 0) {
          await attach.click();
          await sleep(800, 1500);
          const dialog = this.page.getByRole("dialog");        // textarea письма ищем в попапе
          const box = (await dialog.count() > 0 ? dialog : this.page).locator("textarea").first();
          await box.waitFor({ state: "visible", timeout: 8000 });
          await box.fill(letter);                              // fill(), не посимвольно: длинное письмо иначе висит
          await sleep(400, 900);
          await this.page.locator(SEL.letterPopupSubmit).click();
          await sleep(1500, 3000);
          await this.guard();
        }
      } catch { /* отклик уже ушёл; приложение письма — best-effort, не роняем "applied" */ }
      return "applied";
    }

    if (scenario === "form") {
      // Анкета работодателя, если есть: извлекаем вопросы, отвечаем через колбэк (LLM в пайплайне), заполняем.
      if (answerFn && await this.hasQuestionnaire()) {
        const questions = await this.extractQuestionnaire();
        const answers = await answerFn(questions);
        await this.fillQuestionnaire(answers, questions);
        await sleep(800, 1500);
      }
      const toggle = this.page.locator(SEL.letterToggle);
      if (await toggle.count() > 0) { await toggle.click(); await sleep(500, 1500); }
      const input = this.page.locator(SEL.letterInput);
      // Живой отклик без поля письма — не отправляем «пустой» отклик (fail-closed).
      if (await input.count() === 0) return "no_button";
      await input.fill(letter);
      await sleep(400, 900);
      await this.page.locator(SEL.submit).click();
      await sleep(1500, 3000);
      await this.guard();
      return "applied";
    }

    // Не распознали сценарий. Если есть признаки отправки или кнопка отклика исчезла — считаем
    // applied (для аккаунта с одним резюме клик почти всегда = отправка; лучше не недосчитать лимит).
    if (await isDelivered()) return "applied";
    if (await this.page.locator(SEL.respond).count() === 0) return "applied";
    return "no_button";
  }

  async waitCaptchaCleared(timeoutMs: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise(r => setTimeout(r, 20_000));
      if (!(await this.isCaptcha())) return true;
    }
    return false;
  }

  // Анкета работодателя (опросник) на странице отклика: N вопросов, у каждого radio-варианты
  // (сгруппированы по input[name], value=id варианта) + textarea для «Свой вариант».
  async hasQuestionnaire(): Promise<boolean> {
    return await this.page.locator('[data-qa="employer-asking-for-test"], [data-qa="task-question"]').count() > 0;
  }

  async extractQuestionnaire(): Promise<QuestionnaireItem[]> {
    // Порядок в DOM устойчив: i-й task-question ↔ i-я группа radio по name.
    const texts = await this.page.$$eval('[data-qa="task-question"]',
      els => els.map(e => (e.textContent || "").replace(/\s+/g, " ").trim()));
    const radios = await this.page.$$eval('input[type="radio"]', els => els.map(e => ({
      name: e.getAttribute("name") || "",
      value: (e as HTMLInputElement).value,
      text: (e.closest("label")?.textContent || "").replace(/\s+/g, " ").trim(),
    })));
    const order: string[] = [];
    const byName: Record<string, { value: string; text: string }[]> = {};
    for (const r of radios) {
      if (!byName[r.name]) { byName[r.name] = []; order.push(r.name); }
      byName[r.name].push({ value: r.value, text: r.text });
    }
    return order.map((name, i) => ({ name, question: texts[i] ?? name, options: byName[name] }));
  }

  // Заполняет ответы; НЕ отправляет. answers[k].i — индекс вопроса.
  async fillQuestionnaire(answers: QuestionnaireAnswer[], questions: QuestionnaireItem[]): Promise<void> {
    const textareas = this.page.locator("textarea");
    for (const a of answers) {
      const q = questions[a.i];
      if (!q) continue;
      if (a.type === "option" && a.value) {
        await this.page.locator(`input[name="${q.name}"][value="${a.value}"]`).check({ force: true });
      } else if (a.type === "custom") {
        const custom = q.options[q.options.length - 1];             // «Свой вариант» — последний radio
        if (custom) await this.page.locator(`input[name="${q.name}"][value="${custom.value}"]`).check({ force: true });
        await sleep(300, 700);
        if (await textareas.nth(a.i).count() > 0) await textareas.nth(a.i).fill(a.text || "");
      }
      await sleep(400, 900);
    }
  }
}

export class CaptchaDetected extends Error { constructor() { super("captcha detected"); } }
export class LoggedOut extends Error { constructor() { super("logged out"); } }
