/**
 * ADR 0684 phase 1 — feature-declared default orgs.
 *
 * The refusals matter more than the happy path here: a bad declaration must stop
 * the deployment at BOOT, not surface as a 404 to the first stranger who visits.
 *
 * Sabotage that turns it red (each witnessed by /grade-tests probe):
 *  - hyphen-form regex / EQUAL / reserved / two-owner checks dropped → the matching REFUSES case
 *  - collision check widened to any prior                            → allows the SAME feature to re-declare
 *  - OPENWOP_DISABLE_FEATURE_DEFAULT_ORGS ignored                     → operator opt-out
 *  - validation moved inside the create loop                         → validates BEFORE creating anything
 *  - `ensureWorkspaceRootOrg` re-creates every boot                  → idempotent across boots (fixed clock)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { assertDeclarationLegal, ensureFeatureDefaultOrgs, type FeatureDefaultOrg } from '../src/host/featureDefaultOrgs.js';
import { getOrg } from '../src/host/accessControlService.js';
import { SYSTEM_SITE_ORG } from '../src/host/systemSite.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

const decl = (over: Partial<FeatureDefaultOrg> = {}): FeatureDefaultOrg => ({
  featureId: 'demo-feature', orgId: 'host-demo', tenantId: 'host-demo', name: 'Demo', ...over,
});

describe('ADR 0684 §4 — declaration legality, asserted at boot', () => {
  // CORRECTED 2026-09-15. The two cases that used to sit here asserted the
  // EXACT INVERSE of the rule this seam needs, and they were green the whole
  // time: "accepts the hyphen/colon pair" and "REFUSES a tenant id that is not
  // the colon form". A declaration satisfying them can never be an enterable
  // workspace, because this host defines a workspace as an org whose id EQUALS
  // its tenant. The suite was a faithful mirror of the defect, which is why
  // nothing went red for a year and why it took a production sign-in to find.
  //
  // Keeping this note rather than silently rewriting the cases: a test that
  // pinned the wrong invariant is worth more as a recorded warning than as a
  // deleted line.
  it('accepts a workspace-root declaration (orgId === tenantId)', () => {
    expect(() => assertDeclarationLegal(decl(), new Map())).not.toThrow();
  });

  it('REFUSES ids that DIFFER — the pair that shipped an unenterable org', () => {
    expect(() => assertDeclarationLegal(decl({ orgId: 'host-demo', tenantId: 'host:demo' }), new Map()))
      .toThrow(/EQUAL/i);
  });

  it('REFUSES a colon in the org id — it lands in a public URL path segment', () => {
    expect(() => assertDeclarationLegal(decl({ orgId: 'host:demo', tenantId: 'host:demo' }), new Map()))
      .toThrow(/hyphen form/i);
  });

  it('REFUSES the reserved host-site org', () => {
    expect(() => assertDeclarationLegal(decl({ orgId: SYSTEM_SITE_ORG, tenantId: SYSTEM_SITE_ORG }), new Map()))
      .toThrow(/reserved/i);
  });

  it('REFUSES two features claiming one org — two owners is the drift this avoids', () => {
    const seen = new Map<string, string>();
    assertDeclarationLegal(decl({ featureId: 'first' }), seen);
    expect(() => assertDeclarationLegal(decl({ featureId: 'second' }), seen))
      .toThrow(/both declare/i);
  });

  it('allows the SAME feature to re-declare (idempotent boot, not a collision)', () => {
    const seen = new Map<string, string>();
    assertDeclarationLegal(decl(), seen);
    expect(() => assertDeclarationLegal(decl(), seen)).not.toThrow();
  });
});

describe('ADR 0684 phase 1 — provisioning', () => {
  const PRIOR = process.env['OPENWOP_DISABLE_FEATURE_DEFAULT_ORGS'];
  afterEach(() => {
    if (PRIOR === undefined) delete process.env['OPENWOP_DISABLE_FEATURE_DEFAULT_ORGS'];
    else process.env['OPENWOP_DISABLE_FEATURE_DEFAULT_ORGS'] = PRIOR;
  });
  beforeEach(() => { delete process.env['OPENWOP_DISABLE_FEATURE_DEFAULT_ORGS']; });

  it('provisions a declared org, and is idempotent across boots', async () => {
    const d = decl({ orgId: 'host-p1a', tenantId: 'host-p1a' });
    // Only `Date` is faked: a re-create on the second boot would stamp a
    // DIFFERENT createdAt, instead of possibly the same millisecond.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await ensureFeatureDefaultOrgs([d]);
      const first = await getOrg('host-p1a');
      expect(first?.tenantId).toBe('host-p1a');

      // A redeploy must be a no-op, not a second row or a throw.
      vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
      await ensureFeatureDefaultOrgs([d]);
      const second = await getOrg('host-p1a');
      expect(second?.orgId).toBe(first?.orgId);
      expect(second?.createdAt).toBe(first?.createdAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the operator opt-out suppresses every declaration', async () => {
    process.env['OPENWOP_DISABLE_FEATURE_DEFAULT_ORGS'] = 'true';
    await ensureFeatureDefaultOrgs([decl({ orgId: 'host-p1b', tenantId: 'host-p1b' })]);
    expect(await getOrg('host-p1b')).toBeNull();
  });

  it('validates BEFORE creating anything — one bad declaration provisions none', async () => {
    // Order matters: a legal declaration listed first must NOT be created when a
    // later one is illegal, or a failed boot leaves half a deployment behind.
    await expect(ensureFeatureDefaultOrgs([
      decl({ featureId: 'ok', orgId: 'host-p1c', tenantId: 'host-p1c' }),
      decl({ featureId: 'bad', orgId: SYSTEM_SITE_ORG, tenantId: SYSTEM_SITE_ORG }),
    ])).rejects.toThrow(/reserved/i);
    expect(await getOrg('host-p1c')).toBeNull();
  });
});
