import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeTmpDir } from '../shared/tmp-dir.js';

interface CliResult {
  exitCode: number;
  stderr: string;
}

// Port validation happens before anything is bound, so the CLI exits during
// argument parsing and never reaches the server code path.
async function runCli(argv: string[]): Promise<CliResult> {
  const oldArgv = process.argv;
  const oldExit = process.exit;
  let exitCode: number | null = null;
  let stderr = '';
  process.argv = ['node', 'dev-oidc', ...argv];
  process.exit = ((code?: number) => {
    if (exitCode === null) exitCode = code ?? 0;
    throw new Error(`__exit__:${code ?? 0}`);
  }) as never;
  const oldWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  const onUnhandled = (reason: unknown): void => {
    if (reason instanceof Error && reason.message.startsWith('__exit__')) return;
    throw reason as Error;
  };
  process.on('unhandledRejection', onUnhandled);

  vi.resetModules();
  try {
    await import('@/cli.js');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } catch (err) {
    if (!String((err as Error).message).startsWith('__exit__')) throw err;
  } finally {
    process.off('unhandledRejection', onUnhandled);
    process.argv = oldArgv;
    process.exit = oldExit;
    process.stderr.write = oldWrite;
  }
  return { exitCode: exitCode ?? 0, stderr };
}

function tmpProjectConfig(): string {
  const dir = makeTmpDir('dev-oidc-port-');
  const file = path.join(dir, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: 'k1' },
      clients: [{ clientId: 'app', redirectUris: ['http://localhost:5173/cb'], audience: 'api' }],
      profiles: [],
    }),
  );
  return file;
}

describe('dev-oidc start --port validation', () => {
  it('rejects port 0, which would advertise an issuer with a bogus port', async () => {
    const cfg = tmpProjectConfig();
    const result = await runCli([
      'start',
      '--config',
      cfg,
      '--public-url',
      'http://localhost:8095',
      '--port',
      '0',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--port');
  });

  it('rejects a port above the valid range', async () => {
    const cfg = tmpProjectConfig();
    const result = await runCli([
      'start',
      '--config',
      cfg,
      '--public-url',
      'http://localhost:8095',
      '--port',
      '70000',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--port');
  });

  it('rejects a non-numeric port', async () => {
    const cfg = tmpProjectConfig();
    const result = await runCli([
      'start',
      '--config',
      cfg,
      '--public-url',
      'http://localhost:8095',
      '--port',
      'abc',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--port');
  });
});
