/** ADR 0954 P2 recovery: physical profile CAS retains its private binding and
 * erasure receipt; a delayed routing epoch cannot overwrite the newer owner. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { bindLead, bumpRoutingEpoch, closeLeadBinding, commitLeadRoutingDecision, eraseLeadAttribution, getLeadBindingId, getLeadProfile, getLeadRoutingDecision, releaseLeadRoute, reserveLeadRoute } from '../src/features/crm/leadIntel/leadStore.js';
import { getContact } from '../src/features/crm/contactsService.js';
import { tombstoneId } from '../src/features/consent/consentService.js';
import type { RoutingDecision } from '../src/features/crm/leadIntel/routing.js';
import { eraseRoutingPolicySubjects, latestRoutingPolicy, saveRoutingPolicy } from '../src/features/crm/leadIntel/routingPolicy.js';

const tenantId = 'routing-profile-recovery';
const orgId = 'client';
let storage: Storage;
let directory: string;
let database: string;
let contactId: string;
const primary = () => `hostext:crm:lead-profile:${tenantId}::${orgId}::${contactId}`;
async function reopen(): Promise<void> { await storage.close(); storage = openSqliteStorage(database); initHostExtPersistence(storage); }
async function reserve(): Promise<void> {
  const profile = await getLeadProfile(tenantId, orgId, contactId);
  const epoch = (profile?.routingEpoch ?? 0) + 1;
  await reserveLeadRoute(tenantId, orgId, contactId, `run-${epoch}`, { bindingId: await getLeadBindingId(tenantId, orgId, contactId), modelId: 'v0', modelVersion: 0, modelHash: '0'.repeat(64), definitionHash: '1'.repeat(64), requesterHash: 'requester' });
}
function decision(epoch: number, chosen = 'owner-a'): RoutingDecision {
  return { key: `${tenantId}::${orgId}::${contactId}::${epoch}`, tenantId, orgId, contactId, routingEpoch: epoch, runId: `run-${epoch}`, policyVersion: 1, ruleId: 'named', strategy: 'named', candidates: [chosen], skipped: [], chosen, pointerBefore: null, decidedAt: new Date().toISOString() };
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'owp-lead-route-profile-')); database = join(directory, 'state.sqlite');
  storage = openSqliteStorage(database); initHostExtPersistence(storage);
  contactId = (await createContact({ tenantId, name: 'Lead', email: 'lead@example.test', silent: true })).contactId;
  await bindLead({ tenantId, orgId, contactId, source: 'manual', boundBy: 'operator' });

});
afterEach(async () => { vi.restoreAllMocks(); await storage.close(); __resetHostExtPersistence(); rmSync(directory, { recursive: true }); });

describe('routing profile ownership CAS', () => {
  it('two retries of one source reserve the same child epoch and frozen model', async () => {
    await reserve(); await commitLeadRoutingDecision(decision(1));
    const pin = { bindingId: await getLeadBindingId(tenantId, orgId, contactId), requesterHash: 'requester', modelId: 'v0', modelVersion: 0,
      modelHash: '0'.repeat(64), definitionHash: '1'.repeat(64), parentRoutingEpoch: 1, parentRunId: 'run-1', excludeOwnerHashes: [tombstoneId(tenantId, 'owner-a')] };
    const outcomes = await Promise.all([
      reserveLeadRoute(tenantId, orgId, contactId, 'stable-child', pin, { routingEpoch: 1, runId: 'run-1' }),
      reserveLeadRoute(tenantId, orgId, contactId, 'stable-child', { ...pin, modelId: 'changed-model', modelVersion: 2, modelHash: '2'.repeat(64) }, { routingEpoch: 1, runId: 'run-1' }),
    ]);
    expect(outcomes[0]).toEqual(outcomes[1]); expect(outcomes[0]?.pin.routingEpoch).toBe(2);
    await reopen(); expect((await getLeadProfile(tenantId, orgId, contactId))?.routingEpoch).toBe(2);
  });

  it('a newer manual round cannot be skipped by a delayed source reroute', async () => {
    await reserve(); await commitLeadRoutingDecision(decision(1));
    await releaseLeadRoute(tenantId, orgId, contactId, 'run-1'); await reserve();
    const pin = { bindingId: await getLeadBindingId(tenantId, orgId, contactId), requesterHash: 'requester', modelId: 'v0', modelVersion: 0,
      modelHash: '0'.repeat(64), definitionHash: '1'.repeat(64), parentRoutingEpoch: 1, parentRunId: 'run-1', excludeOwnerHashes: [tombstoneId(tenantId, 'owner-a')] };
    await expect(reserveLeadRoute(tenantId, orgId, contactId, 'late-child', pin, { routingEpoch: 1, runId: 'run-1' })).rejects.toMatchObject({ details: { reason: 'routing_superseded' } });
    await reopen(); expect((await getLeadProfile(tenantId, orgId, contactId))?.routingEpoch).toBe(2);
    expect(JSON.parse((await storage.kvGet(primary()))!).routingReservation.runId).toBe('run-2');
  });

  it('erasure crossing the child reservation CAS cannot recreate routing authority', async () => {
    await reserve(); await commitLeadRoutingDecision(decision(1));
    const pin = { bindingId: await getLeadBindingId(tenantId, orgId, contactId), requesterHash: 'requester', modelId: 'v0', modelVersion: 0,
      modelHash: '0'.repeat(64), definitionHash: '1'.repeat(64), parentRoutingEpoch: 1, parentRunId: 'run-1', excludeOwnerHashes: [tombstoneId(tenantId, 'owner-a')] };
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!crossed && key === primary() && JSON.parse(next).routingReservation?.runId === 'erased-child') { crossed = true; await closeLeadBinding(tenantId, contactId); }
      return cas(key, expected, next);
    });
    await expect(reserveLeadRoute(tenantId, orgId, contactId, 'erased-child', pin, { routingEpoch: 1, runId: 'run-1' })).rejects.toMatchObject({ httpStatus: 404 });
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await getLeadProfile(tenantId, orgId, contactId)).toBeNull(); expect(JSON.parse((await storage.kvGet(primary()))!).routingReservation).toBeUndefined();
  });

  it('retains the internal binding through epoch and owner writes, including restart', async () => {
    const binding = await getLeadBindingId(tenantId, orgId, contactId);
    await reserve();
    await commitLeadRoutingDecision(decision(1));
    await reopen();
    expect(await getLeadBindingId(tenantId, orgId, contactId)).toBe(binding);
    expect(await getLeadProfile(tenantId, orgId, contactId)).toMatchObject({ routingEpoch: 1, owner: 'owner-a', boundBy: 'operator' });
    const raw = await storage.kvGet(primary()); if (!raw) throw new Error('profile disappeared');
    expect(JSON.parse(raw)).toMatchObject({ bindingId: binding });
  });

  it('refuses an older owner after a newer routing epoch commits', async () => {
    await reserve();
    await commitLeadRoutingDecision(decision(1));
    await releaseLeadRoute(tenantId, orgId, contactId, 'run-1');
    await reserve();
    await commitLeadRoutingDecision(decision(2, 'owner-b'));
    expect((await commitLeadRoutingDecision(decision(1, 'late-owner'))).replayed).toBe(true);
    await reopen(); expect((await getLeadProfile(tenantId, orgId, contactId))?.owner).toBe('owner-b');
  });

  it.each(['epoch', 'owner'] as const)('a paused %s write cannot reopen an erased binding', async (lane) => {
    if (lane === 'owner') await reserve();
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const row = JSON.parse(next) as { closed?: boolean; routingEpoch?: number; owner?: string };
      if (!crossed && key === primary() && !row.closed && (lane === 'epoch' ? row.routingEpoch === 1 : row.owner === 'late-owner')) {
        crossed = true; await closeLeadBinding(tenantId, contactId);
      }
      return cas(key, expected, next);
    });
    await expect(lane === 'epoch' ? bumpRoutingEpoch(tenantId, orgId, contactId) : commitLeadRoutingDecision(decision(1, 'late-owner'))).rejects.toMatchObject({ httpStatus: 404 });
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await getLeadProfile(tenantId, orgId, contactId)).toBeNull();
    const raw = await storage.kvGet(primary()); if (!raw) throw new Error('erasure fence disappeared');
    expect(JSON.parse(raw)).toMatchObject({ closed: true });
  });

  it('reconciles a lost assignment acknowledgement after restart without another owner or decision', async () => {
    await reserve();
    const cas = storage.kvCompareAndSwap.bind(storage); let lost = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const applied = await cas(key, expected, next);
      if (!lost && applied && key === primary() && JSON.parse(next).routingHistory?.length === 1) { lost = true; throw new Error('assignment acknowledgement lost'); }
      return applied;
    });
    await expect(commitLeadRoutingDecision(decision(1))).rejects.toThrow('assignment acknowledgement lost');
    expect(lost).toBe(true); vi.restoreAllMocks(); await reopen();
    const original = await getLeadRoutingDecision(tenantId, orgId, contactId, 1);
    expect(original?.chosen).toBe('owner-a');
    expect(await commitLeadRoutingDecision(decision(1, 'must-not-replace'))).toEqual({ decision: original, replayed: true });
    expect((await getLeadProfile(tenantId, orgId, contactId))?.owner).toBe('owner-a');
    expect(await getLeadRoutingDecision(tenantId, orgId, contactId, 2)).toBeNull();
    expect((await getContact(contactId))?.owner).toBeUndefined();
  });

  it('a newer epoch refuses an old round before either assignment or history can land', async () => {
    await reserve();
    await releaseLeadRoute(tenantId, orgId, contactId, 'run-1');
    await reserve();
    await commitLeadRoutingDecision(decision(2, 'new-owner'));
    await expect(commitLeadRoutingDecision(decision(1, 'late-owner'))).rejects.toMatchObject({ details: { reason: 'routing_superseded' } });
    await reopen();
    expect((await getLeadProfile(tenantId, orgId, contactId))?.owner).toBe('new-owner');
    expect(await getLeadRoutingDecision(tenantId, orgId, contactId, 1)).toBeNull();
  });

  it('erasure crossing the assignment commit fences both the owner and its private history', async () => {
    await reserve();
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!crossed && key === primary() && JSON.parse(next).routingHistory?.length) { crossed = true; await closeLeadBinding(tenantId, contactId); }
      return cas(key, expected, next);
    });
    await expect(commitLeadRoutingDecision(decision(1))).rejects.toMatchObject({ httpStatus: 404 });
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await getLeadRoutingDecision(tenantId, orgId, contactId, 1)).toBeNull();
    const raw = await storage.kvGet(primary()); expect(raw).not.toBeNull();
    expect(raw).not.toContain('owner-a');
    expect(JSON.parse(raw!)).toMatchObject({ closed: true });
  });
  it('subject erasure crossing the owner/history publication cannot be undone by a delayed routing writer', async () => {
    await reserve();
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!crossed && key === primary() && JSON.parse(next).routingHistory?.length) { crossed = true; await eraseLeadAttribution(tenantId, 'owner-a'); }
      return cas(key, expected, next);
    });
    await expect(commitLeadRoutingDecision(decision(1))).rejects.toMatchObject({ details: { reason: 'routing_subject_erased' } });
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect((await getLeadProfile(tenantId, orgId, contactId))?.owner).toBeUndefined();
    expect(await getLeadRoutingDecision(tenantId, orgId, contactId, 1)).toBeNull();
    expect(await storage.kvGet(primary())).not.toContain('owner-a');
  });

  it('subject erasure redacts the current owner and historic candidates together across restart', async () => {
    await reserve(); await commitLeadRoutingDecision(decision(1));
    await eraseLeadAttribution(tenantId, 'owner-a'); await reopen();
    expect(await getLeadProfile(tenantId, orgId, contactId)).toMatchObject({ unassigned: true });
    expect((await getLeadProfile(tenantId, orgId, contactId))?.owner).toBeUndefined();
    expect(await storage.kvGet(primary())).not.toContain('owner-a');
    const history = await getLeadRoutingDecision(tenantId, orgId, contactId, 1);
    expect(history).not.toBeNull(); expect(history?.routingEpoch).toBe(1);
  });

  it('refuses an oversized next routing record while preserving the old owner and all existing history', async () => {
    await reserve(); await commitLeadRoutingDecision(decision(1));
    await releaseLeadRoute(tenantId, orgId, contactId, 'run-1'); await reserve();
    const oversized: RoutingDecision = { ...decision(2, 'owner-b'), skipped: Array.from({ length: 5000 }, (_, index) => ({ subject: `subject-${index}-${'x'.repeat(180)}`, reason: 'not_eligible' })) };
    await expect(commitLeadRoutingDecision(oversized)).rejects.toMatchObject({ details: { reason: 'routing_history_full' } });
    await reopen();
    expect((await getLeadProfile(tenantId, orgId, contactId))?.owner).toBe('owner-a');
    expect((await getLeadRoutingDecision(tenantId, orgId, contactId, 1))?.chosen).toBe('owner-a');
    expect(await getLeadRoutingDecision(tenantId, orgId, contactId, 2)).toBeNull();
  });

  it('a policy publication paused across subject erasure cannot republish an erased recipient', async () => {
    const key = `hostext:crm:lead-routing:${tenantId}::${orgId}::1`;
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (candidate, expected, next) => {
      if (!crossed && candidate === key && JSON.parse(next).rules?.[0]?.named === 'owner-a') {
        crossed = true; await eraseRoutingPolicySubjects(tenantId, 'owner-a');
      }
      return cas(candidate, expected, next);
    });
    await expect(saveRoutingPolicy({ tenantId, orgId, expectedVersion: 0, rules: [{ ruleId: 'named', strategy: 'named', named: 'owner-a' }], actor: 'operator' })).rejects.toMatchObject({ httpStatus: 409 });
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await storage.kvGet(key)).not.toContain('owner-a');
    await expect(latestRoutingPolicy(tenantId, orgId)).rejects.toMatchObject({ details: { reason: 'routing_policy_pending', latestVersion: 1 } });
  });

  it('redacts an erased pool member without losing eligible owners or another actor’s attribution', async () => {
    await saveRoutingPolicy({ tenantId, orgId, expectedVersion: 0, rules: [{ ruleId: 'pool', strategy: 'round-robin', pool: ['owner-a', 'owner-b'] }], actor: 'operator' });
    await eraseRoutingPolicySubjects(tenantId, 'owner-a'); await reopen();
    expect(await latestRoutingPolicy(tenantId, orgId)).toMatchObject({ version: 1, createdBy: 'operator', rules: [{ pool: ['owner-b'] }] });
    expect(await storage.kvGet(`hostext:crm:lead-routing:${tenantId}::${orgId}::1`)).not.toContain('owner-a');
    await expect(saveRoutingPolicy({ tenantId, orgId, expectedVersion: 1, rules: [{ ruleId: 'named', strategy: 'named', named: 'owner-a' }], actor: 'operator' })).rejects.toMatchObject({ details: { reason: 'routing_policy_subject_erased' } });
  });

  it('reconciles a committed policy with a lost publish acknowledgement without allocating another version', async () => {
    const key = `hostext:crm:lead-routing:${tenantId}::${orgId}::1`;
    const input = { tenantId, orgId, expectedVersion: 0, rules: [{ ruleId: 'named', strategy: 'named', named: 'owner-a' }], actor: 'operator' };
    const cas = storage.kvCompareAndSwap.bind(storage); let lost = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (candidate, expected, next) => {
      const applied = await cas(candidate, expected, next);
      if (!lost && applied && candidate === key && JSON.parse(next).rules?.[0]?.named === 'owner-a') { lost = true; throw new Error('policy publish acknowledgement lost'); }
      return applied;
    });
    await expect(saveRoutingPolicy(input)).rejects.toThrow('policy publish acknowledgement lost');
    expect(lost).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await saveRoutingPolicy(input)).toMatchObject({ version: 1, rules: input.rules });
    expect(await latestRoutingPolicy(tenantId, orgId)).toMatchObject({ version: 1, rules: input.rules });
    expect(await storage.kvGet(`hostext:crm:lead-routing:${tenantId}::${orgId}::2`)).toBeNull();
  });
});
