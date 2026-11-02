/**
 * The plugin frame's `sandbox` attribute, in a module with no imports so the
 * Playwright egress spec (`e2e/plugin-frame-egress.spec.ts`) mounts the exact
 * value the product renders (the `chat/artifacts/artifactSandbox.ts` precedent).
 *
 * allow-scripts ONLY — the deliberate ABSENCE of allow-same-origin is what makes
 * the frame a distinct opaque origin. ADR 0840: the host's frame response carries
 * the same `sandbox` in its Content-Security-Policy header, together with the
 * deny-egress policy, so this attribute is the second, independent boundary. There
 * is no client-side CSP any more: the header is the policy (RFC 0238 §B).
 */
export const PLUGIN_SANDBOX = 'allow-scripts';
