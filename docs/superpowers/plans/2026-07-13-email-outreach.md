# Email Outreach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Для вакансий из новых источников (не hh): найти почту HR через Perplexity (кэш по компании, гейт до скоринга), после скоринга и research сгенерировать письмо, положить в очередь черновиков; отправка — только после ручного подтверждения через MCP-инструменты, по SMTP.

**Architecture:** Почта — атрибут компании (`companies.contact_email` + статус/TTL, как company research). Гейт в стадии скоринга: не-hh вакансия без почты (payload → кэш → Perplexity) скипается до скоринга. Черновики писем — отдельная таблица `emails` (vacancy_id UNIQUE), статусы draft→sent/rejected; статусы вакансий не расширяются (queued→applied как раньше, applied = письмо отправлено). Отправка — nodemailer/SMTP (Gmail app password из env), только из MCP-инструмента `approve_email`.

**Tech Stack:** TypeScript ESM strict, better-sqlite3, vitest, nodemailer (новая зависимость), Perplexity sonar.

**Prerequisite:** План `2026-07-13-multi-source-ingest.md` выполнен (колонка `source`, адаптеры, trudvsem кладёт `email` в raw_json).

## Global Constraints

- Node 24, ESM, TypeScript strict; тесты `npx vitest run`; комментарии по-русски, объясняют «почему».
- Никакой автоотправки: письмо уходит ТОЛЬКО из `approve_email` (ручное действие пользователя через MCP). Пайплайн лишь создаёт черновики.
- Дневной потолок отправки: `cfg.emailDailyLimit` (default 10, max 30) — проверяется в `approve_email`.
- SMTP-пароль только из env `SMTP_PASSWORD` (Gmail app password); в конфиг/БД/логи не писать.
- TTL кэша почты — 30 дней (и для found, и для not_found), симметрично company research.
- Единственная новая зависимость: `nodemailer` + `@types/nodemailer`.
- Коммит после каждой задачи.

---

### Task 1: Миграция V003 + типы + repo-функции для почты и черновиков

**Files:**
- Create: `db/migrations/V003__email_outreach.sql`
- Modify: `src/state/types.ts` (EmailRow, EmailInsert; purpose в LlmCallInsert)
- Modify: `src/state/repo.ts` (getCompanyEmail, saveCompanyEmail, insertEmailDraft, getEmailByVacancy, getEmailsByStatus, markEmailSent, markEmailRejected, updateEmailDraft, emailsSentToday)
- Test: `tests/repo-emails.test.ts`

**Interfaces:**
- Produces:
  - `getCompanyEmail(db, employerId): { email: string | null; status: "found" | "not_found"; checkedAt: string } | null`
  - `saveCompanyEmail(db, employerId, name, email: string | null, source: "source_payload" | "perplexity" | null): void` — email=null пишет status='not_found'
  - `insertEmailDraft(db, { vacancy_id, to_email, subject, body }): boolean` — false, если черновик уже есть
  - `getEmailByVacancy(db, vacancyId): EmailRow | undefined`
  - `getEmailsByStatus(db, status: "draft" | "sent" | "rejected"): EmailRow[]`
  - `updateEmailDraft(db, id, patch: { subject?: string; body?: string }): void`
  - `markEmailSent(db, id): void`; `markEmailRejected(db, id): void`
  - `emailsSentToday(db): number`
  - тип `EmailRow { id: number; vacancy_id: string; to_email: string; subject: string; body: string; status: "draft" | "sent" | "rejected"; created_at: string; sent_at: string | null }`
  - `LlmCallInsert.purpose` расширен значением `"email_search"`

- [ ] **Step 1: Миграция**

```sql
-- db/migrations/V003__email_outreach.sql
-- Почта — атрибут КОМПАНИИ (не вакансии): кэшируется как research, с TTL в коде.
ALTER TABLE companies ADD COLUMN contact_email TEXT;
ALTER TABLE companies ADD COLUMN email_status TEXT CHECK (email_status IN ('found', 'not_found'));
ALTER TABLE companies ADD COLUMN email_checked_at TEXT;
ALTER TABLE companies ADD COLUMN email_source TEXT;  -- source_payload | perplexity

-- Черновики/журнал писем. UNIQUE(vacancy_id): одно письмо на вакансию, повторный прогон
-- пайплайна не плодит дубликаты и не перетирает вручную отредактированный черновик.
CREATE TABLE emails (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    vacancy_id TEXT NOT NULL UNIQUE REFERENCES vacancies(id),
    to_email   TEXT NOT NULL,
    subject    TEXT NOT NULL,
    body       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at    TEXT
);
CREATE INDEX idx_emails_status ON emails (status);

-- llm_calls.purpose: добавить 'email_search'. SQLite не умеет менять CHECK — пересоздаём таблицу.
CREATE TABLE llm_calls_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    vacancy_id    TEXT REFERENCES vacancies(id) ON DELETE SET NULL,
    run_id        INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    provider      TEXT NOT NULL CHECK (provider IN ('anthropic', 'perplexity')),
    purpose       TEXT NOT NULL CHECK (purpose IN ('scoring', 'research', 'letter', 'email_search')),
    model         TEXT NOT NULL,
    request       TEXT NOT NULL,
    response      TEXT,
    error         TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    cost_usd      REAL,
    latency_ms    INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO llm_calls_new SELECT * FROM llm_calls;
DROP TABLE llm_calls;
ALTER TABLE llm_calls_new RENAME TO llm_calls;
CREATE INDEX idx_llm_calls_vacancy ON llm_calls (vacancy_id);
CREATE INDEX idx_llm_calls_created ON llm_calls (created_at DESC);
CREATE INDEX idx_llm_calls_purpose ON llm_calls (purpose);
```

- [ ] **Step 2: Failing-тест**

