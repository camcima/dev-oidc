import { Html, html, renderToString } from '@/shared/html.js';
import type { ActiveTenantState } from '@/hub/tenant-state.js';

const STYLES = `
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0; padding: 2rem; background: #f7f8fa; color: #1a1f2c;
    max-width: 720px;
  }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  h2 { font-size: 1.125rem; margin: 1.75rem 0 0.5rem; }
  p { line-height: 1.5; }
  code { background: #eef0f3; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.95em; }
  ul { padding-left: 1.25rem; }
  li { margin: 0.25rem 0; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
`.trim();

export interface RenderIndexPageInput {
  tenant: ActiveTenantState;
  adminEnabled: boolean;
}

export function renderIndexPage(input: RenderIndexPageInput): string {
  const { tenant, adminEnabled } = input;
  const branding = tenant.runtime.get().branding;
  const adminLink = adminEnabled ? html`<li><a href="/admin">Admin UI</a></li>` : '';

  const doc = html`<!doctype html>
    <html lang="en" style="--accent: ${branding.accentColor}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${branding.title}</title>
        <style>
          ${new Html(STYLES)}
        </style>
      </head>
      <body>
        <h1>dev-oidc</h1>
        <p>Local OIDC provider running at <code>${tenant.issuer}</code>.</p>
        <h2>Endpoints</h2>
        <ul>
          <li><a href="/.well-known/openid-configuration">Discovery document</a></li>
          <li><a href="/.well-known/jwks.json">JWKS</a></li>
          ${adminLink}
        </ul>
        <h2>Start a login</h2>
        <p>
          Send a browser to
          <code
            >/authorize?client_id=...&amp;redirect_uri=...&amp;response_type=code&amp;code_challenge=...&amp;code_challenge_method=S256&amp;scope=openid</code
          >
          to begin the auth-code flow.
        </p>
      </body>
    </html>`;

  return renderToString(doc);
}
