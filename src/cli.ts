#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from '@/config/loader.js';
import { createDevOidcServer } from '@/server.js';
import { createLogger } from '@/logger.js';

const DEFAULT_PORT = 8095;
const DEFAULT_HOST = '127.0.0.1';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      port: { type: 'string' },
      host: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || positionals[0] !== 'start' || !values.config) {
    process.stdout.write(
      [
        'dev-oidc — a minimal OIDC provider for local development',
        '',
        'Usage:',
        '  dev-oidc start --config <path-to-config.json> [--port <port>] [--host <host>]',
        '',
        'Options:',
        '  -c, --config <path>  Path to the JSON config file (required).',
        '      --port <number>  Listen port (default 8095).',
        '      --host <ip>      Listen host (default 127.0.0.1).',
        '  -h, --help           Show this help.',
        '',
      ].join('\n'),
    );
    process.exit(values.help ? 0 : 1);
  }

  const port = Number.parseInt((values.port as string) ?? String(DEFAULT_PORT), 10);
  const host = (values.host as string) ?? DEFAULT_HOST;
  const issuer = `http://${host}:${port}`;

  const logger = createLogger();
  const config = await loadConfig(values.config);
  const server = await createDevOidcServer({
    config,
    configFilePath: values.config,
    issuer,
    logger,
  });

  await server.app.listen({ port, host });
  logger.info({ issuer, port, host }, 'dev-oidc listening');

  const shutdown = async (): Promise<void> => {
    logger.info('dev-oidc shutting down');
    await server.close();
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
