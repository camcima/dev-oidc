import type { Branding, Profile } from '@/config/schema.js';
import { Html, html, renderToString } from '@/shared/html.js';
import { STATIC_STYLES } from '@/login/styles.js';

export interface RenderLoginPageInput {
  pendingAuthId: string;
  profiles: readonly Profile[];
  branding: Branding;
  actionUrl: string;
}

export function renderLoginPage(input: RenderLoginPageInput): string {
  const { pendingAuthId, profiles, branding, actionUrl } = input;

  // prettier-ignore
  const tiles = profiles.map(
    (p) => html`<form class="tile" method="post" action="${actionUrl}">
      <input type="hidden" name="pendingAuthId" value="${pendingAuthId}" />
      <input type="hidden" name="profileId" value="${p.id}" />
      <button type="submit" class="tile">
        <div class="name">${p.displayName}</div>
        <div class="email">${p.email}</div>
      </button>
    </form>`,
  );

  const doc = html`<!doctype html>
    <html lang="en" style="--accent: ${branding.accentColor}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${branding.title}</title>
        <style>
          ${new Html(STATIC_STYLES)}
        </style>
      </head>
      <body>
        <h1>${branding.title}</h1>
        <div class="grid">${tiles}</div>
        <a class="admin-link" href="/admin">Manage profiles →</a>
      </body>
    </html>`;

  return renderToString(doc);
}
