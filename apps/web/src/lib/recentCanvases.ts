const KEY = "tandem.recentCanvases";
const MAX = 5;

export interface RecentCanvas {
  code: string;
  name: string;
  lastOpenedAt: number;
}

export function listRecent(): RecentCanvas[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c): c is RecentCanvas =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as RecentCanvas).code === "string" &&
          typeof (c as RecentCanvas).name === "string" &&
          typeof (c as RecentCanvas).lastOpenedAt === "number"
      )
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function recordRecent(code: string, name: string) {
  try {
    const existing = listRecent().filter((c) => c.code !== code);
    const next: RecentCanvas[] = [
      { code, name, lastOpenedAt: Date.now() },
      ...existing,
    ].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore quota / disabled-storage errors
  }
}

export function removeRecent(code: string) {
  try {
    const filtered = listRecent().filter((c) => c.code !== code);
    localStorage.setItem(KEY, JSON.stringify(filtered));
  } catch {
    // ignore
  }
}
