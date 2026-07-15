import Anthropic from "@anthropic-ai/sdk";
import { withRetry, logCall, type LlmLogCtx } from "./log.js";

const client = new Anthropic({ timeout: 60_000 }); // ключ из env ANTHROPIC_API_KEY

export async function callClaude(
  ctx: LlmLogCtx,
  opts: {
    model: string;
    system: string | string[];
    user: string;
    maxTokens: number;
    purpose: "scoring" | "letter";
  },
): Promise<string> {
  // `temperature` is rejected (400) on claude-sonnet-5 and the whole 4.6+/5 family.
  // Thinking is disabled explicitly: otherwise Sonnet 5 runs adaptive thinking, which
  // eats into max_tokens (truncating the scoring JSON) and prepends a thinking block —
  // so we also read the first *text* block rather than content[0].
  //
  // Prompt caching: cache_control на последнем system-блоке кэширует весь префикс.
  // Минимальный кэшируемый префикс на claude-sonnet-5 — 2048 токенов; один системный
  // промпт короче (SCORING_SYSTEM_V3 ≈ 1.6k), поэтому вызывающий код передаёт system
  // массивом [промпт, стабильный контекст (резюме ≈ 7k)] — иначе кэш молча не пишется.
  const texts = Array.isArray(opts.system) ? opts.system : [opts.system];
  const system = texts.map((text, i) =>
    i === texts.length - 1
      ? { type: "text" as const, text, cache_control: { type: "ephemeral" as const } }
      : { type: "text" as const, text },
  );
  const req = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    thinking: { type: "disabled" as const },
    system,
    messages: [{ role: "user" as const, content: opts.user }],
  };
  const t0 = Date.now();
  try {
    const res = await withRetry(
      () => client.messages.create(req),
      () => {},
    );
    const text = res.content.find((b) => b.type === "text")?.text ?? "";
    logCall(ctx, {
      provider: "anthropic",
      purpose: opts.purpose,
      model: opts.model,
      request: req,
      response: res,
      error: null,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheCreationTokens: res.usage.cache_creation_input_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens,
      latencyMs: Date.now() - t0,
    });
    return text;
  } catch (e) {
    logCall(ctx, {
      provider: "anthropic",
      purpose: opts.purpose,
      model: opts.model,
      request: req,
      response: null,
      error: String(e),
      inputTokens: null,
      outputTokens: null,
      latencyMs: Date.now() - t0,
    });
    throw e;
  }
}
