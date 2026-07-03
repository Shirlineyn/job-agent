import Anthropic from "@anthropic-ai/sdk";
import { withRetry, logCall, type LlmLogCtx } from "./log.js";

const client = new Anthropic({ timeout: 60_000 }); // ключ из env ANTHROPIC_API_KEY

export async function callClaude(ctx: LlmLogCtx, opts: {
  model: string; system: string; user: string; temperature: number; maxTokens: number; purpose: "scoring" | "letter";
}): Promise<string> {
  const req = {
    model: opts.model, max_tokens: opts.maxTokens, temperature: opts.temperature,
    system: [{ type: "text" as const, text: opts.system, cache_control: { type: "ephemeral" as const } }],
    messages: [{ role: "user" as const, content: opts.user }],
  };
  const t0 = Date.now();
  try {
    const res = await withRetry(() => client.messages.create(req), () => {});
    const text = res.content[0]?.type === "text" ? res.content[0].text : "";
    logCall(ctx, { provider: "anthropic", purpose: opts.purpose, model: opts.model, request: req, response: res,
      error: null, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, latencyMs: Date.now() - t0 });
    return text;
  } catch (e) {
    logCall(ctx, { provider: "anthropic", purpose: opts.purpose, model: opts.model, request: req, response: null,
      error: String(e), inputTokens: null, outputTokens: null, latencyMs: Date.now() - t0 });
    throw e;
  }
}
