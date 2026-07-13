import type { Database } from "better-sqlite3";
import * as repo from "../state/repo.js";

export type LlmLogCtx = { db: Database; runId: number | null; vacancyId: string | null };

export const PRICES: Record<string, { inUsd: number; outUsd: number }> = {
  "claude-sonnet-5": { inUsd: 3, outUsd: 15 },   // verified 2026-07: $3/$15 per 1M tok (intro $2/$10 until 2026-08-31)
  "sonar": { inUsd: 1, outUsd: 1 },              // verified 2026-07: $1/$1 per 1M tok (request fees not modeled)
};

// Prompt caching: input_tokens в ответе Anthropic — только некэшированный остаток.
// cache write = 1.25x цены входа, cache read = 0.1x (5-минутный ephemeral TTL).
export function cost(model: string, inTok: number, outTok: number, cacheWriteTok = 0, cacheReadTok = 0): number {
  const p = PRICES[model] ?? { inUsd: 0, outUsd: 0 };
  return ((inTok + 1.25 * cacheWriteTok + 0.1 * cacheReadTok) * p.inUsd + outTok * p.outUsd) / 1_000_000;
}

const RETRYABLE = (s?: number) => s === undefined || s === 429 || (s >= 500 && s < 600);

export async function withRetry<T>(fn: () => Promise<T>, onRetry: (attempt: number) => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const status = (e as { status?: number }).status;
      if (attempt >= 3 || !RETRYABLE(status)) throw e;
      onRetry(attempt);
      await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

export function logCall(ctx: LlmLogCtx, row: {
  provider: "anthropic" | "perplexity"; purpose: "scoring" | "research" | "letter" | "email_search"; model: string;
  request: unknown; response: unknown; error: string | null;
  inputTokens: number | null; outputTokens: number | null; latencyMs: number;
  cacheCreationTokens?: number | null; cacheReadTokens?: number | null;
}): void {
  repo.insertLlmCall(ctx.db, {
    vacancy_id: ctx.vacancyId, run_id: ctx.runId, provider: row.provider, purpose: row.purpose,
    model: row.model, request: JSON.stringify(row.request), response: row.response ? JSON.stringify(row.response) : null,
    error: row.error, input_tokens: row.inputTokens, output_tokens: row.outputTokens,
    cache_creation_tokens: row.cacheCreationTokens ?? null, cache_read_tokens: row.cacheReadTokens ?? null,
    cost_usd: row.inputTokens !== null && row.outputTokens !== null
      ? cost(row.model, row.inputTokens, row.outputTokens, row.cacheCreationTokens ?? 0, row.cacheReadTokens ?? 0)
      : null,
    latency_ms: row.latencyMs,
  });
}
