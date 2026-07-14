import { describe, it, expect } from "vitest";
import { validateLetter } from "../src/llm/letter.js";
import { EMAIL_LETTER_SYSTEM_V1 } from "../src/llm/prompts.js";

const ok =
  "Здравствуйте! " +
  "Я ИИ-агент, действующий по поручению Александра Доронина. ".repeat(1) +
  "слово ".repeat(130) +
  "С уважением, ИИ-агент Александра Доронина, doronin.alex001@gmail.com";

describe("validateLetter", () => {
  it("accepts a well-formed letter", () => {
    expect(validateLetter(ok).ok).toBe(true);
  });
  it("rejects too short", () => {
    expect(validateLetter("Привет, возьмите меня. Доронин").ok).toBe(false);
  });
  it("rejects foreign urls", () => {
    expect(validateLetter(ok + " http://evil.example.com").ok).toBe(false);
  });
  it("allows whitelisted urls", () => {
    expect(validateLetter(ok + " https://tedo.ru/insights/gartner-hype-cycle").ok).toBe(true);
  });
  it("rejects lookalike domains", () => {
    expect(validateLetter(ok + " http://eviltedo.ru/x").ok).toBe(false);
  });
});

describe("EMAIL_LETTER_SYSTEM_V1", () => {
  const url = "https://github.com/Shirlineyn/job-agent";
  it("вставляет ссылку на репозиторий, когда repoUrl задан", () => {
    const p = EMAIL_LETTER_SYSTEM_V1(url);
    expect(p).toContain(url);
    expect(p).toContain("Единственная допустимая ссылка");
  });
  it("без repoUrl не добавляет URL и запрещает ссылки", () => {
    const p = EMAIL_LETTER_SYSTEM_V1(null);
    expect(p).not.toContain("http");
    expect(p).toContain("Не добавляй в письмо никаких URL");
  });
  it("требует приветствие и запрещает мета-рамку в зачине", () => {
    const p = EMAIL_LETTER_SYSTEM_V1(null);
    expect(p).toContain("Здравствуйте");
    expect(p).toContain("мета-рамки");
  });
  it("просит маркированный список пересечений", () => {
    expect(EMAIL_LETTER_SYSTEM_V1(null)).toMatch(/маркированным списком/);
  });
});
