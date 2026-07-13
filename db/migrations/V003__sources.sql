-- source: откуда пришла вакансия. hh — браузерный скрейпер, остальные — HTTP-адаптеры.
ALTER TABLE vacancies ADD COLUMN source TEXT NOT NULL DEFAULT 'hh';
-- dedup_key: нормализованный "работодатель|название" для дедупликации между источниками.
ALTER TABLE vacancies ADD COLUMN dedup_key TEXT;
CREATE INDEX idx_vacancies_source ON vacancies (source);
CREATE INDEX idx_vacancies_dedup  ON vacancies (dedup_key);
-- Бэкфилл для уже существующих hh-строк (грубая SQL-нормализация; JS-нормализация чуть богаче,
-- но расхождение лишь ослабит дедуп для старых строк, что безопасно).
UPDATE vacancies SET dedup_key = lower(trim(employer_name)) || '|' || lower(trim(title));
