/**
 * ADR 0946 D5 — `brand-lock`: re-checks a rendered member against the brand's
 * creative locks (D4). The renderer enforces the locks (P3); this check runs
 * after it, so a lock bug shows up as a finding instead of passing silently.
 * Locks with no lock facts for a rendered member are needs_review.
 */
import { toFinding, type ContentFinding } from '../findings.js';
import type { CreativeLocks, CreativeMemberInput } from './types.js';

const norm = (c: string): string => c.trim().toLowerCase();
const inside = (b: { x: number; y: number; w: number; h: number }, z: { x: number; y: number; w: number; h: number }): boolean =>
  b.x >= z.x && b.y >= z.y && b.x + b.w <= z.x + z.w && b.y + b.h <= z.y + z.h;

export function checkBrandLocks(m: CreativeMemberInput, locks: CreativeLocks | undefined): ContentFinding[] {
  if (!locks || (m.kind !== 'image' && m.kind !== 'video')) return [];
  const block = (ruleId: string, field: string, message: string): ContentFinding =>
    toFinding({ ruleSet: 'brand-lock', ruleId, severity: 'high', action: 'block', assetId: m.memberId, field, introduced: true, message });
  const facts = m.render?.lockFacts;
  if (!facts) {
    return [toFinding({ ruleSet: 'brand-lock', ruleId: 'brand-lock.unverified', severity: 'medium', action: 'needs_review', assetId: m.memberId, field: 'render', introduced: true, message: 'The brand has creative locks, but this member carries no render facts to check them against.' })];
  }
  const out: ContentFinding[] = [];
  if (locks.logo) {
    if (!facts.logoPresent) {
      if (locks.logo.required) out.push(block('brand-lock.logo_missing', 'logo', 'The brand requires its logo, and the render has none.'));
    } else {
      if (facts.logoBox && locks.logo.zones.length > 0 && !locks.logo.zones.some((z) => facts.logoBox && inside(facts.logoBox, z))) {
        out.push(block('brand-lock.logo_zone', 'logo', 'The logo sits outside the brand\'s allowed zones.'));
      }
      if (facts.logoPx !== undefined && facts.logoPx < locks.logo.minPx) {
        out.push(block('brand-lock.logo_size', 'logo', `The logo is ${facts.logoPx}px; the brand minimum is ${locks.logo.minPx}px.`));
      }
    }
  }
  const allowed = (list: string[]): Set<string> => new Set(list.map(norm));
  const text = allowed(locks.textColours);
  for (const c of facts.textColours) if (text.size > 0 && !text.has(norm(c))) out.push(block('brand-lock.text_colour', `colour.${norm(c)}`, `Text colour ${c} is not in the brand's text colours.`));
  const bg = allowed(locks.backgroundColours);
  for (const c of facts.backgroundColours) if (bg.size > 0 && !bg.has(norm(c))) out.push(block('brand-lock.background_colour', `colour.${norm(c)}`, `Background colour ${c} is not in the brand's background colours.`));
  const fonts = allowed(locks.fonts);
  for (const f of facts.fonts) if (fonts.size > 0 && !fonts.has(norm(f))) out.push(block('brand-lock.font', `font.${norm(f)}`, `Font "${f}" is not one of the brand's fonts.`));
  for (const [layerId, n] of Object.entries(facts.nudges)) {
    const over = (n.scale !== undefined && n.scale > locks.overrideBounds.maxScale)
      || Math.abs(n.dxPct ?? 0) > locks.overrideBounds.maxOffsetPct
      || Math.abs(n.dyPct ?? 0) > locks.overrideBounds.maxOffsetPct;
    if (over) out.push(block('brand-lock.override_bounds', `layer.${layerId}`, `The nudge on ${layerId} exceeds the brand's override bounds.`));
  }
  if (locks.requiredDisclaimer && facts.disclaimerPresent !== true) {
    out.push(block('brand-lock.disclaimer', 'disclaimer', 'The brand\'s required disclaimer is missing.'));
  }
  return out;
}
