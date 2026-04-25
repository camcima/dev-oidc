import type { Config, Profile } from '@/config/schema.js';
import { Html, html, renderToString } from '@/shared/html.js';

const STYLES = `
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem; background: #f7f8fa; color: #1a1f2c; max-width: 1100px; }
  h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
  h2 { font-size: 1.125rem; margin: 2rem 0 1rem; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d5dd; border-radius: 8px; overflow: hidden; }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin: 2rem 0 1rem; }
  .section-head h2 { margin: 0; }
  .primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .primary:hover { background: #155ac7; border-color: #155ac7; }
  th, td { text-align: left; padding: 0.75rem 1rem; border-bottom: 1px solid #eaecf0; vertical-align: middle; }
  th { background: #f9fafb; font-weight: 600; font-size: 0.875rem; color: #667085; }
  tr:last-child td { border-bottom: none; }
  button { font: inherit; cursor: pointer; padding: 0.375rem 0.75rem; border: 1px solid #d0d5dd; border-radius: 6px; background: #fff; }
  button.danger { color: #b42318; border-color: #fda29b; }
  button:hover { border-color: #1f6feb; }
  .actions { display: flex; gap: 0.5rem; align-items: center; }
  .actions form { margin: 0; }
  .json { background: #fff; border: 1px solid #d0d5dd; border-radius: 8px; padding: 1rem; white-space: pre; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; }
  form.edit { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; align-items: center; max-width: 600px; background: #fff; padding: 1rem; border: 1px solid #d0d5dd; border-radius: 8px; }
  form.edit input, form.edit textarea { font: inherit; padding: 0.375rem 0.5rem; border: 1px solid #d0d5dd; border-radius: 4px; }
  form.edit textarea { min-height: 4rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; }
  form.edit .wide { grid-column: 1 / -1; display: flex; gap: 0.5rem; justify-content: flex-end; }
  .banner { background: #fef7c3; border: 1px solid #fec84b; padding: 0.5rem 1rem; border-radius: 6px; margin-bottom: 1rem; display: none; }
  .banner.visible { display: block; }
  dialog.edit-dialog { border: 1px solid #d0d5dd; border-radius: 10px; padding: 0; background: #fff; max-width: 640px; width: calc(100vw - 2rem); box-shadow: 0 10px 40px rgba(16, 24, 40, 0.18); }
  dialog.edit-dialog::backdrop { background: rgba(16, 24, 40, 0.45); }
  dialog.edit-dialog .dialog-head { display: flex; align-items: center; justify-content: space-between; padding: 0.875rem 1.125rem; border-bottom: 1px solid #eaecf0; }
  dialog.edit-dialog .dialog-head h3 { margin: 0; font-size: 1rem; font-weight: 600; }
  dialog.edit-dialog form.edit { border: none; border-radius: 0; max-width: none; padding: 1rem 1.125rem; }
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

    document.body.addEventListener('click', (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;

      const edit = target.closest('[data-edit-dialog]');
      if (edit instanceof HTMLElement) {
        const id = edit.dataset.editDialog;
        const dialog = id ? document.getElementById('edit-dialog-' + id) : null;
        if (dialog instanceof HTMLDialogElement) dialog.showModal();
        return;
      }

      const opener = target.closest('[data-open-dialog]');
      if (opener instanceof HTMLElement) {
        const id = opener.dataset.openDialog;
        const dialog = id ? document.getElementById(id) : null;
        if (dialog instanceof HTMLDialogElement) dialog.showModal();
        return;
      }

      const closer = target.closest('[data-dialog-close]');
      if (closer instanceof HTMLElement) {
        const dialog = closer.closest('dialog');
        if (dialog instanceof HTMLDialogElement) dialog.close();
      }
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
  })()
`.trim();

// nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
const SAFE_STYLES = new Html(STYLES); // module-level const string literal, never externally controlled
// nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
const SAFE_CLIENT_SCRIPT = new Html(CLIENT_SCRIPT); // module-level const string literal, never externally controlled

