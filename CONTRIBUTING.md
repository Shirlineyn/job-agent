# Разработка

## Установка

```bash
npm ci
npx playwright install chromium   # только если трогаешь hh-браузер
cp .env.example .env               # вписать ключи
```

Требуется Node.js ≥ 20 (см. `.nvmrc` — проверено на 24).

## Скрипты

| Команда                           | Что делает                                         |
| --------------------------------- | -------------------------------------------------- |
| `npm run dev`                     | Запуск в режиме разработки (tsx, без сборки)       |
| `npm run build`                   | Сборка в `dist/` (`tsconfig.build.json`)           |
| `npm run typecheck`               | Проверка типов (src + tests + scripts, `--noEmit`) |
| `npm run lint`                    | ESLint (typescript-eslint strictTypeChecked)       |
| `npm run format` / `format:check` | Prettier                                           |
| `npm test`                        | Тесты (vitest)                                     |
| `npm run test:coverage`           | Тесты с покрытием                                  |

Полный локальный гейт (тот же, что в CI):

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

## Конвенции

- **TDD**: тест перед реализацией фичи/багфикса; логика — под тестами (фейки для
  браузера, LLM, почты через инъекцию зависимостей).
- **Промпты откалиброваны**: их текст не меняем без причины. Личность кандидата —
  через конфиг (`candidate` в `src/config.ts`); `tests/prompts-identity.test.ts`
  стережёт байт-идентичность при дефолтах.
- **Коммиты** — Conventional Commits с пояснением «почему» (описания на русском):
  `feat(scope): …`, `fix(scope): …`, `refactor: …`.
- **Границы модулей**: направление зависимостей — внутрь, к `config`/`state`; высокоуровневые
  модули (`pipeline`, `mcp`, `scheduler`) не импортируются низкоуровневыми.
