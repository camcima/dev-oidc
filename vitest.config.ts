import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(here, './src'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // CLI tests reset the module cache and re-import @/cli.js, which transitively
    // pulls in the entire server graph. Under full-suite load the per-test
    // import can exceed vitest's 5s default; bump the ceiling to 15s so genuine
    // regressions still fail loudly without false positives from cold-start
    // module evaluation.
    testTimeout: 15_000,
    // `vitest run` defaults to one worker per CPU thread minus one (21 on a
    // 22-thread machine). Many tests are timing-sensitive (file watchers,
    // TTLs, servers), and at that load they compete with each other and with
    // whatever else the machine is doing, as in a release preflight. Half the
    // threads leaves headroom; a percentage scales with the machine (CI's
    // smaller runners included). Override with `--maxWorkers` when needed.
    maxWorkers: '50%',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
