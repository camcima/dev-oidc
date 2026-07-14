// Per-config-path mutation queue. Admin CRUD handlers do read-modify-write
// across an await (writeConfigFile), so two concurrent requests can derive
// from the same runtime snapshot and lose an update. Serializing per path
// closes that window in-process.
const queues = new Map<string, Promise<unknown>>();

export function withConfigLock<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(configPath) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(configPath, tail);
  void tail.then(() => {
    if (queues.get(configPath) === tail) queues.delete(configPath);
  });
  return run;
}
