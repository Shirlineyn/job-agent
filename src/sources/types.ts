import type { VacancyInsert, VacancyRow } from "../state/types.js";
import type { Config } from "../config.js";

export type SourceName = "hirehi" | "habr" | "getmatch" | "trudvsem";

export interface JobSource {
  name: SourceName;
  /** Поисковая выдача по ключевым словам → карточки для upsert. Ошибка одного источника не валит прогон. */
  search(keywords: string[], cfg: Config): Promise<VacancyInsert[]>;
  /** Полный текст вакансии для скоринга. Может читать из v.raw_json, если текст сохранён при ingest. */
  fetchText(v: VacancyRow): Promise<string>;
}
