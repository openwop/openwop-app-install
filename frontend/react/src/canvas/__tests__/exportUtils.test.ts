/**
 * Export helpers (ADR 0333 Phase 8) — the strip contract: classed editor
 * chrome vanishes, class-free renderer content survives, the clone gets
 * standalone sizing. (Rasterization needs real image decode — /manual-tests.)
 */
import { describe, it, expect } from 'vitest';
import { svgElementToCleanString } from '../exportUtils.js';

function scene(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 400 300');
  svg.setAttribute('class', 'cv-draw-interactive__svg');
  svg.setAttribute('role', 'img');
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '10');
  svg.appendChild(rect);
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
    expect(out).toContain('width="400"');
    expect(out).toContain('height="300"');
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});
