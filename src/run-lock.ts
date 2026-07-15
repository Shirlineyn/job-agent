import { openSync, closeSync, writeSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Межпроцессный lock прогона: раньше был только in-process флаг, поэтому scripts/apply-live.ts
// (отдельный процесс) мог одновременно с демоном драйвить один и тот же браузерный профиль
// ~/.hh-agent/profile и биться за его Singleton-lock. PID-файл защищает и между процессами:
// демон (mcp run_now + scheduler) и apply-live делят один lock, а мёртвый владелец
// (краш без release) детектируется по liveness pid и перехватывается.
const defaultLockPath = join(homedir(), ".hh-agent", "run.lock");

let heldPath: string | null = null;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // сигнал 0 — только проверка существования, процесс не трогаем
    return true;
  } catch (e) {
    // ESRCH — процесса нет (stale); EPERM — есть, но чужой (считаем живым)
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function tryAcquireRunLock(lockPath: string = defaultLockPath): boolean {
  if (heldPath !== null) return false; // уже держим в этом процессе
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx"); // эксклюзивное создание: EEXIST, если файл уже есть
      writeSync(fd, String(process.pid));
      closeSync(fd);
      heldPath = lockPath;
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
      if (pidAlive(owner)) return false; // держит живой процесс — уступаем
      try {
        unlinkSync(lockPath); // stale: владелец мёртв — снимаем и пробуем снова
      } catch {
        /* гонка: кто-то уже снял lock — повторная попытка создать разрулит */
      }
    }
  }
  return false;
}

export function releaseRunLock(): void {
  if (heldPath === null) return;
  try {
    unlinkSync(heldPath);
  } catch {
    /* уже снят (напр. внешним cleanup) — идемпотентно */
  }
  heldPath = null;
}