function profileEditForm(profile: Profile, apiBase: string): Html {
  const claimsJson = JSON.stringify(profile.claims, null, 2);
  return html`<form
    class="edit"
    data-api="${apiBase}/${profile.id}"
    data-method="PUT"
    method="post"
  >
    <label for="id-${profile.id}">ID</label>
    <input name="id" id="id-${profile.id}" value="${profile.id}" required readonly />
    <label for="displayName-${profile.id}">Display name</label>
    <input
      name="displayName"
      id="displayName-${profile.id}"
      value="${profile.displayName}"
      required
    />
    <label for="email-${profile.id}">Email</label>
    <input name="email" id="email-${profile.id}" type="email" value="${profile.email}" required />
    <label for="claims-${profile.id}">Claims (JSON)</label>
    <textarea name="claims" id="claims-${profile.id}">${claimsJson}</textarea>
    <div class="wide">
      <button type="button" data-dialog-close>Cancel</button>
      <button type="submit">Save</button>
    </div>
  </form>`;
}

function profileAddForm(apiBase: string): Html {
  return html`<form class="edit" data-api="${apiBase}" data-method="POST" method="post">
    <label for="id-new">ID</label>
    <input name="id" id="id-new" value="" required />
    <label for="displayName-new">Display name</label>
    <input name="displayName" id="displayName-new" value="" required />
    <label for="email-new">Email</label>
    <input name="email" id="email-new" type="email" value="" required />
    <label for="claims-new">Claims (JSON)</label>
    <textarea name="claims" id="claims-new">{}</textarea>
    <div class="wide">
      <button type="button" data-dialog-close>Cancel</button>
      <button type="submit">Add</button>
    </div>
  </form>`;
}

function profileRow(profile: Profile, apiBase: string): Html {
  const claimsCount = Object.keys(profile.claims).length;
  return html`<tr>
    <td>${profile.id}</td>
    <td>${profile.displayName}</td>
    <td>${profile.email}</td>
    <td>${claimsCount} claim(s)</td>
    <td>
      <div class="actions">
        <button type="button" data-edit-dialog="${profile.id}">Edit</button>
        <form data-api="${apiBase}/${profile.id}" data-method="DELETE" method="post">
          <button type="submit" class="danger">Delete</button>
        </form>
      </div>
      <dialog id="edit-dialog-${profile.id}" class="edit-dialog">
        <div class="dialog-head">
          <h3>Edit profile — ${profile.displayName}</h3>
          <button type="button" data-dialog-close aria-label="Close">✕</button>
        </div>
        ${profileEditForm(profile, apiBase)}
      </dialog>
    </td>
  </tr>`;
}

export interface RenderAdminPageInput {
  config: Config;
  slug: string;
}

export function renderAdminPage(input: RenderAdminPageInput): string {
  const config = input.config;
  const apiBase =
    input.slug === '(legacy)' ? '/admin/api/profiles' : `/admin/api/${input.slug}/profiles`;
  // The raw-config dump sits inside a <div> element body. Quotes are not
  // dangerous in element-text context, only in attribute values. Standard
  // escape would convert " to &quot;, which is correct but visually noisy
  // for a JSON dump. Escape only the chars that break out of element-text.
  const configJson = JSON.stringify(config, null, 2);
  const safeJson = configJson.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
  const safeJsonHtml = new Html(safeJson); // escapes &, <, > — safe for element-text context

  const doc = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>dev-oidc Admin</title>
        <style>
          ${SAFE_STYLES}
        </style>
      </head>
      <body>
        <h1>dev-oidc Admin</h1>
        <div id="reload-banner" class="banner">
          Config changed on disk. <a id="reload-link" href="#">Reload</a>
        </div>

        <div class="section-head">
          <h2>Profiles (${config.profiles.length})</h2>
          <button type="button" class="primary" data-open-dialog="add-dialog">Add profile</button>
        </div>
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
            ${config.profiles.map((p) => profileRow(p, apiBase))}
          </tbody>
        </table>

        <dialog id="add-dialog" class="edit-dialog">
          <div class="dialog-head">
            <h3>Add profile</h3>
            <button type="button" data-dialog-close aria-label="Close">✕</button>
          </div>
          ${profileAddForm(apiBase)}
        </dialog>

        <h2>Raw config</h2>
        <div class="json">${safeJsonHtml}</div>

        <script>
          ${SAFE_CLIENT_SCRIPT};
        </script>
      </body>
    </html>`;

  return renderToString(doc);
}
