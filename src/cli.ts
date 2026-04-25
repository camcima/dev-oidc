#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startLegacy } from '@/cli/legacy.js';
import { createLogger } from '@/logger.js';

const HELP = [
  'dev-oidc — a minimal OIDC provider for local development',
  '',
  'Usage:',
  '  dev-oidc start [--config <path>] [options]',
  '  dev-oidc register <project-config-path> [--slug <name>]',
  '  dev-oidc unregister <slug>',
  '  dev-oidc list [--json]',
  '',
  'Options for `start --config`:',
  '  -c, --config <path>      Path to a project config (legacy single-tenant mode).',
  '      --port <number>      Listen port (default 8095).',
  '      --host <ip>          Listen host (default 127.0.0.1).',
  '      --public-url <url>   Issuer URL advertised in discovery (default http://host:port).',
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
    // Phase 4 wires `register`/`unregister`/`list` here. Stub for now:
    case 'register':
    case 'unregister':
    case 'list':
      process.stderr.write(`dev-oidc: ${subcommand} not yet implemented\n`);
      process.exit(2);
      break;
    default:
      process.stdout.write(HELP);
      process.exit(1);
  }
}

async function runStart(
  values: Record<string, string | boolean | undefined>,
  _positionals: string[],
): Promise<void> {
  const logger = createLogger();
  if (values.config) {
    if (typeof values.config !== 'string') {
      process.stderr.write('dev-oidc: --config requires a path\n');
      process.exit(1);
    }
    const port = Number.parseInt((values.port as string) ?? '8095', 10);
    const host = (values.host as string) ?? '127.0.0.1';
    const publicUrl = values['public-url'] as string | undefined;
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
      process.stderr.write('dev-oidc: --port must be a valid port number\n');
      process.exit(1);
    }
    const result = await startLegacy({
      configPath: values.config,
      port,
      host,
      publicUrl: typeof publicUrl === 'string' ? publicUrl : undefined,
      logger,
    });
    logger.info(
      { issuer: result.issuer, port: result.port, host: result.host },
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
  logger.error({ err }, 'dev-oidc failed to start');
  process.exit(1);
});
