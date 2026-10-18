/**
 * CADU-2 — the CAD 3D pane's depth SHADING is `filter:brightness()` over token
 * fills, which forced-colors (Windows High Contrast) flattens — and a
 * brightness GRADIENT is something the forced-colors palette cannot express
 * anyway. What DOES survive HCM is the wireframe: the faces/spheres carry
 * `stroke="currentColor"` and the view-cube's `[role=button]` strokes
 * currentColor, both → CanvasText, plus backface culling + labels. So the HCM
 * affordance is the wireframe, not the shading.
 *
 * The one cheap, real legibility win (the `stroke`/`strokeWidth` are SVG
 * PRESENTATION ATTRIBUTES → CSS-overridable, unlike the inline-`style` fill): a
 * `@media (forced-colors: active)` block that BOLDENS the wireframe stroke-width
 * so the edges read at HCM. This pins that contract. It does NOT restore
 * gradient depth-shading (inherent forced-colors limit) — the live HCM visual is
 * a human click-through (CT-CADU).
 *
 * Born-red: no forced-colors block boldens the CAD wireframe.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { render, cleanup } from '@testing-library/react';
import { Cad3dView } from '../Cad3dView.js';

afterEach(cleanup);

const CSS = readFileSync(join(process.cwd(), 'src/styles/global.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Bodies of every `@media (forced-colors: active)` block, brace-balanced. */
function forcedColorsBlocks(): string[] {
  const out: string[] = [];
  const re = /@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < CSS.length && depth > 0; i++) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}') depth--;
    }
    out.push(CSS.slice(start, i - 1));
  }
  return out;
}

/** The stroke-width a forced-colors rule matching `selNeedle` sets, or null. */
function boldStrokeFor(selNeedle: string): number | null {
  for (const block of forcedColorsBlocks()) {
    const re = new RegExp(`[^{}]*${selNeedle.replace(/[.[\]]/g, '\\$&')}[^{}]*\\{([^{}]*)\\}`, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(block))) {
      const w = match[1]!.match(/stroke-width:\s*([0-9.]+)/);
      if (w) return Number(w[1]);
    }
  }
  return null;
}

/** The stylesheet with every `@media (forced-colors: active)` block body removed. */
function baseCss(): string {
  let out = CSS;
  for (const block of forcedColorsBlocks()) out = out.replace(block, '');
  return out;
}

/** The BASE (non-HCM) stroke-width of the rule whose selector is exactly `sel`. */
function baseStrokeFor(sel: string): number | null {
  const re = new RegExp(`(?:^|[{}])\\s*${sel.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^{}]*)\\}`, 'g');
  const css = baseCss();
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    const w = match[1]!.match(/stroke-width:\s*([0-9.]+)/);
    if (w) return Number(w[1]);
  }
  return null;
}

/** The rendered viewer — a box (faces → polygons) and a sphere (→ circle) —
 *  so the selectors are proven to hit real DOM and the base widths come from
 *  the product, not from literals in this file. */
function renderViewer(): HTMLElement {
  const { container } = render(createElement(Cad3dView, {
    solids: [{ kind: 'box', width: 40, height: 30, depth: 20 }, { kind: 'sphere', x: 60, radius: 5 }],
    label: 'model',
  }));
  return container;
}

describe('CADU-2 — forced-colors boldens the CAD 3D wireframe (edge legibility in HCM)', () => {
  it('the 3D faces/spheres get a bolder stroke-width under forced-colors (> the 0.75 base)', () => {
    const container = renderViewer();
    const polygon = container.querySelector('svg.canvas-cad__svg--3d polygon');
    const circle = container.querySelector('svg.canvas-cad__svg--3d circle[stroke]');
    expect(polygon, 'the 3D viewer renders face polygons').not.toBeNull();
    expect(circle, 'the 3D viewer renders a stroked sphere circle').not.toBeNull();
    // Each element is targeted on its OWN — the faces are the main wireframe.
    const wPoly = boldStrokeFor('.canvas-cad__svg--3d polygon');
    const wCircle = boldStrokeFor('.canvas-cad__svg--3d circle');
    expect(wPoly, 'no forced-colors rule raises stroke-width on 3D face polygons').not.toBeNull();
    expect(wCircle, 'no forced-colors rule raises stroke-width on 3D sphere circles').not.toBeNull();
    // Bolder than the base the viewer actually renders (presentation attributes).
    expect(wPoly!).toBeGreaterThan(Number(polygon!.getAttribute('stroke-width')));
    expect(wCircle!).toBeGreaterThan(Number(circle!.getAttribute('stroke-width')));
  });

  it('the view-cube edges get a bolder stroke-width under forced-colors (> the 1 base)', () => {
    const container = renderViewer();
    expect(container.querySelector('.cad-viewcube__cube [role="button"]'), 'the viewer renders view-cube faces').not.toBeNull();
    const w = boldStrokeFor('.cad-viewcube__cube [role="button"]');
    expect(w, 'no forced-colors rule raises stroke-width on the view-cube edges').not.toBeNull();
    // The cube's base width lives in the non-HCM CSS rule, not on the element.
    const base = baseStrokeFor('.cad-viewcube__cube [role="button"]');
    expect(base, 'the base view-cube stroke rule').not.toBeNull();
    expect(w!).toBeGreaterThan(base!);
  });
});
