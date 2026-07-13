import { describe, it, expect, vi } from "vitest";
import { getJson, stripHtml } from "../src/sources/http.js";

describe("getJson", () => {
  it("парсит JSON и передаёт User-Agent", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    expect(await getJson(f as never, "https://x.test/api")).toEqual({ ok: 1 });
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["user-agent"]).toContain("Mozilla");
  });
  it("бросает на не-2xx со статусом в сообщении", async () => {
    const f = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(getJson(f as never, "https://x.test/api")).rejects.toThrow(/403/);
  });
});

describe("stripHtml", () => {
  it("убирает теги и entities, схлопывает пробелы", () => {
    expect(stripHtml("<p>Обязанности:</p><ul><li>писать&nbsp;код &amp; тесты</li></ul>"))
      .toBe("Обязанности: писать код & тесты");
  });
});
