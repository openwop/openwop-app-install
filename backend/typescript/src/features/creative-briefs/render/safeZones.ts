/**
 * Safe-zone validation (ADR 0399 §4) — pure geometry: does a rendered
 * text/logo/CTA layer's bounding box intersect a platform UI-overlap rect?
 * Plus the Meta 20%-text advisory (`platformSpec.textRulePct`) as a bbox-area
 * heuristic. Warnings NEVER block render or dispatch — they inform the human
 * reviewer before the ADR 0167 approval gate, mirroring ADR 0223's posture
 * that on-platform correctness is a human review step.
 */

import type { AdLayoutTemplate, AdLayerId } from './templates.js';
import type { ComposedAd, RenderWarning } from './renderCreative.js';

/** The layers a platform overlay can visually destroy — imagery underneath a
 *  translucent UI chrome survives; copy and logos do not. */
const OVERLAP_CHECKED: ReadonlySet<AdLayerId> = new Set(['headline', 'body', 'cta', 'logo']);

interface Rect { x: number; y: number; w: number; h: number }

function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Safe-zone + text-rule warnings for a composed render. Pure. */
export function checkSafeZones(
  template: AdLayoutTemplate,
  layerBboxes: ComposedAd['layerBboxes'],
  opts?: { textRulePct?: number },
): RenderWarning[] {
  const warnings: RenderWarning[] = [];

  for (const layer of layerBboxes) {
    if (!OVERLAP_CHECKED.has(layer.layerId)) continue;
    const area = layer.w * layer.h;
    if (area <= 0) continue;
    for (const zone of template.safeZones) {
      const overlap = intersectionArea(layer, zone);
      if (overlap <= 0) continue;
      const overlapPct = Math.round((overlap / area) * 100);
      if (overlapPct < 1) continue;
      warnings.push({
        code: 'safe-zone-overlap',
        layerId: layer.layerId,
        safeZoneId: zone.id,
        overlapPct,
        message: `'${layer.layerId}' overlaps the ${zone.label} by ${overlapPct}% — it may be covered by platform UI.`,
      });
    }
  }

  // The Meta 20%-text advisory (or whatever the brief's platformSpec carries):
  // total text bbox area vs canvas area — a heuristic, stated as such.
  const textRulePct = opts?.textRulePct;
  if (typeof textRulePct === 'number' && Number.isFinite(textRulePct) && textRulePct > 0) {
    const canvasArea = template.width * template.height;
    const textArea = layerBboxes
      .filter((l) => l.kind === 'text')
      .reduce((sum, l) => sum + Math.max(0, l.w) * Math.max(0, l.h), 0);
    const pct = Math.round((textArea / canvasArea) * 100);
    if (pct > textRulePct) {
      warnings.push({
        code: 'text-rule-exceeded',
        message: `Text covers ~${pct}% of the canvas (bbox heuristic) — over the platform's ${textRulePct}% guidance.`,
      });
    }
  }

  return warnings;
}
