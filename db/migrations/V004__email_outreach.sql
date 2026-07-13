-- db/migrations/V004__email_outreach.sql
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
-- Включает кэш-колонки из V002 (ALTER дописал их в КОНЕЦ старой таблицы, поэтому
-- перенос данных — только явным списком колонок, не SELECT *).
CREATE TABLE llm_calls_new (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    vacancy_id            TEXT REFERENCES vacancies(id) ON DELETE SET NULL,
    run_id                INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    provider              TEXT NOT NULL CHECK (provider IN ('anthropic', 'perplexity')),
    purpose               TEXT NOT NULL CHECK (purpose IN ('scoring', 'research', 'letter', 'email_search')),
    model                 TEXT NOT NULL,
    request               TEXT NOT NULL,
    response              TEXT,
    error                 TEXT,
    input_tokens          INTEGER,
    output_tokens         INTEGER,
    cache_creation_tokens INTEGER,
    cache_read_tokens     INTEGER,
    cost_usd              REAL,
    latency_ms            INTEGER,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO llm_calls_new
    (id, vacancy_id, run_id, provider, purpose, model, request, response, error,
     input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
     cost_usd, latency_ms, created_at)
SELECT id, vacancy_id, run_id, provider, purpose, model, request, response, error,
       input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
       cost_usd, latency_ms, created_at
FROM llm_calls;
DROP TABLE llm_calls;
ALTER TABLE llm_calls_new RENAME TO llm_calls;
CREATE INDEX idx_llm_calls_vacancy ON llm_calls (vacancy_id);
CREATE INDEX idx_llm_calls_created ON llm_calls (created_at DESC);
CREATE INDEX idx_llm_calls_purpose ON llm_calls (purpose);
