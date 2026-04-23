import pino, { type Logger } from 'pino';

export type DevOidcLogger = Logger;

export function createLogger(options?: { level?: string }): DevOidcLogger {
  return pino({
    level: options?.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { component: 'dev-oidc' },
  });
}
