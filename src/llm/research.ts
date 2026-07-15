import { RESEARCH_PROMPT_V1 } from "./prompts.js";
import * as repo from "../state/repo.js";
import type { callPerplexity } from "./perplexity.js";
import type { LlmLogCtx } from "./log.js";
import type { Config } from "../config.js";

const TTL_DAYS = 30;

export async function researchCompany(
  ctx: LlmLogCtx,
  pplx: typeof callPerplexity,
  cfg: Config,
  employerId: string,
  name: string,
): Promise<string> {
  const cached = repo.getCompanyResearch(ctx.db, employerId);
  if (cached && (Date.now() - Date.parse(cached.researchedAt)) / 86_400_000 < TTL_DAYS)
    return cached.research;
  const research = await pplx(ctx, {
    model: cfg.perplexityModel,
    prompt: RESEARCH_PROMPT_V1(name, cfg.candidate.city),
    purpose: "research",
  });
  repo.saveCompanyResearch(ctx.db, employerId, name, research);
  return research;
}
