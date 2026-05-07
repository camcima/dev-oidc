import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const tracked: string[] = [];

export function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tracked.push(dir);
  return dir;
}

function cleanup(): void {
  while (tracked.length > 0) {
    const dir = tracked.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

// Vitest's afterAll fires once per test file before the worker exits — the
// reliable hook for cleanup. process.on('exit') is not invoked when vitest
// terminates its worker pool, which is why a plain exit handler leaks.
afterAll(cleanup);
