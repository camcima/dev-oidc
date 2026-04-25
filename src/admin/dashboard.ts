import { Html, html, renderToString } from '@/shared/html.js';

export interface DashboardTenant {
  slug: string;
  status: 'active' | 'error';
  issuer: string | null;
  configPath: string;
  profileCount: number | null;
  lastError: string | null;
}

export interface RenderHubDashboardInput {
  publicUrl: string;
  tenants: readonly DashboardTenant[];
}

const STYLES = `
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem; background: #f7f8fa; color: #1a1f2c; max-width: 1100px; }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d5dd; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 0.75rem 1rem; border-bottom: 1px solid #eaecf0; vertical-align: middle; font-size: 0.95rem; }
  th { background: #f9fafb; font-weight: 600; font-size: 0.875rem; color: #667085; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .pill.active { background: #dcfae6; color: #027a48; }
  .pill.error { background: #fee4e2; color: #b42318; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: #eef0f3; padding: 0.1em 0.35em; border-radius: 4px; }
  details summary { cursor: pointer; color: #b42318; }
  .empty { background: #fff; border: 1px solid #d0d5dd; border-radius: 8px; padding: 2rem; text-align: center; color: #667085; }
`.trim();

// nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
const SAFE_STYLES = new Html(STYLES); // module-level const string literal, never externally controlled

const CLIENT_SCRIPT = `
  (function() {
    const es = new EventSource('/admin/events');
    es.addEventListener('config-changed', function() { window.location.reload(); });
  })();
`.trim();

// nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
const SAFE_CLIENT_SCRIPT = new Html(CLIENT_SCRIPT); // module-level const string literal, never externally controlled

export function renderHubDashboard(input: RenderHubDashboardInput): string {
  const rows = input.tenants.map((t) => {
    const statusPill =
      t.status === 'active'
        ? html`<span class="pill active">Active</span>`
        : html`<span class="pill error">Error</span>`;
    const issuerCell = t.issuer
      ? html`<a href="/${t.slug}/.well-known/openid-configuration"><code>${t.issuer}</code></a>`
      : '—';
    const profilesCell = t.profileCount === null ? '—' : String(t.profileCount);
    const errorBlock = t.lastError
      ? html`<details>
          <summary>Show error</summary>
          <pre>${t.lastError}</pre>
        </details>`
      : '';
    return html`<tr>
      <td><code>${t.slug}</code></td>
      <td>${statusPill}</td>
      <td>${issuerCell}</td>
      <td>${profilesCell}</td>
      <td><code title="${t.configPath}">${truncate(t.configPath, 60)}</code> ${errorBlock}</td>
      <td>${t.status === 'active' ? html`<a href="/admin/${t.slug}">Manage →</a>` : ''}</td>
    </tr>`;
  });

  const body =
    input.tenants.length === 0
      ? html`<div class="empty">
          <p>No tenants registered.</p>
          <p>
            Run <code>dev-oidc register &lt;path-to-dev-oidc.config.json&gt;</code> to mount one.
          </p>
        </div>`
      : html`<table>
          <thead>
            <tr>
              <th>Slug</th>
              <th>Status</th>
              <th>Issuer</th>
              <th>Profiles</th>
              <th>Config path</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>`;

  const doc = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>dev-oidc Hub</title>
        <style>
          ${SAFE_STYLES}
        </style>
      </head>
      <body>
        <h1>dev-oidc — Hub</h1>
        <p>Public URL: <code>${input.publicUrl}</code></p>
        ${body}
        <script>
          ${SAFE_CLIENT_SCRIPT};
        </script>
      </body>
    </html>`;
  return renderToString(doc);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - (max - 1));
}
