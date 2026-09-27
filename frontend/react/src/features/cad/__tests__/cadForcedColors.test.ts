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
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('CADU-2 — forced-colors boldens the CAD 3D wireframe (edge legibility in HCM)', () => {
  it('the 3D faces/spheres get a bolder stroke-width under forced-colors (> the 0.75 base)', () => {
    const w = boldStrokeFor('.canvas-cad__svg--3d');
    expect(w, 'no forced-colors rule raises stroke-width on .canvas-cad__svg--3d').not.toBeNull();
    expect(w!).toBeGreaterThan(0.75);
  });

  it('the view-cube edges get a bolder stroke-width under forced-colors (> the 1 base)', () => {
    const w = boldStrokeFor('.cad-viewcube__cube');
    expect(w, 'no forced-colors rule raises stroke-width on the view-cube edges').not.toBeNull();
    expect(w!).toBeGreaterThan(1);
  });
});
