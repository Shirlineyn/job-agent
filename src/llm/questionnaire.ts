// src/llm/questionnaire.ts — ответы на анкету работодателя из резюме (честно, radio или «Свой вариант»).
import { z } from "zod";
import type { callClaude } from "./anthropic.js";
import type { LlmLogCtx } from "./log.js";
import type { Config } from "../config.js";

export const QUESTIONNAIRE_SYSTEM = `Ты — ИИ-агент, отвечающий на анкету работодателя от лица кандидата Александра Доронина.
Резюме — ЕДИНСТВЕННЫЙ источник фактов о кандидате. Отвечай ЧЕСТНО, без преувеличений и без выдумок.
Для каждого вопроса:
- ПРЕДПОЧИТАЙ "Свой вариант" (type:"custom"), когда есть что честно и по делу написать: краткий содержательный ответ лучше презентует ИИ-агента и кандидата, чем сухой клик по radio. Ответ — 1 фраза, ТОЛЬКО правда из резюме.
- выбирай готовый вариант (type:"option", value), когда добавить по сути нечего (простое Да/Нет без нюансов) или готовый вариант полно и точно отражает правду.
- ОТКРЫТЫЙ вопрос (помечен «ОТКРЫТЫЙ», вариантов нет): ВСЕГДА type:"custom" с конкретным честным ответом. Для зарплатных ожиданий назови конкретную сумму из резюме/CV, если она там есть; если суммы нет — кратко «по договорённости, готов обсудить».
- Вопрос с ЧЕКБОКСАМИ (помечен «МОЖНО НЕСКОЛЬКО»): type:"option", верни ВСЕ подходящие value в поле "values" (массив), честно из резюме. Напр. город проживания — Москва.
«Свой вариант» — это честная конкретика из резюме, а НЕ приукрашивание: не приписывай опыт, которого нет.
Не приписывай кандидату опыт, которого нет в резюме. Если опыта нет — так и отвечай честно («Нет» / краткое пояснение).
Язык — русский. Ответ — ТОЛЬКО валидный JSON-массив, по одному объекту на КАЖДЫЙ вопрос, в том же порядке и с полем i (индекс вопроса с 0):
[{"i":0,"type":"option","value":"<value>"} | {"i":0,"type":"option","values":["<v1>","<v2>"]} | {"i":0,"type":"custom","text":"<честный краткий ответ>"}]`;

const schema = z.array(z.object({
  i: z.number().int().min(0),
  type: z.enum(["option", "custom"]),
  value: z.coerce.string().optional(),   // Claude иногда возвращает числовой value (id варианта)
  values: z.array(z.coerce.string()).optional(),   // чекбоксы: несколько выбранных value
  text: z.string().optional(),
}));

export type QuestionnaireItem = { name: string; question: string; options: { value: string; text: string }[]; textName?: string | null; multi?: boolean };
export type QuestionnaireAnswer = z.infer<typeof schema>[number];

export async function answerQuestionnaire(
  ctx: LlmLogCtx, claude: typeof callClaude, cfg: Config, resume: string, questions: QuestionnaireItem[],
): Promise<QuestionnaireAnswer[]> {
  const body = questions.map((q, i) =>
    q.options.length > 0
      ? `Вопрос ${i}${q.multi ? " (МОЖНО НЕСКОЛЬКО — чекбоксы, верни массив values)" : ""}: ${q.question}\nВарианты: ${q.options.map(o => `[value=${o.value}] ${o.text}`).join(" | ")}`
      : `Вопрос ${i} (ОТКРЫТЫЙ, свободный текст): ${q.question}`).join("\n\n");
  const user = `<резюме>\n${resume}\n</резюме>\n<анкета>\n${body}\n</анкета>\nОтветь JSON-массивом строго по инструкции (по одному объекту на вопрос, с полем i).`;
  const raw = await claude(ctx, { model: cfg.anthropicModel, system: QUESTIONNAIRE_SYSTEM, user, maxTokens: 1024, purpose: "letter" });
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("questionnaire: no json array in response");
  return schema.parse(JSON.parse(m[0]));
}
