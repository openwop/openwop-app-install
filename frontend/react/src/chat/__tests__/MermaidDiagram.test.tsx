/**
 * ADR 0129 Phase 2 — SECURITY + degradation tests for sandboxed Mermaid.
 * Asserts BOTH defense layers around untrusted model output: mermaid initialised
 * with `securityLevel: 'strict'`, and the rendered SVG shown only inside a
 * `sandbox=""` iframe whose srcdoc carries the no-script `default-src 'none'` CSP
 * (stricter than the ADR 0128 artifact frame). Plus the never-throw/never-blank
 * degrade-to-code-block path. Breaks if either layer is loosened or a failed
 * render shows a frame (or nothing) instead of the source.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';

const { renderMock, initMock } = vi.hoisted(() => ({
  renderMock: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
  initMock: vi.fn<(config: Record<string, unknown>) => void>(),
}));
vi.mock('mermaid', () => ({ default: { initialize: initMock, render: renderMock } }));
// CodeBlock pulls i18n; give it a trivial t().
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { MermaidDiagram, buildMermaidSrcdoc, svgHeightPx } from '../MermaidDiagram.js';

afterEach(() => { renderMock.mockReset(); initMock.mockReset(); cleanup(); });

describe('buildMermaidSrcdoc — no-script static sandbox', () => {
  it('injects a CSP with NO script-src (default-src none denies scripts)', () => {
    const doc = buildMermaidSrcdoc('<svg><rect/></svg>');
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toContain('script-src'); // a static SVG never needs scripts
    expect(doc).not.toContain('connect-src'); // no network egress
    expect(doc).toContain('<svg><rect/></svg>');
  });
});

describe('svgHeightPx', () => {
  it('reads the height attribute, capped', () => {
    expect(svgHeightPx('<svg height="240" >')).toBe(248);
    expect(svgHeightPx('<svg height="5000">')).toBe(1200); // cap
  });
  it('falls back to viewBox, then a default', () => {
    expect(svgHeightPx('<svg viewBox="0 0 100 180">')).toBe(188);
    expect(svgHeightPx('<svg>')).toBe(360);
  });
});

describe('MermaidDiagram — render + isolation + degrade', () => {
  it('renders the SVG in an iframe with sandbox="" (no allow-scripts)', async () => {
    renderMock.mockResolvedValue({ svg: '<svg height="100"><g/></svg>' });
    const { container } = render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('sandbox')).toBe(''); // empty = no scripts, null origin
    const srcdoc = iframe.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('<svg height="100">');
    // Layer 2: the frame's document carries the locked-down CSP, not the bare SVG.
    expect(srcdoc).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';">`);
    // Layer 1: mermaid itself sanitises (no htmlLabels / click / script directives).
    expect(initMock).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict' }));
  });

  it('DEGRADES to the raw code block when mermaid throws (partial/malformed)', async () => {
    renderMock.mockRejectedValue(new Error('parse error'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { container } = render(<MermaidDiagram source="graph TD; A--" />);
      // The loading state shows the SAME code block, so wait on the real failure
      // signal (the surfaced warn) and let the state update flush before asserting.
      await waitFor(() => expect(warn).toHaveBeenCalledWith('[artifact] mermaid render failed', 'parse error'));
      await act(async () => {});
      expect(screen.queryByText(/graph TD/)).not.toBeNull();
      expect(container.querySelector('iframe')).toBeNull(); // no diagram frame
    } finally {
      warn.mockRestore();
    }
  });
});
