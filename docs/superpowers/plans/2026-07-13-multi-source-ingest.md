# Multi-Source Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подключить 4 новых источника вакансий (hirehi.ru, Habr Career, getmatch.ru, trudvsem.ru) к существующему пайплайну: ingest → хард-фильтры → скоринг, с дедупликацией против hh.ru. Отклик для новых источников в этом плане НЕ делается (см. отдельный план email-outreach).

**Architecture:** Каждый источник — адаптер интерфейса `JobSource` (чистый HTTP через глобальный `fetch`, браузер не нужен). Вакансии складываются в ту же таблицу `vacancies` с новой колонкой `source` и namespaced id (`hirehi:123`). Дедуп — по нормализованному ключу «работодатель|название»: hh первичен, дубликаты из новых источников не вставляются. В `runSession` добавляется стадия ingest (после hh-discover), стадия скоринга диспатчит получение текста по источнику, стадия apply пропускает не-hh вакансии.

**Tech Stack:** TypeScript (ESM, strict), better-sqlite3, vitest, глобальный `fetch` (Node 24). Новых зависимостей нет.

## Global Constraints

- Node 24, ESM (`import ... from "./x.js"` даже для .ts), TypeScript strict.
- Тесты: `npx vitest run` из корня; тестовые файлы в `tests/*.test.ts`.
- Никаких обходов антибота: честный User-Agent, пауза ~1–1.5 с между HTTP-запросами к одному источнику, таймаут 30 с.
- Комментарии в коде — по-русски и только там, где объясняют «почему» (стиль кодовой базы).
- Все API неофициальные (кроме trudvsem): адаптер обязан бросать понятную ошибку при неожиданной схеме ответа, а не молча отдавать мусор.
- Каждый коммит: `git add <файлы> && git commit -m "..."` — осмысленное сообщение с «почему».
- Точка сверки схем API: docs/job-boards-research.md (проверено 2026-07-13). Перед реализацией адаптера — обязательный curl-шаг сверки реального ответа.

---

### Task 1: Миграция V002 + `source`/`dedup_key` в types и repo

**Files:**
- Create: `db/migrations/V002__sources.sql`
- Create: `src/state/dedup.ts`
- Modify: `src/state/types.ts` (VacancyRow, VacancyInsert)
- Modify: `src/state/repo.ts` (upsertVacancy)
- Modify: `src/browser/hh.ts` (конструирование VacancyInsert — добавить `source: "hh"`)
- Test: `tests/repo-sources.test.ts`

**Interfaces:**
- Consumes: существующие `openDb`, `upsertVacancy`.
- Produces: `VacancyInsert.source: string` (обязательное поле), `VacancyRow.source`, `dedupKey(employerName: string, title: string): string` из `src/state/dedup.ts`. `upsertVacancy` возвращает `false` для не-hh дубликата по dedup_key.

- [ ] **Step 1: Написать миграцию**

```sql
-- db/migrations/V002__sources.sql
-- source: откуда пришла вакансия. hh — браузерный скрейпер, остальные — HTTP-адаптеры.
ALTER TABLE vacancies ADD COLUMN source TEXT NOT NULL DEFAULT 'hh';
-- dedup_key: нормализованный "работодатель|название" для дедупликации между источниками.
ALTER TABLE vacancies ADD COLUMN dedup_key TEXT;
CREATE INDEX idx_vacancies_source ON vacancies (source);
CREATE INDEX idx_vacancies_dedup  ON vacancies (dedup_key);
-- Бэкфилл для уже существующих hh-строк (грубая SQL-нормализация; JS-нормализация чуть богаче,
-- но расхождение лишь ослабит дедуп для старых строк, что безопасно).
UPDATE vacancies SET dedup_key = lower(trim(employer_name)) || '|' || lower(trim(title));
```

- [ ] **Step 2: Написать failing-тест**

```typescript
// tests/repo-sources.test.ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { dedupKey } from "../src/state/dedup.js";
import type { VacancyInsert } from "../src/state/types.js";

const mk = (over: Partial<VacancyInsert>): VacancyInsert => ({
  id: "hh1", url: "https://hh.ru/vacancy/1", title: "ML Engineer", employer_id: "e1",
  employer_name: "Acme", salary_from: null, salary_to: null, currency: null,
  work_format: null, experience: null, published_at: null, raw_json: null,
  source: "hh", ...over,
});

describe("dedupKey", () => {
  it("нормализует регистр, кавычки и пробелы", () => {
    expect(dedupKey('ООО  «Акме»', ' ML   Engineer ')).toBe("ооо акме|ml engineer");
  });
});

describe("upsertVacancy с source", () => {
  it("сохраняет source и dedup_key", () => {
    const db = openDb(":memory:");
    expect(repo.upsertVacancy(db, mk({}))).toBe(true);
    const v = repo.getVacancy(db, "hh1")!;
    expect(v.source).toBe("hh");
    expect(v.dedup_key).toBe("acme|ml engineer");
  });
  it("не вставляет не-hh дубликат той же вакансии от того же работодателя", () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, mk({}));
    const dup = mk({ id: "hirehi:9", source: "hirehi", url: "https://hirehi.ru/j/9" });
    expect(repo.upsertVacancy(db, dup)).toBe(false);
    expect(repo.getVacancy(db, "hirehi:9")).toBeUndefined();
  });
  it("hh вставляется всегда, даже если не-hh пришёл раньше", () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, mk({ id: "hirehi:9", source: "hirehi" }));
    expect(repo.upsertVacancy(db, mk({ id: "hh2" }))).toBe(true);
  });
});
```

- [ ] **Step 3: Прогнать тест — убедиться, что падает**

Run: `npx vitest run tests/repo-sources.test.ts`
Expected: FAIL — `dedup.js` не существует / `source` неизвестное поле.

- [ ] **Step 4: Реализация**

```typescript
// src/state/dedup.ts
// Ключ дедупликации между источниками: одна и та же вакансия на hh и hirehi/habr
// почти всегда совпадает по (работодатель, название) после нормализации.
export function dedupKey(employerName: string, title: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[«»"'`]/g, "").replace(/\s+/g, " ").trim();
  return `${norm(employerName)}|${norm(title)}`;
}
```

В `src/state/types.ts` добавить в оба интерфейса:

```typescript
// в VacancyRow после raw_json:
  source: string;
  dedup_key: string | null;
