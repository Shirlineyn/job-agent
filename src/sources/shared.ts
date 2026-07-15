import type { VacancyRow, WorkFormat } from "../state/types.js";

// Единый двуязычный маппер формата работы из свободного текста. Порядок значим:
// remote > hybrid > office — при нескольких признаках берём наиболее гибкий.
export function parseWorkFormat(s: string | null | undefined): WorkFormat {
  if (!s) return "unknown";
  if (/удал|remote/i.test(s)) return "remote";
  if (/гибрид|hybrid/i.test(s)) return "hybrid";
  if (/офис|office/i.test(s)) return "office";
  return "unknown";
}

// fetchText для источников, кладущих полный текст вакансии в raw_json.text ещё на этапе
// search (getmatch, trudvsem): повторный сетевой вызов не нужен.
export function fetchTextFromRawJson(v: VacancyRow, source: string): string {
  const text = (JSON.parse(v.raw_json ?? "{}") as { text?: string }).text;
  if (!text) throw new Error(`${source}: нет текста в raw_json для ${v.id}`);
  return text;
}
