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

/** Is the request's Origin/Referer allowed by the widget's domain allowlist?
 *  DEFAULT-DENY: an empty allowlist or an unparseable/absent origin → false. */
export function originAllowed(originOrReferer: string | undefined, allowedDomains: readonly string[]): boolean {
  if (!originOrReferer || allowedDomains.length === 0) return false;
  const host = hostOf(originOrReferer);
  if (!host) return false;
  return allowedDomains.some((d) => {
    const allowed = d.trim().toLowerCase();
    return allowed.length > 0 && hostMatches(host, allowed);
  });
}
