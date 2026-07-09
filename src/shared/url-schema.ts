import { z } from 'zod';

export interface HttpUrlOptions {
  /** Permit a query string (default true; issuer-like URLs should pass false). */
  allowQuery?: boolean;
}

// Strict HTTP(S) URL: absolute, http/https only, no embedded credentials,
// no fragment. z.string().url() alone accepts all of those.
export function httpUrl(options: HttpUrlOptions = {}) {
  const allowQuery = options.allowQuery ?? true;
  return z.string().superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a valid absolute URL' });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'must use http or https' });
    }
    if (url.username !== '' || url.password !== '') {
      ctx.addIssue({ code: 'custom', message: 'must not contain embedded credentials' });
    }
    if (url.hash !== '') {
      ctx.addIssue({ code: 'custom', message: 'must not contain a fragment' });
    }
    if (!allowQuery && url.search !== '') {
      ctx.addIssue({ code: 'custom', message: 'must not contain a query string' });
    }
  });
}
