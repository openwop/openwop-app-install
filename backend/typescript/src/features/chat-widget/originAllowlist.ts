/**
 * ADR 0127 Phase 2a — pure Origin/Referer domain-allowlist matcher.
 *
 * The security gate for the public widget: a runtime request's Origin (or Referer)
 * host MUST match the widget's `allowedDomains` exactly OR be a subdomain of an
 * allowed host. A bare-domain entry (`acme.com`) admits the apex + any subdomain
 * (`app.acme.com`); a subdomain entry (`app.acme.com`) admits ONLY that host. This
 * rejects the eTLD+1 spoof class (`acme.com.evil.com` does NOT match `acme.com`)
 * because matching is host-suffix on a `.`-boundary, not substring. Pure +
 * deterministic; the public gateway (Phase 2b) calls this before serving.
 *
 * @see docs/adr/0127-public-embeddable-chat-widget.md
 */

/** Extract the lowercase host from an Origin or Referer URL (or a bare host). */
export function hostOf(originOrReferer: string): string | null {
  const v = originOrReferer.trim();
  if (!v) return null;
  try {
    return new URL(v.includes('://') ? v : `https://${v}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True iff `host` equals `allowed` or is a dot-boundary subdomain of it. */
function hostMatches(host: string, allowed: string): boolean {
  if (host === allowed) return true;
  return host.endsWith(`.${allowed}`); // dot-boundary → no `acme.com.evil.com` spoof
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** ADR 1018 D5 — normalise one `allowedDomains` entry to a host, or `null` when it is
 *  not one an operator can mean. A pasted `https://Acme.com/path` becomes `acme.com`.
 *  Refused: a port, a wildcard, an empty label, and a SINGLE label other than
 *  `localhost` — a bare `com` would admit every `.com` site through the suffix match
 *  below. A public suffix such as `co.uk` still passes (no PSL in the host; a known
 *  limit, recorded in the ADR). Used at write time (400) AND at match time, so a legacy
 *  row stored before this check fails closed instead of staying live. */
export function normalizeAllowedDomain(entry: string): string | null {
  const raw = entry.trim().toLowerCase();
  if (!raw || raw.includes('*')) return null;
  let host: string;
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (u.port || u.username || u.password) return null;
    host = u.hostname.replace(/\.$/, '');
  } catch {
    return null;
  }
  if (host === 'localhost') return host;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  return host;
}

/** Is the request's Origin/Referer allowed by the widget's domain allowlist?
 *  DEFAULT-DENY: an empty allowlist or an unparseable/absent origin → false. Each
 *  stored entry passes `normalizeAllowedDomain` first; an entry that does not
 *  normalise matches nothing. */
export function originAllowed(originOrReferer: string | undefined, allowedDomains: readonly string[]): boolean {
  if (!originOrReferer || allowedDomains.length === 0) return false;
  const host = hostOf(originOrReferer);
  if (!host) return false;
  return allowedDomains.some((d) => {
    const allowed = normalizeAllowedDomain(d);
    return allowed !== null && hostMatches(host, allowed);
  });
}