// в VacancyInsert после raw_json:
  source: string;
```

В `src/state/repo.ts` заменить `upsertVacancy`:

```typescript
import { dedupKey } from "./dedup.js";

export function upsertVacancy(db: Database, v: VacancyInsert): boolean {
  const key = dedupKey(v.employer_name, v.title);
  // hh — первичный источник: его вставляем всегда. Дубликат из нового источника
  // (та же вакансия у того же работодателя, найденная где-то ещё) не вставляем —
  // отклик по ней уже возможен через hh, а двойной скоринг жжёт бюджет.
  if (v.source !== "hh") {
    const dup = db.prepare(`SELECT 1 FROM vacancies WHERE dedup_key=? LIMIT 1`).get(key);
    if (dup) return false;
  }
  const insertVacancy = db.prepare(`INSERT OR IGNORE INTO vacancies
    (id,url,title,employer_id,employer_name,salary_from,salary_to,currency,work_format,experience,published_at,raw_json,source,dedup_key)
    VALUES (@id,@url,@title,@employer_id,@employer_name,@salary_from,@salary_to,@currency,@work_format,@experience,@published_at,@raw_json,@source,@key)`);
  const run = db.transaction((row: VacancyInsert & { key: string }) => {
    if (row.employer_id != null) {
      db.prepare(`INSERT OR IGNORE INTO companies (employer_id, name) VALUES (@employer_id, @employer_name)`).run(row);
    }
    return insertVacancy.run(row);
  });
  return run({ ...v, key }).changes > 0;
}
```

(Комментарий про FK-стаб companies из старой версии сохранить над транзакцией.)

В `src/browser/hh.ts` найти место, где собирается объект `VacancyInsert` (внутри `searchVacancies`), и добавить поле `source: "hh"`.

- [ ] **Step 5: Прогнать все тесты**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, включая старые тесты.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/V002__sources.sql src/state/dedup.ts src/state/types.ts src/state/repo.ts src/browser/hh.ts tests/repo-sources.test.ts
git commit -m "feat(sources): колонка source + дедуп по (работодатель|название) — hh первичен"
```

---

### Task 2: Конфиг — `enabledSources` и `sourceKeywords`

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config-sources.test.ts`

**Interfaces:**
- Produces: `cfg.enabledSources: ("hirehi"|"habr"|"getmatch"|"trudvsem")[]`, `cfg.sourceKeywords: string[]`.

- [ ] **Step 1: Failing-тест**

```typescript
// tests/config-sources.test.ts
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../src/config.js";

describe("config sources", () => {
  it("дефолты: все 4 источника, непустые ключевые слова", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.enabledSources).toEqual(["hirehi", "habr", "getmatch", "trudvsem"]);
    expect(cfg.sourceKeywords.length).toBeGreaterThan(0);
  });
  it("неизвестный источник отклоняется", () => {
    expect(() => ConfigSchema.parse({ enabledSources: ["linkedin"] })).toThrow();
  });
});
```

- [ ] **Step 2: Прогнать — FAIL** (`enabledSources` нет в схеме).

- [ ] **Step 3: Реализация** — в `ConfigSchema` после `searchQueries`:

```typescript
  // Новые источники ищут по простым ключевым словам (их поиск не понимает hh-синтаксис "A OR B").
  enabledSources: z
    .array(z.enum(["hirehi", "habr", "getmatch", "trudvsem"]))
    .default(["hirehi", "habr", "getmatch", "trudvsem"]),
  sourceKeywords: z
    .array(z.string())
    .default(["LLM", "ML инженер", "AI инженер", "аналитик данных", "python"]),
```

- [ ] **Step 4: Прогнать** `npx vitest run tests/config-sources.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config-sources.test.ts
git commit -m "feat(config): enabledSources + sourceKeywords для HTTP-источников"
```

---

### Task 3: Интерфейс `JobSource` + HTTP-хелпер

**Files:**
- Create: `src/sources/types.ts`
- Create: `src/sources/http.ts`
- Test: `tests/sources-http.test.ts`

**Interfaces:**
- Produces:
  - `type SourceName = "hirehi" | "habr" | "getmatch" | "trudvsem"`
  - `interface JobSource { name: SourceName; search(keywords: string[], cfg: Config): Promise<VacancyInsert[]>; fetchText(v: VacancyRow): Promise<string> }`
  - `type Fetch = typeof fetch`
  - `getJson<T>(f: Fetch, url: string, timeoutMs?: number): Promise<T>` — бросает `Error("GET <url> -> <status>")` при не-2xx
  - `getText(f: Fetch, url: string, timeoutMs?: number): Promise<string>`
  - `politePause(): Promise<void>` — 1000–1500 мс
  - `stripHtml(html: string): string` — теги → пробелы, entities `&nbsp; &amp; &lt; &gt; &quot;`, схлопнуть пробелы

- [ ] **Step 1: Failing-тест**

```typescript
// tests/sources-http.test.ts
import { describe, it, expect, vi } from "vitest";
import { getJson, stripHtml } from "../src/sources/http.js";

describe("getJson", () => {
  it("парсит JSON и передаёт User-Agent", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    expect(await getJson(f as never, "https://x.test/api")).toEqual({ ok: 1 });
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["user-agent"]).toContain("Mozilla");
  });
  it("бросает на не-2xx со статусом в сообщении", async () => {
    const f = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(getJson(f as never, "https://x.test/api")).rejects.toThrow(/403/);
  });
});

describe("stripHtml", () => {
  it("убирает теги и entities, схлопывает пробелы", () => {
    expect(stripHtml("<p>Обязанности:</p><ul><li>писать&nbsp;код &amp; тесты</li></ul>"))
      .toBe("Обязанности: писать код & тесты");
  });
});
```

- [ ] **Step 2: Прогнать — FAIL** (модулей нет).

- [ ] **Step 3: Реализация**

```typescript
// src/sources/types.ts
import type { VacancyInsert, VacancyRow } from "../state/types.js";
import type { Config } from "../config.js";

export type SourceName = "hirehi" | "habr" | "getmatch" | "trudvsem";

export interface JobSource {
  name: SourceName;
  /** Поисковая выдача по ключевым словам → карточки для upsert. Ошибка одного источника не валит прогон. */
  search(keywords: string[], cfg: Config): Promise<VacancyInsert[]>;
  /** Полный текст вакансии для скоринга. Может читать из v.raw_json, если текст сохранён при ingest. */
  fetchText(v: VacancyRow): Promise<string>;
}
```

```typescript
// src/sources/http.ts
export type Fetch = typeof fetch;

