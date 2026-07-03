import type { Config } from "./config.js";
import type { VacancyInsert } from "./state/types.js";

type Verdict = { pass: true } | { pass: false; reason: string };

export function applyHardFilters(v: VacancyInsert, f: Config["filters"], blacklist: string[]): Verdict {
  const name = v.employer_name.toLowerCase();
  if (blacklist.some(p => name.includes(p.toLowerCase()) || p === v.employer_id)) return { pass: false, reason: "blacklisted" };
  const cap = v.salary_to ?? v.salary_from;
  if (cap === null) {
    if (!f.allowUnknownSalary) return { pass: false, reason: "salary_unknown" };
  } else if (cap < f.salaryMin) return { pass: false, reason: "salary_below_min" };
  if (v.work_format && !f.workFormats.includes(v.work_format)) return { pass: false, reason: "work_format" };
  if (v.experience && !f.maxExperience.includes(v.experience)) return { pass: false, reason: "experience_mismatch" };
  if (v.published_at) {
    const ageDays = (Date.now() - Date.parse(v.published_at)) / 86_400_000;
    if (ageDays > f.freshDays) return { pass: false, reason: "stale" };
  }
  return { pass: true };
}
