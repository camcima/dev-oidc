import type { FastifyReply } from 'fastify';
import { escape } from '@/shared/html.js';

/**
 * How the authorization endpoint hands its result back to the client.
 *
 * - `query` (default for `response_type=code`) and `fragment`: OAuth 2.0
 *   Multiple Response Type Encoding Practices §2.1.
 * - `form_post`: OAuth 2.0 Form Post Response Mode.
 *
 * MSAL sends `response_mode=fragment` by default and reads the code (or a
 * `login_required` from a silent iframe) only from the hash, so ignoring the
 * parameter broke MSAL apps against dev-oidc.
 */
export type ResponseMode = 'query' | 'fragment' | 'form_post';

export const RESPONSE_MODES: readonly ResponseMode[] = ['query', 'fragment', 'form_post'];

/** Absent or empty means `query`; an unknown value returns `null`. */
export function parseResponseMode(value: string | undefined): ResponseMode | null {
  if (value === undefined || value === '') return 'query';
  return (RESPONSE_MODES as readonly string[]).includes(value) ? (value as ResponseMode) : null;
}

function renderFormPost(action: string, params: Record<string, string>): string {
  const inputs: string = Object.entries(params)
    .map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`)
    .join('\n      ');
  // The inline onload handler is what auto-submits the form. No CSP is set on
  // this route; if one is ever added it must allow this handler.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Submit this form</title>
  </head>
  <body onload="document.forms[0].submit()">
    <form method="post" action="${escape(action)}">
      ${inputs}
      <noscript>
        <p>JavaScript is disabled. Continue to the application:</p>
        <button type="submit">Continue</button>
      </noscript>
    </form>
  </body>
</html>
`;
}

/**
 * Sends an authorization response (success or error) to the client in the
 * requested response mode.
 *
 * `redirectUri` must be the value matched against client.redirectUris, never
 * the request value, so nothing request-controlled reaches the Location
 * header or the form action.
 */
export function deliverAuthorizationResponse(
  reply: FastifyReply,
  redirectUri: string,
  params: Record<string, string>,
  mode: ResponseMode,
): FastifyReply {
  if (mode === 'form_post') {
    return reply
      .code(200)
      .header('cache-control', 'no-store')
      .header('pragma', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(renderFormPost(redirectUri, params));
  }

  const url: URL = new URL(redirectUri);
  if (mode === 'fragment') {
    url.hash = new URLSearchParams(params).toString();
  } else {
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  }
  return reply.code(302).header('location', url.toString()).send();
}
