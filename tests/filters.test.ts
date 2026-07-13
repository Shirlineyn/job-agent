import { describe, it, expect } from "vitest";
import { applyHardFilters } from "../src/filters.js";

const f = { salaryMin: 200000, allowUnknownSalary: true, workFormats: ["remote", "hybrid", "office"], freshDays: 7, maxExperience: ["noExperience", "between1And3", "between3And6"] } as const;
const base = { id: "1", url: "u", title: "t", employer_id: "e", employer_name: "Acme",
  salary_from: null, salary_to: null, currency: null, work_format: "remote" as const,
  experience: "between1And3", published_at: new Date().toISOString(), raw_json: "{}", source: "hh" };

describe("hard filters", () => {
  it("passes unknown salary when allowed", () => {
    expect(applyHardFilters(base, { ...f }, []).pass).toBe(true);
  });
  it("rejects salary ceiling below minimum", () => {
    const r = applyHardFilters({ ...base, salary_to: 150000 }, { ...f }, []);
    expect(r).toEqual({ pass: false, reason: "salary_below_min" });
  });
  it("rejects blacklisted employer by substring, case-insensitive", () => {
    const r = applyHardFilters(base, { ...f }, ["acme"]);
    expect(r).toEqual({ pass: false, reason: "blacklisted" });
  });
  it("rejects stale vacancy", () => {
    const r = applyHardFilters({ ...base, published_at: "2026-06-01" }, { ...f }, []);
    expect(r).toEqual({ pass: false, reason: "stale" });
  });
  it("rejects 6+ years experience", () => {
    const r = applyHardFilters({ ...base, experience: "moreThan6" }, { ...f }, []);
    expect(r).toEqual({ pass: false, reason: "experience_mismatch" });
  });
  it("treats null work_format as unknown and rejects it when unknown is not allowed", () => {
    const r = applyHardFilters({ ...base, work_format: null }, { ...f, workFormats: ["remote"] }, []);
    expect(r).toEqual({ pass: false, reason: "work_format" });
  });
  it("passes null work_format when unknown is allowed", () => {
    const r = applyHardFilters({ ...base, work_format: null }, { ...f, workFormats: ["remote", "unknown"] }, []);
    expect(r.pass).toBe(true);
  });
});