```typescript
// tests/repo-emails.test.ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import type { VacancyInsert } from "../src/state/types.js";

const vac = (id: string): VacancyInsert => ({
  id, url: "https://x.test/" + id, title: "ML", employer_id: "hirehi:acme", employer_name: "Acme",
  salary_from: null, salary_to: null, currency: null, work_format: null, experience: null,
  published_at: null, raw_json: null, source: "hirehi",
});

describe("кэш почты компании", () => {
  it("save/get found и not_found", () => {
    const db = openDb(":memory:");
    repo.saveCompanyEmail(db, "e1", "Acme", "hr@acme.ru", "perplexity");
    expect(repo.getCompanyEmail(db, "e1")).toMatchObject({ email: "hr@acme.ru", status: "found" });
    repo.saveCompanyEmail(db, "e2", "Beta", null, null);
    expect(repo.getCompanyEmail(db, "e2")).toMatchObject({ email: null, status: "not_found" });
    expect(repo.getCompanyEmail(db, "нет")).toBeNull();
  });
  it("не затирает research при сохранении почты", () => {
    const db = openDb(":memory:");
    repo.saveCompanyResearch(db, "e1", "Acme", "справка");
    repo.saveCompanyEmail(db, "e1", "Acme", "hr@acme.ru", "perplexity");
    expect(repo.getCompanyResearch(db, "e1")?.research).toBe("справка");
  });
});

describe("черновики писем", () => {
  it("insert → get → update → sent; повторный insert не дублирует", () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, vac("hirehi:1"));
    expect(repo.insertEmailDraft(db, { vacancy_id: "hirehi:1", to_email: "hr@acme.ru", subject: "S", body: "B" })).toBe(true);
    expect(repo.insertEmailDraft(db, { vacancy_id: "hirehi:1", to_email: "hr@acme.ru", subject: "S2", body: "B2" })).toBe(false);
    const e = repo.getEmailByVacancy(db, "hirehi:1")!;
    expect(e.subject).toBe("S");   // повторный прогон не перетёр черновик
    repo.updateEmailDraft(db, e.id, { body: "правленый" });
    expect(repo.getEmailByVacancy(db, "hirehi:1")!.body).toBe("правленый");
    expect(repo.emailsSentToday(db)).toBe(0);
    repo.markEmailSent(db, e.id);
    expect(repo.getEmailsByStatus(db, "sent")).toHaveLength(1);
    expect(repo.emailsSentToday(db)).toBe(1);
  });
});

describe("llm_calls после пересоздания", () => {
  it("принимает purpose=email_search и сохраняет старые записи", () => {
    const db = openDb(":memory:");
    repo.insertLlmCall(db, { vacancy_id: null, run_id: null, provider: "perplexity", purpose: "email_search",
      model: "sonar", request: "{}", response: null, error: null, input_tokens: 1, output_tokens: 1, cost_usd: 0, latency_ms: 1 });
  });
});
```

- [ ] **Step 3: Прогнать — FAIL** (нет миграции/функций).

- [ ] **Step 4: Реализация**

В `src/state/types.ts`:

```typescript
export type EmailStatus = "draft" | "sent" | "rejected";

export interface EmailRow {
  id: number;
  vacancy_id: string;
  to_email: string;
  subject: string;
  body: string;
  status: EmailStatus;
  created_at: string;
  sent_at: string | null;
}

export interface EmailInsert {
  vacancy_id: string;
  to_email: string;
  subject: string;
  body: string;
}
```

и в `LlmCallInsert`: `purpose: "scoring" | "research" | "letter" | "email_search";` (то же обновить в `src/llm/log.ts` в типе параметра `logCall`, поле `purpose`).

В `src/state/repo.ts` добавить:

```typescript
import type { EmailInsert, EmailRow, EmailStatus } from "./types.js";

export function getCompanyEmail(db: Database, employerId: string):
  { email: string | null; status: "found" | "not_found"; checkedAt: string } | null {
  const r = db.prepare(`SELECT contact_email, email_status, email_checked_at FROM companies
    WHERE employer_id=? AND email_status IS NOT NULL`).get(employerId) as
    { contact_email: string | null; email_status: "found" | "not_found"; email_checked_at: string } | undefined;
  return r ? { email: r.contact_email, status: r.email_status, checkedAt: r.email_checked_at } : null;
}

export function saveCompanyEmail(db: Database, employerId: string, name: string,
  email: string | null, source: "source_payload" | "perplexity" | null): void {
  db.prepare(`INSERT INTO companies (employer_id, name, contact_email, email_status, email_checked_at, email_source)
    VALUES (?,?,?,?,datetime('now'),?)
    ON CONFLICT(employer_id) DO UPDATE SET contact_email=excluded.contact_email,
      email_status=excluded.email_status, email_checked_at=excluded.email_checked_at, email_source=excluded.email_source`)
    .run(employerId, name, email, email ? "found" : "not_found", source);
}

export function insertEmailDraft(db: Database, e: EmailInsert): boolean {
  const r = db.prepare(`INSERT OR IGNORE INTO emails (vacancy_id,to_email,subject,body)
    VALUES (@vacancy_id,@to_email,@subject,@body)`).run(e);
  return r.changes > 0;
}
export function getEmailByVacancy(db: Database, vacancyId: string): EmailRow | undefined {
  return db.prepare(`SELECT * FROM emails WHERE vacancy_id=?`).get(vacancyId) as EmailRow | undefined;
}
export function getEmailsByStatus(db: Database, status: EmailStatus): EmailRow[] {
  return db.prepare(`SELECT * FROM emails WHERE status=? ORDER BY created_at`).all(status) as EmailRow[];
}
export function updateEmailDraft(db: Database, id: number, patch: { subject?: string; body?: string }): void {
  db.prepare(`UPDATE emails SET subject=COALESCE(@subject,subject), body=COALESCE(@body,body)
    WHERE id=@id AND status='draft'`).run({ subject: null, body: null, ...patch, id });
}
export function markEmailSent(db: Database, id: number): void {
  db.prepare(`UPDATE emails SET status='sent', sent_at=datetime('now') WHERE id=?`).run(id);
}
export function markEmailRejected(db: Database, id: number): void {
  db.prepare(`UPDATE emails SET status='rejected' WHERE id=?`).run(id);
}
export function emailsSentToday(db: Database): number {
  const r = db.prepare(`SELECT COUNT(*) n FROM emails WHERE status='sent'
    AND date(sent_at,'localtime')=date('now','localtime')`).get() as { n: number };
  return r.n;
}
```

