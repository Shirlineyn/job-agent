import { withRetry, logCall, type LlmLogCtx } from "./log.js";

export async function callPerplexity(ctx: LlmLogCtx, opts: { model: string; prompt: string; purpose: "research" }): Promise<string> {
  const req = { model: opts.model, messages: [{ role: "user", content: opts.prompt }] };
  const t0 = Date.now();
  try {
    const res = await withRetry(async () => {
      const r = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST", signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!r.ok) throw Object.assign(new Error(`perplexity ${r.status}`), { status: r.status });
      return await r.json() as { choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
    }, () => {});
    logCall(ctx, { provider: "perplexity", purpose: "research", model: opts.model, request: req, response: res, error: null,
      inputTokens: res.usage?.prompt_tokens ?? null, outputTokens: res.usage?.completion_tokens ?? null, latencyMs: Date.now() - t0 });
    return res.choices[0]?.message.content ?? "";
  } catch (e) {
    logCall(ctx, { provider: "perplexity", purpose: "research", model: opts.model, request: req, response: null,
      error: String(e), inputTokens: null, outputTokens: null, latencyMs: Date.now() - t0 });
    throw e;
  }
}
