import { describe, it, expect, vi } from "vitest";
import { trudvsemSource } from "../src/sources/trudvsem.js";
import type { Config } from "../src/config.js";

// Фикстура собрана по curl-сверке 2026-07-13 (docs/job-boards-research.md, раздел trudvsem):
// реальный ответ несёт ДВА текстовых поля — `duty` (обязанности) и отдельное плоское
// `requirements` (текст требований, Hard/Soft Skills); `requirement` — это ДРУГОЕ поле,
// объект {education, experience}, не текст. Бриф путал `requirement.education` с текстом
// требований — фикстура и маппинг ниже это отражают.
const FIXTURE = {
  status: "200",
  results: { vacancies: [{ vacancy: {
    id: "b49900b8-aaaa", "job-name": "Разработчик Python",
    salary_min: 150000, salary_max: 250000,
    duty: "<p>Разработка сервисов</p>",
    requirements: "Python 3.10+, FastAPI, опыт от 3 лет",
    requirement: { education: "Высшее образование", experience: 3 },
    company: { name: "АО ЦПЛ", email: "hr@cpl.ru", companycode: "1097746819720" },
    vac_url: "https://trudvsem.ru/vacancy/card/1097746819720/b49900b8-aaaa",
    "creation-date": "2026-07-08",
    schedule: "Дистанционная (удаленная) работа",
  }}]},
};
const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe("trudvsemSource", () => {
  it("маппит вакансию: id, зарплата, email в raw_json, удалёнка из schedule, duty+requirements в тексте", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(jsonRes(FIXTURE))
      .mockResolvedValue(jsonRes({ status: "200", results: {} }));
    const cards = await trudvsemSource(f as never).search(["python"], {} as Config);
    expect(cards).toHaveLength(1);
    const c = cards[0];
    expect(c.id).toBe("trudvsem:b49900b8-aaaa");
    expect(c.employer_id).toBe("trudvsem:1097746819720");
    expect(c.salary_from).toBe(150000);
    expect(c.work_format).toBe("remote");
    expect(c.url).toContain("trudvsem.ru/vacancy/card");
    const raw = JSON.parse(c.raw_json!) as { text: string; email: string };
    expect(raw.email).toBe("hr@cpl.ru");
    expect(raw.text).toContain("Разработка сервисов");
    // requirements — отдельное плоское текстовое поле (не requirement.education) — тоже должно попасть в текст
    expect(raw.text).toContain("FastAPI");
  });

  it("fetchText читает из raw_json без сети", async () => {
    const f = vi.fn().mockResolvedValueOnce(jsonRes(FIXTURE)).mockResolvedValue(jsonRes({ status: "200", results: {} }));
    const src = trudvsemSource(f as never);
    const [card] = await src.search(["python"], {} as Config);
    f.mockClear();
    expect(await src.fetchText(card as never)).toContain("Разработка сервисов");
    expect(f).not.toHaveBeenCalled();
  });

  it("пустой results:{} (0 результатов) не падает — meta.total=0 отдаёт results без ключа vacancies", async () => {
    const f = vi.fn().mockResolvedValue(jsonRes({ status: "200", results: {} }));
    const cards = await trudvsemSource(f as never).search(["zzzznonexistent"], {} as Config);
    expect(cards).toEqual([]);
  });

  it("битая запись (company: null) не валит весь батч — пропускается, остальные проходят", async () => {
    const fixture = {
      status: "200",
      results: { vacancies: [
        { vacancy: {
          id: "good-1", "job-name": "Разработчик Python", duty: "<p>Разработка</p>", requirements: "Python",
          company: { name: "Good Co", companycode: "111" },
          "creation-date": "2026-07-08",
        } },
        { vacancy: {
          id: "broken-1", "job-name": "Broken Job", duty: "<p>Broken</p>", requirements: "Python",
          company: null,
          "creation-date": "2026-07-08",
        } },
      ] },
    };
    const f = vi.fn()
      .mockResolvedValueOnce(jsonRes(fixture))
      .mockResolvedValue(jsonRes({ status: "200", results: {} }));
    const cards = await trudvsemSource(f as never).search(["python"], {} as Config);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("trudvsem:good-1");
  });

  it("регрессия: salary_min=0 и salary_max=0 → null (не вилка до 0₽)", async () => {
    const fixtureZeroSalary = {
      status: "200",
      results: { vacancies: [{ vacancy: {
        id: "c11111111-bbbb", "job-name": "Разработчик C++",
        salary_min: 0, salary_max: 0,
        duty: "<p>Разработка приложений</p>",
        requirements: "C++, опыт от 2 лет",
        company: { name: "Tech Startup", companycode: "1234567890123" },
        vac_url: "https://trudvsem.ru/vacancy/card/1234567890123/c11111111-bbbb",
        "creation-date": "2026-07-12",
      }}]},
    };
    const f = vi.fn()
      .mockResolvedValueOnce(jsonRes(fixtureZeroSalary))
      .mockResolvedValue(jsonRes({ status: "200", results: {} }));
    const cards = await trudvsemSource(f as never).search(["c++"], {} as Config);
    expect(cards).toHaveLength(1);
    const c = cards[0];
    expect(c.salary_from).toBeNull();
    expect(c.salary_to).toBeNull();
    expect(c.currency).toBeNull();
  });
});