- [ ] **Step 5: Прогнать всё** — `npx vitest run && npx tsc --noEmit` — PASS.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/V003__email_outreach.sql src/state/types.ts src/state/repo.ts src/llm/log.ts tests/repo-emails.test.ts
git commit -m "feat(email): схема V003 — кэш почты компании, таблица emails, purpose email_search"
```

---

### Task 2: Конфиг SMTP + emailDailyLimit

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config-email.test.ts`

**Interfaces:**
- Produces: `cfg.smtp: { host: string; port: number; user: string; fromName: string }`, `cfg.emailDailyLimit: number`, `cfg.resumePdfPath: string | null`.

- [ ] **Step 1: Failing-тест**

```typescript
// tests/config-email.test.ts
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../src/config.js";

describe("email config", () => {
  it("дефолты smtp и лимита", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.smtp.host).toBe("smtp.gmail.com");
    expect(cfg.smtp.port).toBe(465);
    expect(cfg.emailDailyLimit).toBe(10);
    expect(cfg.resumePdfPath).toBeNull();
  });
  it("emailDailyLimit ограничен сверху", () => {
    expect(() => ConfigSchema.parse({ emailDailyLimit: 100 })).toThrow();
  });
});
```

- [ ] **Step 2: Прогнать — FAIL.**

- [ ] **Step 3: Реализация** — в `ConfigSchema` после `dailyLimit`:

```typescript
  // Прямые письма HR: отправка только вручную через approve_email, лимит — второй предохранитель.
  emailDailyLimit: z.number().int().min(1).max(30).default(10),
  smtp: z
    .object({
      host: z.string().default("smtp.gmail.com"),
      port: z.number().default(465),
      user: z.string().default("doronin.alex001@gmail.com"),
      fromName: z.string().default("Александр Доронин"),
    })
    .default({ host: "smtp.gmail.com", port: 465, user: "doronin.alex001@gmail.com", fromName: "Александр Доронин" }),
  resumePdfPath: z.string().nullable().default(null),   // PDF-резюме вложением, если задан
```

- [ ] **Step 4: Прогнать — PASS.** 

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config-email.test.ts
git commit -m "feat(config): smtp + emailDailyLimit + resumePdfPath"
```

---

### Task 3: Модуль поиска почты (Perplexity + кэш)

**Files:**
- Create: `src/llm/emailSearch.ts`
- Modify: `src/llm/prompts.ts` (EMAIL_SEARCH_PROMPT_V1)
- Modify: `src/llm/perplexity.ts` (purpose как параметр)
- Test: `tests/email-search.test.ts`

**Interfaces:**
- Consumes: `callPerplexity`, `repo.getCompanyEmail`/`saveCompanyEmail` (Task 1).
- Produces: `findCompanyEmail(ctx: LlmLogCtx, pplx: typeof callPerplexity, cfg: Config, employerId: string, name: string, payloadEmail?: string | null): Promise<string | null>`; `parseEmailAnswer(raw: string): string | null` (экспорт для теста).
- Modify contract: `callPerplexity` принимает `purpose: "research" | "email_search"` (в `src/llm/research.ts` передавать `"research"` явно — сигнатура уже принимает purpose в opts, поменять тип).

- [ ] **Step 1: Failing-тест**

```typescript
// tests/email-search.test.ts
import { describe, it, expect, vi } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { findCompanyEmail, parseEmailAnswer } from "../src/llm/emailSearch.js";

const cfg = { perplexityModel: "sonar" } as never;
const ctx = (db: ReturnType<typeof openDb>) => ({ db, runId: null, vacancyId: null });

describe("parseEmailAnswer", () => {
  it("валидный JSON с почтой", () => {
    expect(parseEmailAnswer('{"email": "hr@acme.ru"}')).toBe("hr@acme.ru");
  });
  it("JSON в маркдаун-обёртке", () => {
    expect(parseEmailAnswer('Вот ответ:\n```json\n{"email": "jobs@x.io"}\n```')).toBe("jobs@x.io");
  });
  it("null и мусор → null", () => {
    expect(parseEmailAnswer('{"email": null}')).toBeNull();
    expect(parseEmailAnswer('{"email": "не найдено"}')).toBeNull();
    expect(parseEmailAnswer("просто текст")).toBeNull();
  });
});

