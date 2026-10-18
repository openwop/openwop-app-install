/**
 * Suppression list + audience sync (ADR 0217 / campaign gap plan C3):
 *   - suppression CRUD + the honesty rule (system reasons aren't operator-removable)
 *     and the SUPP-1 per-tenant cap counter;
 *   - buildAudienceUpload excludes no-email / consent-refused / suppressed members and
 *     emits exactly sha256(trim+lowercase email) for the rest (raw addresses and
 *     contactIds never in the output);
 *   - adsAdapter.syncAudience DEFAULTS to require-approval (PII-adjacent): one pending
 *     approval per content while pending; approve → the upload proceeds to the platform
 *     leg (no connection in tests ⇒ no_connection — i.e. PAST the gate); 'disabled'
 *     refuses.
 * The email-send suppression subtraction (skipped:'suppressed') is covered by
 * `email-campaign-send.test.ts`, not here.
 *
 * Sabotage that turns it red: drop the lower-casing in `normalizeEmail`; lift the
 * system-reason rule in `removeSuppression`; skip the `+1` counter bump or loosen the cap
 * compare; treat 'suppressed' as clear / skip the consent check / hash a different input
 * in `buildAudienceUpload`; start `syncAudience` approved, re-mint the approval while
 * pending, or ignore the 'disabled' policy.
 * Double guard (honest ceiling): the counter DECREMENT on remove is masked by the
 * boundary scan-verify (`reconcileCount`) — a stale-high counter never refuses, by design.
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __hostExtStorage, __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { addSuppression, isSuppressed, removeSuppression, listSuppressions, __clearSuppressions } from '../src/features/crm/suppressionService.js';
import { buildAudienceUpload } from '../src/features/campaign-connectors/audienceService.js';
import { createSegment } from '../src/features/crm/segmentsService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { recordConsent } from '../src/features/consent/consentService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault, registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { consentFeature } from '../src/features/consent/feature.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { listApprovals, resolveApproval } from '../src/host/approvalService.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';

// Storage-only boot: every subject here is a host-ext DurableCollection.
let storage: Storage;
beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  if (consentFeature.toggleDefault) registerToggleDefault(consentFeature.toggleDefault); // what createApp's feature boot would do
});
afterAll(async () => { await storage.close(); __resetHostExtPersistence(); });

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function storageOrThrow() {
  const s = __hostExtStorage();
  if (!s) throw new Error('host-ext storage not initialized');
  return s;
}

describe('ADR 0217 — suppression service', () => {
  const T = 'user:suppress-test';
  it('normalizes, upserts, and enforces the system-reason removal rule', async () => {
    await addSuppression(T, '  Bounce@Example.COM ', 'bounced', 'test');
    expect(await isSuppressed(T, 'bounce@example.com')).toBe(true);
    expect(await isSuppressed(T, 'BOUNCE@example.com')).toBe(true);
    expect(await isSuppressed('user:other-tenant', 'bounce@example.com')).toBe(false);

    // A system reason is NOT operator-removable…
    await expect(removeSuppression(T, 'bounce@example.com')).rejects.toThrowError(/re-opting in/);
    // …a manual one is.
    await addSuppression(T, 'hold@example.com', 'manual', 'test');
    expect(await removeSuppression(T, 'hold@example.com')).toBe(true);
    expect((await listSuppressions(T)).map((s) => s.email)).toEqual(['bounce@example.com']);
  });

  // SUPP-1 — the fast per-tenant counter enforces the cap without a per-insert
  // list scan, stays correct across add/remove, and never rejects a
  // re-suppression (not a new insert).
  it('enforces the cap via the fast counter and keeps it in sync across remove', async () => {
    const C = 'user:suppress-cap';
    await __clearSuppressions();
    process.env.OPENWOP_SUPPRESSION_MAX = '2';
    try {
      await addSuppression(C, 'a@x.com', 'manual', 'test');
      await addSuppression(C, 'b@x.com', 'manual', 'test');
      // 3rd NEW address is refused at the cap (fast counter → boundary scan-verify).
      await expect(addSuppression(C, 'c@x.com', 'manual', 'test')).rejects.toThrowError(/full/);
      // Re-suppressing an EXISTING address is not a new insert → allowed at cap.
      await addSuppression(C, 'a@x.com', 'complaint', 'test');
      expect((await listSuppressions(C)).length).toBe(2);
      // Free a slot → a new address fits again (the decrement is a fast path; the
      // boundary scan-verify reconciles a stale counter — a double guard, see header).
      expect(await removeSuppression(C, 'b@x.com')).toBe(true);
      await addSuppression(C, 'c@x.com', 'manual', 'test');
      expect(new Set((await listSuppressions(C)).map((s) => s.email))).toEqual(new Set(['a@x.com', 'c@x.com']));
    } finally {
      delete process.env.OPENWOP_SUPPRESSION_MAX;
    }
  });
});

describe('ADR 0217 — audience build (consent + suppression subtraction, hashes only)', () => {
  const T = 'user:audience-test';
  it('excludes no-email + suppressed members and never emits a raw address', async () => {
    const a = await createContact({ tenantId: T, name: 'Ada', email: 'ada@example.com', stage: 'customer' });
    const b = await createContact({ tenantId: T, name: 'Bob', email: 'bob@example.com', stage: 'customer' });
    const c = await createContact({ tenantId: T, name: 'Cy', email: '  Cy.Two@Example.COM ', stage: 'customer' });
    await createContact({ tenantId: T, name: 'NoMail', stage: 'customer' });
    await addSuppression(T, 'bob@example.com', 'unsubscribed', 'test');
    const seg = await createSegment({ tenantId: T, name: 'Customers', filters: [{ field: 'stage', op: 'eq', value: 'customer' }], createdBy: 'test' });

    const upload = await buildAudienceUpload(T, seg.segmentId);
    // Exactly sha256 of the NORMALIZED (trim + lowercase) address — never another input.
    const expected = [sha256('ada@example.com'), sha256('cy.two@example.com')].sort();
    expect([...upload.memberHashes].sort()).toEqual(expected);
    expect(upload.size).toBe(2);
    expect(upload.membersKey).toBe(sha256(JSON.stringify(expected)));
    expect(upload.excluded).toMatchObject({ noEmail: 1, suppressed: 1, consent: 0 });
    const raw = JSON.stringify(upload);
    expect(raw).not.toContain('ada@example.com');
    expect(raw).not.toContain('bob@example.com');
    expect(raw.toLowerCase()).not.toContain('cy.two@example.com');
    expect([a.contactId, b.contactId, c.contactId].some((id) => raw.includes(id))).toBe(false);
  });

  it('with consent enforcement ON, a contact who refused marketing is excluded (never hashed)', async () => {
    const TC = 'user:audience-consent-test';
    const d = getToggleDefault('consent');
    expect(d, 'the consent toggle must be declared for this case to mean anything').toBeTruthy();
    await saveConfig({ ...d!, status: 'on' }, 'test');
    try {
      const yes = await createContact({ tenantId: TC, name: 'Yes', email: 'yes@example.com', stage: 'customer' });
      const no = await createContact({ tenantId: TC, name: 'No', email: 'no@example.com', stage: 'customer' });
      await recordConsent({ tenantId: TC, subjectKey: yes.contactId, categories: { marketing: true }, source: 'test', legalBasis: 'consent' });
      await recordConsent({ tenantId: TC, subjectKey: no.contactId, categories: { marketing: false }, source: 'test', legalBasis: 'consent' });
      const seg = await createSegment({ tenantId: TC, name: 'Customers', filters: [{ field: 'stage', op: 'eq', value: 'customer' }], createdBy: 'test' });

      const upload = await buildAudienceUpload(TC, seg.segmentId);
      expect(upload.memberHashes).toEqual([sha256('yes@example.com')]);
      expect(upload.excluded).toMatchObject({ consent: 1, consentUnreadable: 0, suppressed: 0 });
    } finally {
      await saveConfig(d!, 'test');
    }
  });
});

describe('ADR 0217 — syncAudience gate (default require-approval)', () => {
  const T = 'user:audience-gate-test';
  const args = {
    platform: 'meta' as const, adAccountId: 'act_9', audienceName: 'Customers',
    memberHashes: ['a'.repeat(64)], membersKey: 'k'.repeat(64),
  };
  it('unset policy → approval required; approved → proceeds; disabled → refused', async () => {
    const adapter = makeAdsAdapter({ storage: storageOrThrow(), tenantId: T, runId: 'run-a', actingUserId: 'u1' });

    const r1 = await adapter.syncAudience(args);
    if (r1.outcome !== 'requires_approval') throw new Error(`expected requires_approval, got ${JSON.stringify(r1)}`);
    const approvalId = r1.approvalId;
    const appr = (await listApprovals(T, 'pending')).find((a) => a.approvalId === approvalId);
    expect(appr?.kind).toBe('campaign-spend');
    expect(appr?.spendKind).toBe('audience');

    // Same content while pending → the same approval.
    const r2 = await adapter.syncAudience(args);
    expect(r2).toEqual({ outcome: 'requires_approval', approvalId });
    // COUNT, not just compare ids: exactly one pending spend approval for the tenant.
    expect((await listApprovals(T, 'pending')).filter((p) => p.kind === 'campaign-spend')).toHaveLength(1);

    await resolveApproval(approvalId, { status: 'approved' });
    const r3 = await adapter.syncAudience(args);
    expect(r3.outcome).toBe('no_connection'); // past the gate, into the platform leg

    await setGovernancePolicy(T, { actionPolicy: { 'ads.audience': 'disabled' } }, 'test');
    const r4 = await adapter.syncAudience({ ...args, audienceName: 'Other' });
    expect(r4).toEqual({ outcome: 'failed', error: 'policy_disabled' });
  });
});
