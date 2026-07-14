// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Мягко к намеренно неиспользуемым аргументам/переменным с префиксом _.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Шаблонные строки логов/писем осознанно интерполируют числа и boolean.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      // Конфликтует с noUncheckedIndexedAccess и оборонительными рантайм-проверками
      // недоверенных данных (вакансии/веб) — гасим, чтобы не удалять реальные guard'ы.
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Осознанно используем `||` для fallback пустых строк/нулей при скрапинге
      // (textContent || "", nums[0] || null). `??` изменил бы поведение на пустой строке.
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      // Часть async-методов реализует async-интерфейсы (JobSource.fetchText) или
      // обработчики MCP-SDK, которым не нужен await — это конформность, а не дефект.
      "@typescript-eslint/require-await": "off",
      // Пустые стрелки — намеренные no-op колбэки best-effort (.catch(() => {})),
      // отмеченные комментариями в коде.
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    // Файл конфигурации ESLint — JS вне TS-программы; отключаем type-aware правила.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // CLI-скрипты и тесты: точечные послабления type-aware правил.
    files: ["scripts/**/*.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // В одноразовых CLI-обёртках main().catch(err => ...) типизация err как unknown избыточна.
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
    },
  },
  {
    // Тестовые фейки: async-моки без await, пустые заглушки и передача методов
    // в expect() — идиомы vitest, а не дефекты.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  prettier,
);
