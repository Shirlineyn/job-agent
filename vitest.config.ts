import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // Покрываем прикладную ЛОГИКУ. Исключаем чистые I/O-границы и wiring, которые
      // проверяются smoke-запуском и probe-скриптами, а не юнит-тестами: точка сборки
      // Deps, транспорт MCP, cron-обвязка, тонкие HTTP-клиенты LLM, Playwright-браузер,
      // нативные уведомления, реестр источников, типы.
      exclude: [
        "src/index.ts",
        "src/**/types.ts",
        "src/mcp/server.ts",
        "src/scheduler.ts",
        "src/notify.ts",
        "src/llm/anthropic.ts",
        "src/llm/perplexity.ts",
        "src/browser/**",
        "src/sources/index.ts",
      ],
      thresholds: { statements: 75, branches: 65, functions: 75, lines: 75 },
    },
  },
});
