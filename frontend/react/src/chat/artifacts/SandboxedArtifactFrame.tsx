/**
 * Sandboxed interactive-artifact renderer (ADR 0128 Phase 2). SECURITY-CRITICAL:
 * renders UNTRUSTED model/code-generated HTML in a maximally-isolated iframe.
 *
 * Isolation (reviewed via /architect):
 *  - `sandbox="allow-scripts"` WITHOUT `allow-same-origin` → the framed doc has an
 *    OPAQUE/null origin: it cannot read the parent DOM, cookies, localStorage, or
 *    make credentialed same-origin requests. allow-scripts is safe under a null
 *    origin. The default sandbox also blocks top-navigation, popups, and forms.
 *  - A `default-src 'none'` CSP (no connect-src) → NO network egress, so a hostile
 *    artifact can't exfiltrate anything it sees. Inline script/style only (the
 *    artifact is self-contained); images limited to data: URIs.
 *  - The untrusted body goes ONLY into the iframe `srcdoc` (origin-isolated) — it is
 *    NEVER innerHTML'd into the parent document.
 * Gated by `useFeatureAccess('interactive-artifacts')`.
 */
import { useTranslation } from 'react-i18next';

/** The locked-down CSP injected into every sandboxed artifact document. */
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;";

/** The sandbox attribute set — allow-scripts ONLY (no allow-same-origin → null
 *  origin; no allow-top-navigation/popups/forms → no escape). */
export const ARTIFACT_SANDBOX = 'allow-scripts';

/** Wrap an untrusted body in a minimal document carrying the locked-down CSP. The
 *  body is NOT sanitized here — isolation (null origin + no-egress CSP), not
 *  sanitization, is the security boundary. Exported for test coverage. */
export function buildArtifactSrcdoc(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"></head><body>${body}</body></html>`;
}

interface Props {
  body: string;
  title?: string;
}

/** IART-6: an upper bound on the untrusted body fed to the iframe (the backend inline cap is
 *  the authority; this is a defense-in-depth FE bound so a pathological local-edit draft can't
 *  re-paint an unbounded iframe). */
const MAX_BODY_CHARS = 512_000;

export function SandboxedArtifactFrame({ body, title }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  // interactive-artifacts is always-on (toggle removed); the sandbox always renders.
  let safeBody = body;
  if (body.length > MAX_BODY_CHARS) {
    if (typeof console !== 'undefined') console.warn('[artifact] body exceeds the render cap; truncating', { length: body.length });
    safeBody = body.slice(0, MAX_BODY_CHARS);
  }

  return (
    <iframe
      className="artifact-sandbox-frame"
      sandbox={ARTIFACT_SANDBOX}
      srcDoc={buildArtifactSrcdoc(safeBody)}
      title={title ?? t('interactiveArtifactTitle')}
      // Defense-in-depth: referrer leak prevention (the null-origin sandbox already
      // blocks credentialed requests; this also strips the referrer on any allowed
      // data: fetch).
      referrerPolicy="no-referrer"
    />
  );
}