describe("findCompanyEmail", () => {
  it("payload-почта сохраняется без вызова Perplexity", async () => {
    const db = openDb(":memory:");
    const pplx = vi.fn();
    expect(await findCompanyEmail(ctx(db), pplx as never, cfg, "t:1", "ЦПЛ", "hr@cpl.ru")).toBe("hr@cpl.ru");
    expect(pplx).not.toHaveBeenCalled();
    expect(repo.getCompanyEmail(db, "t:1")).toMatchObject({ email: "hr@cpl.ru" });
  });
  it("свежий not_found в кэше → null без вызова", async () => {
    const db = openDb(":memory:");
    repo.saveCompanyEmail(db, "h:2", "Beta", null, null);
    const pplx = vi.fn();
    expect(await findCompanyEmail(ctx(db), pplx as never, cfg, "h:2", "Beta")).toBeNull();
    expect(pplx).not.toHaveBeenCalled();
  });
  it("кэш пуст → Perplexity, результат кэшируется", async () => {
    const db = openDb(":memory:");
    const pplx = vi.fn().mockResolvedValue('{"email": "career@gamma.ru"}');
    expect(await findCompanyEmail(ctx(db), pplx as never, cfg, "h:3", "Gamma")).toBe("career@gamma.ru");
    expect(await findCompanyEmail(ctx(db), pplx as never, cfg, "h:3", "Gamma")).toBe("career@gamma.ru");
    expect(pplx).toHaveBeenCalledTimes(1);
  });
  it("Perplexity не нашла → кэшируем not_found", async () => {
    const db = openDb(":memory:");
    const pplx = vi.fn().mockResolvedValue('{"email": null}');
    expect(await findCompanyEmail(ctx(db), pplx as never, cfg, "h:4", "Delta")).toBeNull();
    expect(repo.getCompanyEmail(db, "h:4")).toMatchObject({ status: "not_found" });
  });
});
```

- [ ] **Step 2: Прогнать — FAIL.**

- [ ] **Step 3: Реализация**

В `src/llm/perplexity.ts` расширить тип: `purpose: "research" | "email_search"` (в сигнатуре opts и в `logCall`). В `src/llm/prompts.ts`:

```typescript
// Узкий промпт: НЕ смешивать с research (проверено — совмещение размывает оба ответа).
export const EMAIL_SEARCH_PROMPT_V1 = (company: string) => `Найди публичный email для откликов на вакансии компании «${company}» (Россия, IT-найм): почту HR-отдела, рекрутинга или карьерную почту (hr@, job@, career@, cv@ и т.п.) с официального сайта компании, её карьерной страницы или официальных страниц в соцсетях.

Правила:
- НЕ выдумывай адрес и НЕ конструируй его по шаблону — только адрес, реально опубликованный компанией.
- Личные адреса сотрудников не предлагай.
- Ответь СТРОГО одним JSON-объектом без пояснений: {"email": "адрес"} или {"email": null}, если публичного адреса для откликов нет.`;
```

```typescript
// src/llm/emailSearch.ts
import * as repo from "../state/repo.js";
import { EMAIL_SEARCH_PROMPT_V1 } from "./prompts.js";
import type { callPerplexity } from "./perplexity.js";
import type { LlmLogCtx } from "./log.js";
import type { Config } from "../config.js";

const TTL_DAYS = 30;   // симметрично company research
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zа-яё]{2,}$/i;

export function parseEmailAnswer(raw: string): string | null {
  const m = raw.match(/\{[^{}]*\}/);
  if (!m) return null;
  try {
    const email = (JSON.parse(m[0]) as { email?: unknown }).email;
    return typeof email === "string" && EMAIL_RE.test(email.trim()) ? email.trim().toLowerCase() : null;
  } catch { return null; }
}

export async function findCompanyEmail(
  ctx: LlmLogCtx, pplx: typeof callPerplexity, cfg: Config,
  employerId: string, name: string, payloadEmail?: string | null,
): Promise<string | null> {
  // 1) источник сам отдал почту (trudvsem) — бесплатно и надёжнее любого поиска
  if (payloadEmail && EMAIL_RE.test(payloadEmail)) {
    repo.saveCompanyEmail(ctx.db, employerId, name, payloadEmail.toLowerCase(), "source_payload");
    return payloadEmail.toLowerCase();
  }
  // 2) кэш: и found, и not_found валидны TTL — не переискиваем то, что недавно не нашлось
  const cached = repo.getCompanyEmail(ctx.db, employerId);
  if (cached && (Date.now() - Date.parse(cached.checkedAt)) / 86_400_000 < TTL_DAYS) return cached.email;
  // 3) Perplexity, отдельным узким вызовом (НЕ внутри research — проверено, деградируют оба)
  const raw = await pplx(ctx, { model: cfg.perplexityModel, prompt: EMAIL_SEARCH_PROMPT_V1(name), purpose: "email_search" });
  const email = parseEmailAnswer(raw);
  repo.saveCompanyEmail(ctx.db, employerId, name, email, email ? "perplexity" : null);
  return email;
}
```

Примечание: `getCompanyEmail` в тесте «свежий not_found» использует `datetime('now')` — свежесть по TTL проверяется в `findCompanyEmail`, повторяя паттерн `researchCompany`. Если сигнатура `callPerplexity` (opts.purpose) сейчас жёстко `"research"` — расширить тип в perplexity.ts, это часть задачи.

- [ ] **Step 4: Прогнать всё** — PASS (включая старый research-тест).

- [ ] **Step 5: Commit**

```bash
git add src/llm/emailSearch.ts src/llm/prompts.ts src/llm/perplexity.ts tests/email-search.test.ts
git commit -m "feat(email): поиск почты HR через Perplexity с кэшем по компании (TTL 30д)"
```

---

### Task 4: Модуль отправки (nodemailer)

**Files:**
- Create: `src/email/send.ts`
- Modify: `package.json` (deps)
- Test: `tests/email-send.test.ts`

**Interfaces:**
- Produces:
  - `type Mailer = { send(msg: { to: string; subject: string; body: string }): Promise<void> }`
  - `makeMailer(cfg: Config): Mailer` — SMTP из cfg.smtp, пароль из `process.env.SMTP_PASSWORD` (бросает понятную ошибку, если не задан), вложение-резюме из `cfg.resumePdfPath` (если задан).
  - `makeMailer` не создаёт соединение до первого send (ленивый transport) — MCP-сервер стартует и без SMTP-пароля.

- [ ] **Step 1: Установить зависимость**

Run: `npm install nodemailer && npm install -D @types/nodemailer`
Expected: package.json обновлён.

- [ ] **Step 2: Failing-тест**

```typescript
// tests/email-send.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// мокаем nodemailer ДО импорта модуля
const sendMail = vi.fn().mockResolvedValue({ messageId: "x" });
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }));

