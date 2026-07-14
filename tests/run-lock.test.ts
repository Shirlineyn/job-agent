import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireRunLock, releaseRunLock } from "../src/run-lock.js";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-lock-"));
  lockPath = join(dir, "run.lock");
});
afterEach(() => {
  releaseRunLock();
  rmSync(dir, { recursive: true, force: true });
});

describe("run-lock (cross-process PID lock)", () => {
  it("захватывает и освобождает, создавая/удаляя lock-файл", () => {
    expect(tryAcquireRunLock(lockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    releaseRunLock();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("второй захват в том же процессе отклоняется (in-process guard)", () => {
    expect(tryAcquireRunLock(lockPath)).toBe(true);
    expect(tryAcquireRunLock(lockPath)).toBe(false);
  });

  it("повторный захват возможен после release", () => {
    expect(tryAcquireRunLock(lockPath)).toBe(true);
    releaseRunLock();
    expect(tryAcquireRunLock(lockPath)).toBe(true);
  });

  it("отклоняет захват, если lock держит ЖИВОЙ чужой процесс", () => {
    // Живой pid (текущий процесс), но в этом процессе мы lock не держим → должен отказать.
    writeFileSync(lockPath, String(process.pid));
    expect(tryAcquireRunLock(lockPath)).toBe(false);
  });

  it("перехватывает stale-lock мёртвого процесса", () => {
    writeFileSync(lockPath, "999999999"); // заведомо несуществующий pid
    expect(tryAcquireRunLock(lockPath)).toBe(true);
  });

  it("перехватывает битый (пустой) lock-файл", () => {
    writeFileSync(lockPath, "");
    expect(tryAcquireRunLock(lockPath)).toBe(true);
  });
});
