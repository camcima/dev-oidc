import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as LegacyModule from '@/cli/legacy.js';
import type { LegacyStartOptions } from '@/cli/legacy.js';
import { makeTmpDir } from '../shared/tmp-dir.js';

interface CliResult {
  exitCode: number;
  stderr: string;
}

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
  const dir = makeTmpDir('dev-oidc-pub-');
  const file = path.join(dir, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      signingKey: { kid: 'k1', alg: 'RS256', source: 'generate' },
      clients: [{ clientId: 'c', redirectUris: ['http://localhost/cb'] }],
      profiles: [{ id: 'a', displayName: 'A', email: 'a@example.com' }],
    }),
  );
  return file;
}

describe('CLI DEV_OIDC_PUBLIC_URL fallback', () => {
  const originalEnv = process.env.DEV_OIDC_PUBLIC_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DEV_OIDC_PUBLIC_URL;
    } else {
      process.env.DEV_OIDC_PUBLIC_URL = originalEnv;
    }
  });

  it('refuses to start with --host 0.0.0.0 when neither --public-url nor DEV_OIDC_PUBLIC_URL is set', async () => {
    delete process.env.DEV_OIDC_PUBLIC_URL;
    const cfg = tmpProjectConfig();
    // Use a port that's almost certainly unbindable to confirm the bind-all
    // guard fires before the listen attempt rather than getting an EACCES /
    // EADDRINUSE error first.
    const { exitCode } = await runCli([
      'start',
      '--config',
      cfg,
      '--host',
      '0.0.0.0',
      '--port',
      '0',
    ]);
    expect(exitCode).toBe(1);
  });

  it('uses DEV_OIDC_PUBLIC_URL as the publicUrl fallback when --public-url is omitted', async () => {
    // We can't actually start the server (no port available + would hang the
    // suite); instead spy on `startLegacy` and assert the publicUrl threaded
    // through. The CLI imports startLegacy lazily, so we mock the module.
    process.env.DEV_OIDC_PUBLIC_URL = 'http://idp.example.test:8095';
    const cfg = tmpProjectConfig();

    const startLegacy = vi.fn(async (_options: LegacyStartOptions) => ({
      server: { close: async () => undefined } as never,
      port: 8095,
      host: '0.0.0.0',
      issuer: 'http://idp.example.test:8095',
    }));
    vi.doMock('@/cli/legacy.js', async () => {
      const actual = await vi.importActual<typeof LegacyModule>('@/cli/legacy.js');
      return { ...actual, startLegacy };
    });

    await runCli(['start', '--config', cfg, '--host', '0.0.0.0', '--port', '8095']);

    expect(startLegacy).toHaveBeenCalledTimes(1);
    const firstCall = startLegacy.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall![0].publicUrl).toBe('http://idp.example.test:8095');

    vi.doUnmock('@/cli/legacy.js');
  });
});