import nodemailer from "nodemailer";
import { makeMailer } from "../src/email/send.js";
import { ConfigSchema } from "../src/config.js";

beforeEach(() => { vi.clearAllMocks(); });

describe("makeMailer", () => {
  it("бросает без SMTP_PASSWORD при send, но конструируется без него", async () => {
    delete process.env.SMTP_PASSWORD;
    const m = makeMailer(ConfigSchema.parse({}));
    await expect(m.send({ to: "hr@x.ru", subject: "s", body: "b" })).rejects.toThrow(/SMTP_PASSWORD/);
  });
  it("шлёт письмо с From-именем и plain-text телом", async () => {
    process.env.SMTP_PASSWORD = "app-pass";
    const m = makeMailer(ConfigSchema.parse({}));
    await m.send({ to: "hr@x.ru", subject: "Отклик", body: "Здравствуйте" });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.gmail.com", port: 465, secure: true,
      auth: { user: "doronin.alex001@gmail.com", pass: "app-pass" },
    }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: "hr@x.ru", subject: "Отклик", text: "Здравствуйте",
      from: '"Александр Доронин" <doronin.alex001@gmail.com>',
    }));
  });
});
```

- [ ] **Step 3: Прогнать — FAIL.**

- [ ] **Step 4: Реализация**

```typescript
// src/email/send.ts
import nodemailer from "nodemailer";
import { basename } from "node:path";
import type { Config } from "../config.js";

export type Mailer = { send(msg: { to: string; subject: string; body: string }): Promise<void> };

// Ленивый transport: пароль нужен только в момент реальной отправки (approve_email),
// а MCP-сервер должен подниматься и без него.
export function makeMailer(cfg: Config): Mailer {
  let transport: nodemailer.Transporter | null = null;
  return {
    async send({ to, subject, body }): Promise<void> {
      const pass = process.env.SMTP_PASSWORD;
      if (!pass) throw new Error("SMTP_PASSWORD не задан в env — отправка невозможна");
      transport ??= nodemailer.createTransport({
        host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.port === 465,
        auth: { user: cfg.smtp.user, pass },
      });
      await transport.sendMail({
        from: `"${cfg.smtp.fromName}" <${cfg.smtp.user}>`,
        to, subject, text: body,
        attachments: cfg.resumePdfPath ? [{ filename: basename(cfg.resumePdfPath), path: cfg.resumePdfPath }] : undefined,
      });
    },
  };
}
```

- [ ] **Step 5: Прогнать — PASS.**

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/email/send.ts tests/email-send.test.ts
git commit -m "feat(email): SMTP-отправка через nodemailer, ленивый transport, вложение-резюме"
```

---

### Task 5: Пайплайн — гейт почты до скоринга (не-hh)

**Files:**
- Modify: `src/pipeline/run.ts` (стадия 2)
- Test: `tests/pipeline-email-gate.test.ts`

**Interfaces:**
- Consumes: `findCompanyEmail` (Task 3), `v.raw_json.email` (trudvsem), существующий цикл скоринга.
- Produces: не-hh вакансия без почты → `setStatus(skipped, { filter_reason: "no_email" })` ДО вызова скоринга; ошибка поиска почты обрабатывается как ошибка LLM (транзиентная → вакансия остаётся discovered).

- [ ] **Step 1: Failing-тест**

```typescript
// tests/pipeline-email-gate.test.ts
import { describe, it, expect, vi } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { runSession, type Deps } from "../src/pipeline/run.js";
import { ConfigSchema } from "../src/config.js";
import type { VacancyInsert } from "../src/state/types.js";

const card = (id: string, employerId: string, email?: string | null): VacancyInsert => ({
  id, url: "https://x.test/" + id, title: "ML " + id, employer_id: employerId, employer_name: "Emp " + employerId,
  salary_from: 300000, salary_to: null, currency: "RUR", work_format: "remote", experience: null,
  published_at: new Date().toISOString(),
  raw_json: JSON.stringify({ text: "текст про LLM", email: email ?? null }), source: "trudvsem",
});

function mkDeps(db: ReturnType<typeof openDb>, pplxImpl: (...a: never[]) => Promise<string>): Deps {
  return {
    db, cfg: ConfigSchema.parse({ mode: "dry_run", searchQueries: [], enabledSources: [] }),
    browser: { searchVacancies: vi.fn().mockResolvedValue([]), fetchVacancyText: vi.fn(), apply: vi.fn(), waitCaptchaCleared: vi.fn() } as never,
    claude: vi.fn().mockResolvedValue(JSON.stringify({ score: 80, reasons: [], red_flags: [] })) as never,
    pplx: vi.fn(pplxImpl) as never,
    notify: vi.fn(), resume: "резюме",
    sources: [{ name: "trudvsem", search: vi.fn().mockResolvedValue([]), fetchText: vi.fn().mockResolvedValue("текст про LLM") }] as never,
  };
}

describe("email-гейт до скоринга", () => {
  it("почта из payload → скоринг выполняется, почта в кэше", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, card("trudvsem:1", "t:1", "hr@cpl.ru"));
    const deps = mkDeps(db, async () => "research");
    await runSession(deps, "manual", "dry_run");
    expect(repo.getVacancy(db, "trudvsem:1")!.status).toBe("queued");
    expect(repo.getCompanyEmail(db, "t:1")).toMatchObject({ email: "hr@cpl.ru" });
  });
  it("почта не найдена → skipped/no_email, скоринг НЕ вызывался", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, card("trudvsem:2", "t:2"));
    const deps = mkDeps(db, async () => '{"email": null}');
    await runSession(deps, "manual", "dry_run");
    const v = repo.getVacancy(db, "trudvsem:2")!;
    expect(v.status).toBe("skipped");
    expect(v.filter_reason).toBe("no_email");
    expect(deps.claude).not.toHaveBeenCalled();
  });
  it("hh-вакансии гейт не касается", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, { ...card("hh1", "e1", null), id: "hh1", source: "hh" });
    const deps = mkDeps(db, async () => '{"email": null}');
    // fetchVacancyText для hh
    (deps.browser.fetchVacancyText as ReturnType<typeof vi.fn>).mockResolvedValue("текст hh-вакансии");
    await runSession(deps, "manual", "dry_run");
    expect(repo.getVacancy(db, "hh1")!.status).toBe("queued");   // проскорена без гейта
  });
});
```