// Честный браузерный UA: часть площадок (rabota.ru-подобные за Qrator) банят куцые UA;
// наши источники не банят, но единый UA упрощает жизнь.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export async function getJson<T>(f: Fetch, url: string, timeoutMs = 30_000): Promise<T> {
  const res = await f(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export async function getText(f: Fetch, url: string, timeoutMs = 30_000): Promise<string> {
  const res = await f(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

// Вежливый интервал между запросами к одному источнику — мы гости на неофициальных API.
export const politePause = (): Promise<void> => new Promise(r => setTimeout(r, 1000 + Math.random() * 500));

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
```

- [ ] **Step 4: Прогнать** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/types.ts src/sources/http.ts tests/sources-http.test.ts
git commit -m "feat(sources): интерфейс JobSource и HTTP-хелпер с вежливым рейтом"
```

---

### Task 4: Адаптер hirehi.ru

**Files:**
- Create: `src/sources/hirehi.ts`
- Test: `tests/sources-hirehi.test.ts`

**Interfaces:**
- Consumes: `JobSource`, `getJson`, `politePause`, `stripHtml` (Task 3).
- Produces: `hirehiSource(f?: Fetch): JobSource`. id вида `hirehi:<num>`, employer_id `hirehi:<нормализованное имя>`.

**Схема API (сверено 2026-07-13, docs/job-boards-research.md):**
- Поиск: `GET https://hirehi.ru/api/search/jobs?query=<kw>&page=<n>` → `{ total_count, jobs: [...] }`, ~27/стр.
- Карточка: `GET https://hirehi.ru/api/jobs/<id>` → `{ description, requirements, tasks_details, conditions_details, salary_display, format, level, ... }`.

- [ ] **Step 0: Сверить реальную схему ответа**

Run: `curl -s "https://hirehi.ru/api/search/jobs?query=python&page=1" | python3 -m json.tool | head -60` и `curl -s "https://hirehi.ru/api/jobs/<id из выдачи>" | python3 -m json.tool | head -60`.
Expected: поля `id`, `title`, `company`, `salary_display`, `format`, `published_at`-подобное поле и веб-URL вакансии (поле со ссылкой либо шаблон урла из фронтенда). **Если имена полей отличаются от фикстуры ниже — поправить фикстуру и маппинг под фактические, это часть задачи.**

- [ ] **Step 1: Failing-тест**

```typescript
// tests/sources-hirehi.test.ts
import { describe, it, expect, vi } from "vitest";
import { hirehiSource } from "../src/sources/hirehi.js";
import type { Config } from "../src/config.js";

const SEARCH_FIXTURE = {
  total_count: 1,
  jobs: [{
    id: 123, title: "ML Engineer", company: "Acme",
    salary_display: "от 250 000 до 400 000 ₽", format: "удалённо",
    level: "middle", published_at: "2026-07-10",
  }],
};
const JOB_FIXTURE = {
  id: 123, description: "<p>Ищем ML-инженера</p>", requirements: "Python, LLM",
  tasks_details: "RAG-пайплайны", conditions_details: "удалёнка",
};
const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("hirehiSource", () => {
  it("search маппит карточки: namespaced id, зарплата из salary_display, формат", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(jsonRes(SEARCH_FIXTURE))   // page 1
      .mockResolvedValue(jsonRes({ total_count: 1, jobs: [] }));
    const src = hirehiSource(f as never);
    const cards = await src.search(["python"], {} as Config);
    expect(cards).toHaveLength(1);
    const c = cards[0];
    expect(c.id).toBe("hirehi:123");
    expect(c.source).toBe("hirehi");
    expect(c.employer_name).toBe("Acme");
    expect(c.employer_id).toBe("hirehi:acme");
    expect(c.salary_from).toBe(250000);
    expect(c.salary_to).toBe(400000);
    expect(c.work_format).toBe("remote");
  });
  it("fetchText собирает описание из карточки API", async () => {
    const f = vi.fn().mockResolvedValue(jsonRes(JOB_FIXTURE));
    const src = hirehiSource(f as never);
    const text = await src.fetchText({ id: "hirehi:123", raw_json: null } as never);
    expect(text).toContain("Ищем ML-инженера");
    expect(text).toContain("Python, LLM");
  });
  it("дедуплицирует id между ключевыми словами", async () => {
    const f = vi.fn().mockResolvedValue(jsonRes(SEARCH_FIXTURE));
    const src = hirehiSource(f as never);
    const cards = await src.search(["python", "ml"], {} as Config);
    expect(cards).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Прогнать — FAIL.**

- [ ] **Step 3: Реализация**

```typescript
// src/sources/hirehi.ts
import type { Config } from "../config.js";
import type { VacancyInsert, VacancyRow, WorkFormat } from "../state/types.js";
import type { Fetch, } from "./http.js";
import type { JobSource } from "./types.js";
import { getJson, politePause, stripHtml } from "./http.js";

type HirehiJob = {
  id: number; title: string; company: string;
  salary_display?: string | null; format?: string | null; level?: string | null;
  published_at?: string | null;
};
type SearchResp = { total_count: number; jobs: HirehiJob[] };
type JobResp = { description?: string; requirements?: string; tasks_details?: string; conditions_details?: string };

// "от 250 000 до 400 000 ₽" → [250000, 400000]; "до 300 000 ₽" → [null, 300000]
export function parseSalary(s: string | null | undefined): { from: number | null; to: number | null } {
  if (!s) return { from: null, to: null };
  const nums = [...s.matchAll(/\d[\d\s]*\d|\d/g)].map(m => Number(m[0].replace(/\s/g, "")));
  if (nums.length === 0) return { from: null, to: null };
  if (/от/.test(s) && !/до/.test(s)) return { from: nums[0], to: null };
  if (/до/.test(s) && !/от/.test(s)) return { from: null, to: nums[0] };
  return { from: nums[0], to: nums[1] ?? null };
}

export function parseFormat(s: string | null | undefined): WorkFormat {
  if (!s) return "unknown";
  if (/удал|remote/i.test(s)) return "remote";
  if (/гибрид|hybrid/i.test(s)) return "hybrid";
  if (/офис|office/i.test(s)) return "office";
  return "unknown";
}

const PAGES_PER_KEYWORD = 2;   // ~54 свежих вакансии на слово; глубже — старьё и дубли

export function hirehiSource(f: Fetch = fetch): JobSource {
  return {
    name: "hirehi",
    async search(keywords: string[], _cfg: Config): Promise<VacancyInsert[]> {
      const seen = new Set<string>();
      const out: VacancyInsert[] = [];
      for (const kw of keywords) {
        for (let page = 1; page <= PAGES_PER_KEYWORD; page++) {
          const resp = await getJson<SearchResp>(f, `https://hirehi.ru/api/search/jobs?query=${encodeURIComponent(kw)}&page=${page}`);
          if (!Array.isArray(resp.jobs)) throw new Error(`hirehi: неожиданная схема ответа (нет jobs)`);
          for (const j of resp.jobs) {
            const id = `hirehi:${j.id}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const sal = parseSalary(j.salary_display);
            out.push({
              id, url: `https://hirehi.ru/jobs/${j.id}`, title: j.title,
              employer_id: `hirehi:${j.company.toLowerCase().trim()}`, employer_name: j.company,
              salary_from: sal.from, salary_to: sal.to, currency: sal.from || sal.to ? "RUR" : null,
              work_format: parseFormat(j.format), experience: null,
              published_at: j.published_at ?? null, raw_json: JSON.stringify(j), source: "hirehi",
            });
          }
          if (resp.jobs.length === 0) break;
          await politePause();
        }
      }
      return out;
    },
    async fetchText(v: VacancyRow): Promise<string> {
      const num = v.id.replace(/^hirehi:/, "");
      const j = await getJson<JobResp>(f, `https://hirehi.ru/api/jobs/${num}`);
      const text = [j.description, j.requirements, j.tasks_details, j.conditions_details]
        .filter(Boolean).map(s => stripHtml(String(s))).join("\n\n");
      if (!text) throw new Error(`hirehi: пустой текст вакансии ${v.id}`);
      return text;
    },
  };
}
```

Примечание для имплементера: шаблон `url` (`https://hirehi.ru/jobs/<id>`) сверить со Step 0 — если веб-урл другой (или API отдаёт готовую ссылку), использовать фактический.

- [ ] **Step 4: Прогнать** `npx vitest run tests/sources-hirehi.test.ts` — PASS.

- [ ] **Step 5: Живой smoke-тест (одноразовый, не в CI)**

Run: `npx tsx -e "import {hirehiSource} from './src/sources/hirehi.js'; const s=hirehiSource(); const c=await s.search(['python'],{} as any); console.log(c.length, c[0]); console.log((await s.fetchText(c[0] as any)).slice(0,200))"`
Expected: >0 карточек, осмысленный текст. Если схема поехала — поправить маппинг и фикстуры.

- [ ] **Step 6: Commit**

```bash
git add src/sources/hirehi.ts tests/sources-hirehi.test.ts
git commit -m "feat(sources): адаптер hirehi.ru — открытый JSON API, ~16k вакансий"
```

---

### Task 5: Адаптер Habr Career

**Files:**
- Create: `src/sources/habr.ts`
- Test: `tests/sources-habr.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: `habrSource(f?: Fetch): JobSource`. id `habr:<num>`, employer_id `habr:<company.id|alias>`.

**Схема API (сверено 2026-07-13):**
- Список: `GET https://career.habr.com/api/frontend/vacancies?q=<kw>&page=<n>&per_page=50&sort=date` → `{ list: [...], meta: { totalPages } }`.
- Поля элемента: `id, href, title, remoteWork (bool), salary {from,to,currency}, company {id, title, alias}, publishedDate, locations`.
- Карточка: `GET https://career.habr.com/vacancies/<id>` — HTML c `<script type="application/ld+json">` (schema.org JobPosting, поле `description` — HTML полного описания).

- [ ] **Step 0: Сверка схемы**

Run: `curl -s "https://career.habr.com/api/frontend/vacancies?q=python&page=1&per_page=5" | python3 -m json.tool | head -80` и открыть одну карточку: `curl -s "https://career.habr.com/vacancies/<id>" | grep -o 'application/ld+json' `.
Expected: поля как выше (уточнить формат `publishedDate` — объект или строка) и JSON-LD на карточке. Расхождения → поправить типы/фикстуры.

- [ ] **Step 1: Failing-тест**

```typescript
// tests/sources-habr.test.ts
import { describe, it, expect, vi } from "vitest";
import { habrSource, extractJsonLd } from "../src/sources/habr.js";
import type { Config } from "../src/config.js";

const LIST_FIXTURE = {
  list: [{
    id: 555, href: "/vacancies/555", title: "LLM Engineer", remoteWork: true,
    salary: { from: 300000, to: null, currency: "rur" },
    company: { id: 77, title: "ООО Рога", alias: "roga" },
    publishedDate: { date: "2026-07-11T10:00:00+03:00" },
    locations: [{ title: "Москва" }],
  }],
  meta: { totalPages: 1 },
};
const CARD_HTML = `<html><head>
<script type="application/ld+json">{"@type":"JobPosting","title":"LLM Engineer","description":"<p>Нужен LLM-инженер: RAG, агенты</p>"}</script>
</head><body></body></html>`;
const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe("habrSource", () => {
  it("search маппит список: id, вилка, remote", async () => {
    const f = vi.fn().mockResolvedValue(jsonRes(LIST_FIXTURE));
    const cards = await habrSource(f as never).search(["llm"], {} as Config);
    expect(cards[0].id).toBe("habr:555");
    expect(cards[0].url).toBe("https://career.habr.com/vacancies/555");
    expect(cards[0].salary_from).toBe(300000);
    expect(cards[0].work_format).toBe("remote");
    expect(cards[0].employer_id).toBe("habr:77");
    expect(cards[0].published_at).toBe("2026-07-11T10:00:00+03:00");
  });
  it("extractJsonLd достаёт описание JobPosting из HTML", () => {
    const d = extractJsonLd(CARD_HTML);
    expect(d).toContain("Нужен LLM-инженер");
    expect(d).not.toContain("<p>");
  });
  it("fetchText берёт описание с карточки", async () => {
    const f = vi.fn().mockResolvedValue(new Response(CARD_HTML, { status: 200 }));
    const text = await habrSource(f as never).fetchText({ id: "habr:555", url: "https://career.habr.com/vacancies/555" } as never);
    expect(text).toContain("RAG, агенты");
  });
});
```

- [ ] **Step 2: Прогнать — FAIL.**

- [ ] **Step 3: Реализация**

```typescript
// src/sources/habr.ts
import type { Config } from "../config.js";
import type { VacancyInsert, VacancyRow } from "../state/types.js";
import type { Fetch } from "./http.js";
import type { JobSource } from "./types.js";
import { getJson, getText, politePause, stripHtml } from "./http.js";

type HabrItem = {
  id: number; href: string; title: string; remoteWork: boolean;
  salary: { from: number | null; to: number | null; currency: string | null } | null;
  company: { id: number; title: string; alias?: string };
  publishedDate?: { date?: string } | string | null;
  locations?: { title: string }[];
};
type ListResp = { list: HabrItem[]; meta: { totalPages: number } };

const MAX_PAGES = 3;   // 150 свежих на слово при sort=date — дальше старьё

export function extractJsonLd(html: string): string {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("habr: JSON-LD не найден на карточке");
  const data = JSON.parse(m[1]) as { description?: string };
  if (!data.description) throw new Error("habr: JobPosting без description");
  return stripHtml(data.description);
}

export function habrSource(f: Fetch = fetch): JobSource {
  return {
    name: "habr",
    async search(keywords: string[], _cfg: Config): Promise<VacancyInsert[]> {
      const seen = new Set<string>();
      const out: VacancyInsert[] = [];
      for (const kw of keywords) {
        for (let page = 1; page <= MAX_PAGES; page++) {
          const resp = await getJson<ListResp>(f,
            `https://career.habr.com/api/frontend/vacancies?q=${encodeURIComponent(kw)}&page=${page}&per_page=50&sort=date`);
          if (!Array.isArray(resp.list)) throw new Error("habr: неожиданная схема (нет list)");
          for (const it of resp.list) {
            const id = `habr:${it.id}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const pub = typeof it.publishedDate === "string" ? it.publishedDate : it.publishedDate?.date ?? null;
            out.push({
              id, url: `https://career.habr.com${it.href}`, title: it.title,
              employer_id: `habr:${it.company.id}`, employer_name: it.company.title,
              salary_from: it.salary?.from ?? null, salary_to: it.salary?.to ?? null,
              currency: it.salary?.currency?.toUpperCase() === "RUR" ? "RUR" : it.salary?.currency ?? null,
              work_format: it.remoteWork ? "remote" : "unknown",   // офис/гибрид в списке не различимы
              experience: null, published_at: pub, raw_json: JSON.stringify(it), source: "habr",
            });
          }
          if (page >= resp.meta.totalPages) break;
          await politePause();
        }
      }
      return out;
    },
    async fetchText(v: VacancyRow): Promise<string> {
      return extractJsonLd(await getText(f, v.url));
    },
  };
}
```

- [ ] **Step 4: Прогнать** — PASS. **Step 5: живой smoke** (аналогично Task 4 Step 5, через `npx tsx`). 

- [ ] **Step 6: Commit**

```bash
git add src/sources/habr.ts tests/sources-habr.test.ts
git commit -m "feat(sources): адаптер Habr Career — /api/frontend/vacancies + JSON-LD карточки"
```

---

### Task 6: Адаптер getmatch.ru

**Files:**
- Create: `src/sources/getmatch.ts`
- Test: `tests/sources-getmatch.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: `getmatchSource(f?: Fetch): JobSource`. id `getmatch:<num>`. Особенность: текстового поиска в API нет — качаем всё (limit=100, до `meta.total`) и фильтруем локально по keywords; `description_html` приходит в списке → текст кладём в `raw_json` при ingest, `fetchText` читает из него без сети.

