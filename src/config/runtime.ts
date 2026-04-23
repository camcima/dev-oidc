import type { Config } from '@/config/schema.js';

export interface RuntimeConfig {
  get: () => Config;
  set: (config: Config) => void;
  onChange: (handler: (config: Config) => void) => () => void;
}

export function createRuntimeConfig(initial: Config): RuntimeConfig {
  let current = initial;
  const handlers = new Set<(config: Config) => void>();

  return {
    get: () => current,
    set: (config: Config) => {
      current = config;
      for (const handler of handlers) handler(current);
    },
    onChange: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
