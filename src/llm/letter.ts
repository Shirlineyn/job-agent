import { LETTER_SYSTEM_V1 } from "./prompts.js";
import type { callClaude } from "./anthropic.js";
import type { LlmLogCtx } from "./log.js";
import type { Config } from "../config.js";
import type { ScoreResult } from "./scoring.js";

const URL_WHITELIST = ["tedo.ru", "github.com"];

export function validateLetter(text: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const words = text.trim().split(/\s+/).length;
  if (words < 100 || words > 220) problems.push(`word count ${words}, expected 120-180`);
  for (const m of text.matchAll(/https?:\/\/([^\s/]+)/g))
    if (!URL_WHITELIST.some(d => m[1].endsWith(d))) problems.push(`foreign url: ${m[1]}`);
  if (!text.includes("Доронин")) problems.push("no signature");
  return { ok: problems.length === 0, problems };
}

export async function writeLetter(
  ctx: LlmLogCtx, claude: typeof callClaude, cfg: Config,
  args: { resume: string; vacancyText: string; research: string; score: ScoreResult },
): Promise<string> {
  const user = `<резюме>\n${args.resume}\n</резюме>\n<вакансия>\n${args.vacancyText}\n</вакансия>\n<справка_о_компании>\n${args.research}\n</справка_о_компании>\n<сильные_пересечения>\n${args.score.reasons.join("\n")}\n</сильные_пересечения>`;
  const letter = (await claude(ctx, { model: cfg.anthropicModel, system: LETTER_SYSTEM_V1, user, temperature: 0.6, maxTokens: 1024, purpose: "letter" })).trim();
  const check = validateLetter(letter);
  if (!check.ok) {
    const retry = (await claude(ctx, { model: cfg.anthropicModel, system: LETTER_SYSTEM_V1,
      user: user + `\nПредыдущее письмо отклонено проверкой: ${check.problems.join("; ")}. Исправь и верни только текст письма.`,
      temperature: 0.6, maxTokens: 1024, purpose: "letter" })).trim();
    const check2 = validateLetter(retry);
    if (!check2.ok) throw new Error(`letter failed validation twice: ${check2.problems.join("; ")}`);
    return retry;
  }
  return letter;
}
