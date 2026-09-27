/**
 * Suppression list + audience sync (ADR 0217 / campaign gap plan C3):
 *   - suppression CRUD + the honesty rule (system reasons aren't operator-removable);
 *   - the email send subtracts suppressed recipients (skipped:'suppressed');
 *   - buildAudienceUpload excludes no-email/suppressed members and hashes the rest
 *     (raw addresses never in the output);
 *   - adsAdapter.syncAudience DEFAULTS to require-approval (PII-adjacent);
 *     approve → the upload proceeds to the platform leg (no connection in tests
 *     ⇒ no_connection — i.e. PAST the gate); 'disabled' refuses.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { addSuppression, isSuppressed, removeSuppression, listSuppressions, __clearSuppressions } from '../src/features/crm/suppressionService.js';
import { buildAudienceUpload } from '../src/features/campaign-connectors/audienceService.js';
import { createSegment } from '../src/features/crm/segmentsService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { listApprovals, resolveApproval } from '../src/host/approvalService.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

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
      // Free a slot → the counter decremented → a new address fits again.
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
    await createContact({ tenantId: T, name: 'NoMail', stage: 'customer' });
    await addSuppression(T, 'bob@example.com', 'unsubscribed', 'test');
    const seg = await createSegment({ tenantId: T, name: 'Customers', filters: [{ field: 'stage', op: 'eq', value: 'customer' }], createdBy: 'test' });

    const upload = await buildAudienceUpload(T, seg.segmentId);
    expect(upload.size).toBe(1);
    expect(upload.excluded).toMatchObject({ noEmail: 1, suppressed: 1 });
    expect(upload.memberHashes[0]).toMatch(/^[0-9a-f]{64}$/);
    const raw = JSON.stringify(upload);
    expect(raw).not.toContain('ada@example.com');
    expect(raw).not.toContain('bob@example.com');
    expect([a.contactId, b.contactId].some((id) => raw.includes(id))).toBe(false);
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
    expect(r1.outcome).toBe('requires_approval');
    const approvalId = (r1 as { approvalId: string }).approvalId;
    const appr = (await listApprovals(T, 'pending')).find((a) => a.approvalId === approvalId);
    expect(appr?.kind).toBe('campaign-spend');
    expect(appr?.spendKind).toBe('audience');

    // Same content while pending → the same approval.
    const r2 = await adapter.syncAudience(args);
    expect((r2 as { approvalId: string }).approvalId).toBe(approvalId);

    await resolveApproval(approvalId, { status: 'approved' });
    const r3 = await adapter.syncAudience(args);
    expect(r3.outcome).toBe('no_connection'); // past the gate, into the platform leg

    await setGovernancePolicy(T, { actionPolicy: { 'ads.audience': 'disabled' } }, 'test');
    const r4 = await adapter.syncAudience({ ...args, audienceName: 'Other' });
    expect(r4).toEqual({ outcome: 'failed', error: 'policy_disabled' });
  });
});