**Схема API (сверено 2026-07-13):** `GET https://getmatch.ru/api/offers?limit=100&offset=<n>` → `{ meta: { total }, offers: [...] }`; поля оффера: `id, position, company {name}, salary_display_from, salary_display_to, salary_currency, description_html, location_items [{format?}], english_level, published_at, url`.

- [ ] **Step 0: Сверка схемы**

Run: `curl -s "https://getmatch.ru/api/offers?limit=2&offset=0" | python3 -m json.tool | head -80`
Expected: поля как выше; уточнить точные имена (`salary_display_from` vs `salary_from`), формат `location_items`, наличие `url`. Расхождения → поправить.

- [ ] **Step 1: Failing-тест**

```typescript
// tests/sources-getmatch.test.ts
import { describe, it, expect, vi } from "vitest";
import { getmatchSource, matchesKeywords } from "../src/sources/getmatch.js";
import type { Config } from "../src/config.js";

const OFFERS_FIXTURE = {
  meta: { total: 2 },
  offers: [
    { id: 1, position: "Senior Python Developer", company: { name: "Fintech X" },
      salary_display_from: 350000, salary_display_to: 450000, salary_currency: "RUB",
      description_html: "<p>Бэкенд на Python, ML-пайплайны</p>",
      location_items: [{ format: "remote" }], published_at: "2026-07-09", url: "https://getmatch.ru/vacancies/1" },
    { id: 2, position: "1C Консультант", company: { name: "Y" },
      salary_display_from: null, salary_display_to: null, salary_currency: null,
      description_html: "<p>1C</p>", location_items: [], published_at: "2026-07-09", url: "https://getmatch.ru/vacancies/2" },
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
  it("matchesKeywords ищет по позиции и описанию, без регистра", () => {
    expect(matchesKeywords("ML Engineer", "<p>деплой моделей</p>", ["python", "ml"])).toBe(true);
    expect(matchesKeywords("Бухгалтер", "<p>1С</p>", ["python", "ml"])).toBe(false);
  });
});
```

