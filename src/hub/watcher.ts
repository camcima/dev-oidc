import chokidar, { type FSWatcher } from 'chokidar';
import { loadHubConfig } from '@/hub/loader.js';
import type { HubConfig } from '@/hub/schema.js';

export interface WatchHubOptions {
  onReload: (config: HubConfig) => void;
  onError: (error: Error) => void;
  debounceMs?: number;
}

export interface HubConfigWatcher {
  close: () => Promise<void>;
}

export async function watchHubConfig(
  filePath: string,
  options: WatchHubOptions,
): Promise<HubConfigWatcher> {
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
      loadHubConfig(filePath)
        .then(options.onReload)
        .catch((err: unknown) =>
          options.onError(err instanceof Error ? err : new Error(String(err))),
        );
    }, debounceMs);
  };

  watcher.on('change', trigger);
  watcher.on('add', trigger);
  watcher.on('error', (err) =>
    options.onError(err instanceof Error ? err : new Error(String(err))),
  );

  await new Promise<void>((resolve) => watcher.on('ready', () => resolve()));

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
