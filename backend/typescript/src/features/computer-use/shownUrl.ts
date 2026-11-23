/**
 * ADR 1136 D8 — a URL as anything outside the session row sees it: origin and
 * path only. A query string or fragment can carry what the person typed (a search
 * box, a token in a redirect), so it never reaches a read projection, a stored
 * error or a log line. An unparsable or non-web value is omitted.
 */
export function shownUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return undefined;
    return `${x.origin}${x.pathname}`;
  } catch { return undefined; }
}
