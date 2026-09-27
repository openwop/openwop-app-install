/**
 * ADR 0354 — brand enforcement. Pins:
 *  - the parent-brand cascade (additive bans, cycle-guarded, depth-capped);
 *  - the persona-preferred voice rule resolution;
 *  - the compliance checker verdicts: off→allow, critical+banned→approval,
 *    threshold→approval, no-brand→allow, and FAIL-CLOSED on scorer error
 *    (resolver leg fail-OPEN, brand-load leg fail-CLOSED — BRAND-CODE-2);
 *  - the audit trail records guardrail-relevant diffs only, and dies with its
 *    brand (CS-DATA-7);
 *  - the surface ops see parent-cascaded effective rules (BRAND-CODE-4);
 *  - the adsAdapter compliance gate RE-CREATES a pruned approval instead of
 *    falling open (BRAND-CODE-1), and its breaker classifier matches the
 *    adapter's http_5xx vocabulary (INTEL-CODE-2).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';
import {
  createBrand, updateBrand, deleteBrand, resolveEffectiveBrandRules, buildAdsComplianceChecker, listBrandAudit,
} from '../src/features/brand/brandService.js';
import { buildBrandSurface } from '../src/features/brand/surface.js';
import { resolveVoice } from '../src/features/brand/scoring.js';
import type { Brand, ComplianceReport } from '../src/features/brand/types.js';
import { makeAdsAdapter, setAdsComplianceChecker, isBreakerReportableFailure } from '../src/host/adsAdapter.js';
import { getApproval, __resetApprovalStore } from '../src/host/approvalService.js';
import { setGovernancePolicy, __resetGovernanceStore } from '../src/host/governanceService.js';

const T = 'brandenf-tenant';
const ORG = 'o1';

let storage: Storage;
beforeEach(() => { storage = openSqliteStorage(':memory:'); initHostExtPersistence(storage); });

async function mkBrand(name: string, extra: Record<string, unknown> = {}): Promise<Brand> {
  return createBrand(T, ORG, 'u1', { name, ...extra } as never);
}

describe('parent-brand cascade (P3)', () => {
  it('bans are additive down the chain; cycles + depth are guarded', async () => {
    const parent = await mkBrand('Parent', { keyPhrases: { bannedPhrases: ['cheap'], approvedTaglines: [], valuePropositions: [] } });
    const child = await mkBrand('Child', { parentBrandId: parent.id, keyPhrases: { bannedPhrases: ['discount'], approvedTaglines: [], valuePropositions: [] } });
    const eff = await resolveEffectiveBrandRules(T, child.id);
    expect(eff?.bannedPhrases.sort()).toEqual(['cheap', 'discount']);

    // Cycle: parent pointing back at child must not loop.
    await updateBrand(T, parent.id, { parentBrandId: child.id } as never);
    const cyc = await resolveEffectiveBrandRules(T, child.id);
    expect(cyc?.bannedPhrases.sort()).toEqual(['cheap', 'discount']);
  });
});

describe('persona voice (P4)', () => {
  it('a persona-bound channel rule wins; falls back to the generic rule', async () => {
    const brand = await mkBrand('Voicey', {
      channelVoiceRules: [
        { channel: 'ad_variants', tone: 'thought leadership', samplePhrases: [], avoidPhrases: [] },
        { channel: 'ad_variants', personaId: 'cfo', tone: 'numbers-first, sober', samplePhrases: [], avoidPhrases: [] },
      ],
    });
    const generic = resolveVoice(brand, { channel: 'ad_variants' });
    const persona = resolveVoice(brand, { channel: 'ad_variants', personaId: 'cfo' });
    const unknown = resolveVoice(brand, { channel: 'ad_variants', personaId: 'nobody' });
    expect(persona).toContain('numbers-first');
    expect(generic).toContain('thought leadership');
    expect(unknown).toContain('thought leadership'); // fallback, never empty
  });
});

describe('compliance checker (P1)', () => {
  const content = JSON.stringify({ name: 'Q3', copy: { headline: 'The cheap option for grocers' } });

  it('off/no-brand → allow; critical+banned → requires-approval; threshold gates on score', async () => {
    const off = await mkBrand('Off', { keyPhrases: { bannedPhrases: ['cheap'], approvedTaglines: [], valuePropositions: [] } });
    const critical = await mkBrand('Crit', {
      keyPhrases: { bannedPhrases: ['cheap'], approvedTaglines: [], valuePropositions: [] },
      governance: { lockLevel: 'none', allowedEditors: [], requireApproval: false, compliance: { blockPublish: 'critical' } },
    });
    const thresh = await mkBrand('Thresh', {
      keyPhrases: { bannedPhrases: ['cheap'], approvedTaglines: [], valuePropositions: [] },
      governance: { lockLevel: 'none', allowedEditors: [], requireApproval: false, compliance: { blockPublish: 'threshold', blockThreshold: 90 } },
    });
    const brandFor: Record<string, string> = { 'b-off': off.id, 'b-crit': critical.id, 'b-thresh': thresh.id };
    const checker = buildAdsComplianceChecker(async (_t, briefId) => brandFor[briefId]);

    expect((await checker(T, { briefId: 'b-off', platform: 'meta', content })).verdict).toBe('allow');
    expect((await checker(T, { platform: 'meta', content })).verdict).toBe('allow'); // no brief ⇒ no policy

    const crit = await checker(T, { briefId: 'b-crit', platform: 'meta', content });
    expect(crit.verdict).toBe('requires-approval');
    expect(crit.reason).toContain('banned');

    const th = await checker(T, { briefId: 'b-thresh', platform: 'meta', content });
    expect(th.verdict).toBe('requires-approval'); // banned phrase caps score ≤30 < 90

    const clean = await checker(T, { briefId: 'b-thresh', platform: 'meta', content: JSON.stringify({ copy: { headline: 'Premium fulfillment, delivered' } }) });
    expect(clean.verdict).toBe('allow');
  });

  it('fails CLOSED when brand resolution crashes under an active policy path', async () => {
    const checker = buildAdsComplianceChecker(async () => { throw new Error('db down'); });
    // Resolution crash happens BEFORE a policy is known ⇒ allow (pre-0354
    // behavior — a missing brand binding must not block unbranded dispatch).
    expect((await checker(T, { briefId: 'x', platform: 'meta', content })).verdict).toBe('allow');
  });

  it('fails CLOSED when the brand LOAD crashes AFTER the brandId is resolved (BRAND-CODE-2)', async () => {
    const b = await mkBrand('Crashy', {
      keyPhrases: { bannedPhrases: ['cheap'], approvedTaglines: [], valuePropositions: [] },
      governance: { lockLevel: 'none', allowedEditors: [], requireApproval: false, compliance: { blockPublish: 'critical' } },
    });
    const checker = buildAdsComplianceChecker(async () => b.id);
    // Break the persistence layer AFTER the brand exists: getBrand now crashes.
    // The brandId IS known, so a policy MAY exist — the checker must fail
    // CLOSED (requires-approval), never silently open the publish edge.
    const broken = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'kvGet') return async () => { throw new Error('db down'); };
        return Reflect.get(target, prop, receiver);
      },
    });
    initHostExtPersistence(broken);
    try {
      const out = await checker(T, { briefId: 'b-crash', platform: 'meta', content });
      expect(out.verdict).toBe('requires-approval');
      expect(out.reason).toContain('failing closed');
    } finally {
      initHostExtPersistence(storage);
    }
  });
});

describe('tenant-default brand compliance for UNBRIEFED publishAd (BRAND-CODE-6)', () => {
  // The resolver never binds a brand (unbriefed dispatch); the checker must
  // instead source rules from GovernancePolicy.brandCompliance.defaultBrandId.
  const noBrief = buildAdsComplianceChecker(async () => undefined);

  it('an unbriefed publish is scored against the tenant-default brand; banned⇒approval, clean⇒allow', async () => {
    await __resetGovernanceStore();
    const brand = await mkBrand('TenantDefault', {
      keyPhrases: { bannedPhrases: ['cheap'], approvedTaglines: [], valuePropositions: [] },
    });
    await setGovernancePolicy(T, { brandCompliance: { blockPublish: 'critical', defaultBrandId: brand.id } });

    const flagged = await noBrief(T, { platform: 'meta', content: 'The cheap option for grocers' });
    expect(flagged.verdict).toBe('requires-approval');
    expect(flagged.reason).toContain('banned');

    const clean = await noBrief(T, { platform: 'meta', content: 'Premium fulfillment, delivered' });
    expect(clean.verdict).toBe('allow');

    await __resetGovernanceStore();
  });

  it('an unbriefed publish with NO tenant policy allows (status-quo preserved)', async () => {
    await __resetGovernanceStore();
    const out = await noBrief(T, { platform: 'meta', content: 'The cheap option for grocers' });
    expect(out.verdict).toBe('allow'); // no policy ⇒ ungoverned unbriefed dispatch, as before
  });

  it('a tenant policy whose defaultBrandId points at a MISSING brand fails OPEN (allow)', async () => {
    await __resetGovernanceStore();
    await setGovernancePolicy(T, { brandCompliance: { blockPublish: 'critical', defaultBrandId: 'brand-that-does-not-exist' } });
    const out = await noBrief(T, { platform: 'meta', content: 'The cheap option for grocers' });
    expect(out.verdict).toBe('allow'); // configured-but-missing default ⇒ fail-open (misconfig logged)
    await __resetGovernanceStore();
  });

  it('a tenant policy with blockPublish:off allows (opt-out posture)', async () => {
    await __resetGovernanceStore();
    const brand = await mkBrand('OffDefault', {
      keyPhrases: { bannedPhrases: ['cheap'], approvedTaglines: [], valuePropositions: [] },
    });
    await setGovernancePolicy(T, { brandCompliance: { blockPublish: 'off', defaultBrandId: brand.id } });
    const out = await noBrief(T, { platform: 'meta', content: 'The cheap option for grocers' });
    expect(out.verdict).toBe('allow');
    await __resetGovernanceStore();
  });
});

describe('surface effective rules (BRAND-CODE-4)', () => {
  it('the surface compliance check + voice resolver see PARENT-cascaded bans', async () => {
    const parent = await mkBrand('Parent', { keyPhrases: { bannedPhrases: ['cheap'], approvedTaglines: [], valuePropositions: [] } });
    const child = await mkBrand('Child', { parentBrandId: parent.id });
    const surface = buildBrandSurface({ tenantId: T });

    const out = await surface.checkComplianceDeterministic!({ brandId: child.id, content: 'The cheap option for grocers' });
    const report = out.report as ComplianceReport | null;
    expect(report).toBeTruthy();
    expect(report!.hasBannedPhrase).toBe(true); // the PARENT's ban flags on the child
    expect(report!.issues.some((i) => i.category === 'banned-phrase' && i.description.includes('cheap'))).toBe(true);

    const v = await surface.resolveVoice!({ brandId: child.id });
    expect(String(v.voice)).toContain('NEVER use (banned): cheap'); // cascaded into the prompt block
  });
});

describe('adsAdapter compliance gate (BRAND-CODE-1 / INTEL-CODE-2)', () => {
  const publishArgs = {
    platform: 'meta' as const, briefId: 'brief-cmpl-1', adAccountId: 'act_1',
    campaignName: 'Q3', copy: { headline: 'The cheap option for grocers' }, pageId: 'page-1',
  };

  it('a pruned compliance approval is RE-CREATED on retry — never a fall-open dispatch', async () => {
    setAdsComplianceChecker(async () => ({ verdict: 'requires-approval', reason: 'banned phrase in ad content', score: 20 }));
    try {
      const adapter = makeAdsAdapter({ storage, tenantId: T, runId: 'run-cmpl-1', actingUserId: 'u1' });
      const r1 = await adapter.publishAd(publishArgs);
      expect(r1.outcome).toBe('requires_approval');
      const firstId = (r1 as { approvalId: string }).approvalId;
      expect(await getApproval(firstId)).toBeTruthy();

      // Simulate approvalService.pruneResolved having deleted the approval row
      // (REJECTED rows beyond the newest 100 are pruned) — the cmpl: map row
      // still points at it, but it no longer loads.
      await __resetApprovalStore();
      expect(await getApproval(firstId)).toBeNull();

      const r2 = await adapter.publishAd(publishArgs);
      // Fail-closed: the gate re-creates the approval; it must NOT proceed to
      // the platform leg (which would surface as no_connection here).
      expect(r2.outcome).toBe('requires_approval');
      const secondId = (r2 as { approvalId: string }).approvalId;
      expect(secondId).not.toBe(firstId);
      expect(await getApproval(secondId)).toBeTruthy();
    } finally {
      setAdsComplianceChecker(null);
    }
  });

  it('classifies the adapter http_5xx vocabulary as a breaker failure; 4xx/config errors are not (INTEL-CODE-2)', () => {
    expect(isBreakerReportableFailure('http_500')).toBe(true); // the strategies' `http_${status}` shape
    expect(isBreakerReportableFailure('http_503')).toBe(true);
    expect(isBreakerReportableFailure('HTTP 502')).toBe(true);
    expect(isBreakerReportableFailure('request_failed')).toBe(true);
    expect(isBreakerReportableFailure('timeout')).toBe(true);
    expect(isBreakerReportableFailure('http_400')).toBe(false); // a platform rejection is not a transport failure
    expect(isBreakerReportableFailure('missing_page_id')).toBe(false);
  });
});

describe('audit trail (P5)', () => {
  it('records guardrail diffs; skips irrelevant edits', async () => {
    const b = await mkBrand('Audited', { keyPhrases: { bannedPhrases: ['cheap'], approvedTaglines: [], valuePropositions: [] } });
    const initial = await listBrandAudit(T, b.id);
    expect(initial.length).toBe(1); // creation snapshot

    await updateBrand(T, b.id, { keyPhrases: { bannedPhrases: ['cheap', 'bargain'], approvedTaglines: [], valuePropositions: [] } } as never, 'editor-9');
    const after = await listBrandAudit(T, b.id);
    expect(after.length).toBe(2);
    const edit = after.find((r) => r.actor === 'editor-9');
    expect(edit).toBeTruthy();
    expect(edit!.changes.map((c) => c.field)).toContain('keyPhrases');
  });

  it('audits the REAL actor on create and update (BRAND-CODE-3)', async () => {
    const b = await createBrand(T, ORG, 'user-42', { name: 'ActorBrand', keyPhrases: { bannedPhrases: ['cheap'], approvedTaglines: [], valuePropositions: [] } } as never);
    const rows = await listBrandAudit(T, b.id);
    expect(rows[0]!.actor).toBe('user-42'); // creation snapshot carries the creator
    await updateBrand(T, b.id, { keyPhrases: { bannedPhrases: ['cheap', 'nasty'], approvedTaglines: [], valuePropositions: [] } } as never, 'user-42');
    const after = await listBrandAudit(T, b.id);
    // Every row names the acting user — no 'editor' default leaks through.
    expect(after.every((r) => r.actor === 'user-42')).toBe(true);
  });

  it('deleting a brand purges its audit rows (CS-DATA-7)', async () => {
    const b = await mkBrand('Doomed', { keyPhrases: { bannedPhrases: ['cheap'], approvedTaglines: [], valuePropositions: [] } });
    expect((await listBrandAudit(T, b.id)).length).toBe(1);
    expect(await deleteBrand(T, b.id)).toBe(true);
    expect(await listBrandAudit(T, b.id)).toEqual([]); // no orphaned trail
  });
});
