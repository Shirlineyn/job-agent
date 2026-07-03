import cron from "node-cron";
import { jitter } from "./browser/humanize.js";
import { runSession, type Deps } from "./pipeline/run.js";
import { loadConfig, type Config } from "./config.js";
import { notify } from "./notify.js";
import { tryAcquireRunLock, releaseRunLock } from "./run-lock.js";

export function startScheduler(mkDeps: () => Promise<Deps>, cfg: Config): void {
  for (const expr of cfg.schedule) {
    cron.schedule(expr, async () => {
      if (loadConfig().paused) { console.log("[scheduler] paused, skip"); return; }
      if (!tryAcquireRunLock()) { console.log("[scheduler] session already running, skip"); return; }
      try {
        await new Promise(r => setTimeout(r, jitter(0, 20 * 60_000)));
        // Перечитываем конфиг ПОСЛЕ джиттера: пользователь мог поставить паузу или
        // переключить live→dry_run в течение окна ожидания — учитываем это, а не снимок «до».
        const fresh = loadConfig();
        if (fresh.paused) { console.log("[scheduler] paused during jitter, skip"); return; }
        const deps = await mkDeps();
        const s = await runSession({ ...deps, cfg: fresh }, "schedule");
        notify(`hh-agent: сессия завершена — откликов ${s.applied}, ошибок ${s.errors} (${s.stopReason})`);
      } catch (e) { notify(`hh-agent: сессия упала: ${e}`); }
      finally { releaseRunLock(); }
    }, { timezone: "Europe/Moscow" });
  }
  console.log(`[scheduler] armed: ${cfg.schedule.join(" | ")}`);
}
