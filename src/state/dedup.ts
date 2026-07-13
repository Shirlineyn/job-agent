// src/state/dedup.ts
// Ключ дедупликации между источниками: одна и та же вакансия на hh и hirehi/habr
// почти всегда совпадает по (работодатель, название) после нормализации.
export function dedupKey(employerName: string, title: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[«»"'`]/g, "").replace(/\s+/g, " ").trim();
  return `${norm(employerName)}|${norm(title)}`;
}
