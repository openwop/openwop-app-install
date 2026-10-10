/**
 * ADR 0833 D5 — the ONE "is this a same-origin, in-app path?" predicate for
 * every redirect sink and stored action URL.
 *
 * There used to be five. The SAML login/ACS copy accepted `/\evil.com`: Express
 * puts it in `Location` unchanged and browsers resolve the backslash as a
 * slash, so the post-SSO redirect left the site (S5). The OAuth and Copilot
 * copies had the same hole, masked only because an absolute base is prefixed
 * before they redirect. This is the strict version the notifications agent tool
 * already used, moved here so each sink calls it instead of re-deriving it.
 *
 * In-app paths only: a leading `/`, never protocol-relative `//`, no backslash,
 * whitespace or control characters (header / markdown smuggling), bounded length.
 */
const URL_MAX = 500;

export function isSafeInAppPath(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  if (url.length === 0 || url.length > URL_MAX) return false;
  if (!url.startsWith('/') || url.startsWith('//')) return false;
  if (url.includes('\\') || /\s/.test(url)) return false;
  for (let i = 0; i < url.length; i += 1) {
    const c = url.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** `url` when it is a safe in-app path, else `fallback`. */
export function safeInAppPathOr(url: unknown, fallback: string): string {
  return isSafeInAppPath(url) ? url : fallback;
}
