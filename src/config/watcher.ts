import chokidar, { type FSWatcher } from 'chokidar';
import { loadConfig } from '@/config/loader.js';
import type { Config } from '@/config/schema.js';

export interface WatchOptions {
  onReload: (config: Config) => void;
  onError: (error: Error) => void;
  debounceMs?: number;
}

export interface ConfigWatcher {
  close: () => Promise<void>;
}

export async function watchConfig(filePath: string, options: WatchOptions): Promise<ConfigWatcher> {
  const debounceMs = options.debounceMs ?? 200;
  const watcher: FSWatcher = chokidar.watch(filePath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
  });

  let timer: NodeJS.Timeout | null = null;

  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      loadConfig(filePath)
        .then(options.onReload)
        .catch((err: unknown) =>
          options.onError(err instanceof Error ? err : new Error(String(err))),
        );
    }, debounceMs);
  };

  watcher.on('change', () => trigger());
  watcher.on('add', () => trigger());
  watcher.on('error', (err) =>
    options.onError(err instanceof Error ? err : new Error(String(err))),
  );

  await new Promise<void>((resolve) => watcher.on('ready', resolve));

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
