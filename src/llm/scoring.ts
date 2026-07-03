import { z } from "zod";
import { SCORING_SYSTEM_V1 } from "./prompts.js";
import type { callClaude } from "./anthropic.js";
import type { LlmLogCtx } from "./log.js";
import type { Config } from "../config.js";

const schema = z.object({
  score: z.number().min(0).max(100),
  reasons: z.array(z.string()),
  red_flags: z.array(z.string()),
  salary_match: z.enum(["match", "below", "unknown"]),
  seniority_match: z.enum(["match", "stretch", "overqualified", "underqualified"]),
});
export type ScoreResult = z.infer<typeof schema>;

export class InvalidScoreJson extends Error {}

export function parseScore(raw: string): ScoreResult {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new InvalidScoreJson("no json object in response");
  try { return schema.parse(JSON.parse(m[0])); }
  catch (e) { throw new InvalidScoreJson(String(e)); }
}

export async function scoreVacancy(
  ctx: LlmLogCtx, claude: typeof callClaude, cfg: Config, resume: string, vacancyText: string,
): Promise<ScoreResult> {
  const user = `<резюме>\n${resume}\n</резюме>\n<вакансия>\n${vacancyText}\n</вакансия>\nЗарплатные ожидания: ${cfg.filters.salaryMin}+ руб на руки.`;
  const ask = (extra: string) => claude(ctx, {
    model: cfg.anthropicModel, system: SCORING_SYSTEM_V1, user: user + extra, maxTokens: 1024, purpose: "scoring",
  });
  try { return parseScore(await ask("")); }
  catch (e) {
    if (!(e instanceof InvalidScoreJson)) throw e;
    return parseScore(await ask(`\nПредыдущий ответ не распарсился (${e.message}). Верни СТРОГО валидный JSON по схеме.`));
  }
}
