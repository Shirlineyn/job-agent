-- Prompt caching (Anthropic): input_tokens в ответе API — только некэшированный остаток.
-- Полный вход = input_tokens + cache_creation_tokens + cache_read_tokens.
ALTER TABLE llm_calls ADD COLUMN cache_creation_tokens INTEGER;
ALTER TABLE llm_calls ADD COLUMN cache_read_tokens INTEGER;
