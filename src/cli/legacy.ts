// src/cli/legacy.ts
import { loadConfig } from '@/config/loader.js';
import { createDevOidcServer, type DevOidcServer } from '@/server.js';
import { requirePublicUrlOrSafeHost } from '@/hub/issuer.js';
import { createLogger, type DevOidcLogger } from '@/logger.js';

export interface LegacyStartOptions {
  configPath: string;
  port: number;
  host: string;
  publicUrl?: string;
  logger?: DevOidcLogger;
}

export interface LegacyStartResult {
  server: DevOidcServer;
  port: number;
  host: string;
  issuer: string;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function startLegacy(options: LegacyStartOptions): Promise<LegacyStartResult> {
  const logger = options.logger ?? createLogger();
  requirePublicUrlOrSafeHost({ host: options.host, publicUrl: options.publicUrl });
  const config = await loadConfig(options.configPath);
  const issuer = stripTrailingSlash(options.publicUrl ?? `http://${options.host}:${options.port}`);
  const server = await createDevOidcServer({
    config,
    configFilePath: options.configPath,
    issuer,
    listenHost: options.host,
    listenPort: options.port,
    publicUrl: options.publicUrl,
    logger,
  });
  await server.app.listen({ port: options.port, host: options.host });
  return { server, port: options.port, host: options.host, issuer };
}
