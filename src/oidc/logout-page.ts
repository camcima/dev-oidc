import type { Branding } from '@/config/schema.js';
import { Html, html, renderToString } from '@/shared/html.js';

const STYLES = `
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0; padding: 2rem; background: #f7f8fa; color: #1a1f2c;
    display: flex; flex-direction: column; align-items: flex-start;
    max-width: 480px;
  }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  p { line-height: 1.5; margin: 0 0 1rem; }
  a {
    display: inline-block;
    color: var(--accent); text-decoration: none;
    border-bottom: 1px dashed currentColor;
  }
  a:hover { text-decoration: none; border-bottom-style: solid; }
`.trim();

export interface RenderLogoutPageInput {
  branding: Branding;
}

export function renderLogoutPage(input: RenderLogoutPageInput): string {
  const { branding } = input;
  const doc = html`<!doctype html>
    <html lang="en" style="--accent: ${branding.accentColor}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${branding.title} — Signed out</title>
        <style>
          ${new Html(STYLES)}
        </style>
      </head>
      <body>
        <h1>Signed out</h1>
        <p>You have been logged out of dev-oidc.</p>
        <a href="/">Back to home</a>
      </body>
    </html>`;
  return renderToString(doc);
}