- [ ] **Step 2: Прогнать — FAIL** (гейта нет, no_email не проставляется).

- [ ] **Step 3: Реализация** — в `src/pipeline/run.ts`, в стадии 2, сразу после прохождения хард-фильтров и ДО получения текста/скоринга:

```typescript
      // email-гейт (только не-hh): письмо слать некуда — скорить незачем (скоринг в ~5 раз
      // дороже поиска почты, а почта кэшируется на компанию). hh-вакансии откликаются
      // через браузер, им почта не нужна.
      if (v.source !== "hh") {
        try {
          const payloadEmail = (JSON.parse(v.raw_json ?? "{}") as { email?: string | null }).email ?? null;
          const email = await findCompanyEmail(ctx(v.id), deps.pplx, cfg, v.employer_id ?? v.employer_name, v.employer_name, payloadEmail);
          if (!email) { repo.setStatus(db, v.id, "skipped", { filter_reason: "no_email" }); continue; }
          llmErrors = 0;
        } catch (e) {
          s.errors++;
          if (!isTransient(e)) repo.setStatus(db, v.id, "failed");
          if (++llmErrors >= 5) { s.stopReason = "error_streak"; break; }
          continue;
        }
      }
```

Импорт: `import { findCompanyEmail } from "../llm/emailSearch.js";`

- [ ] **Step 4: Прогнать всё** — PASS (и тесты плана 1 не сломаны).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/run.ts tests/pipeline-email-gate.test.ts
git commit -m "feat(pipeline): email-гейт до скоринга для не-hh — нет почты, незачем скорить"
```

---

### Task 6: Пайплайн — генерация черновиков писем

**Files:**
- Modify: `src/pipeline/run.ts` (новая стадия 3b после apply)
- Test: `tests/pipeline-email-drafts.test.ts`

**Interfaces:**
- Consumes: `researchCompany`, `writeLetter`, `repo.insertEmailDraft`/`getEmailByVacancy`/`getCompanyEmail` , не-hh вакансии в статусе `queued`.
- Produces: для каждой не-hh `queued` вакансии — черновик в `emails` (subject `Отклик на вакансию «<title>» — Александр Доронин`), письмо также сохраняется в `vacancies.letter`; повторный прогон черновики не пересоздаёт; в конце — `notify` с числом новых черновиков.

- [ ] **Step 1: Failing-тест**

```typescript
// tests/pipeline-email-drafts.test.ts
import { describe, it, expect, vi } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { runSession, type Deps } from "../src/pipeline/run.js";
import { ConfigSchema } from "../src/config.js";
import type { VacancyInsert } from "../src/state/types.js";

const queuedVac = (db: ReturnType<typeof openDb>, id: string): void => {
  const v: VacancyInsert = {
    id, url: "https://x.test/" + id, title: "LLM Engineer", employer_id: "h:acme", employer_name: "Acme",
    salary_from: null, salary_to: null, currency: null, work_format: "remote", experience: null,
    published_at: null, raw_json: JSON.stringify({ text: "текст" }), source: "hirehi",
  };
  repo.upsertVacancy(db, v);
  repo.setStatus(db, id, "queued", { score: 90, score_reasons: JSON.stringify({ score: 90, reasons: [], red_flags: [] }) });
};

function mkDeps(db: ReturnType<typeof openDb>): Deps {
  return {
    db, cfg: ConfigSchema.parse({ mode: "dry_run", searchQueries: [], enabledSources: [] }),
    browser: { searchVacancies: vi.fn().mockResolvedValue([]), fetchVacancyText: vi.fn(), apply: vi.fn(), waitCaptchaCleared: vi.fn() } as never,
    claude: vi.fn().mockResolvedValue("Здравствуйте! Я Александр, откликаюсь на вакансию.") as never,
    pplx: vi.fn().mockResolvedValue("справка о компании") as never,
    notify: vi.fn(), resume: "резюме", sources: [] as never,
  };
}

