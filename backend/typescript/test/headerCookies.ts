/**
 * `Headers.getSetCookie()` typed for the repo's TS lib (where it's optional),
 * with a single-`set-cookie` fallback. One helper so route tests don't each cast
 * `res.headers` — replaces the scattered `(res.headers as any).getSetCookie()`.
 */
export function getSetCookies(headers: Headers): string[] {
  const h = headers as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}
