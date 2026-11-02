/** ADR 0954 P3: SQLite rung/inbox receipts survive failed writes and lost
 * acknowledgements; erasure seals a pending recipient before retry.
 *
 * The four collaborators the rung reads (lead profile, routing decision,
 * contact, effective access) are mocked with fixtures typed against the real
 * exports, so a field the product starts reading cannot be silently absent.
 *
 * Double guard (recorded): after recipient erasure a resumed writer is refused
 * twice — by the sealed rung (`superseded`) and by `canSeeClient`'s tombstone
 * read. "recipient erasure seals…" therefore reads the rung row directly after
 * erasure, so the seal itself is observable (w74 round 1: the probe on the seal
 * alone was vacuous until this read existed).
 *
 * "deduplicates concurrent recovery…" does not force its race: two direct
 * `fireSlaRung` calls interleave at their awaits, and the case asserts the
 * loser's observable (`fired: false`), witnessed by probe sld-cas-loser.
 *
 * Sabotage-witnessed (w74 probes sld-*): no durable-row check after emit; a
 * swallowed or always-rethrown insert error; re-emitting over a committed row;
 * no replay gate before reserving; a blind rung reservation; cancelled inbox
 * rows never deleted. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setNotificationBackend } from '../src/notifications/emitter.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import { eraseSlaSettingsSubjects, fireSlaRung, getSlaRung } from '../src/features/crm/leadIntel/speedToLead.js';
import type { LeadProfile } from '../src/features/crm/leadIntel/leadStore.js';
import type { RoutingDecision } from '../src/features/crm/leadIntel/routing.js';
import type { Contact } from '../src/features/crm/contactsService.js';
import type { EffectiveAccess } from '../src/host/accessControlService.js';

const f = vi.hoisted(() => ({ tenantId: 'sla-delivery', orgId: 'client', contactId: 'lead', owner: 'recipient' }));
vi.mock('../src/features/crm/leadIntel/leadStore.js', async (original) => ({ ...await original<typeof import('../src/features/crm/leadIntel/leadStore.js')>(), getLeadProfile: async (): Promise<LeadProfile> => ({
  tenantId: f.tenantId, orgId: f.orgId, contactId: f.contactId, source: 'form', status: 'new', boundBy: 'operator', routingEpoch: 1,
  createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z',
}) }));
vi.mock('../src/features/crm/leadIntel/routing.js', async (original) => ({ ...await original<typeof import('../src/features/crm/leadIntel/routing.js')>(), getRoutingDecision: async (): Promise<RoutingDecision> => ({
  key: `${f.tenantId}::${f.orgId}::${f.contactId}::1`, tenantId: f.tenantId, orgId: f.orgId, contactId: f.contactId, routingEpoch: 1, runId: 'source',
  policyVersion: 1, ruleId: 'named', strategy: 'named', candidates: [f.owner], skipped: [], chosen: f.owner, pointerBefore: null, decidedAt: '2026-10-20T10:00:00.000Z',
}) }));
vi.mock('../src/features/crm/contactsService.js', async (original) => ({ ...await original<typeof import('../src/features/crm/contactsService.js')>(), getContact: async (): Promise<Contact> => ({
  contactId: f.contactId, tenantId: f.tenantId, name: 'Private Contact Name', stage: 'lead', customFields: {},
  createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z',
}) }));
vi.mock('../src/host/accessControlService.js', async (original) => ({ ...await original<typeof import('../src/host/accessControlService.js')>(), resolveEffectiveAccess: async (): Promise<EffectiveAccess> => ({ roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' }) }));
let storage: Storage; let directory: string; let database: string;
async function reopen(): Promise<void> { await storage.close(); storage = openSqliteStorage(database); initHostExtPersistence(storage); setNotificationBackend(storage); }
const fire = () => fireSlaRung({ tenantId: f.tenantId, orgId: f.orgId, contactId: f.contactId, routingEpoch: 1, rung: 1, runId: 'source' });
const notices = () => storage.listNotifications({ tenantId: f.tenantId, recipientUserId: f.owner });
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'owp-sla-delivery-')); database = join(directory, 'state.sqlite'); storage = openSqliteStorage(database); initHostExtPersistence(storage); setNotificationBackend(storage); });
afterEach(async () => { vi.restoreAllMocks(); await storage.close(); __resetHostExtPersistence(); rmSync(directory, { recursive: true }); });

it('retries an uncommitted inbox insert after reopening instead of acknowledging the rung', async () => {
  vi.spyOn(storage, 'insertNotification').mockRejectedValueOnce(new Error('inbox unavailable'));
  await expect(fire()).rejects.toThrow('inbox unavailable');
  expect(await notices()).toHaveLength(0);
  expect((await getSlaRung(f.tenantId, f.orgId, f.contactId, 1, 1))?.outcome).toBe('notifying');
  vi.restoreAllMocks(); await reopen();
  expect(await fire()).toEqual({ outcome: 'reminded-owner', fired: false });
  expect(await notices()).toHaveLength(1);
});

it('recovers a committed reservation whose acknowledgement was lost before inbox delivery', async () => {
  const cas = storage.kvCompareAndSwap.bind(storage); let lost = false;
  vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
    const applied = await cas(key, expected, next);
    if (!lost && applied && key.startsWith('hostext:crm:lead-sla-rung:') && JSON.parse(next).outcome === 'notifying') { lost = true; throw new Error('reservation acknowledgement lost'); }
    return applied;
  });
  await expect(fire()).rejects.toThrow('reservation acknowledgement lost'); expect(lost).toBe(true); expect(await notices()).toHaveLength(0);
  vi.restoreAllMocks(); await reopen();
  expect(await fire()).toEqual({ outcome: 'reminded-owner', fired: false }); expect(await notices()).toHaveLength(1);
});

it('requires a durable inbox row even when an emitter call returned successfully', async () => {
  vi.spyOn(storage, 'insertNotification').mockResolvedValueOnce();
  await expect(fire()).rejects.toMatchObject({ httpStatus: 503, details: { reason: 'sla_notice_pending' } });
  expect((await getSlaRung(f.tenantId, f.orgId, f.contactId, 1, 1))?.outcome).toBe('notifying'); expect(await notices()).toHaveLength(0);
  vi.restoreAllMocks(); await reopen(); expect(await fire()).toEqual({ outcome: 'reminded-owner', fired: false }); expect(await notices()).toHaveLength(1);
});

it('a replay reaching an unrecorded rung is refused before reserving or notifying', async () => {
  await expect(runWithEffectContext({ runId: 'fork', replaying: true }, fire)).rejects.toMatchObject({ name: 'ReplayEffectError' });
  expect(await getSlaRung(f.tenantId, f.orgId, f.contactId, 1, 1)).toBeNull(); expect(await notices()).toHaveLength(0);
});

it('uses the committed inbox receipt after a lost insert acknowledgement without another insert', async () => {
  const insert = storage.insertNotification.bind(storage);
  vi.spyOn(storage, 'insertNotification').mockImplementationOnce(async (record) => { await insert(record); throw new Error('insert acknowledgement lost'); });
  expect(await fire()).toEqual({ outcome: 'reminded-owner', fired: true });
  vi.restoreAllMocks(); await reopen();
  const spy = vi.spyOn(storage, 'insertNotification');
  expect(await fire()).toEqual({ outcome: 'reminded-owner', fired: false });
  expect(spy).not.toHaveBeenCalled();
  const saved = await notices(); expect(saved).toHaveLength(1); expect(JSON.stringify(saved)).not.toContain('Private Contact Name');
});

it('recovers a lost final rung acknowledgement after restart from the same inbox row', async () => {
  const cas = storage.kvCompareAndSwap.bind(storage); let lost = false;
  vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
    if (!lost && key.startsWith('hostext:crm:lead-sla-rung:') && JSON.parse(next).outcome === 'reminded-owner') { lost = true; throw new Error('rung acknowledgement lost'); }
    return cas(key, expected, next);
  });
  await expect(fire()).rejects.toThrow('rung acknowledgement lost'); expect(lost).toBe(true); expect(await notices()).toHaveLength(1);
  vi.restoreAllMocks(); await reopen(); const spy = vi.spyOn(storage, 'insertNotification');
  expect(await fire()).toEqual({ outcome: 'reminded-owner', fired: false }); expect(spy).not.toHaveBeenCalled(); expect(await notices()).toHaveLength(1);
});

it('deduplicates concurrent recovery at the actual unique inbox id', async () => {
  const result = await Promise.all([fire(), fire()]);
  expect(result.map((r) => r.fired).sort()).toEqual([false, true]);
  expect(result.map((r) => r.outcome)).toEqual(['reminded-owner', 'reminded-owner']);
  await reopen(); expect(await notices()).toHaveLength(1);
});

it('recipient erasure seals a reserved rung before an old writer can resume it', async () => {
  vi.spyOn(storage, 'insertNotification').mockRejectedValueOnce(new Error('pause delivery'));
  await expect(fire()).rejects.toThrow('pause delivery'); vi.restoreAllMocks();
  await eraseSlaSettingsSubjects(f.tenantId, f.owner); await reopen();
  // The seal itself, before any writer resumes (the resumed writer is refused by a second guard too).
  expect((await getSlaRung(f.tenantId, f.orgId, f.contactId, 1, 1))?.outcome).toBe('superseded');
  expect(await fire()).toEqual({ outcome: 'superseded', fired: false }); expect(await notices()).toHaveLength(0);
});

it('removes an inbox write that completes across recipient erasure', async () => {
  const insert = storage.insertNotification.bind(storage);
  vi.spyOn(storage, 'insertNotification').mockImplementationOnce(async (record) => { await eraseSlaSettingsSubjects(f.tenantId, f.owner); await insert(record); });
  expect(await fire()).toEqual({ outcome: 'superseded', fired: true });
  await reopen(); expect(await notices()).toHaveLength(0);
  expect(await fire()).toEqual({ outcome: 'superseded', fired: false });
});

it('keeps the hashed cancellation receipt when cleanup fails across erasure and restart', async () => {
  const insert = storage.insertNotification.bind(storage);
  vi.spyOn(storage, 'insertNotification').mockImplementationOnce(async (record) => { await eraseSlaSettingsSubjects(f.tenantId, f.owner); await insert(record); });
  vi.spyOn(storage, 'deleteNotification').mockRejectedValueOnce(new Error('cleanup unavailable'));
  await expect(fire()).rejects.toThrow('cleanup unavailable');
  vi.restoreAllMocks(); await reopen(); expect(await notices()).toHaveLength(1);
  expect(await fire()).toEqual({ outcome: 'superseded', fired: false }); expect(await notices()).toHaveLength(0);
});
