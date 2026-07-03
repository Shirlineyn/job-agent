let running = false;

export function tryAcquireRunLock(): boolean {
  if (running) return false;
  running = true;
  return true;
}

export function releaseRunLock(): void {
  running = false;
}
