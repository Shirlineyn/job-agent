import cron from "node-cron";
import { jitter } from "./browser/humanize.js";
import { runSession, type Deps } from "./pipeline/run.js";
import { loadConfig, type Config } from "./config.js";
import { notify } from "./notify.js";
import { logger } from "./logger.js";
import { tryAcquireRunLock, releaseRunLock } from "./run-lock.js";

const log = logger("scheduler");

export function startScheduler(mkDeps: () => Promise<Deps>, cfg: Config): void {
  for (const expr of cfg.schedule) {
    cron.schedule(
      expr,
      async () => {
        if (loadConfig().paused) {
          log.info("paused, skip");
          return;
        }
        if (!tryAcquireRunLock()) {
          log.info("session already running, skip");
          return;
        }
        try {
          await new Promise((r) => setTimeout(r, jitter(0, 20 * 60_000)));
          // Перечитываем конфиг ПОСЛЕ джиттера: пользователь мог поставить паузу или
          // переключить live→dry_run в течение окна ожидания — учитываем это, а не снимок «до».
          const fresh = loadConfig();
          if (fresh.paused) {
            log.info("paused during jitter, skip");
            return;
          }
          const deps = await mkDeps();
          const s = await runSession({ ...deps, cfg: fresh }, "schedule");
          notify(
            `hh-agent: сессия завершена — откликов ${s.applied}, ошибок ${s.errors} (${s.stopReason})`,
          );
        } catch (e) {
          notify(`hh-agent: сессия упала: ${String(e)}`);
        } finally {
          releaseRunLock();
        }
      },
      { timezone: "Europe/Moscow" },
    );
  }
  log.info(`armed: ${cfg.schedule.join(" | ")}`);
}
