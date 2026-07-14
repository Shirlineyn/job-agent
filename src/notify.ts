import { execFile } from "node:child_process";
import { platform } from "node:os";
import { logger } from "./logger.js";

const log = logger("notify");

export function notify(msg: string): void {
  // Нативный тост — только на macOS (osascript). На других платформах тихо
  // деградируем до лога: агент кросс-платформенный, уведомление — не критичный путь.
  if (platform() === "darwin") {
    execFile(
      "osascript",
      [
        "-e",
        `display notification ${JSON.stringify(msg)} with title "hh-agent" sound name "Glass"`,
      ],
      () => {
        /* best-effort: сбой уведомления не должен ронять сессию */
      },
    );
  }
  log.info(msg);
}
