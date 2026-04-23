import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import type { Config } from '@/config/schema.js';
import { createRuntimeConfig, type RuntimeConfig } from '@/config/runtime.js';
import { watchConfig, type ConfigWatcher } from '@/config/watcher.js';
import { buildDiscoveryDocument } from '@/oidc/discovery.js';
import { buildJwks } from '@/oidc/jwks.js';
import { createKeyMaterial, type KeyMaterial } from '@/oidc/keys.js';
import { createCodeStore, type CodeStore } from '@/oidc/codes.js';
import { createPendingAuthStore, type PendingAuthStore } from '@/oidc/pending.js';
import { createLogger, type DevOidcLogger } from '@/logger.js';
import { registerAuthorize } from '@/oidc/authorize.js';
import { registerComplete } from '@/oidc/complete.js';
import { registerToken } from '@/oidc/token.js';
import { registerLogout } from '@/oidc/logout.js';

export interface CreateServerOptions {
  config: Config;
  configFilePath?: string;
  logger?: DevOidcLogger;
}

export interface DevOidcServer {
  app: FastifyInstance;
  runtime: RuntimeConfig;
  keyMaterial: KeyMaterial;
  codes: CodeStore;
  pending: PendingAuthStore;
  close: () => Promise<void>;
}

export async function createDevOidcServer(options: CreateServerOptions): Promise<DevOidcServer> {
  const logger = options.logger ?? createLogger();
  const runtime = createRuntimeConfig(options.config);
  const keyMaterial = await createKeyMaterial(options.config.signingKey);
  const codes = createCodeStore({
    ttlMs: 60_000,
    refreshTtlMs: options.config.refreshTokenTtlSeconds * 1_000,
  });
  const pending = createPendingAuthStore({ ttlMs: 10 * 60_000 });

  const rawApp = Fastify({ loggerInstance: logger });
  // Cast to the default FastifyInstance type so that register helpers typed
  // against FastifyBaseLogger (the Fastify default) accept this instance.
  const app = rawApp as unknown as FastifyInstance;

  await app.register(formbody);

  app.get('/.well-known/openid-configuration', async () => {
    return buildDiscoveryDocument({ issuer: runtime.get().issuer });
  });

  app.get('/.well-known/jwks.json', async () => {
    return buildJwks(keyMaterial);
  });

  registerAuthorize(app, { runtime, pending });
  registerComplete(app, { runtime, pending, codes });
  registerToken(app, { runtime, codes, keyMaterial });
  registerLogout(app, { runtime });

  let watcher: ConfigWatcher | null = null;
  if (options.configFilePath) {
    watcher = await watchConfig(options.configFilePath, {
      onReload: (config) => {
        runtime.set(config);
        logger.info({ issuer: config.issuer }, 'config reloaded');
      },
      onError: (err) => logger.warn({ err }, 'config reload failed; keeping previous config'),
    });
  }

  return {
    app,
    runtime,
    keyMaterial,
    codes,
    pending,
    close: async () => {
      if (watcher) await watcher.close();
      await app.close();
    },
  };
}
