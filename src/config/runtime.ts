import type { Config } from '@/config/schema.js';

export interface RuntimeConfig {
  get: () => Config;
  set: (config: Config) => void;
  onChange: (handler: (config: Config) => void) => () => void;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

export function createRuntimeConfig(initial: Config): RuntimeConfig {
  let current = initial;
  let currentCanonical = canonicalize(initial);
  const handlers = new Set<(config: Config) => void>();

  return {
    get: () => current,
    set: (config: Config) => {
      const nextCanonical = canonicalize(config);
      if (nextCanonical === currentCanonical) return;
      current = config;
      currentCanonical = nextCanonical;
      for (const handler of handlers) handler(current);
    },
    onChange: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
