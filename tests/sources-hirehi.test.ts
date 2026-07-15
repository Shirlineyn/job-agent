import { describe, it, expect, vi } from "vitest";
import { hirehiSource } from "../src/sources/hirehi.js";
import type { Config } from "../src/config.js";

// Реальная схема (curl-сверка 2026-07-13, docs/job-boards-research.md):
// - параметр поиска — `search`, не `query` (query игнорируется API, всегда total_count=16174);
// - дата — `created_at` (ISO), поля `published_at` в ответе нет;
// - у карточки нет поля с готовым URL — веб-урл строим как /{category}/vacancy-{id}
//   (сверено: любой slug-текст перед -{id} 301-редиректит на канонический урл, значение
//   category не валидируется бэкендом при рендере, так что placeholder безопасен).
const SEARCH_FIXTURE = {
  total_count: 1,
  jobs: [
    {
      id: 123,
      title: "ML Engineer",
      company: "Acme",
      category: "development",
      salary_display: "от 250 000 до 400 000 ₽",
      format: "удалённо",
      level: "middle",
      created_at: "2026-07-10T09:00:00Z",
    },
  ],
};
const JOB_FIXTURE = {
  id: 123,
  description: "<p>Ищем ML-инженера</p>",
  requirements: "Python, LLM",
  tasks_details: "RAG-пайплайны",
  conditions_details: "удалёнка",
};
const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("hirehiSource", () => {
  it("search маппит карточки: namespaced id, зарплата из salary_display, формат", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(SEARCH_FIXTURE)) // page 1
      .mockResolvedValue(jsonRes({ total_count: 1, jobs: [] }));
    const src = hirehiSource(f as never);
    const cards = await src.search(["python"], {} as Config);
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c.id).toBe("hirehi:123");
    expect(c.source).toBe("hirehi");
    expect(c.employer_name).toBe("Acme");
    expect(c.employer_id).toBe("hirehi:acme");
    expect(c.salary_from).toBe(250000);
    expect(c.salary_to).toBe(400000);
    expect(c.work_format).toBe("remote");
    expect(c.published_at).toBe("2026-07-10T09:00:00Z");
    expect(c.url).toBe("https://hirehi.ru/development/vacancy-123");
  });
  it("fetchText собирает описание из карточки API", async () => {
    const f = vi.fn().mockResolvedValue(jsonRes(JOB_FIXTURE));
    const src = hirehiSource(f as never);
    const text = await src.fetchText({ id: "hirehi:123", raw_json: null } as never);
    expect(text).toContain("Ищем ML-инженера");
    expect(text).toContain("Python, LLM");
  });
  it("дедуплицирует id между ключевыми словами", async () => {
    // mockImplementation, не mockResolvedValue: PAGES_PER_KEYWORD=2 и непустой jobs
    // означают до 4 вызовов f, а один и тот же Response нельзя прочитать (.json()) дважды.
    // Таймаут увеличен: между вызовами реальная politePause() (~1-1.5с) × до 4 вызовов.
    const f = vi.fn().mockImplementation(() => Promise.resolve(jsonRes(SEARCH_FIXTURE)));
    const src = hirehiSource(f as never);
    const cards = await src.search(["python", "ml"], {} as Config);
    expect(cards).toHaveLength(1);
  }, 10_000);
  it("битая запись (company: null) не валит весь батч — пропускается, остальные проходят", async () => {
    const fixture = {
      total_count: 2,
      jobs: [
        { id: 1, title: "OK Job", company: "Good Co", category: "dev", salary_display: null },
        { id: 2, title: "Broken Job", company: null, category: "dev", salary_display: null },
      ],
    };
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(fixture))
      .mockResolvedValue(jsonRes({ total_count: 0, jobs: [] }));
    const src = hirehiSource(f as never);
    const cards = await src.search(["python"], {} as Config);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe("hirehi:1");
  });
  it("одиночную приблизительную зарплату (~N) трактует как from=to", async () => {
    const fixture = {
      total_count: 1,
      jobs: [
        { id: 999, title: "QA", company: "Beta", category: "qa", salary_display: "~ 300 000 ₽" },
      ],
    };
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(fixture))
      .mockResolvedValue(jsonRes({ total_count: 1, jobs: [] }));
    const src = hirehiSource(f as never);
    const cards = await src.search(["qa"], {} as Config);
    expect(cards[0]!.salary_from).toBe(300000);
    expect(cards[0]!.salary_to).toBe(300000);
  });
});
