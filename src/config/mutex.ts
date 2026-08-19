import { createKeyedMutex } from '@/shared/keyed-mutex.js';

// Admin CRUD handlers do read-modify-write across an await (writeConfigFile),
// so two concurrent requests can derive from the same runtime snapshot and
// lose an update. Serializing per config path closes that window in-process.
const mutex = createKeyedMutex();

export function withConfigLock<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
  return mutex.run(configPath, fn);
}
