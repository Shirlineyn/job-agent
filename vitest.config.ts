import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Покрываем прикладную логику; CLI-скрипты, точку сборки Deps и голый MCP-транспорт
      // исключаем — их проверяет smoke-запуск, а не юнит-тесты.
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/**/types.ts"],
    },
  },
});
