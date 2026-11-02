/**
 * ADR 1017 D1 — the sandbox posture of the interactive-artifact frame, kept free of
 * React so the real-browser egress witness (`e2e/artifact-sandbox-egress.spec.ts`) can
 * load the exact values the product renders. `SandboxedArtifactFrame` re-exports them.
 */

/** The CSP injected into every sandboxed artifact document. It blocks fetch, images
 *  other than data:, fonts and frames. It does NOT stop a running script from
 *  navigating its own frame or using WebRTC (ADR 1017 M1). */
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;";

/** The sandbox while the viewer has chosen to run scripts: allow-scripts ONLY (no
 *  allow-same-origin → null origin; no top-navigation/popups/forms). */
export const ARTIFACT_SANDBOX = 'allow-scripts';

/** The default sandbox: no tokens at all — no scripts, no forms, no popups. */
export const ARTIFACT_SANDBOX_STATIC = '';

/** Wrap an untrusted body in a minimal document carrying the CSP. The body is NOT
 *  sanitized here: the sandbox mode, not sanitization, is the boundary. Exported for
 *  test coverage. */
export function buildArtifactSrcdoc(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"></head><body>${body}</body></html>`;
}