- [ ] **Step 2: Прогнать — FAIL.**

- [ ] **Step 3: Реализация**

```typescript
// src/sources/getmatch.ts
import type { Config } from "../config.js";
import type { VacancyInsert, VacancyRow, WorkFormat } from "../state/types.js";
import type { Fetch } from "./http.js";
import type { JobSource } from "./types.js";
import { getJson, politePause, stripHtml } from "./http.js";

type Offer = {
  id: number; position: string; company: { name: string };
  salary_display_from: number | null; salary_display_to: number | null; salary_currency: string | null;
  description_html: string; location_items: { format?: string }[];
  published_at: string | null; url?: string;
};
type OffersResp = { meta: { total: number }; offers: Offer[] };

// В API getmatch нет текстового поиска — базы ~700 офферов, качаем целиком и фильтруем сами.
export function matchesKeywords(position: string, descriptionHtml: string, keywords: string[]): boolean {
  const hay = `${position} ${stripHtml(descriptionHtml)}`.toLowerCase();
  return keywords.some(k => hay.includes(k.toLowerCase()));
}

function fmt(items: { format?: string }[]): WorkFormat {
  const fs = items.map(i => i.format ?? "");
  if (fs.some(x => /remote/i.test(x))) return "remote";
  if (fs.some(x => /hybrid/i.test(x))) return "hybrid";
  if (fs.some(x => /office/i.test(x))) return "office";
  return "unknown";
}

export function getmatchSource(f: Fetch = fetch): JobSource {
  return {
    name: "getmatch",
    async search(keywords: string[], _cfg: Config): Promise<VacancyInsert[]> {
      const out: VacancyInsert[] = [];
      for (let offset = 0; ; offset += 100) {
        const resp = await getJson<OffersResp>(f, `https://getmatch.ru/api/offers?limit=100&offset=${offset}`);
        if (!Array.isArray(resp.offers)) throw new Error("getmatch: неожиданная схема (нет offers)");
        for (const o of resp.offers) {
          if (!matchesKeywords(o.position, o.description_html ?? "", keywords)) continue;
          out.push({
            id: `getmatch:${o.id}`, url: o.url ?? `https://getmatch.ru/vacancies/${o.id}`, title: o.position,
            employer_id: `getmatch:${o.company.name.toLowerCase().trim()}`, employer_name: o.company.name,
            salary_from: o.salary_display_from, salary_to: o.salary_display_to,
            currency: o.salary_currency === "RUB" ? "RUR" : o.salary_currency,
            work_format: fmt(o.location_items ?? []), experience: null,
            published_at: o.published_at,
            // description_html кладём в raw_json: fetchText потом не ходит в сеть
            raw_json: JSON.stringify({ text: stripHtml(o.description_html ?? "") }),
            source: "getmatch",
          });
        }
        if (offset + 100 >= resp.meta.total || resp.offers.length === 0) break;
        await politePause();
      }
      return out;
    },
    async fetchText(v: VacancyRow): Promise<string> {
      const text = (JSON.parse(v.raw_json ?? "{}") as { text?: string }).text;
      if (!text) throw new Error(`getmatch: нет текста в raw_json для ${v.id}`);
      return text;
    },
  };
}
```

- [ ] **Step 4: Прогнать** — PASS. **Step 5: живой smoke** через `npx tsx` (аналогично Task 4).

- [ ] **Step 6: Commit**

```bash
git add src/sources/getmatch.ts tests/sources-getmatch.test.ts
git commit -m "feat(sources): адаптер getmatch.ru — полная выкачка + локальный фильтр"
```

---

### Task 7: Адаптер trudvsem.ru («Работа России»)

**Files:**
- Create: `src/sources/trudvsem.ts`
- Test: `tests/sources-trudvsem.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: `trudvsemSource(f?: Fetch): JobSource`. id `trudvsem:<uuid>`, employer_id `trudvsem:<companycode>`. **Email работодателя из payload сохраняется в raw_json** (`{ text, email }`) — его подберёт email-flow (второй план).

