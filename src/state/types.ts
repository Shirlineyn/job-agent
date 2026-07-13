// src/state/types.ts

export type VacancyStatus =
  | "discovered"
  | "filtered_out"
  | "scored"
  | "skipped"
  | "queued"
  | "applied"
  | "failed";

export type WorkFormat = "office" | "hybrid" | "remote" | "unknown";

export interface VacancyRow {
  id: string;
  url: string;
  title: string;
  employer_id: string | null;
  employer_name: string;
  salary_from: number | null;
  salary_to: number | null;
  currency: string | null;
  work_format: WorkFormat | null;
  experience: string | null;
  published_at: string | null;
  discovered_at: string;
  status: VacancyStatus;
  score: number | null;
  score_reasons: string | null;
  filter_reason: string | null;
  letter: string | null;
  applied_at: string | null;
  raw_json: string | null;
  source: string;
  dedup_key: string | null;
  updated_at: string;
}

export interface VacancyInsert {
  id: string;
  url: string;
  title: string;
  employer_id: string | null;
  employer_name: string;
  salary_from: number | null;
  salary_to: number | null;
  currency: string | null;
  work_format: WorkFormat | null;
  experience: string | null;
  published_at: string | null;
  raw_json: string | null;
  source: string;
}

export interface LlmCallInsert {
  vacancy_id: string | null;
  run_id: number | null;
  provider: "anthropic" | "perplexity";
  purpose: "scoring" | "research" | "letter" | "email_search";
  model: string;
  request: string;
  response: string | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
}

export type EmailStatus = "draft" | "sent" | "rejected";

export interface EmailRow {
  id: number;
  vacancy_id: string;
  to_email: string;
  subject: string;
  body: string;
  status: EmailStatus;
  created_at: string;
  sent_at: string | null;
}

export interface EmailInsert {
  vacancy_id: string;
  to_email: string;
  subject: string;
  body: string;
}

export interface RunPatch {
  discovered?: number;
  filtered_out?: number;
  scored?: number;
  applied?: number;
  errors?: number;
  stop_reason?: string;
}
