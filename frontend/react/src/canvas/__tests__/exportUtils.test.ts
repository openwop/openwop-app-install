/**
 * Export helpers (ADR 0333 Phase 8) — the strip contract: classed editor
 * chrome vanishes, class-free renderer content survives, the clone gets
 * standalone sizing. (Rasterization needs real image decode — /manual-tests.)
 *
 * The UX-D1 `currentColor` resolution is asserted only as "the computed colour
 * lands on the root": jsdom's computed value is its default, not a theme colour
 * (CEILING for the theme half — /manual-tests).
 */
import { describe, it, expect } from 'vitest';
import { svgElementToCleanString } from '../exportUtils.js';

function scene(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 400 300');
  svg.setAttribute('class', 'cv-draw-interactive__svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Drawing editor');
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '10');
  svg.appendChild(rect);
  // Class-free renderer content NESTED in a class-free group survives intact.
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M0 0L5 7');
  g.appendChild(path);
  svg.appendChild(g);
  const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  hit.setAttribute('class', 'cv-draw-interactive__hit');
  svg.appendChild(hit);
  const guide = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  guide.setAttribute('class', 'cv-draw-interactive__snap-guide');
  svg.appendChild(guide);
  return svg;
}

describe('svgElementToCleanString', () => {
  it('keeps class-free content, strips classed chrome + editor attrs, sizes the root', () => {
    const out = svgElementToCleanString(scene());
    expect(out).toContain('<rect x="10"');
    expect(out).not.toContain('cv-draw-interactive__hit');
    expect(out).not.toContain('snap-guide');
    expect(out).not.toContain('class=');
    expect(out).not.toContain('role=');
    expect(out).not.toContain('aria-label=');
    expect(out).toContain('<g><path d="M0 0L5 7"/></g>');
    // Exact root sizing from the (non-square) viewBox, read off the ROOT tag
    // (not a substring anywhere). NOTE: not re-parsed with DOMParser — under
    // jsdom the output carries `xmlns` TWICE (the serializer's own declaration +
    // the explicit setAttribute), which a strict XML parser rejects. Whether a
    // real browser serializer dedupes it is unverified here; reported to the
    // coordinator as a possible product defect, not pinned.
    const rootTag = /^<svg\b[^>]*>/.exec(out)?.[0] ?? '';
    expect(rootTag).toMatch(/\swidth="400"/);
    expect(rootTag).toMatch(/\sheight="300"/);
    // UX-D1: the live computed text colour is resolved onto the clone's root
    // (jsdom computes its default, which is enough to show the line runs).
    expect(rootTag).toMatch(/\sstyle="color: [^";]+;"/);
    // CEILING (w46g2-ex-xmlns vacuous): XMLSerializer emits the SVG namespace for
    // an SVG-namespaced root on its own, so the explicit setAttribute('xmlns') is
    // a belt-and-braces line this assertion cannot isolate. Kept as a check of the
    // OUTPUT (a standalone file must carry it), not as a witness of that line.
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});