**Схема API (официальная, сверено 2026-07-13):**
- `GET https://opendata.trudvsem.ru/api/v1/vacancies/region/77?text=<kw>&limit=100&offset=<page>` — `offset` это **номер страницы** (0-based), `limit` ≤ 100.
- Ответ: `{ status, results: { vacancies: [{ vacancy: {...} }] } }`; поля vacancy: `id, job-name, salary_min, salary_max, duty, requirement {education, experience}, company {name, email, companycode, inn}, vac_url, creation-date, schedule` (+ поле требований `requirements`-текст в некоторых версиях — сверить).
- API медленное (~4–5 с/запрос) — таймаут 60 с.

- [ ] **Step 0: Сверка схемы**

Run: `curl -s "https://opendata.trudvsem.ru/api/v1/vacancies/region/77?text=python&limit=2&offset=0" | python3 -m json.tool | head -100`
Expected: структура как выше; уточнить имя поля с текстом требований (плоское `requirement` — объект education/experience; текст обязанностей — `duty`). Расхождения → поправить типы/фикстуру.

- [ ] **Step 1: Failing-тест**

```typescript
// tests/sources-trudvsem.test.ts
import { describe, it, expect, vi } from "vitest";
import { trudvsemSource } from "../src/sources/trudvsem.js";
import type { Config } from "../src/config.js";

const FIXTURE = {
  status: "200",
  results: { vacancies: [{ vacancy: {
    id: "b49900b8-aaaa", "job-name": "Разработчик Python",
    salary_min: 150000, salary_max: 250000,
    duty: "<p>Разработка сервисов</p>",
    company: { name: "АО ЦПЛ", email: "hr@cpl.ru", companycode: "1097746819720" },
    vac_url: "https://trudvsem.ru/vacancy/card/1097746819720/b49900b8-aaaa",
    "creation-date": "2026-07-08",
    schedule: "Дистанционная (удаленная) работа",
  }}]},
};
const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe("trudvsemSource", () => {
  it("маппит вакансию: id, зарплата, email в raw_json, удалёнка из schedule", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(jsonRes(FIXTURE))
      .mockResolvedValue(jsonRes({ status: "200", results: { vacancies: [] } }));
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
  });
  it("fetchText читает из raw_json без сети", async () => {
    const f = vi.fn().mockResolvedValueOnce(jsonRes(FIXTURE)).mockResolvedValue(jsonRes({ status: "200", results: { vacancies: [] } }));
    const src = trudvsemSource(f as never);
    const [card] = await src.search(["python"], {} as Config);
    f.mockClear();
    expect(await src.fetchText(card as never)).toContain("Разработка сервисов");
    expect(f).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Прогнать — FAIL.**

- [ ] **Step 3: Реализация**

```typescript
// src/sources/trudvsem.ts
import type { Config } from "../config.js";
import type { VacancyInsert, VacancyRow, WorkFormat } from "../state/types.js";
import type { Fetch } from "./http.js";
import type { JobSource } from "./types.js";
import { getJson, politePause, stripHtml } from "./http.js";

