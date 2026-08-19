import type { Config } from '@/config/schema.js';

/**
 * dev-oidc is a local development tool, so CORS is scoped to origins that a
 * local setup can legitimately use rather than reflecting every Origin.
 * Reflecting any origin let an arbitrary website drive a full authorization
 * flow against the developer's machine and read the resulting tokens.
 */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // URL normalises IPv6 hostnames to bracketed form.
  if (host === '[::1]' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Origins a relying party may legitimately call from: anything the config
 * already names as a redirect target (which covers LAN and custom-domain
 * setups without extra configuration) plus the advertised public URL.
 */
export function configuredOrigins(configs: Iterable<Config>, publicUrl?: string): Set<string> {
  const origins = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value === undefined) return;
    const origin = originOf(value);
    if (origin !== null) origins.add(origin);
  };
  add(publicUrl);
  for (const config of configs) {
    for (const client of config.clients) {
      for (const uri of client.redirectUris) add(uri);
      for (const uri of client.postLogoutRedirectUris) add(uri);
    }
  }
  return origins;
}

export type CorsOriginDelegate = (
  origin: string | undefined,
  callback: (error: Error | null, allow: boolean) => void,
) => void;

/**
 * Builds the @fastify/cors `origin` delegate. `extraOrigins` is consulted per
 * request so a hot-reloaded config (or a newly registered tenant) takes effect
 * without a restart.
 */
export function createCorsOriginDelegate(extraOrigins: () => Set<string>): CorsOriginDelegate {
  return (origin, callback) => {
    // No Origin header: a non-browser client (curl, a server-side token
    // exchange) or a same-origin navigation. Nothing to authorise.
    if (origin === undefined || origin === '') {
      callback(null, true);
      return;
    }
    callback(null, isLoopbackOrigin(origin) || extraOrigins().has(origin));
  };
}
