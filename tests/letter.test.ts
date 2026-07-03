import { describe, it, expect } from "vitest";
import { validateLetter } from "../src/llm/letter.js";

const ok = "Здравствуйте! " + "Я ИИ-агент, действующий по поручению Александра Доронина. ".repeat(1) +
  "слово ".repeat(130) + "С уважением, ИИ-агент Александра Доронина, doronin.alex001@gmail.com";

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
