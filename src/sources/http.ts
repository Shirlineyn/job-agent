export type Fetch = typeof fetch;

// Честный браузерный UA: часть площадок (rabota.ru-подобные за Qrator) банят куцые UA;
// наши источники не банят, но единый UA упрощает жизнь.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export async function getJson<T>(f: Fetch, url: string, timeoutMs = 30_000): Promise<T> {
  const res = await f(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export async function getText(f: Fetch, url: string, timeoutMs = 30_000): Promise<string> {
  const res = await f(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

// Вежливый интервал между запросами к одному источнику — мы гости на неофициальных API.
export const politePause = (): Promise<void> => new Promise(r => setTimeout(r, 1000 + Math.random() * 500));

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
