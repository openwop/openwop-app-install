/**
 * Production context builder (ADR 0172) — PURE unit tests for the team+vendor
 * ranker. No app boot: `buildProductionContext` is a pure function, so channel→
 * category mapping, skill-name inference, ranking order, the token cap, and gap
 * analysis are all directly assertable.
 */

import { describe, expect, it } from 'vitest';
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
    expect(cats).toEqual(expect.arrayContaining(['design', 'development', 'writing']));
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

  it('ranks a preferred, high-quality vendor first and surfaces coverage gaps', () => {
    const a = vendor({ vendorId: 'vnd:a', name: 'A', contractStatus: 'active', capabilities: [{ name: 'Copy', category: 'writing', qualityRating: 3 }] });
    const b = vendor({ vendorId: 'vnd:b', name: 'B', contractStatus: 'preferred', capabilities: [{ name: 'Copy', category: 'writing', qualityRating: 5 }] });
    const r = buildProductionContext({ channels: ['email_sequence'], profiles: [], vendors: [a, b] });
    expect(r.rankedVendors[0]?.vendorId).toBe('vnd:b'); // preferred + quality bonus wins
    // email_sequence needs writing/design/strategy — design & strategy are uncovered.
    expect(r.gaps).toEqual(expect.arrayContaining(['design', 'strategy']));
  });

  it('keeps the combined context within the token budget', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      profile({ userId: `u:${i}`, jobTitle: `Designer ${i} `.padEnd(120, 'x'), skills: [{ name: 'design', proficiency: 5, endorsements: [] }] }),
    );
    const r = buildProductionContext({ channels: ['creative_briefs'], profiles: many, vendors: [] });
    // 1500 tokens * 4 chars — the sections together must not exceed the budget.
    expect(r.teamCapabilitySection.length + r.vendorSection.length).toBeLessThanOrEqual(1500 * 4);
    // and the ranker caps at 10 members regardless of input size.
    expect(r.rankedMembers.length).toBeLessThanOrEqual(10);
  });
});

describe('PROD2-M6 (R3) — the vendor contact email is a DECLARED PII field', () => {
  it("contactEmail is declared for production.vendor; a non-PII sibling is not", async () => {
    await import('../src/features/production/productionService.js'); // the declaration is a module side effect
    const { isPiiField } = await import('../src/host/dataClassification.js');
    expect(isPiiField('production.vendor', 'contactEmail')).toBe(true);   // the declaration
    expect(isPiiField('production.vendor', 'region')).toBe(false);        // …and it is not a blanket
  });
});
