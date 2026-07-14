import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CandidateSchema } from "../src/config.js";
import {
  LETTER_SYSTEM_V1,
  LETTER_SYSTEM_V2,
  EMAIL_LETTER_SYSTEM_V1,
  RESEARCH_PROMPT_V1,
} from "../src/llm/prompts.js";
import { QUESTIONNAIRE_SYSTEM } from "../src/llm/questionnaire.js";

// Регрессионный якорь калибровки: промпты откалиброваны на реальных прогонах, поэтому
// вынесение личности кандидата в конфиг НЕ должно менять ни байта итогового текста при
// дефолтном candidate. baseline снят с исходных литералов ДО рефактора.
const baseline = JSON.parse(
  readFileSync(new URL("./fixtures/prompts-baseline.json", import.meta.url), "utf8"),
) as Record<string, string>;

const c = CandidateSchema.parse({});

describe("prompt identity (byte-identical with default candidate)", () => {
  it("LETTER_SYSTEM_V1", () => {
    expect(LETTER_SYSTEM_V1(c)).toBe(baseline.LETTER_SYSTEM_V1);
  });
  it("LETTER_SYSTEM_V2", () => {
    expect(LETTER_SYSTEM_V2(c)).toBe(baseline.LETTER_SYSTEM_V2);
  });
  it("QUESTIONNAIRE_SYSTEM", () => {
    expect(QUESTIONNAIRE_SYSTEM(c)).toBe(baseline.QUESTIONNAIRE_SYSTEM);
  });
  it("EMAIL_LETTER_SYSTEM_V1 без repoUrl", () => {
    expect(EMAIL_LETTER_SYSTEM_V1(c, null)).toBe(baseline.EMAIL_LETTER_null);
  });
  it("EMAIL_LETTER_SYSTEM_V1 с repoUrl", () => {
    expect(EMAIL_LETTER_SYSTEM_V1(c, "https://github.com/Shirlineyn/job-agent")).toBe(
      baseline.EMAIL_LETTER_repo,
    );
  });
  it("RESEARCH_PROMPT_V1", () => {
    expect(RESEARCH_PROMPT_V1("Acme", c.city)).toBe(baseline.RESEARCH);
  });
});
