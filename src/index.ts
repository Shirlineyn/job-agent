import "dotenv/config";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { openDb } from "./state/db.js";
import { loadConfig } from "./config.js";
import { HhBrowser } from "./browser/hh.js";
import { callClaude } from "./llm/anthropic.js";
import { callPerplexity } from "./llm/perplexity.js";
import { notify } from "./notify.js";
import { startScheduler } from "./scheduler.js";
import { startMcp } from "./mcp/server.js";
import { buildSources } from "./sources/index.js";
import type { Deps } from "./pipeline/run.js";

const DIR = join(homedir(), ".hh-agent");
const cfg = loadConfig();
const db = openDb(join(DIR, "state.db"));

let browser: HhBrowser | null = null;
async function mkDeps(): Promise<Deps> {
  if (!browser?.isAlive()) {
    browser = new HhBrowser();
    await browser.launch(join(DIR, "profile"));
  }
  const freshCfg = loadConfig();
  return {
    db,
    cfg: freshCfg,
    browser,
    claude: callClaude,
    pplx: callPerplexity,
    notify,
    resume: readFileSync(freshCfg.resumePath, "utf8"),
    sources: buildSources(freshCfg),
  };
}

startMcp(db, mkDeps, cfg.port);
startScheduler(mkDeps, cfg);
console.log(`[hh-agent] mode=${cfg.mode} limit=${cfg.dailyLimit}/day`);
