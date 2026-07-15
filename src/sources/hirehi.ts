import type { Config } from "../config.js";
import type { VacancyInsert, VacancyRow } from "../state/types.js";
import type { Fetch } from "./http.js";
import type { JobSource } from "./types.js";
import { getJson, politePause, stripHtml } from "./http.js";
import { parseWorkFormat } from "./shared.js";

// Реальная схема API (curl-сверка 2026-07-13, docs/job-boards-research.md) отличается от
// исходной фикстуры задачи:
// - параметр поиска называется `search`, не `query` (query API молча игнорирует —
//   total_count всегда 16174, выдача не фильтруется);
// - у карточки в поиске нет `published_at`, есть `created_at` (ISO datetime);
// - ни в поиске, ни в /api/jobs/<id> нет готового веб-URL. Реальный URL —
//   /{category}/{seo-slug}-{id}, но seo-slug нигде в API не отдаётся. Проверено:
//   /{category}/<любой-текст>-{id} отдаёт 301 → канонический URL, и даже с "неправильным"
//   category страница рендерит верную вакансию (301 не проверяет category, конечная
//   страница отдаёт 200 по чистому id). Поэтому строим URL как /{category}/vacancy-{id} —
//   он реален и рабочий (редиректит/рендерит), даже если category неточный.
interface HirehiJob {
  id: number;
  title: string;
  company: string | null;
  category?: string | null;
  salary_display?: string | null;
  format?: string | null;
  level?: string | null;
  created_at?: string | null;
}
interface SearchResp {
  total_count: number;
  jobs: HirehiJob[];
}
interface JobResp {
  description?: string;
  requirements?: string;
  tasks_details?: string;
  conditions_details?: string;
}

// "от 250 000 до 400 000 ₽" → [250000, 400000]; "до 300 000 ₽" → [null, 300000];
// "~ 300 000 ₽" (частый в реальных данных приблизительный расчёт) → [300000, 300000].
export function parseSalary(s: string | null | undefined): {
  from: number | null;
  to: number | null;
} {
  if (!s) return { from: null, to: null };
  const nums = [...s.matchAll(/\d[\d\s]*\d|\d/g)].map((m) => Number(m[0].replace(/\s/g, "")));
  if (nums.length === 0) return { from: null, to: null };
  const hasFrom = s.includes("от");
  const hasTo = s.includes("до");
  if (hasFrom && hasTo) return { from: nums[0] ?? null, to: nums[1] ?? null };
  if (hasFrom) return { from: nums[0] ?? null, to: null };
  if (hasTo) return { from: null, to: nums[0] ?? null };
  // "~ N ₽" или голое число — единственная оценка, трактуем как одновременно from и to
  return { from: nums[0] ?? null, to: nums[1] ?? nums[0] ?? null };
}

const PAGES_PER_KEYWORD = 2; // ~54 свежих вакансии на слово; глубже — старьё и дубли

export function hirehiSource(f: Fetch = fetch): JobSource {
  return {
    name: "hirehi",
    async search(keywords: string[], _cfg: Config): Promise<VacancyInsert[]> {
      const seen = new Set<string>();
      const out: VacancyInsert[] = [];
      for (const kw of keywords) {
        for (let page = 1; page <= PAGES_PER_KEYWORD; page++) {
          const resp = await getJson<SearchResp>(
            f,
            `https://hirehi.ru/api/search/jobs?search=${encodeURIComponent(kw)}&page=${page}`,
          );
          if (!Array.isArray(resp.jobs))
            throw new Error(`hirehi: неожиданная схема ответа (нет jobs)`);
          for (const j of resp.jobs) {
            // Битая запись без company — пропускаем ЭТУ запись, не роняем весь батч источника
            // (throw оставляем только на неожиданную схему конверта ответа выше).
            if (!j.company) continue;
            const id = `hirehi:${j.id}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const sal = parseSalary(j.salary_display);
            out.push({
              id,
              url: `https://hirehi.ru/${j.category ?? "vacancy"}/vacancy-${j.id}`,
              title: j.title,
              employer_id: `hirehi:${j.company.toLowerCase().trim()}`,
              employer_name: j.company,
              salary_from: sal.from,
              salary_to: sal.to,
              currency: sal.from || sal.to ? "RUR" : null,
              work_format: parseWorkFormat(j.format),
              experience: null,
              published_at: j.created_at ?? null,
              raw_json: JSON.stringify(j),
              source: "hirehi",
            });
          }
          if (resp.jobs.length === 0) break;
          await politePause();
        }
      }
      return out;
    },
    async fetchText(v: VacancyRow): Promise<string> {
      const num = v.id.replace(/^hirehi:/, "");
      const j = await getJson<JobResp>(f, `https://hirehi.ru/api/jobs/${num}`);
      const text = [j.description, j.requirements, j.tasks_details, j.conditions_details]
        .filter(Boolean)
        .map((s) => stripHtml(String(s)))
        .join("\n\n");
      if (!text) throw new Error(`hirehi: пустой текст вакансии ${v.id}`);
      return text;
    },
  };
}