describe("черновики писем", () => {
  it("для queued не-hh с почтой создаётся draft с темой и телом", async () => {
    const db = openDb(":memory:");
    queuedVac(db, "hirehi:1");
    repo.saveCompanyEmail(db, "h:acme", "Acme", "hr@acme.ru", "perplexity");
    const deps = mkDeps(db);
    await runSession(deps, "manual", "dry_run");
    const e = repo.getEmailByVacancy(db, "hirehi:1")!;
    expect(e.to_email).toBe("hr@acme.ru");
    expect(e.subject).toContain("LLM Engineer");
    expect(e.status).toBe("draft");
    expect(e.body.length).toBeGreaterThan(10);
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("1"));
  });
  it("повторный прогон не пересоздаёт и не перетирает черновик", async () => {
    const db = openDb(":memory:");
    queuedVac(db, "hirehi:2");
    repo.saveCompanyEmail(db, "h:acme", "Acme", "hr@acme.ru", "perplexity");
    const deps = mkDeps(db);
    await runSession(deps, "manual", "dry_run");
    const before = repo.getEmailByVacancy(db, "hirehi:2")!;
    repo.updateEmailDraft(db, before.id, { body: "правленый вручную" });
    await runSession(deps, "manual", "dry_run");
    expect(repo.getEmailByVacancy(db, "hirehi:2")!.body).toBe("правленый вручную");
    expect(repo.getEmailsByStatus(db, "draft")).toHaveLength(1);
  });
});
```

Примечание: мок `claude` должен удовлетворить реальный `writeLetter` (валидация письма в letter.ts) — свериться с `src/llm/letter.ts` и вернуть строку, проходящую его проверки; при необходимости поправить мок, не production-код.

- [ ] **Step 2: Прогнать — FAIL.**

- [ ] **Step 3: Реализация** — в `src/pipeline/run.ts` после стадии 3 (apply), перед `finishRun`:

```typescript
  // 3b) черновики писем для не-hh queued: research → письмо → emails(draft).
  // Отправки здесь НЕТ — только очередь на ручное подтверждение (approve_email в MCP).
  if (s.stopReason === "completed" || s.stopReason === "daily_limit") {
    let drafts = 0;
    for (const v of repo.getByStatus(db, "queued")) {
      if (v.source === "hh") continue;
      if (repo.getEmailByVacancy(db, v.id)) continue;
      const contact = v.employer_id ? repo.getCompanyEmail(db, v.employer_id) : null;
      if (!contact?.email) { repo.setStatus(db, v.id, "skipped", { filter_reason: "no_email" }); continue; }
      try {
        let letter = v.letter;
        if (!letter) {
          const research = await researchCompany(ctx(v.id), deps.pplx, cfg, v.employer_id ?? v.employer_name, v.employer_name);
          const text = (JSON.parse(v.raw_json ?? "{}") as { text?: string }).text ?? v.title;
          letter = await writeLetter(ctx(v.id), deps.claude, cfg, { resume: deps.resume, vacancyText: text, research, score: JSON.parse(v.score_reasons ?? "{}") });
          repo.setStatus(db, v.id, "queued", { letter });
        }
        repo.insertEmailDraft(db, {
          vacancy_id: v.id, to_email: contact.email,
          subject: `Отклик на вакансию «${v.title}» — Александр Доронин`, body: letter,
        });
        drafts++; llmErrors = 0;
      } catch (e) {
        s.errors++;
        if (!isTransient(e)) repo.setStatus(db, v.id, "failed");
        if (++llmErrors >= 5) { s.stopReason = "error_streak"; break; }
      }
    }
    if (drafts > 0) deps.notify(`hh-agent: ${drafts} новых писем ждут подтверждения (get_email_queue)`);
  }
```

- [ ] **Step 4: Прогнать всё** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/run.ts tests/pipeline-email-drafts.test.ts
git commit -m "feat(pipeline): черновики email для не-hh queued — очередь на ручное подтверждение"
```

---

### Task 7: MCP-инструменты очереди писем

**Files:**
- Modify: `src/mcp/server.ts` (get_email_queue, update_email, approve_email, reject_email; mailer в buildServer)
- Test: `tests/mcp-emails.test.ts` (логика approve вынесена в функцию — тестируем её, не HTTP)

**Interfaces:**
- Consumes: repo-функции (Task 1), `Mailer`/`makeMailer` (Task 4), `cfg.emailDailyLimit`.
- Produces:
  - `approveEmail(db, cfg, mailer, id): Promise<{ ok: true } | { error: string }>` — экспорт из `src/email/approve.ts` (новый файл, чтобы логика была тестируема без MCP-транспорта):
    - письмо не найдено или не draft → `{ error }`
    - `emailsSentToday >= cfg.emailDailyLimit` → `{ error: "daily email limit reached" }`
    - иначе: `mailer.send` → `markEmailSent` → `setStatus(vacancy, "applied", { applied_at })` → `{ ok: true }`
  - MCP-тулзы: `get_email_queue` (drafts + title/employer вакансии), `update_email {id, subject?, body?}`, `approve_email {id}`, `reject_email {id}` (markEmailRejected + vacancy → skipped, filter_reason "email_rejected").

- [ ] **Step 1: Failing-тест**

```typescript
// tests/mcp-emails.test.ts
import { describe, it, expect, vi } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { approveEmail } from "../src/email/approve.js";
import { ConfigSchema } from "../src/config.js";
import type { VacancyInsert } from "../src/state/types.js";

const cfg = ConfigSchema.parse({ emailDailyLimit: 1 });
const vac = (id: string): VacancyInsert => ({
  id, url: "https://x.test/" + id, title: "ML", employer_id: "h:a", employer_name: "A",
  salary_from: null, salary_to: null, currency: null, work_format: null, experience: null,
  published_at: null, raw_json: null, source: "hirehi",
});

describe("approveEmail", () => {
  it("шлёт, помечает sent и переводит вакансию в applied", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, vac("hirehi:1"));
    repo.insertEmailDraft(db, { vacancy_id: "hirehi:1", to_email: "hr@a.ru", subject: "S", body: "B" });
    const mailer = { send: vi.fn().mockResolvedValue(undefined) };
    const e = repo.getEmailByVacancy(db, "hirehi:1")!;
    expect(await approveEmail(db, cfg, mailer, e.id)).toEqual({ ok: true });
    expect(mailer.send).toHaveBeenCalledWith({ to: "hr@a.ru", subject: "S", body: "B" });
    expect(repo.getEmailByVacancy(db, "hirehi:1")!.status).toBe("sent");
    expect(repo.getVacancy(db, "hirehi:1")!.status).toBe("applied");
  });
  it("дневной лимит блокирует отправку", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, vac("hirehi:1"));
    repo.upsertVacancy(db, vac("hirehi:2"));
    repo.insertEmailDraft(db, { vacancy_id: "hirehi:1", to_email: "a@a.ru", subject: "S", body: "B" });
    repo.insertEmailDraft(db, { vacancy_id: "hirehi:2", to_email: "b@b.ru", subject: "S", body: "B" });
    const mailer = { send: vi.fn().mockResolvedValue(undefined) };
    await approveEmail(db, cfg, mailer, repo.getEmailByVacancy(db, "hirehi:1")!.id);
    const r = await approveEmail(db, cfg, mailer, repo.getEmailByVacancy(db, "hirehi:2")!.id);
    expect(r).toMatchObject({ error: expect.stringContaining("limit") });
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });
  it("ошибка SMTP не помечает письмо sent", async () => {
    const db = openDb(":memory:");
    repo.upsertVacancy(db, vac("hirehi:1"));
    repo.insertEmailDraft(db, { vacancy_id: "hirehi:1", to_email: "hr@a.ru", subject: "S", body: "B" });
    const mailer = { send: vi.fn().mockRejectedValue(new Error("535 auth failed")) };
    const r = await approveEmail(db, cfg, mailer, repo.getEmailByVacancy(db, "hirehi:1")!.id);
    expect(r).toMatchObject({ error: expect.stringContaining("535") });
    expect(repo.getEmailByVacancy(db, "hirehi:1")!.status).toBe("draft");
  });
});
```

