import cron from "node-cron";
import { jitter } from "./browser/humanize.js";
import { runSession, type Deps } from "./pipeline/run.js";
import { loadConfig, type Config } from "./config.js";
import { notify } from "./notify.js";

let running = false;

export function startScheduler(mkDeps: () => Promise<Deps>, cfg: Config): void {
  for (const expr of cfg.schedule) {
    cron.schedule(expr, async () => {
      const fresh = loadConfig();                       // paused/mode могли поменяться через MCP
      if (fresh.paused) { console.log("[scheduler] paused, skip"); return; }
      if (running) { console.log("[scheduler] session already running, skip"); return; }
      running = true;
      try {
        await new Promise(r => setTimeout(r, jitter(0, 20 * 60_000)));
        const deps = await mkDeps();
        const s = await runSession({ ...deps, cfg: fresh }, "schedule");
        notify(`hh-agent: сессия завершена — откликов ${s.applied}, ошибок ${s.errors} (${s.stopReason})`);
      } catch (e) { notify(`hh-agent: сессия упала: ${e}`); }
      finally { running = false; }
    }, { timezone: "Europe/Moscow" });
  }
  console.log(`[scheduler] armed: ${cfg.schedule.join(" | ")}`);
}
