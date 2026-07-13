import { describe, it, expect, vi } from "vitest";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";
import { findCompanyEmail, parseEmailAnswer } from "../src/llm/emailSearch.js";

const cfg = { perplexityModel: "sonar" } as never;
const ctx = (db: ReturnType<typeof openDb>) => ({ db, runId: null, vacancyId: null });

describe("parseEmailAnswer", () => {
  it("валидный JSON с почтой", () => {
    expect(parseEmailAnswer('{"email": "hr@acme.ru"}')).toBe("hr@acme.ru");
  });
  it("JSON в маркдаун-обёртке", () => {
    expect(parseEmailAnswer('Вот ответ:\n```json\n{"email": "jobs@x.io"}\n```')).toBe("jobs@x.io");
  });
  it("null и мусор → null", () => {
    expect(parseEmailAnswer('{"email": null}')).toBeNull();
    expect(parseEmailAnswer('{"email": "не найдено"}')).toBeNull();
    expect(parseEmailAnswer("просто текст")).toBeNull();
  });
});

describe("findCompanyEmail", () => {
  it("payload-почта сохраняется без вызова Perplexity", async () => {
    const db = openDb(":memory:");
    const pplx = vi.fn();
    expect(await findCompanyEmail(ctx(db), pplx as never, cfg, "t:1", "ЦПЛ", "hr@cpl.ru")).toBe("hr@cpl.ru");
    expect(pplx).not.toHaveBeenCalled();
    expect(repo.getCompanyEmail(db, "t:1")).toMatchObject({ email: "hr@cpl.ru" });
  });
  it("свежий not_found в кэше → null без вызова", async () => {
    const db = openDb(":memory:");
    repo.saveCompanyEmail(db, "h:2", "Beta", null, null);
    const pplx = vi.fn();
    expect(await findCompanyEmail(ctx(db), pplx as never, cfg, "h:2", "Beta")).toBeNull();
    expect(pplx).not.toHaveBeenCalled();
  });
  it("кэш пуст → Perplexity, результат кэшируется", async () => {
    const db = openDb(":memory:");
    const pplx = vi.fn().mockResolvedValue('{"email": "career@gamma.ru"}');
    expect(await findCompanyEmail(ctx(db), pplx as never, cfg, "h:3", "Gamma")).toBe("career@gamma.ru");
    expect(await findCompanyEmail(ctx(db), pplx as never, cfg, "h:3", "Gamma")).toBe("career@gamma.ru");
    expect(pplx).toHaveBeenCalledTimes(1);
  });
  it("Perplexity не нашла → кэшируем not_found", async () => {
    const db = openDb(":memory:");
    const pplx = vi.fn().mockResolvedValue('{"email": null}');
    expect(await findCompanyEmail(ctx(db), pplx as never, cfg, "h:4", "Delta")).toBeNull();
    expect(repo.getCompanyEmail(db, "h:4")).toMatchObject({ status: "not_found" });
  });
});