type TvVacancy = {
  id: string; "job-name": string; salary_min?: number | null; salary_max?: number | null;
  duty?: string; requirement?: { education?: string; experience?: number };
  company: { name: string; email?: string; companycode?: string; inn?: string };
  vac_url?: string; "creation-date"?: string; schedule?: string;
};
type TvResp = { status: string; results?: { vacancies?: { vacancy: TvVacancy }[] } };

const MAX_PAGES = 2;   // 200 на слово в Москве — больше по IT там просто нет
const TIMEOUT = 60_000; // API госпортала медленное, ~4-5 c на запрос

function fmt(schedule: string | undefined): WorkFormat {
  return schedule && /дистанц|удал/i.test(schedule) ? "remote" : "unknown";
}

export function trudvsemSource(f: Fetch = fetch): JobSource {
  return {
    name: "trudvsem",
    async search(keywords: string[], _cfg: Config): Promise<VacancyInsert[]> {
      const seen = new Set<string>();
      const out: VacancyInsert[] = [];
      for (const kw of keywords) {
        for (let page = 0; page < MAX_PAGES; page++) {
          // offset у trudvsem — номер СТРАНИЦЫ (0-based), не записи
          const resp = await getJson<TvResp>(f,
            `https://opendata.trudvsem.ru/api/v1/vacancies/region/77?text=${encodeURIComponent(kw)}&limit=100&offset=${page}`, TIMEOUT);
          const items = resp.results?.vacancies ?? [];
          for (const { vacancy: v } of items) {
            const id = `trudvsem:${v.id}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const text = stripHtml([v.duty ?? "", v.requirement?.education ?? ""].join("\n"));
            out.push({
              id, url: v.vac_url ?? `https://trudvsem.ru/vacancy/card/${v.company.companycode}/${v.id}`,
              title: v["job-name"],
              employer_id: `trudvsem:${v.company.companycode ?? v.company.inn ?? v.company.name.toLowerCase()}`,
              employer_name: v.company.name,
              salary_from: v.salary_min ?? null, salary_to: v.salary_max ?? null,
              currency: v.salary_min || v.salary_max ? "RUR" : null,
              work_format: fmt(v.schedule), experience: null,
              published_at: v["creation-date"] ?? null,
              // text — для скоринга без повторного похода; email — подхватит email-flow
              raw_json: JSON.stringify({ text, email: v.company.email ?? null }),
              source: "trudvsem",
            });
          }
          if (items.length < 100) break;
          await politePause();
        }
      }
      return out;
    },
    async fetchText(v: VacancyRow): Promise<string> {
      const text = (JSON.parse(v.raw_json ?? "{}") as { text?: string }).text;
      if (!text) throw new Error(`trudvsem: нет текста в raw_json для ${v.id}`);
      return text;
    },
  };
}
```

- [ ] **Step 4: Прогнать** — PASS. **Step 5: живой smoke** через `npx tsx` (учесть латентность API).

- [ ] **Step 6: Commit**

```bash
git add src/sources/trudvsem.ts tests/sources-trudvsem.test.ts
git commit -m "feat(sources): адаптер trudvsem — официальное API, email работодателя в raw_json"
```

---

### Task 8: Реестр источников + интеграция в пайплайн

**Files:**
- Create: `src/sources/index.ts`
- Modify: `src/pipeline/run.ts` (стадия ingest; диспатч fetchText; skip не-hh в apply)
- Modify: `src/index.ts` (sources в Deps)
- Test: `tests/pipeline-sources.test.ts`

**Interfaces:**
- Consumes: все адаптеры (Task 4–7), `JobSource`, `cfg.enabledSources`, `cfg.sourceKeywords`.
- Produces: `buildSources(cfg: Config, f?: Fetch): JobSource[]`; `Deps` расширен полем `sources: JobSource[]`; `RunSummary` без изменений.

- [ ] **Step 1: Реестр**

```typescript
// src/sources/index.ts
import type { Config } from "../config.js";
import type { Fetch } from "./http.js";
import type { JobSource } from "./types.js";
import { hirehiSource } from "./hirehi.js";
import { habrSource } from "./habr.js";
import { getmatchSource } from "./getmatch.js";
import { trudvsemSource } from "./trudvsem.js";

export function buildSources(cfg: Config, f: Fetch = fetch): JobSource[] {
  const all: Record<string, (ff: Fetch) => JobSource> = {
    hirehi: hirehiSource, habr: habrSource, getmatch: getmatchSource, trudvsem: trudvsemSource,
  };
  return cfg.enabledSources.map(name => all[name](f));
}
```

- [ ] **Step 2: Failing-тест интеграции**

```typescript
// tests/pipeline-sources.test.ts
import { describe, it, expect, vi } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { runSession, type Deps } from "../src/pipeline/run.js";
import { ConfigSchema } from "../src/config.js";
import type { JobSource } from "../src/sources/types.js";
import type { VacancyInsert } from "../src/state/types.js";

const card = (id: string, source: string, title: string): VacancyInsert => ({
  id, url: `https://x.test/${id}`, title, employer_id: `${source}:acme`, employer_name: "Acme " + id,
  salary_from: 300000, salary_to: null, currency: "RUR", work_format: "remote",
  experience: null, published_at: new Date().toISOString(), raw_json: JSON.stringify({ text: "текст вакансии про LLM" }), source,
});

function fakeSource(name: string, cards: VacancyInsert[]): JobSource {
  return {
    name: name as never,
    search: vi.fn().mockResolvedValue(cards),
    fetchText: vi.fn().mockResolvedValue("полный текст про LLM и Python"),
  };
}

function mkDeps(db: ReturnType<typeof openDb>, sources: JobSource[]): Deps {
  return {
    db, cfg: ConfigSchema.parse({ mode: "dry_run", searchQueries: [], scoreThreshold: 65 }),
    browser: {
      searchVacancies: vi.fn().mockResolvedValue([]),
      fetchVacancyText: vi.fn(), apply: vi.fn(), waitCaptchaCleared: vi.fn(),
    } as never,
    claude: vi.fn().mockResolvedValue(JSON.stringify({ score: 80, reasons: ["ok"], red_flags: [] })) as never,
    pplx: vi.fn().mockResolvedValue("research") as never,
    notify: vi.fn(), resume: "резюме", sources,
  };
}

