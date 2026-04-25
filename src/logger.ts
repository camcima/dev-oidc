import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';

export type DevOidcLogger = FastifyBaseLogger;

export function createLogger(options?: { level?: string }): DevOidcLogger {
  return pino({
    level: options?.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { component: 'dev-oidc' },
  });
}
