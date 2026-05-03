import { describe, expect, it, vi } from 'vitest';

// Defer the import — we'll require fresh per test after setting argv.
async function runCli(argv: string[]): Promise<{ exitCode: number; stderr: string }> {
  const oldArgv = process.argv;
  const oldExit = process.exit;
  let exitCode: number | null = null;
  let stderr = '';
  process.argv = ['node', 'dev-oidc', ...argv];
  process.exit = ((code?: number) => {
    // Capture only the first exit attempt — `main().catch(...)` in the CLI
    // can re-enter `process.exit(1)` after the validation `process.exit(2)`
    // throws under our mock.
    if (exitCode === null) exitCode = code ?? 0;
    throw new Error(`__exit__:${code ?? 0}`);
  }) as never;
  const oldWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  // Swallow the unhandled rejection from `main().catch(...)` re-entering
  // the mocked `process.exit` — it's a test artifact, not a real crash.
  const onUnhandled = (reason: unknown): void => {
    if (reason instanceof Error && reason.message.startsWith('__exit__')) return;
    throw reason as Error;
  };
  process.on('unhandledRejection', onUnhandled);

  vi.resetModules();
  try {
    await import('@/cli.js');
    // Allow the top-level `main().catch(...)` chain to settle.
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

describe('CLI TLS flag validation', () => {
  it('exits 2 when --tls-cert is set without --tls-key', async () => {
    const { exitCode, stderr } = await runCli([
      'start',
      '--config',
      '/tmp/none.json',
      '--tls-cert',
      '/p/cert.pem',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/tls-cert and --tls-key must be paired/i);
  });

  it('exits 2 when --tls-key is set without --tls-cert', async () => {
    const { exitCode } = await runCli([
      'start',
      '--config',
      '/tmp/none.json',
      '--tls-key',
      '/p/key.pem',
    ]);
    expect(exitCode).toBe(2);
  });

  it('exits 2 when BYO mode is mixed with --tls-hostname', async () => {
    const { exitCode, stderr } = await runCli([
      'start',
      '--config',
      '/tmp/none.json',
      '--tls-cert',
      '/p/cert.pem',
      '--tls-key',
      '/p/key.pem',
      '--tls-hostname',
      'localhost',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/--tls-hostname is only valid in auto-mkcert mode/i);
  });
});
