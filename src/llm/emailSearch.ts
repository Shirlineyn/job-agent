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
