// One-off interactive login into hh.ru using the persistent Chromium profile.
// Run: npx tsx scripts/login.ts
//
// Opens a headed browser at hh.ru with the same profile the agent uses
// (~/.hh-agent/profile) and keeps it open until you close the window. Log in
// (and pass any captcha) by hand — the session is saved in the profile, so the
// agent will be logged in on its next run. Nothing is submitted or scraped here.
import { chromium } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";

async function main(): Promise<void> {
  const profileDir = join(homedir(), ".hh-agent", "profile");
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://hh.ru/account/login", { waitUntil: "domcontentloaded" });

  console.log("[login] Браузер открыт. Войдите в аккаунт hh.ru (и пройдите капчу, если есть).");
  console.log(
    "[login] Когда закончите — просто закройте окно браузера. Сессия сохранится в профиле.",
  );

  await new Promise<void>((resolve) =>
    ctx.on("close", () => {
      resolve();
    }),
  );
  console.log("[login] Окно закрыто, сессия сохранена. Готово.");
}

main().catch((err) => {
  console.error("[login] ERROR:", err);
  process.exit(1);
});
