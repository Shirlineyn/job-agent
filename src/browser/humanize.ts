export const jitter = (min: number, max: number) => min + Math.random() * (max - min);
export const sleep = (minMs: number, maxMs: number) =>
  new Promise<void>((r) => setTimeout(r, jitter(minMs, maxMs)));
