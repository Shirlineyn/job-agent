import { LETTER_SYSTEM_V2, EMAIL_LETTER_SYSTEM_V1 } from "./prompts.js";
import type { callClaude } from "./anthropic.js";
import type { LlmLogCtx } from "./log.js";
import type { Config } from "../config.js";
import type { ScoreResult } from "./scoring.js";

// Канал доставки письма: platform — отклик через job-площадку (hh), email — холодное письмо на HR-почту.
export type LetterChannel = "platform" | "email";

const URL_WHITELIST = ["tedo.ru", "github.com"];

export function validateLetter(text: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const words = text.trim().split(/\s+/).length;
  if (words < 100 || words > 220) problems.push(`word count ${words}, expected 120-180`);
  for (const m of text.matchAll(/https?:\/\/([^\s/]+)/g)) {
    const host = m[1];
    if (host && !URL_WHITELIST.some((d) => host === d || host.endsWith("." + d)))
      problems.push(`foreign url: ${host}`);
  }
  if (!text.includes("Доронин")) problems.push("no signature");
  return { ok: problems.length === 0, problems };
}

export async function writeLetter(
  ctx: LlmLogCtx,
  claude: typeof callClaude,
  cfg: Config,
  args: { resume: string; vacancyText: string; research: string; score: ScoreResult },
  channel: LetterChannel = "platform",
): Promise<string> {
  // Холодное email-письмо — свой промпт (цепляет делом, не мета-рамкой; +ссылка на репо, если задан
  // cfg.repoUrl). Отклик через площадку остаётся на LETTER_SYSTEM_V2. Резюме — в system вторым блоком:
  // кэшируемый префикс должен превысить 2048 токенов (сам промпт ≈ 0.6k — ниже минимума, кэш не пишется).
  const systemPrompt = channel === "email" ? EMAIL_LETTER_SYSTEM_V1(cfg.repoUrl) : LETTER_SYSTEM_V2;
  const system = [systemPrompt, `<резюме>\n${args.resume}\n</резюме>`];
  const user = `<вакансия>\n${args.vacancyText}\n</вакансия>\n<справка_о_компании>\n${args.research}\n</справка_о_компании>\n<сильные_пересечения>\n${args.score.reasons.join("\n")}\n</сильные_пересечения>`;
  const letter = (
    await claude(ctx, {
      model: cfg.anthropicModel,
      system,
      user,
      maxTokens: 1024,
      purpose: "letter",
    })
  ).trim();
  const check = validateLetter(letter);
  if (!check.ok) {
    const retry = (
      await claude(ctx, {
        model: cfg.anthropicModel,
        system,
        user:
          user +
          `\nПредыдущее письмо отклонено проверкой: ${check.problems.join("; ")}. Исправь и верни только текст письма.`,
        maxTokens: 1024,
        purpose: "letter",
      })
    ).trim();
    const check2 = validateLetter(retry);
    if (!check2.ok)
      throw new Error(`letter failed validation twice: ${check2.problems.join("; ")}`);
    return retry;
  }
  return letter;
}
