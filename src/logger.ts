// Минимальный структурированный логгер: ISO-время + уровень + scope модуля.
// Достаточно для однопроцессного демона; при этом строки остаются грепаемыми
// (напр. `[mcp] http://...`, `[scheduler] armed:` — на них смотрят README и launchd tail).
type Level = "INFO" | "WARN" | "ERROR";

function emit(level: Level, scope: string, msg: string): void {
  const line = `${new Date().toISOString()} ${level} [${scope}] ${msg}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function logger(scope: string): Logger {
  return {
    info: (msg) => {
      emit("INFO", scope, msg);
    },
    warn: (msg) => {
      emit("WARN", scope, msg);
    },
    error: (msg) => {
      emit("ERROR", scope, msg);
    },
  };
}
