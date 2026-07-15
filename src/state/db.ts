// src/state/db.ts
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const n = Number(/^V(\d+)__/.exec(f)?.[1]);
    if (!n || n <= current) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
      db.pragma(`user_version = ${n}`);
    })();
  }
}
