/**
 * User-facing feature copy never cites internal ADR / RFC numbers.
 *
 * A toggle's `label` + `description` render verbatim on the `/feature-toggles`
 * admin cards, and the label also feeds the public pricing page's
 * `featureLabels` (`publicFeatureLabels` reads `getToggleDefault(id).label`).
 * Owner request 2026-10-07: copy like "ADR 0512 — anonymous, counts-only
 * navigation aggregates" must read as product language, not as a pointer into
 * our decision log. Labels and descriptions always resolve from code
 * (`mergeStoredOverDefault` spreads the DECLARED default first and takes only
 * admin choices from the stored row), so this ratchet covers every serve.
 *
 * Covers: every `toggleDefault` + `extraToggleDefaults` on BACKEND_FEATURES,
 * every imperative `registerToggleDefault({ … })` call in src (read from
 * source — they run inside route registrars a boot-free test cannot run), and
 * the user-visible bundle labels in `distributions/bundles.json`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BACKEND_FEATURES } from '../src/features/index.js';
import type { ToggleConfig } from '../src/host/featureToggles/types.js';

const SRC = join(import.meta.dirname, '../src');
const BUNDLES = join(import.meta.dirname, '../../../distributions/bundles.json');

const NUMBERED = /\b(ADR|RFC)[\s-]?\d{3,4}\b/i;
const BARE = /\b(ADR|RFC)s?\b/;
const cites = (s: string): boolean => NUMBERED.test(s) || BARE.test(s);
/** A default-state claim ("OFF by default", "Default ON"): the admin card already
 *  shows the live status, and a stored override makes the sentence false. */
const STATE = /\b(?:on|off) by default\b|\bdefaults? (?:on|off)\b/i;

/** The text of each imperative `registerToggleDefault({ … })` literal's
 *  label/description, keyed `file:id`. A description may span lines or be a
 *  `'…' + '…'` concatenation, so we take everything from `description:` to the
 *  next sibling key — any ADR/RFC token in that span is user copy. */
function imperativeCopy(dir = SRC, out: Array<[string, string]> = []): Array<[string, string]> {
  for (const e of readdirSync(dir)) {
    if (e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { imperativeCopy(p, out); continue; }
    if (!p.endsWith('.ts')) continue;
    const text = readFileSync(p, 'utf8');
    for (const m of text.matchAll(/registerToggleDefault\(\{([\s\S]*?)\n\s*\}\);/g)) {
      // Drop `//` comments (whole-line or trailing); `https://` survives because
      // its `//` follows a `:`, not whitespace or a comma.
      const body = m[1]!.replace(/(^|[\s,])\/\/[^\n]*/g, '$1');
      const id = /id:\s*([^,\n]+)/.exec(body)?.[1]?.trim() ?? '?';
      for (const key of ['label', 'description'] as const) {
        const span = new RegExp(`\\b${key}:([\\s\\S]*?)(?=\\n\\s*(?:id|label|description|category|status|bucketUnit|salt|variants|betaCohort):)`).exec(body)?.[1];
        if (span) out.push([`${relative(SRC, p)} ${id}.${key}`, span]);
      }
    }
  }
  return out;
}

describe('feature copy cites no ADR / RFC numbers', () => {
  const declared: ToggleConfig[] = BACKEND_FEATURES.flatMap((f) => [
    ...(f.toggleDefault ? [f.toggleDefault] : []),
    ...(f.extraToggleDefaults ?? []),
  ]);
  const imperative = imperativeCopy();
  const bundles = JSON.parse(readFileSync(BUNDLES, 'utf8')) as { bundles: Record<string, { label?: string }> };

  it('non-vacuity: the registry, the imperative registrars and the catalog are all read', () => {
    expect(declared.length).toBeGreaterThan(50);
    expect(declared.filter((t) => t.description).length).toBeGreaterThan(50);
    expect(imperative.length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(bundles.bundles).length).toBeGreaterThan(5);
  });

  it('positive control: the matcher flags the copy this ratchet exists for', () => {
    expect(cites('ADR 0512 — anonymous, counts-only navigation aggregates')).toBe(true);
    expect(cites('implements RFC 0050 SAML/SCIM')).toBe(true);
    expect(cites('per the ADR')).toBe(true);
    expect(cites('Anonymous, counts-only navigation aggregates.')).toBe(false);
    expect(cites('governed by the RFCs')).toBe(true);
    expect(STATE.test('No individual activity is stored. Default OFF.')).toBe(true);
    expect(STATE.test('OFF by default — opt-in per tenant.')).toBe(true);
    expect(STATE.test('Turn OFF to store event counts only.')).toBe(false);
  });

  it('no toggle description claims a default state (the card shows the live status)', () => {
    const offenders = [
      ...declared.filter((t) => t.description && STATE.test(t.description)).map((t) => `${t.id}: ${t.description}`),
      ...imperative.filter(([k, s]) => k.endsWith('.description') && STATE.test(s)).map(([k, s]) => `${k}: ${s.trim()}`),
    ];
    expect(offenders).toEqual([]);
  });

  it('every declared toggle label + description is free of ADR/RFC citations', () => {
    const offenders = declared.flatMap((t) => [
      ...(t.label && cites(t.label) ? [`${t.id}.label: ${t.label}`] : []),
      ...(t.description && cites(t.description) ? [`${t.id}.description: ${t.description}`] : []),
    ]);
    expect(offenders).toEqual([]);
  });

  it('every imperative registerToggleDefault label + description is free of ADR/RFC citations', () => {
    expect(imperative.filter(([, s]) => cites(s)).map(([k, s]) => `${k}: ${s.trim()}`)).toEqual([]);
  });

  it('bundles.json bundle labels are free of ADR/RFC citations', () => {
    const offenders = Object.entries(bundles.bundles).filter(([, b]) => b.label && cites(b.label)).map(([k, b]) => `${k}: ${b.label}`);
    expect(offenders).toEqual([]);
  });
});
