import { loadConfig } from '@/config/loader.js';
import { createDevOidcServer, type DevOidcServer } from '@/server.js';
import { formatHostPort, requirePublicUrlOrSafeHost, stripTrailingSlash } from '@/hub/issuer.js';
import { createLogger, type DevOidcLogger } from '@/logger.js';
import { loadTlsMaterial, type TlsMaterial } from '@/server/tls-loader.js';
import path from 'node:path';
import { defaultCertCacheDir, defaultTlsHostnames, expandTildePath } from '@/shared/paths.js';

export interface LegacyStartOptions {
  configPath: string;
  port: number;
  host: string;
  publicUrl?: string;
  logger?: DevOidcLogger;
  tls?: { mode: 'auto'; hostnames?: string[] } | { mode: 'byo'; cert: string; key: string };
}

export interface LegacyStartResult {
  server: DevOidcServer;
  port: number;
  host: string;
  issuer: string;
}

export async function startLegacy(options: LegacyStartOptions): Promise<LegacyStartResult> {
  const logger = options.logger ?? createLogger();
  requirePublicUrlOrSafeHost({ host: options.host, publicUrl: options.publicUrl });
  const config = await loadConfig(options.configPath);

  let tlsMaterial: TlsMaterial | undefined;
  if (options.tls) {
    const cwd = process.cwd();
    const resolveCliPath = (raw: string): string => {
      const expanded = expandTildePath(raw);
      return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
    };
    const tlsConfig =
      options.tls.mode === 'byo'
        ? {
            cert: resolveCliPath(options.tls.cert),
            key: resolveCliPath(options.tls.key),
          }
        : { hostnames: options.tls.hostnames };
    tlsMaterial = await loadTlsMaterial({
      config: tlsConfig,
      cacheDir: defaultCertCacheDir(),
      defaultHostnames: defaultTlsHostnames(options.host, options.publicUrl),
    });
  }

  const scheme = tlsMaterial ? 'https' : 'http';
  const issuer = stripTrailingSlash(
    options.publicUrl ?? `${scheme}://${formatHostPort(options.host, options.port)}`,
  );
  const server = await createDevOidcServer({
    config,
    configFilePath: options.configPath,
    issuer,
    listenHost: options.host,
    listenPort: options.port,
    publicUrl: options.publicUrl,
    logger,
    tls: tlsMaterial,
  });
  await server.app.listen({ port: options.port, host: options.host });
  return { server, port: options.port, host: options.host, issuer };
}
