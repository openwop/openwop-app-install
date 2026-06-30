/**
 * ADR 0129 Phase 2 — SECURITY + degradation tests for sandboxed Mermaid.
 * Asserts the no-script static sandbox (stricter than the ADR 0128 artifact frame)
 * and the never-throw/never-blank degrade-to-code-block path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const renderMock = vi.fn();
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: renderMock } }));
// CodeBlock pulls i18n; give it a trivial t().
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { MermaidDiagram, buildMermaidSrcdoc, svgHeightPx, SVG_CSP_FOR_TEST } from '../MermaidDiagram.js';

afterEach(() => { renderMock.mockReset(); cleanup(); });

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
    expect(iframe.getAttribute('srcdoc')).toContain('<svg height="100">');
  });

  it('DEGRADES to the raw code block when mermaid throws (partial/malformed)', async () => {
    renderMock.mockRejectedValue(new Error('parse error'));
    const { container } = render(<MermaidDiagram source="graph TD; A--" />);
    await waitFor(() => expect(screen.queryByText(/graph TD/)).not.toBeNull());
    expect(container.querySelector('iframe')).toBeNull(); // no diagram frame
  });
});
