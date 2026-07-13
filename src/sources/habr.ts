import type { Config } from "../config.js";
import type { VacancyInsert, VacancyRow } from "../state/types.js";
import type { Fetch } from "./http.js";
import type { JobSource } from "./types.js";
import { getJson, getText, politePause, stripHtml } from "./http.js";

// Реальная схема API (curl-сверка 2026-07-13, docs/job-boards-research.md):
// - `q=` реально фильтрует выдачу (totalResults: python 509, golang 48, мусорное слово 0);
// - alias компании называется `alias_name`, не `alias`;
// - `publishedDate` — объект `{date, title}`, где date — ISO с таймзоной;
// - у salary есть лишнее поле `formatted`; часто from/to/currency все null —
//   вместо них публикуется `predictedSalary` (оценка Хабра, НЕ вилка работодателя — не берём);
// - карточка /vacancies/<id> — статический HTML с одним <script type="application/ld+json">
//   (schema.org JobPosting), description — HTML полного описания.
type HabrItem = {
  id: number; href: string; title: string; remoteWork: boolean;
  salary: { from: number | null; to: number | null; currency: string | null } | null;
  company: { id: number; title: string; alias_name?: string };
  publishedDate?: { date?: string } | string | null;
  locations?: { title: string }[];
};
type ListResp = { list: HabrItem[]; meta: { totalPages: number } };

const MAX_PAGES = 3;   // 150 свежих на слово при sort=date — дальше старьё

export function extractJsonLd(html: string): string {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("habr: JSON-LD не найден на карточке");
  const data = JSON.parse(m[1]) as { description?: string };
  if (!data.description) throw new Error("habr: JobPosting без description");
  return stripHtml(data.description);
}

export function habrSource(f: Fetch = fetch): JobSource {
  return {
    name: "habr",
    async search(keywords: string[], _cfg: Config): Promise<VacancyInsert[]> {
      const seen = new Set<string>();
      const out: VacancyInsert[] = [];
      for (const kw of keywords) {
        for (let page = 1; page <= MAX_PAGES; page++) {
          const resp = await getJson<ListResp>(f,
            `https://career.habr.com/api/frontend/vacancies?q=${encodeURIComponent(kw)}&page=${page}&per_page=50&sort=date`);
          if (!Array.isArray(resp.list)) throw new Error("habr: неожиданная схема (нет list)");
          for (const it of resp.list) {
            const id = `habr:${it.id}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const pub = typeof it.publishedDate === "string" ? it.publishedDate : it.publishedDate?.date ?? null;
            out.push({
              id, url: `https://career.habr.com${it.href}`, title: it.title,
              employer_id: `habr:${it.company.id}`, employer_name: it.company.title,
              salary_from: it.salary?.from ?? null, salary_to: it.salary?.to ?? null,
              currency: it.salary?.currency?.toUpperCase() === "RUR" ? "RUR" : it.salary?.currency ?? null,
              work_format: it.remoteWork ? "remote" : "unknown",   // офис/гибрид в списке не различимы
              experience: null, published_at: pub, raw_json: JSON.stringify(it), source: "habr",
            });
          }
          if (page >= resp.meta.totalPages) break;
          await politePause();
        }
      }
      return out;
    },
    async fetchText(v: VacancyRow): Promise<string> {
      return extractJsonLd(await getText(f, v.url));
    },
  };
}
