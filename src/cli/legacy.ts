import { loadConfig } from '@/config/loader.js';
import { createDevOidcServer, type DevOidcServer } from '@/server.js';
import { formatHostPort, requirePublicUrlOrSafeHost, stripTrailingSlash } from '@/hub/issuer.js';
import { createLogger, type DevOidcLogger } from '@/logger.js';
import { loadTlsMaterial, type TlsMaterial } from '@/server/tls-loader.js';
import path from 'node:path';
import os from 'node:os';

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

function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const root = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), '.cache');
  return path.join(root, 'dev-oidc', 'certs');
}

/**
 * Expand a leading `~/` to the user's home directory. Node's `fs` does not
 * interpret tildes (the shell normally does), so a path like
 * `~/certs/dev-oidc.pem` typed into the CLI or hub.json would otherwise be
 * read as a literal `./~/certs/dev-oidc.pem` and fail with ENOENT.
 */
export function expandTildePath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function buildDefaultHostnames(input: { host: string; publicUrl?: string }): string[] {
  const set = new Set<string>([input.host, 'localhost']);
  if (input.publicUrl) {
    try {
      const u = new URL(input.publicUrl);
      if (u.hostname) set.add(u.hostname);
    } catch {
      // ignore
    }
  }
  return [...set];
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
      cacheDir: defaultCacheDir(),
      defaultHostnames: buildDefaultHostnames({ host: options.host, publicUrl: options.publicUrl }),
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
