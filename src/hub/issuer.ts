export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function computeIssuer(input: { publicUrl: string; slug: string }): string {
  return `${stripTrailingSlash(input.publicUrl)}/${input.slug}`;
}

const BIND_ALL_HOSTS = new Set(['0.0.0.0', '::', '0::', '[::]', '[::0]', '0:0:0:0:0:0:0:0']);

export function isBindAllHost(host: string): boolean {
  return BIND_ALL_HOSTS.has(host);
}

export function deriveDefaultPublicUrl(input: {
  host: string;
  port: number;
  tlsEnabled?: boolean;
}): string {
  const scheme = input.tlsEnabled ? 'https' : 'http';
  return `${scheme}://${input.host}:${input.port}`;
}

/**
 * Picks the host:port to use in the HTTPS redirect Location header.
 *
 * The HTTP→HTTPS hook fires before any host validation (OIDC routes are
 * intentionally not host-checked because relying parties hit them
 * cross-origin). Echoing `req.host` directly would let an attacker send a
 * Host header of `evil.com:443` and walk away with a `Location:
 * https://evil.com:443/...` response — open-redirect-shaped behavior, even
 * though dev-oidc is normally only reachable on a developer's loopback.
 *
 * Strategy:
 *   - If the request's Host header matches the configured publicUrl host or
 *     the listen host:port, echo it (preserves operator-chosen aliases like
 *     `idp.example.test:8095`).
 *   - Otherwise, fall back to the publicUrl host or listenHost:listenPort —
 *     values dev-oidc owns and trusts.
 */
export function pickRedirectHost(input: {
  requestHost: string | undefined;
  publicUrl: string | undefined;
  listenHost: string;
  listenPort: number;
}): string {
  const allowed = new Set<string>();
  const portSuffix = `:${input.listenPort.toString()}`;
  if (!isBindAllHost(input.listenHost)) {
    allowed.add(`${input.listenHost}${portSuffix}`);
    allowed.add(input.listenHost);
  }
  let publicHost: string | undefined;
  if (input.publicUrl) {
    try {
      const u = new URL(input.publicUrl);
      publicHost = u.host;
      allowed.add(u.host);
      allowed.add(u.hostname);
    } catch {
      // ignore unparseable publicUrl
    }
  }
  if (input.requestHost && allowed.has(input.requestHost)) {
    return input.requestHost;
  }
  if (publicHost) return publicHost;
  return isBindAllHost(input.listenHost)
    ? `127.0.0.1${portSuffix}`
    : `${input.listenHost}${portSuffix}`;
}

/**
 * If the user binds to all interfaces (0.0.0.0 / ::) without setting an
 * explicit publicUrl, the issuer would advertise an unreachable address and
 * relying parties would fail token verification (issuer mismatch). Refuse to
 * start with a clear error.
 */
export function requirePublicUrlOrSafeHost(input: { host: string; publicUrl?: string }): void {
  if (input.publicUrl) return;
  if (isBindAllHost(input.host)) {
    throw new Error(
      `dev-oidc: refusing to start with host "${input.host}" and no publicUrl. ` +
        `An issuer of "http://${input.host}:<port>/..." is not reachable by relying parties. ` +
        `Set --public-url <url> (legacy) or server.publicUrl in hub.json (hub mode).`,
    );
  }
}