- [ ] **Step 2: Прогнать — FAIL.**

- [ ] **Step 3: Реализация**

```typescript
// src/email/approve.ts
import type { Database } from "better-sqlite3";
import * as repo from "../state/repo.js";
import type { Config } from "../config.js";
import type { Mailer } from "./send.js";

// Единственная точка, из которой письмо реально уходит. Лимит — второй предохранитель
// после ручного просмотра; порядок строгий: send → sent → applied (упавший SMTP
// оставляет черновик draft, ничего не потеряно).
export async function approveEmail(db: Database, cfg: Config, mailer: Mailer, id: number):
  Promise<{ ok: true } | { error: string }> {
  const e = db.prepare(`SELECT * FROM emails WHERE id=?`).get(id) as
    { id: number; vacancy_id: string; to_email: string; subject: string; body: string; status: string } | undefined;
  if (!e) return { error: `email ${id} not found` };
  if (e.status !== "draft") return { error: `email ${id} is ${e.status}, not draft` };
  if (repo.emailsSentToday(db) >= cfg.emailDailyLimit) return { error: "daily email limit reached" };
  try {
    await mailer.send({ to: e.to_email, subject: e.subject, body: e.body });
  } catch (err) { return { error: String(err) }; }
  repo.markEmailSent(db, e.id);
  repo.setStatus(db, e.vacancy_id, "applied", { applied_at: new Date().toISOString() });
  return { ok: true };
}
```

В `src/mcp/server.ts` — импорты и 4 тулзы внутри `buildServer` (mailer создаётся лениво из свежего конфига):

```typescript
import { makeMailer } from "../email/send.js";
import { approveEmail } from "../email/approve.js";

  // ... внутри buildServer, после blacklist_remove:
  mcp.tool("get_email_queue", "Черновики писем HR, ждущие подтверждения", {}, async () =>
    j(repo.getEmailsByStatus(db, "draft").map(e => {
      const v = repo.getVacancy(db, e.vacancy_id);
      return { id: e.id, vacancy_id: e.vacancy_id, title: v?.title, employer: v?.employer_name,
        score: v?.score, url: v?.url, to: e.to_email, subject: e.subject, body: e.body };
    })));
  mcp.tool("update_email", "Поправить тему/текст черновика перед отправкой",
    { id: z.number(), subject: z.string().optional(), body: z.string().optional() },
    async ({ id, subject, body }) => { repo.updateEmailDraft(db, id, { subject, body }); return j({ updated: id }); });
  mcp.tool("approve_email", "Подтвердить и ОТПРАВИТЬ письмо (реальная отправка на почту HR)",
    { id: z.number() }, async ({ id }) => {
      const cfg = loadConfig();
      return j(await approveEmail(db, cfg, makeMailer(cfg), id));
    });
  mcp.tool("reject_email", "Отклонить черновик (вакансия → skipped)", { id: z.number() }, async ({ id }) => {
    const e = repo.getEmailsByStatus(db, "draft").find(x => x.id === id);
    if (!e) return j({ error: `draft ${id} not found` });
    repo.markEmailRejected(db, id);
    repo.setStatus(db, e.vacancy_id, "skipped", { filter_reason: "email_rejected" });
    return j({ rejected: id });
  });
```

- [ ] **Step 4: Прогнать всё** — `npx vitest run && npx tsc --noEmit` — PASS.

- [ ] **Step 5: Живой smoke (без реальной отправки HR!)**

Отправить тестовое письмо самому себе: временно создать в БД черновик с `to_email = doronin.alex001@gmail.com`, выставить `SMTP_PASSWORD`, дернуть `approve_email` через MCP-клиент, проверить входящие. Удалить тестовые строки из БД после проверки.
Expected: письмо в ящике с темой, телом и вложением-резюме (если `resumePdfPath` задан).

- [ ] **Step 6: Commit**

```bash
git add src/email/approve.ts src/mcp/server.ts tests/mcp-emails.test.ts
git commit -m "feat(mcp): очередь писем — get_email_queue/update/approve/reject, отправка только вручную"
```

---

## Self-Review (выполнено при написании)

- Покрытие решений из docs/job-boards-research.md: кэш почты по компании с TTL и not_found (T1, T3), payload-почта trudvsem бесплатно (T3, T5), гейт до скоринга (T5), отдельный вызов Perplexity, не слитый с research (T3), research остаётся перед письмом (T6), очередь с ручным подтверждением и без автоотправки (T6, T7), только новые площадки — hh-ветка не тронута (гейт и стадия 3b фильтруют по `source`).
- Типы сходятся: `EmailRow`/`EmailInsert` (T1) ↔ repo ↔ approve (T7); `Mailer` (T4) ↔ approveEmail (T7); `findCompanyEmail` (T3) ↔ гейт (T5); subject-формат в T6 совпадает с ожиданием теста T6.
- SMTP-пароль только из env (T4), лимит в approve (T7), упавший SMTP не теряет черновик (T7 тест).
