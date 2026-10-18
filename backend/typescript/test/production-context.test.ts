/**
 * Production context builder (ADR 0172) — PURE unit tests for the team+vendor
 * ranker. No app boot: `buildProductionContext` is a pure function, so channel→
 * category mapping, skill-name inference, ranking order, the token cap, and gap
 * analysis are all directly assertable.
 *
 * w32 (grade-tests): four claims here could not fail — the budget fixture never
 * exceeded the budget (10 capped members ≈ 1.4 k chars of 6 k), the vendor case won
 * by two bonuses at once (removing either left the winner), and two `arrayContaining`
 * checks passed any superset. Each now isolates the one rule it names.
 */

import { describe, expect, it } from 'vitest';
import { isPiiField } from '../src/host/dataClassification.js';
import '../src/features/production/productionService.js'; // registers the production.vendor PII declaration (module side effect)
import { buildProductionContext, relevantCategoriesFor } from '../src/features/production/productionContext.js';
import type { Profile } from '../src/features/profiles/profilesService.js';
import type { Vendor } from '../src/features/production/productionService.js';

function profile(over: Partial<Profile>): Profile {
  return {
    userId: over.userId ?? 'user:x',
    tenantId: 'default',
    portfolioAssetTokens: [],
    skills: [],
    equipment: [],
    interests: [],
    workflows: [],
    pinnedAgentIds: [],
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}
function vendor(over: Partial<Vendor>): Vendor {
  return {
    vendorId: over.vendorId ?? 'vnd:x',
    tenantId: 'default',
    orgId: 'org:1',
    type: 'contractor',
    name: over.name ?? 'V',
    capabilities: [],
    priceRanges: [],
    pastProjects: [],
    portfolioAssetTokens: [],
    contractStatus: 'active',
    createdBy: 'u',
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

describe('relevantCategoriesFor', () => {
  it('maps channels to the union of production categories', () => {
    const cats = relevantCategoriesFor(['landing_page']);
    expect(cats).toEqual(['design', 'development', 'writing']);
  });
  it('is empty for unknown channels', () => {
    expect(relevantCategoriesFor(['nonsense'])).toEqual([]);
  });
});

describe('buildProductionContext', () => {
  it('returns empty sections when no channel is relevant', () => {
    const r = buildProductionContext({ channels: [], profiles: [profile({})], vendors: [] });
    expect(r.teamCapabilitySection).toBe('');
    expect(r.rankedMembers).toEqual([]);
  });

  it('ranks a matching designer above a non-matching engineer for a design channel', () => {
    const designer = profile({ userId: 'u:designer', jobTitle: 'Designer', skills: [{ name: 'Brand design', proficiency: 5, endorsements: [] }] });
    const dev = profile({ userId: 'u:dev', jobTitle: 'Engineer', skills: [{ name: 'React development', proficiency: 5, endorsements: [] }] });
    const r = buildProductionContext({ channels: ['creative_briefs'], profiles: [dev, designer], vendors: [] });
    // creative_briefs → design/video/photography/audio ⇒ the designer matches, the dev does not.
    expect(r.rankedMembers[0]?.userId).toBe('u:designer');
    expect(r.rankedMembers.some((m) => m.userId === 'u:dev')).toBe(false);
  });

  it('ranks a PREFERRED vendor above an otherwise-identical active one', () => {
    const a = vendor({ vendorId: 'vnd:a', name: 'A', contractStatus: 'active', capabilities: [{ name: 'Copy', category: 'writing', qualityRating: 3 }] });
    const b = vendor({ vendorId: 'vnd:b', name: 'B', contractStatus: 'preferred', capabilities: [{ name: 'Copy', category: 'writing', qualityRating: 3 }] });
    const r = buildProductionContext({ channels: ['email_sequence'], profiles: [], vendors: [a, b] });
    expect(r.rankedVendors.map((v) => v.vendorId), 'the preferred bonus alone decides').toEqual(['vnd:b', 'vnd:a']);
  });

  it('ranks a high-QUALITY vendor above an otherwise-identical one, and surfaces coverage gaps', () => {
    const a = vendor({ vendorId: 'vnd:a', name: 'A', contractStatus: 'active', capabilities: [{ name: 'Copy', category: 'writing', qualityRating: 3 }] });
    const b = vendor({ vendorId: 'vnd:b', name: 'B', contractStatus: 'active', capabilities: [{ name: 'Copy', category: 'writing', qualityRating: 5 }] });
    const r = buildProductionContext({ channels: ['email_sequence'], profiles: [], vendors: [a, b] });
    expect(r.rankedVendors.map((v) => v.vendorId), 'the quality bonus alone decides').toEqual(['vnd:b', 'vnd:a']);
    // email_sequence needs writing/design/strategy — writing is covered, design & strategy are not.
    expect(r.gaps).toEqual(['design', 'strategy']);
  });

  it('keeps the combined context within the token budget', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      // ~1 000-char titles: 10 ranked lines are far past the 6 000-char budget, so the
      // cap — not the member limit — is what keeps the block in bounds.
      profile({ userId: `u:${i}`, jobTitle: `Designer ${i} ${'lead brand '.repeat(100)}`, skills: [{ name: 'design', proficiency: 5, endorsements: [] }] }),
    );
    const r = buildProductionContext({ channels: ['creative_briefs'], profiles: many, vendors: [] });
    // 1500 tokens * 4 chars — the sections together must not exceed the budget.
    expect(r.teamCapabilitySection.length + r.vendorSection.length).toBeLessThanOrEqual(1500 * 4);
    expect(r.teamCapabilitySection.endsWith('...'), 'the team section was truncated to fit').toBe(true);
    // and the ranker caps at 10 members regardless of input size.
    expect(r.rankedMembers).toHaveLength(10);
  });
});

describe('PROD2-M6 (R3) — the vendor contact email is a DECLARED PII field', () => {
  it("contactEmail is declared for production.vendor; a non-PII sibling is not", () => {
    expect(isPiiField('production.vendor', 'contactEmail')).toBe(true);   // the declaration
    expect(isPiiField('production.vendor', 'region')).toBe(false);        // …and it is not a blanket
  });
});
