export interface Entry<T> {
  value: T;
  expiresAt: number;
}

export const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * Opportunistic maintenance run before each insert into a TTL-keyed Map: drop
 * every expired entry, then evict oldest entries (Maps preserve insertion
 * order) until there is room for one more. Entries are normally removed when
 * consumed; this reclaims the ones whose exact key is never presented again,
 * bounding memory in a long-running hub.
 */
export function evictForInsert<T>(map: Map<string, Entry<T>>, maxEntries: number): void {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (now > entry.expiresAt) map.delete(key);
  }
  while (map.size >= maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
