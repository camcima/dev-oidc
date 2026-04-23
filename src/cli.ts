#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from '@/config/loader.js';
import { createDevOidcServer } from '@/server.js';
import { createLogger } from '@/logger.js';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || positionals[0] !== 'start' || !values.config) {
    process.stdout.write(
      [
        'dev-oidc — a minimal OIDC provider for local development',
        '',
        'Usage:',
        '  dev-oidc start --config <path-to-config.json>',
        '',
        'Options:',
        '  -c, --config <path>  Path to the JSON config file (required).',
        '  -h, --help           Show this help.',
        '',
      ].join('\n'),
    );
    process.exit(values.help ? 0 : 1);
  }

  const logger = createLogger();
  const config = await loadConfig(values.config);
  const server = await createDevOidcServer({
    config,
    configFilePath: values.config,
    logger,
  });

  await server.app.listen({ port: config.port, host: config.host });
  logger.info(
    { issuer: config.issuer, port: config.port, host: config.host },
    'dev-oidc listening',
  );

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
