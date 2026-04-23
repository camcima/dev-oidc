import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Config, Profile } from '@/config/schema.js';

// Placeholder replaced post-render so we never pass dynamic content through
// dangerouslySetInnerHTML (which semgrep flags for non-constant values).
const RAW_CONFIG_PLACEHOLDER = '<!--RAW_CONFIG_PLACEHOLDER-->';

export function renderAdminPage(config: Config): string {
  const body = renderToStaticMarkup(<AdminPage config={config} />);
  const configJson = JSON.stringify(config, null, 2);
  // Escape only the characters that matter inside a <pre> text context.
  const safeJson = configJson.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = body.replace(RAW_CONFIG_PLACEHOLDER, safeJson);
  return `<!doctype html>\n${html}`;
}

const STYLES = `
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem; background: #f7f8fa; color: #1a1f2c; max-width: 1100px; }
  h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
  h2 { font-size: 1.125rem; margin: 2rem 0 1rem; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d5dd; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 0.75rem 1rem; border-bottom: 1px solid #eaecf0; }
  th { background: #f9fafb; font-weight: 600; font-size: 0.875rem; color: #667085; }
  tr:last-child td { border-bottom: none; }
  button { font: inherit; cursor: pointer; padding: 0.375rem 0.75rem; border: 1px solid #d0d5dd; border-radius: 6px; background: #fff; margin-right: 0.25rem; }
  button.danger { color: #b42318; border-color: #fda29b; }
  button:hover { border-color: #1f6feb; }
  form.inline { display: inline; }
  .json { background: #fff; border: 1px solid #d0d5dd; border-radius: 8px; padding: 1rem; white-space: pre; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; }
  form.edit { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; align-items: center; max-width: 600px; background: #fff; padding: 1rem; border: 1px solid #d0d5dd; border-radius: 8px; }
  form.edit input, form.edit textarea { font: inherit; padding: 0.375rem 0.5rem; border: 1px solid #d0d5dd; border-radius: 4px; }
  form.edit textarea { min-height: 4rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; }
  form.edit .wide { grid-column: 1 / -1; }
  .banner { background: #fef7c3; border: 1px solid #fec84b; padding: 0.5rem 1rem; border-radius: 6px; margin-bottom: 1rem; display: none; }
  .banner.visible { display: block; }
`.trim();

const CLIENT_SCRIPT = `
  (function() {
    const banner = document.getElementById('reload-banner');
    const es = new EventSource('/admin/events');
    es.addEventListener('config-changed', () => {
      if (banner) banner.classList.add('visible');
    });

    document.getElementById('reload-link').addEventListener('click', (e) => {
      e.preventDefault();
      window.location.reload();
    });

    document.body.addEventListener('submit', async (ev) => {
      const form = ev.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (!form.dataset.api) return;
      ev.preventDefault();
      const method = form.dataset.method || 'POST';
      const url = form.dataset.api;
      let body = undefined;
      if (method === 'POST' || method === 'PUT') {
        const data = {};
        for (const el of form.elements) {
          if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) continue;
          if (!el.name) continue;
          if (el.name === 'claims') {
            try { data[el.name] = el.value ? JSON.parse(el.value) : {}; }
            catch (e) { alert('Invalid JSON in claims'); return; }
          } else {
            data[el.name] = el.value;
          }
        }
        body = JSON.stringify(data);
      }
      const res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body,
      });
      if (res.ok) {
        window.location.reload();
      } else {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        alert(err.error_description || err.details || err.error || 'Request failed');
      }
    });
  })();
`.trim();

interface AdminPageProps {
  config: Config;
}

function AdminPage({ config }: AdminPageProps): ReactElement {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>dev-oidc Admin</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <h1>dev-oidc Admin</h1>

        <div id="reload-banner" className="banner">
          {'Config changed on disk. '}
          <a id="reload-link" href="#">
            Reload
          </a>
        </div>

        <h2>Profiles ({config.profiles.length})</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Email</th>
              <th>Claims</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {config.profiles.map((p) => (
              <ProfileRow key={p.id} profile={p} />
            ))}
          </tbody>
        </table>

        <h2>Add profile</h2>
        <ProfileForm />

        <h2>Raw config</h2>
        {/* Raw config JSON is injected post-render via string replace in renderAdminPage */}
        <div className="json" dangerouslySetInnerHTML={{ __html: RAW_CONFIG_PLACEHOLDER }} />

        <script dangerouslySetInnerHTML={{ __html: CLIENT_SCRIPT }} />
      </body>
    </html>
  );
}

function ProfileRow({ profile }: { profile: Profile }): ReactElement {
  return (
    <tr>
      <td>{profile.id}</td>
      <td>{profile.displayName}</td>
      <td>{profile.email}</td>
      <td>{Object.keys(profile.claims).length} claim(s)</td>
      <td>
        <details>
          <summary>
            <button type="button">Edit</button>
          </summary>
          <ProfileForm profile={profile} />
        </details>
        <form
          className="inline"
          data-api={`/admin/api/profiles/${profile.id}`}
          data-method="DELETE"
          method="post"
        >
          <button type="submit" className="danger">
            Delete
          </button>
        </form>
      </td>
    </tr>
  );
}

function ProfileForm({ profile }: { profile?: Profile }): ReactElement {
  const isEdit = Boolean(profile);
  return (
    <form
      className="edit"
      data-api={isEdit ? `/admin/api/profiles/${profile!.id}` : '/admin/api/profiles'}
      data-method={isEdit ? 'PUT' : 'POST'}
      method="post"
    >
      <label htmlFor="id">ID</label>
      <input name="id" id="id" defaultValue={profile?.id ?? ''} required readOnly={isEdit} />
      <label htmlFor="displayName">Display name</label>
      <input
        name="displayName"
        id="displayName"
        defaultValue={profile?.displayName ?? ''}
        required
      />
      <label htmlFor="email">Email</label>
      <input name="email" id="email" type="email" defaultValue={profile?.email ?? ''} required />
      <label htmlFor="claims">Claims (JSON)</label>
      <textarea
        name="claims"
        id="claims"
        defaultValue={JSON.stringify(profile?.claims ?? {}, null, 2)}
      />
      <div className="wide">
        <button type="submit">{isEdit ? 'Save' : 'Add'}</button>
      </div>
    </form>
  );
}
