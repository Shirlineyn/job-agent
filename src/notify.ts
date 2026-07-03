import { execFile } from "node:child_process";

export function notify(msg: string): void {
  execFile("osascript", ["-e", `display notification ${JSON.stringify(msg)} with title "hh-agent" sound name "Glass"`], () => {});
  console.log(`[notify] ${msg}`);
}
