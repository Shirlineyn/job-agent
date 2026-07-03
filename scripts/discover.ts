// Discover + скоринг БЕЗ писем и БЕЗ отправки: наполняет очередь свежими вакансиями со score.
// Письма и отправка — потом, по одной, через apply-live submit (письмо генерится JIT).
// Потолок на скоринг, чтобы не жечь бюджет. Run: npx tsx scripts/discover.ts [capN]
import "dotenv/config";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HhBrowser, CaptchaDetected, LoggedOut } from "../src/browser/hh.js";
import { openDb } from "../src/state/db.js";
import { loadConfig } from "../src/config.js";
import * as repo from "../src/state/repo.js";
import { applyHardFilters } from "../src/filters.js";
import { scoreVacancy } from "../src/llm/scoring.js";
import { callClaude } from "../src/llm/anthropic.js";

const CAP = Number(process.argv[2]) || 12;   // сколько новых вакансий максимум оценить

async function main() {
  const cfg = loadConfig();
  const resume = readFileSync(cfg.resumePath, "utf8");
  const db = openDb(join(homedir(), ".hh-agent", "state.db"));
  const runId = repo.startRun(db, "manual", "dry_run");
  const browser = new HhBrowser();
  await browser.launch(join(homedir(), ".hh-agent", "profile"));
  let discovered = 0, scored = 0, queued = 0;
  try {
    for (const q of cfg.searchQueries) {
      const found = await browser.searchVacancies(q, cfg.area);
      for (const card of found) if (repo.upsertVacancy(db, card)) discovered++;
    }
    // hh-рекомендации: пустой запрос + дефолтный (релевантный) порядок hh под резюме.
    const rec = await browser.searchVacancies("", cfg.area, "default");
    let recNew = 0;
    for (const card of rec) if (repo.upsertVacancy(db, card)) { discovered++; recNew++; }
    console.log(`discovered новых: ${discovered} (из них hh-рекомендаций: ${recNew} из ${rec.length} карточек)`);
    const blacklist = repo.getBlacklist(db);
    for (const v of repo.getByStatus(db, "discovered")) {
      if (scored >= CAP) { console.log(`достигнут потолок скоринга (${CAP}) — остальные оставлены discovered`); break; }
      const verdict = applyHardFilters(v, cfg.filters, blacklist);
      if (!verdict.pass) { repo.setStatus(db, v.id, "filtered_out", { filter_reason: verdict.reason }); continue; }
      const text = await browser.fetchVacancyText(v.url);
      try {
        const score = await scoreVacancy({ db, runId, vacancyId: v.id }, callClaude, cfg, resume, text);
        scored++;
        const st = score.score >= cfg.scoreThreshold ? "queued" : "skipped";
        if (st === "queued") { queued++; console.log(`  [${score.score}] queued: ${(v.employer_name||"").slice(0,20)} — ${(v.title||"").slice(0,40)}  id=${v.id}`); }
        repo.setStatus(db, v.id, st, { score: score.score, score_reasons: JSON.stringify(score), raw_json: JSON.stringify({ text }) });
      } catch (e) { console.log(`  score fail ${v.id}: ${String(e).slice(0, 50)}`); }
    }
    console.log(`\nОценено: ${scored}, в очередь: ${queued}.`);
  } catch (e) {
    if (e instanceof CaptchaDetected) console.log("КАПЧА — пройди в окне и перезапусти.");
    else if (e instanceof LoggedOut) console.log("РАЗЛОГИН — залогинься (scripts/login.ts).");
    else console.log("ERROR:", e);
  } finally {
    repo.finishRun(db, runId, { discovered, scored, stop_reason: "discover_only" });
    await browser.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
