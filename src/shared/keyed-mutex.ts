/**
 * Serializes async work per key. Two copies of this pattern existed — one for
 * config-file writes, one for tenant slug mutations — with subtly different
 * cleanup; this is the single implementation.
 *
 * Entries are dropped once a key's queue drains, so a long-lived process does
 * not accumulate one promise per key it has ever touched.
 */
export interface KeyedMutex {
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
}

export function createKeyedMutex(): KeyedMutex {
  const queues = new Map<string, Promise<unknown>>();

  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = queues.get(key) ?? Promise.resolve();
      // Run `fn` whether the previous entry settled or rejected: one caller's
      // failure must not wedge the queue for every later caller.
      const result = previous.then(fn, fn);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      queues.set(key, tail);
      void tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
      });
      return result;
    },
  };
}
