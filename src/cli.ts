#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startLegacy, type LegacyStartOptions } from '@/cli/legacy.js';
import { runList, runRegister, runUnregister } from '@/cli/hub-commands.js';
import { defaultHubConfigPath } from '@/hub/loader.js';
import { createLogger } from '@/logger.js';
import { TlsConfigurationError } from '@/server/tls-loader.js';

const HELP = [
  'dev-oidc — a minimal OIDC provider for local development',
  '',
  'Usage:',
  '  dev-oidc start [--config <path>] [options]',
  '  dev-oidc register <project-dir-or-config-path> [--slug <name>]',
  '  dev-oidc unregister <slug>',
  '  dev-oidc list [--json]',
  '',
  'Options for `start --config`:',
  '  -c, --config <path>      Path to a project config (legacy single-tenant mode).',
  '      --port <number>      Listen port (default 8095).',
  '      --host <ip>          Listen host (default 127.0.0.1).',
  '      --public-url <url>   Issuer URL advertised in discovery (default http://host:port).',
  '                           Falls back to DEV_OIDC_PUBLIC_URL if the flag is omitted.',
  '',
  'TLS options (legacy mode; mirror server.tls in hub.json for hub mode):',
  '      --tls                  Enable HTTPS with auto-mkcert provisioning.',
  '      --tls-hostname <host>  Append a SAN; repeatable. Implies --tls.',
  '      --tls-cert <path>      BYO cert file (absolute, CWD-relative, or ~/-relative path).',
  '                             Must pair with --tls-key. Implies --tls.',
  '      --tls-key <path>       BYO key file. Must pair with --tls-cert.',
  '',
  'Hub options (run without --config):',
  '      --hub-config <path>  Hub config path (default ~/.config/dev-oidc/hub.json).',
  '',
  '  -h, --help               Show this help.',
  '',
].join('\n');

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      port: { type: 'string' },
      host: { type: 'string' },
      'public-url': { type: 'string' },
      'hub-config': { type: 'string' },
      slug: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      tls: { type: 'boolean' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      'tls-hostname': { type: 'string', multiple: true },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const subcommand = positionals[0];

  switch (subcommand) {
    case 'start':
      await runStart(values, positionals);
      break;
    case 'register': {
      const target = positionals[1];
      if (!target) {
        process.stderr.write('dev-oidc: register requires a path argument\n');
        process.exit(1);
      }
      const hubConfigPath =
        typeof values['hub-config'] === 'string' ? values['hub-config'] : defaultHubConfigPath();
      const result = await runRegister({
        hubConfigPath,
        configPathArg: target,
        slug: typeof values.slug === 'string' ? values.slug : undefined,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
      break;
    }
    case 'unregister': {
      const slug = positionals[1];
      if (!slug) {
        process.stderr.write('dev-oidc: unregister requires a slug\n');
        process.exit(1);
      }
      const hubConfigPath =
        typeof values['hub-config'] === 'string' ? values['hub-config'] : defaultHubConfigPath();
      const result = await runUnregister({ hubConfigPath, slug });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
      break;
    }
    case 'list': {
      const hubConfigPath =
        typeof values['hub-config'] === 'string' ? values['hub-config'] : defaultHubConfigPath();
      const result = await runList({ hubConfigPath, json: values.json === true });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
      break;
    }
    default:
      process.stdout.write(HELP);
      process.exit(1);
  }
}

async function runStart(
  values: Record<string, string | boolean | string[] | undefined>,
  _positionals: string[],
): Promise<void> {
  const logger = createLogger();
  if (values.config) {
    if (typeof values.config !== 'string') {
      process.stderr.write('dev-oidc: --config requires a path\n');
      process.exit(1);
    }
    const portRaw = typeof values.port === 'string' ? values.port : '8095';
    const port = Number.parseInt(portRaw, 10);
    const host = typeof values.host === 'string' ? values.host : '127.0.0.1';
    // --public-url has the highest priority. Fall back to DEV_OIDC_PUBLIC_URL
    // so the published Docker image (which sets that env var to a sane
    // default) can boot with `--host 0.0.0.0` without an explicit flag.
    const publicUrl =
      typeof values['public-url'] === 'string'
        ? values['public-url']
        : process.env.DEV_OIDC_PUBLIC_URL?.trim() || undefined;
    // Port 0 would bind an ephemeral port while the issuer still advertised
    // ":0", so relying parties could never reach it. Reject rather than
    // silently publish an unusable issuer.
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      process.stderr.write('dev-oidc: --port must be a valid port number\n');
      process.exit(1);
    }

    const tlsCert = typeof values['tls-cert'] === 'string' ? values['tls-cert'] : undefined;
    const tlsKey = typeof values['tls-key'] === 'string' ? values['tls-key'] : undefined;
    const tlsHostnames = Array.isArray(values['tls-hostname'])
      ? (values['tls-hostname'] as string[])
      : undefined;
    const tlsFlag = values.tls === true;

    if ((tlsCert && !tlsKey) || (tlsKey && !tlsCert)) {
      process.stderr.write(
        'dev-oidc: --tls-cert and --tls-key must be paired (both set or both omitted)\n',
      );
      process.exit(2);
    }
    if (tlsCert && tlsKey && tlsHostnames !== undefined) {
      process.stderr.write(
        'dev-oidc: --tls-hostname is only valid in auto-mkcert mode (when --tls-cert/--tls-key are not set)\n',
      );
      process.exit(2);
    }

    const tls: LegacyStartOptions['tls'] | undefined =
      tlsCert && tlsKey
        ? { mode: 'byo', cert: tlsCert, key: tlsKey }
        : tlsFlag || tlsHostnames !== undefined
          ? { mode: 'auto', hostnames: tlsHostnames }
          : undefined;

    const result = await startLegacy({
      configPath: values.config,
      port,
      host,
      publicUrl,
      logger,
      tls,
    });
    logger.info(
      { issuer: result.issuer, port: result.port, host: result.host, tls: tls !== undefined },
      'dev-oidc listening (legacy)',
    );
    setupShutdown(result.server.close, logger);
    return;
  }

  // Hub mode
  const { createHubServer } = await import('@/hub/server.js');
  const { defaultHubConfigPath } = await import('@/hub/loader.js');
  const hubConfigPath =
    typeof values['hub-config'] === 'string' ? values['hub-config'] : defaultHubConfigPath();
  const server = await createHubServer({ hubConfigPath, logger });
  const { host, port } = server.hubConfig.server;
  await server.app.listen({ port, host });
  logger.info(
    {
      publicUrl: server.hubConfig.server.publicUrl ?? `http://${host}:${port}`,
      port,
      host,
      tenants: server.registry.list().length,
    },
    'dev-oidc listening (hub)',
  );
  setupShutdown(server.close, logger);
}

function setupShutdown(close: () => Promise<void>, logger: ReturnType<typeof createLogger>): void {
  const shutdown = async (): Promise<void> => {
    logger.info('dev-oidc shutting down');
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  const logger = createLogger();
  if (err instanceof TlsConfigurationError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  // `runStart` (legacy + hub) is the only path that can throw past `main()`
  // — register/unregister/list always return a CommandResult. Anything that
  // gets here is a server-startup failure.
  logger.error({ err }, 'dev-oidc failed to start');
  process.exit(1);
});
