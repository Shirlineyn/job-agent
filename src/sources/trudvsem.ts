import type { Config } from "../config.js";
import type { VacancyInsert, VacancyRow, WorkFormat } from "../state/types.js";
import type { Fetch } from "./http.js";
import type { JobSource } from "./types.js";
import { getJson, politePause, stripHtml } from "./http.js";

// Реальная схема API (curl-сверка 2026-07-13, docs/job-boards-research.md, раздел trudvsem)
// отличается от исходной фикстуры брифа в одном месте:
// - текст требований — отдельное ПЛОСКОЕ строковое поле `requirements` (Hard/Soft Skills,
//   часто крупнее duty), а НЕ `requirement.education`. `requirement` — это другой объект
//   ({education, experience}) с формальными полями анкеты, не текст требований. Бриф спутал
//   имя поля; адаптер берёт текст из duty + requirements, requirement не используется для текста.
// - при 0 результатах API отдаёт `results: {}` без ключа `vacancies` вовсе (не пустой массив) —
//   `resp.results?.vacancies ?? []` уже это покрывает.
// - `salary_min`/`salary_max` иногда приходят как 0 (означает "не указано", а не "вилка до 0₽") —
//   нормализуем через `|| null`, а не `?? null`.
// - `offset` подтверждён curl'ом как номер СТРАНИЦЫ (0-based): offset=0 и offset=1 при
//   limit=2 отдают непересекающиеся вакансии.
type TvVacancy = {
  id: string; "job-name": string; salary_min?: number | null; salary_max?: number | null;
  duty?: string; requirements?: string;
  company: { name: string; email?: string; companycode?: string; inn?: string } | null;
  vac_url?: string; "creation-date"?: string; schedule?: string;
};
type TvResp = { status: string; results?: { vacancies?: { vacancy: TvVacancy }[] } };

const MAX_PAGES = 2;   // 200 на слово в Москве — больше по IT там просто нет
const TIMEOUT = 60_000; // API госпортала медленное, ~4-5 c на запрос

function fmt(schedule: string | undefined): WorkFormat {
  return schedule && /дистанц|удал/i.test(schedule) ? "remote" : "unknown";
}

export function trudvsemSource(f: Fetch = fetch): JobSource {
  return {
    name: "trudvsem",
    async search(keywords: string[], _cfg: Config): Promise<VacancyInsert[]> {
      const seen = new Set<string>();
      const out: VacancyInsert[] = [];
      for (const kw of keywords) {
        for (let page = 0; page < MAX_PAGES; page++) {
          // offset у trudvsem — номер СТРАНИЦЫ (0-based), не записи
          const resp = await getJson<TvResp>(f,
            `https://opendata.trudvsem.ru/api/v1/vacancies/region/77?text=${encodeURIComponent(kw)}&limit=100&offset=${page}`, TIMEOUT);
          const items = resp.results?.vacancies ?? [];
          for (const { vacancy: v } of items) {
            // Битая запись без company.name — пропускаем ЭТУ запись, не роняем весь батч источника
            // (throw оставляем только на неожиданную схему конверта ответа выше).
            if (!v.company?.name) continue;
            const id = `trudvsem:${v.id}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const text = stripHtml([v.duty ?? "", v.requirements ?? ""].join("\n"));
            out.push({
              id, url: v.vac_url ?? `https://trudvsem.ru/vacancy/card/${v.company.companycode}/${v.id}`,
              title: v["job-name"],
              employer_id: `trudvsem:${v.company.companycode ?? v.company.inn ?? v.company.name.toLowerCase().trim()}`,
              employer_name: v.company.name,
              salary_from: v.salary_min || null, salary_to: v.salary_max || null,
              currency: v.salary_min || v.salary_max ? "RUR" : null,
              work_format: fmt(v.schedule), experience: null,
              published_at: v["creation-date"] ?? null,
              // text — для скоринга без повторного похода; email — подхватит email-flow
              raw_json: JSON.stringify({ text, email: v.company.email ?? null }),
              source: "trudvsem",
            });
          }
          if (items.length < 100) break;
          await politePause();
        }
      }
      return out;
    },
    async fetchText(v: VacancyRow): Promise<string> {
      const text = (JSON.parse(v.raw_json ?? "{}") as { text?: string }).text;
      if (!text) throw new Error(`trudvsem: нет текста в raw_json для ${v.id}`);
      return text;
    },
  };
}
