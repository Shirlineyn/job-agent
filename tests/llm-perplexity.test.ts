import { describe, it, expect, vi, afterEach } from "vitest";
import { openDb } from "../src/state/db.js";
import { callPerplexity } from "../src/llm/perplexity.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callPerplexity", () => {
  it("sends the x-pplx-integration attribution header", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const db = openDb(":memory:");
    const out = await callPerplexity(
      { db, runId: null, vacancyId: null },
      { model: "sonar", prompt: "p", purpose: "research" },
    );
    expect(out).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.perplexity.ai/chat/completions");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-pplx-integration"]).toBe("job-agent");
  });
});
