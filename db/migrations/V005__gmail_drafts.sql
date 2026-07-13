-- Метка «письмо уже положено в Черновики Gmail» — чтобы повторный вызов draft_to_gmail
-- не плодил дубли черновиков (кладём только те, у кого gmail_drafted_at IS NULL).
ALTER TABLE emails ADD COLUMN gmail_drafted_at TEXT;
