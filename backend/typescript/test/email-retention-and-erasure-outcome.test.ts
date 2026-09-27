/**
 * ADR 0655 D9 — EM-17 (the send log and the soft-bounce streak age out through the
 * REAL retention purgers, tenant-scoped) and EM-24 (`deleteSubjectSends` returns an
 * OUTCOME so one bad row cannot abort the fan-out and pin the address-bearing token
 * store behind it).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { processRetentionSweep } from '../src/host/retentionSweepDaemon.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { deleteSubjectSends, __resetEmailStore } from '../src/features/email/emailService.js';

const DAY = 86_400_000;
const now = 1_900_000_000_000;

interface SendLogRow { sendId: string; tenantId: string; campaignId: string; contactId: string; status: string; ts: string }
const sendLogs = new DurableCollection<SendLogRow>('email:sendlog', (s) => s.sendId, undefined, (s) => s.tenantId);
interface SoftRow { key: string; tenantId: string; email: string; consecutive: number; updatedAt: string }
const soft = new DurableCollection<SoftRow>('email:soft-bounce-count', (c) => c.key, undefined, (c) => c.tenantId);

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetEmailStore();
});

describe('EM-17 — the real purgers age the send log and the soft-bounce streak', () => {
  it('past-window rows go, fresh rows and other tenants stay', async () => {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    const row = (id: string, tenantId: string, ageDays: number): SendLogRow => ({ sendId: id, tenantId, campaignId: 'c', contactId: 'ct', status: 'sent', ts: new Date(now - ageDays * DAY).toISOString() });
    await sendLogs.put(row('old', 'tenantA', 400)); await sendLogs.put(row('fresh', 'tenantA', 10)); await sendLogs.put(row('foreign', 'tenantB', 400));
    await soft.put({ key: 'tenantA:a@x.test', tenantId: 'tenantA', email: 'a@x.test', consecutive: 2, updatedAt: new Date(now - 400 * DAY).toISOString() });
    await soft.put({ key: 'tenantA:b@x.test', tenantId: 'tenantA', email: 'b@x.test', consecutive: 1, updatedAt: new Date(now - 3 * DAY).toISOString() });
    await processRetentionSweep({ storage }, now);
    expect((await sendLogs.listForTenantIndexed('tenantA')).map((r) => r.sendId).sort()).toEqual(['fresh']);
    expect((await sendLogs.listForTenantIndexed('tenantB')).map((r) => r.sendId)).toEqual(['foreign']);
    expect((await soft.listForTenantIndexed('tenantA')).map((r) => r.email)).toEqual(['b@x.test']);
  });
});

describe('EM-24 — deleteSubjectSends returns an outcome, never throws mid-loop', () => {
  it('counts removed rows and never crosses a tenant', async () => {
    await sendLogs.put({ sendId: 's1', tenantId: 'tX', campaignId: 'c', contactId: 'subj', status: 'sent', ts: new Date().toISOString() });
    await sendLogs.put({ sendId: 's2', tenantId: 'tX', campaignId: 'c', contactId: 'other', status: 'sent', ts: new Date().toISOString() });
    await sendLogs.put({ sendId: 's3', tenantId: 'tY', campaignId: 'c', contactId: 'subj', status: 'sent', ts: new Date().toISOString() });
    expect(await deleteSubjectSends('tX', 'subj')).toEqual({ removed: 1, failed: 0 });
    expect(await deleteSubjectSends('tX', 'subj')).toEqual({ removed: 0, failed: 0 });
    expect(await deleteSubjectSends('tX', '')).toEqual({ removed: 0, failed: 0 });
    expect((await sendLogs.listForTenantIndexed('tY')).length).toBe(1);
  });
});
