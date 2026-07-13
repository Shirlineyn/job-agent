import type { Config } from "../config.js";
import type { VacancyInsert, VacancyRow, WorkFormat } from "../state/types.js";
import type { Fetch } from "./http.js";
import type { JobSource } from "./types.js";
import { getJson, politePause, stripHtml } from "./http.js";

// Реальная схема API (curl-сверка 2026-07-13, docs/job-boards-research.md) отличается от
// исходной фикстуры задачи в двух местах:
// - поля `description_html` в ответе есть, но оно ВСЕГДА null (и в списке /api/offers,
//   и в детальном /api/offers/<id>). Реальный текст описания — поле `offer_description`
//   (HTML), и оно действительно приходит прямо в списке без доп. параметров — сама идея
//   брифа "текст доступен в списке" верна, просто под другим именем поля;
// - `url` в API — относительный путь (`/vacancies/<id>-<slug>`), не абсолютный. Адаптер
//   достраивает его сам (https://getmatch.ru + url), с фолбэком на /vacancies/<id>,
//   если поле пустое.
// salary_display_from/to, salary_currency и структура location_items:[{format}] совпали
// с брифом без изменений.
type Offer = {
  id: number; position: string; company: { name: string };
  salary_display_from: number | null; salary_display_to: number | null; salary_currency: string | null;
  offer_description: string | null; location_items: { format?: string }[];
  published_at: string | null; url?: string | null;
};
type OffersResp = { meta: { total: number }; offers: Offer[] };

// В API getmatch нет текстового поиска — база ~720 офферов, качаем целиком и фильтруем сами.
export function matchesKeywords(position: string, descriptionHtml: string, keywords: string[]): boolean {
  const hay = `${position} ${stripHtml(descriptionHtml)}`.toLowerCase();
  return keywords.some(k => hay.includes(k.toLowerCase()));
}

function fmt(items: { format?: string }[]): WorkFormat {
  const fs = items.map(i => i.format ?? "");
  if (fs.some(x => /remote/i.test(x))) return "remote";
  if (fs.some(x => /hybrid/i.test(x))) return "hybrid";
  if (fs.some(x => /office/i.test(x))) return "office";
  return "unknown";
}

function absUrl(url: string | null | undefined, id: number): string {
  if (!url) return `https://getmatch.ru/vacancies/${id}`;
  return url.startsWith("http") ? url : `https://getmatch.ru${url}`;
}

export function getmatchSource(f: Fetch = fetch): JobSource {
  return {
    name: "getmatch",
    async search(keywords: string[], _cfg: Config): Promise<VacancyInsert[]> {
      const out: VacancyInsert[] = [];
      for (let offset = 0; ; offset += 100) {
        const resp = await getJson<OffersResp>(f, `https://getmatch.ru/api/offers?limit=100&offset=${offset}`);
        if (!Array.isArray(resp.offers)) throw new Error("getmatch: неожиданная схема (нет offers)");
        for (const o of resp.offers) {
          if (!matchesKeywords(o.position, o.offer_description ?? "", keywords)) continue;
          out.push({
            id: `getmatch:${o.id}`, url: absUrl(o.url, o.id), title: o.position,
            employer_id: `getmatch:${o.company.name.toLowerCase().trim()}`, employer_name: o.company.name,
            salary_from: o.salary_display_from, salary_to: o.salary_display_to,
            currency: o.salary_currency === "RUB" ? "RUR" : o.salary_currency,
            work_format: fmt(o.location_items ?? []), experience: null,
            published_at: o.published_at,
            // offer_description кладём в raw_json: fetchText потом не ходит в сеть
            raw_json: JSON.stringify({ text: stripHtml(o.offer_description ?? "") }),
            source: "getmatch",
          });
        }
        if (offset + 100 >= resp.meta.total || resp.offers.length === 0) break;
        await politePause();
      }
      return out;
    },
    async fetchText(v: VacancyRow): Promise<string> {
      const text = (JSON.parse(v.raw_json ?? "{}") as { text?: string }).text;
      if (!text) throw new Error(`getmatch: нет текста в raw_json для ${v.id}`);
      return text;
    },
  };
}
