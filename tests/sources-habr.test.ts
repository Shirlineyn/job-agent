import { describe, it, expect, vi } from "vitest";
import { habrSource, extractJsonLd } from "../src/sources/habr.js";
import type { Config } from "../src/config.js";

const LIST_FIXTURE = {
  list: [{
    id: 555, href: "/vacancies/555", title: "LLM Engineer", remoteWork: true,
    salary: { from: 300000, to: null, currency: "rur" },
    company: { id: 77, title: "ООО Рога", alias_name: "roga" },
    publishedDate: { date: "2026-07-11T10:00:00+03:00" },
    locations: [{ title: "Москва" }],
  }],
  meta: { totalPages: 1 },
};
const CARD_HTML = `<html><head>
<script type="application/ld+json">{"@type":"JobPosting","title":"LLM Engineer","description":"<p>Нужен LLM-инженер: RAG, агенты</p>"}</script>
</head><body></body></html>`;
const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe("habrSource", () => {
  it("search маппит список: id, вилка, remote", async () => {
    const f = vi.fn().mockResolvedValue(jsonRes(LIST_FIXTURE));
    const cards = await habrSource(f as never).search(["llm"], {} as Config);
    expect(cards[0].id).toBe("habr:555");
    expect(cards[0].url).toBe("https://career.habr.com/vacancies/555");
    expect(cards[0].salary_from).toBe(300000);
    expect(cards[0].work_format).toBe("remote");
    expect(cards[0].employer_id).toBe("habr:77");
    expect(cards[0].published_at).toBe("2026-07-11T10:00:00+03:00");
  });
  it("extractJsonLd достаёт описание JobPosting из HTML", () => {
    const d = extractJsonLd(CARD_HTML);
    expect(d).toContain("Нужен LLM-инженер");
    expect(d).not.toContain("<p>");
  });
  it("fetchText берёт описание с карточки", async () => {
    const f = vi.fn().mockResolvedValue(new Response(CARD_HTML, { status: 200 }));
    const text = await habrSource(f as never).fetchText({ id: "habr:555", url: "https://career.habr.com/vacancies/555" } as never);
    expect(text).toContain("RAG, агенты");
  });
});