describe("runSession с новыми источниками", () => {
  it("инжестит карточки из источников и скорит их без браузера", async () => {
    const db = openDb(":memory:");
    const src = fakeSource("hirehi", [card("hirehi:1", "hirehi", "LLM Engineer")]);
    const deps = mkDeps(db, [src]);
    const s = await runSession(deps, "manual", "dry_run");
    expect(s.discovered).toBe(1);
    expect(src.search).toHaveBeenCalled();
    const v = repo.getVacancy(db, "hirehi:1")!;
    expect(["queued", "skipped"]).toContain(v.status);   // проскорена, браузер не трогали
    expect((deps.browser.fetchVacancyText as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
  it("падение одного источника не валит прогон", async () => {
    const db = openDb(":memory:");
    const bad: JobSource = { name: "habr", search: vi.fn().mockRejectedValue(new Error("503")), fetchText: vi.fn() };
    const ok = fakeSource("hirehi", [card("hirehi:2", "hirehi", "ML Engineer")]);
    const s = await runSession(mkDeps(db, [bad, ok]), "manual", "dry_run");
    expect(s.discovered).toBe(1);
    expect(s.errors).toBeGreaterThan(0);
    expect(s.stopReason).toBe("completed");
  });
  it("не-hh вакансии не попадают в браузерный apply", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, card("hirehi:3", "hirehi", "AI Engineer"));
    repo.setStatus(db, "hirehi:3", "queued", { score: 90, score_reasons: "{}", raw_json: JSON.stringify({ text: "t" }) });
    const deps = mkDeps(db, []);
    await runSession(deps, "manual", "live");
    expect((deps.browser.apply as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
```

Примечание: если сигнатура мокнутого `claude` не совпадёт с реальным `scoreVacancy` — свериться с `src/llm/scoring.ts` и замокать так, как он реально дергает `callClaude` (тест должен пройти через настоящий scoreVacancy).

- [ ] **Step 3: Прогнать — FAIL** (Deps без sources, ingest-стадии нет).

- [ ] **Step 4: Реализация в `src/pipeline/run.ts`**

Изменения:

1. Импорт и Deps:

```typescript
import type { JobSource } from "../sources/types.js";
// в Deps добавить:
export type Deps = { db: Database; cfg: Config; browser: BrowserPort; claude: typeof callClaude; pplx: typeof callPerplexity; notify: (msg: string) => void; resume: string; sources: JobSource[] };
```

2. После блока hh-рекомендаций (строка ~69), новая стадия ingest:

```typescript
  // 1b) ingest из HTTP-источников: браузер не нужен, ошибка одного источника — не повод
  // останавливать прогон (hh-часть уже отработала, остальные источники независимы).
  for (const src of deps.sources) {
    try {
      const cards = await src.search(cfg.sourceKeywords, cfg);
      for (const c of cards) if (repo.upsertVacancy(db, c)) s.discovered++;
    } catch (e) {
      s.errors++;
      console.error(`[run ${runId}] source ${src.name} failed: ${String(e).slice(0, 200)}`);
    }
  }
```

(Стадия выполняется даже если hh остановился по капче: заменить условие `if (s.stopReason === "completed")` вокруг стадии 2 нельзя трогать, но ingest вставить ПЕРЕД проверкой — т.е. между стадиями 1 и 2, без обёртки в условие. Исключение: `stopReason === "logged_out"` тоже не мешает HTTP-источникам.)

3. В стадии 2 (score) заменить получение текста:

```typescript
      let text: string;
      if (v.source === "hh") {
        const t = await guarded(() => deps.browser.fetchVacancyText(v.url));
        if (t === "stop") break;
        if (t === "skip") { repo.setStatus(db, v.id, "failed"); continue; }
        text = t;
      } else {
        const src = deps.sources.find(x => x.name === v.source);
        if (!src) { repo.setStatus(db, v.id, "failed", { filter_reason: "source_disabled" }); continue; }
        try { text = await src.fetchText(v); }
        catch (e) {
          s.errors++;
          // транзиентная ошибка — оставляем discovered на следующий прогон
          if (!isTransient(e)) repo.setStatus(db, v.id, "failed");
          continue;
        }
      }
```

4. В стадии 3 (apply), первой строкой цикла:

```typescript
      // Отклик умеем делать только на hh (браузер). Не-hh queued ждут email-flow (отдельный план).
      if (v.source !== "hh") continue;
```

5. `src/index.ts`: добавить импорт `buildSources` и поле в mkDeps:

```typescript
import { buildSources } from "./sources/index.js";
// в mkDeps():
  return { db, cfg: loadConfig(), browser, claude: callClaude, pplx: callPerplexity, notify,
    resume: readFileSync(loadConfig().resumePath, "utf8"), sources: buildSources(loadConfig()) };
```

- [ ] **Step 5: Прогнать всё**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. Если старые тесты создают Deps — добавить им `sources: []`.

- [ ] **Step 6: Живой smoke всего пайплайна (dry_run)**

Run: `npm run build && node -e "..."` — либо через MCP `run_now {mode: 'dry_run'}` на живом агенте. Проверить в БД: `sqlite3 ~/.hh-agent/state.db "SELECT source, COUNT(*) FROM vacancies GROUP BY source"` — появились строки новых источников.
Expected: discovered > 0 от новых источников, скоринг работает, hh-поток не сломан.

- [ ] **Step 7: Commit**

```bash
git add src/sources/index.ts src/pipeline/run.ts src/index.ts tests/pipeline-sources.test.ts
git commit -m "feat(pipeline): ingest из 4 HTTP-источников + скоринг без браузера; apply только для hh"
```

---

## Self-Review (выполнено при написании)

- Покрытие: миграция+дедуп (T1), конфиг (T2), интерфейс (T3), 4 адаптера (T4–7), интеграция (T8). Email-flow сознательно вне скоупа — второй план.
- Типы сходятся: `VacancyInsert.source` (T1) используется всеми адаптерами; `JobSource` (T3) — единый для T4–T8; `Deps.sources` (T8).
- Известные допущения, проверяемые Step 0 каждого адаптера: точные имена полей ответов и шаблон веб-URL hirehi. Это отражено в шагах сверки — расхождение фикстуры с реальностью чинится в рамках задачи адаптера.
