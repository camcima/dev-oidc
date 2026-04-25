import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isBindAllHost } from '@/hub/issuer.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Normalize an HTTP `Host` header (or URL `host`) by stripping the default
 * HTTP/HTTPS ports per RFC 7230. `localhost:80` and `localhost` are
 * equivalent identifiers for the same authority on plain HTTP.
 */
function normalizeHostHeader(host: string): string {
  if (host.endsWith(':80')) return host.slice(0, -3);
  if (host.endsWith(':443')) return host.slice(0, -4);
  return host;
}

export interface BuildAllowedHostsInput {
  listenHost: string;
  listenPort: number;
  publicUrl?: string | undefined;
}

/**
 * Builds the set of acceptable values for the HTTP `Host` header on admin
 * routes. Used to defend against DNS rebinding: an attacker's page resolves
 * a malicious hostname to 127.0.0.1, but the Host header carries that
 * hostname and gets rejected here.
 */
export function buildAdminAllowedHosts(input: BuildAllowedHostsInput): Set<string> {
  const allowed = new Set<string>();
  const portSuffix = `:${input.listenPort.toString()}`;

  if (!isBindAllHost(input.listenHost)) {
    allowed.add(`${input.listenHost}${portSuffix}`);
    allowed.add(input.listenHost);
  }
  if (isLoopbackHost(input.listenHost) || isBindAllHost(input.listenHost)) {
    for (const lb of LOOPBACK_HOSTS) {
      allowed.add(`${lb}${portSuffix}`);
      allowed.add(lb);
    }
  }
  if (input.publicUrl) {
    const url = safeParseUrl(input.publicUrl);
    if (url) {
      allowed.add(url.host);
      allowed.add(url.hostname);
    }
  }
  return allowed;
}

export interface AdminGuardOptions {
  allowedHosts: Set<string>;
}

/**
 * Registers an `onRequest` hook that protects `/admin` and `/admin/...`
 * routes from cross-origin attacks.
 *
 * - DNS rebinding: requires `Host` to be in `allowedHosts`.
 * - CSRF: rejects requests where `Sec-Fetch-Site` is cross-site/same-site,
 *   or where `Origin`/`Referer` is present and does not match the request's
 *   own host. (Same-origin requests, and same-server tools that do not send
 *   `Origin` like curl, are allowed.)
 *
 * OIDC routes (discovery, jwks, authorize, token, logout) are intentionally
 * not protected — RP SPAs need cross-origin access to them.
 */
export function registerAdminGuard(app: FastifyInstance, options: AdminGuardOptions): void {
  const { allowedHosts } = options;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const url = req.url;
    // Match exactly /admin and the /admin/<...> subtree only. Earlier
    // implementations used `startsWith('/admin')` which would also match
    // sibling paths like `/administer` or `/admin-foo`.
    const isAdminPath = url === '/admin' || url.startsWith('/admin/') || url.startsWith('/admin?');
    if (!isAdminPath) return;

    const host = req.headers.host;
    if (!host || !allowedHosts.has(normalizeHostHeader(host))) {
      void reply
        .code(403)
        .send({ error: 'forbidden', error_description: 'host header not allowed' });
      return;
    }

    const fetchSite = req.headers['sec-fetch-site'];
    if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      void reply
        .code(403)
        .send({ error: 'forbidden', error_description: 'cross-site request rejected' });
      return;
    }

    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const claimed = origin ?? (typeof referer === 'string' ? safeParseUrl(referer)?.origin : null);
    if (claimed) {
      const claimedUrl = safeParseUrl(claimed);
      const claimedHost = claimedUrl?.host;
      if (!claimedHost || !allowedHosts.has(normalizeHostHeader(claimedHost))) {
        void reply.code(403).send({ error: 'forbidden', error_description: 'origin not allowed' });
        return;
      }
    }
  });
}
