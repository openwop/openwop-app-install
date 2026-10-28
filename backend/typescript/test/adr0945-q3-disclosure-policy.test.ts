/**
 * ADR 0945 Q3 (decided 2026-10-20, team-lead; David can override) — label AI
 * content wherever the destination OFFERS a label, even where no rule requires
 * it. The policy is the table's default; `requiredBy` says which reason applied.
 * Breaks if the default policy reverts to required-only, an offered label is
 * skipped, or non-AI content is labelled.
 */
import { describe, expect, it } from 'vitest';
import { DISCLOSURE_POLICY, disclosureFor, type DisclosureRule } from '../src/host/creativeFidelity/disclosureRules.js';

const OFFERED_ONLY: DisclosureRule[] = [
  { id: 'cms-caption', destination: 'openwop.cms.page', offeredWhen: 'always', label: 'ai-generated', mechanism: 'caption', source: 'test row', dated: '2026-10-20', status: 'provisional' },
];
const ai = { destination: 'openwop.cms.page' as const, ai: true, edited: false, political: false };

describe('Q3 — label where offered', () => {
  it('is the default policy', () => {
    expect(DISCLOSURE_POLICY).toBe('label-where-offered');
  });
  it('labels an offered-but-not-required destination under the default, and not under required-only', () => {
    expect(disclosureFor(ai, undefined, OFFERED_ONLY)).toMatchObject({ required: true, requiredBy: 'policy', mechanism: 'caption' });
    expect(disclosureFor(ai, 'required-only', OFFERED_ONLY)).toMatchObject({ required: false });
  });
  it('a rule-required label says so; non-AI content is never labelled', () => {
    expect(disclosureFor({ destination: 'ads:tiktok', ai: true, edited: true, political: false })).toMatchObject({ required: true, requiredBy: 'rule', label: 'ai-edited' });
    expect(disclosureFor({ ...ai, ai: false }, undefined, OFFERED_ONLY)).toMatchObject({ required: false });
  });
});
