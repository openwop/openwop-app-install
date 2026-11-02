/**
 * authFrameSrc (ADR 1021 D9) — the pure half of `check-auth-frame-src.mjs`: the
 * app CSP's `frame-src` admits the Firebase auth domain EXACTLY, and never a
 * Firebase wildcard.
 *
 * Why this exists: `frame-src` is the one control over where a plugin frame (or
 * any frame) can navigate itself, and `https://*.firebaseapp.com` admitted every
 * Firebase project on the internet, including one an attacker registers (ADR
 * 1021 M1). It was there only so the default `<project>.firebaseapp.com` auth
 * domain's sign-in frame could load. The demo's auth domain is its own custom
 * domain, served by the same Hosting site, so `'self'` covers it.
 *
 * Removing the wildcard breaks sign-in for a deployment whose auth domain IS the
 * default one, unless that exact origin is listed. That failure would be silent
 * until someone signs in, so this build step makes it loud:
 *  - a wildcard Firebase source (`*.firebaseapp.com`, `*.web.app`) in `frame-src`
 *    is refused;
 *  - an auth domain on a Firebase platform suffix must appear as
 *    `https://<authDomain>` in `frame-src`;
 *  - any other auth domain is taken to be this site's own custom domain, which
 *    `'self'` covers, so `'self'` must be present. (A build cannot see which
 *    domain Hosting serves; that half is the post-deploy sign-in check.)
 *  - no auth domain configured: nothing to check.
 */

const FIREBASE_SUFFIXES = ['.firebaseapp.com', '.web.app'];

/** Problems with `frameSrc` (the directive's source list) for `authDomain`. Pure. */
export function authFrameSrcFindings(authDomain, frameSrc) {
  const sources = frameSrc.trim().split(/\s+/).filter(Boolean);
  const findings = [];
  for (const s of sources) {
    if (FIREBASE_SUFFIXES.some((suffix) => s.includes(`*${suffix}`))) {
      findings.push(`frame-src admits the wildcard ${s}: every Firebase project, including an attacker's. List the exact auth origin instead.`);
    }
  }
  const domain = (authDomain ?? '').trim().toLowerCase();
  if (!domain) return findings;
  if (FIREBASE_SUFFIXES.some((suffix) => domain.endsWith(suffix))) {
    const origin = `https://${domain}`;
    if (!sources.includes(origin)) {
      findings.push(`the auth domain ${domain} is a Firebase default domain, so its sign-in frame needs ${origin} in frame-src (exactly that origin, not a wildcard). Without it, sign-in fails.`);
    }
  } else if (!sources.includes("'self'")) {
    findings.push(`the auth domain ${domain} is a custom domain, which this check takes to be served by this site; frame-src needs 'self' for its sign-in frame.`);
  }
  return findings;
}

/** The app-wide CSP's `frame-src` source list from a firebase.json text. */
export function appFrameSrc(firebaseJsonText) {
  const hosting = JSON.parse(firebaseJsonText).hosting;
  for (const site of Array.isArray(hosting) ? hosting : [hosting]) {
    if ((site.target ?? 'app') !== 'app') continue;
    for (const rule of site.headers ?? []) {
      if (!String(rule.source ?? '').startsWith('**/!(')) continue;
      const csp = rule.headers?.find((h) => h.key.toLowerCase() === 'content-security-policy')?.value;
      const directive = csp?.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src '));
      if (directive) return directive.slice('frame-src '.length);
    }
  }
  return null;
}

