import { describe, it, expect, vi } from "vitest";
import { researchCompany } from "../src/llm/research.js";
import { openDb } from "../src/state/db.js";
import * as repo from "../src/state/repo.js";

describe("researchCompany", () => {
  it("uses cache when fresh", async () => {
    const db = openDb(":memory:");
    repo.saveCompanyResearch(db, "e1", "Acme", "cached research");
    const pplx = vi.fn();
    const ctx = { db, runId: null, vacancyId: null };
    const cfg = { perplexityModel: "sonar" } as never;
    expect(await researchCompany(ctx, pplx as never, cfg, "e1", "Acme")).toBe("cached research");
    expect(pplx).not.toHaveBeenCalled();
  });
});
