import { describe, it, expect } from "vitest";
import { parseScore } from "../src/llm/scoring.js";

describe("parseScore", () => {
  it("parses valid json with markdown fence", () => {
    const r = parseScore(
      '```json\n{"score":72,"reasons":["a"],"red_flags":[],"salary_match":"match","seniority_match":"stretch"}\n```',
    );
    expect(r.score).toBe(72);
  });
  it("throws on out-of-range score", () => {
    expect(() =>
      parseScore(
        '{"score":150,"reasons":[],"red_flags":[],"salary_match":"match","seniority_match":"match"}',
      ),
    ).toThrow();
  });
  it("throws on non-json", () => {
    expect(() => parseScore("вакансия хорошая, рекомендую")).toThrow();
  });
});
