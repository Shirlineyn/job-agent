import { describe, it, expect, vi } from "vitest";
import { getmatchSource, matchesKeywords } from "../src/sources/getmatch.js";
import type { Config } from "../src/config.js";

// Реальная схема (curl-сверка 2026-07-13, docs/job-boards-research.md):
// - поля salary_display_from/to, salary_currency, location_items[{format}] — как в брифе;
// - НО поля `description_html` нет в списке (в ответе оно есть, но всегда null — и в списке,
//   и в /api/offers/<id>); реальный текст описания приходит в списке под именем
//   `offer_description` (HTML) — переименовано в фикстуре ниже;
// - `url` в API — относительный путь (`/vacancies/<id>-<slug>`), не абсолютный —
//   фикстура ниже отражает это, адаптер сам достраивает https://getmatch.ru.
const OFFERS_FIXTURE = {
  meta: { total: 2 },
  offers: [
    { id: 1, position: "Senior Python Developer", company: { name: "Fintech X" },
      salary_display_from: 350000, salary_display_to: 450000, salary_currency: "RUB",
      offer_description: "<p>Бэкенд на Python, ML-пайплайны</p>",
      location_items: [{ format: "remote" }], published_at: "2026-07-09", url: "/vacancies/1-senior-python" },
    { id: 2, position: "1C Консультант", company: { name: "Y" },
      salary_display_from: null, salary_display_to: null, salary_currency: null,
      offer_description: "<p>1C</p>", location_items: [], published_at: "2026-07-09", url: "/vacancies/2-1c" },
  ],
};
const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe("getmatchSource", () => {
  it("качает всё и фильтрует локально по ключевым словам", async () => {
    const f = vi.fn().mockResolvedValue(jsonRes(OFFERS_FIXTURE));
    const cards = await getmatchSource(f as never).search(["python"], {} as Config);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("getmatch:1");
    expect(cards[0].salary_from).toBe(350000);
    expect(cards[0].work_format).toBe("remote");
    expect(cards[0].url).toBe("https://getmatch.ru/vacancies/1-senior-python");
  });
  it("fetchText читает из raw_json без сети", async () => {
    const f = vi.fn().mockResolvedValue(jsonRes(OFFERS_FIXTURE));
    const src = getmatchSource(f as never);
    const [card] = await src.search(["python"], {} as Config);
    f.mockClear();
    const text = await src.fetchText({ ...card, raw_json: card.raw_json } as never);
    expect(text).toContain("ML-пайплайны");
    expect(f).not.toHaveBeenCalled();
  });
  it("битая запись (company: null) не валит весь батч — пропускается, остальные проходят", async () => {
    const fixture = {
      meta: { total: 2 },
      offers: [
        { id: 1, position: "Python Developer", company: { name: "Good Co" },
          salary_display_from: null, salary_display_to: null, salary_currency: null,
          offer_description: "<p>Python backend</p>", location_items: [], published_at: null, url: null },
        { id: 2, position: "Python Broken", company: null,
          salary_display_from: null, salary_display_to: null, salary_currency: null,
          offer_description: "<p>Python broken record</p>", location_items: [], published_at: null, url: null },
      ],
    };
    const f = vi.fn().mockResolvedValue(jsonRes(fixture));
    const cards = await getmatchSource(f as never).search(["python"], {} as Config);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("getmatch:1");
  });
  it("matchesKeywords ищет по позиции и описанию, без регистра", () => {
    expect(matchesKeywords("ML Engineer", "<p>деплой моделей</p>", ["python", "ml"])).toBe(true);
    expect(matchesKeywords("Бухгалтер", "<p>1С</p>", ["python", "ml"])).toBe(false);
  });
});
