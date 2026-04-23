import type { CSSProperties, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Branding, Profile } from '@/config/schema.js';
import { STATIC_STYLES } from '@/login/styles.js';

export interface RenderLoginPageInput {
  pendingAuthId: string;
  profiles: readonly Profile[];
  branding: Branding;
  actionUrl: string;
}

export function renderLoginPage(input: RenderLoginPageInput): string {
  const body = renderToStaticMarkup(<LoginPage {...input} />);
  return `<!doctype html>\n${body}`;
}

function LoginPage({
  pendingAuthId,
  profiles,
  branding,
  actionUrl,
}: RenderLoginPageInput): ReactElement {
  // accentColor is a config-controlled string, not user input, but we set it
  // via the React style prop so React handles the value safely — no raw HTML
  // interpolation, no dangerouslySetInnerHTML needed.
  const rootStyle = { '--accent': branding.accentColor } as CSSProperties;

  return (
    <html lang="en" style={rootStyle}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{branding.title}</title>
        <style>{STATIC_STYLES}</style>
      </head>
      <body>
        <h1>{branding.title}</h1>
        <div className="grid">
          {profiles.map((p) => (
            <form key={p.id} className="tile" method="post" action={actionUrl}>
              <input type="hidden" name="pendingAuthId" value={pendingAuthId} />
              <input type="hidden" name="profileId" value={p.id} />
              <button type="submit" className="tile">
                <div className="name">{p.displayName}</div>
                <div className="email">{p.email}</div>
              </button>
            </form>
          ))}
        </div>
      </body>
    </html>
  );
}
