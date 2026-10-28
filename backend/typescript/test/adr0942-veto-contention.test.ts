/** ADR0942: storage contention cannot extend a veto deadline or silently skip
 * subject erasure. Real KV rows exercise the retry boundary and retained state. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openStorage, type Storage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { castVeto, closeVetoWindow, eraseVetoSubjects, getVeto, markVetoNotified, openVetoWindow } from '../src/host/autonomyPolicy/veto.js';

let storage: Storage;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await storage.close(); });
const window = () => openVetoWindow({ tenantId: 't', campaignId: 'c', runId: 'r', gateKey: 'g', actionClass: 'plan.approve', ruleId: 'rule', notify: { roleRefs: ['admin'], channels: ['inbox'], digest: 'immediate' }, windowMs: 1000 });

it('an unnotified window cannot elapse, including after its deadline', async () => {
  const { record } = await window();
  vi.setSystemTime(new Date(Date.parse(record.deadline) + 1));
  expect((await closeVetoWindow('t', 'c', record.vetoId, 'r'))?.status).toBe('open');
  await expect(markVetoNotified('t', 'c', record.vetoId, 'r')).rejects.toThrow('after its review deadline');
  expect((await getVeto('t', 'c', record.vetoId))?.notifiedAt).toBeUndefined();
});

it('rechecks the deadline when a losing CAS retries after expiry', async () => {
  const { record } = await window();
  const original = storage.kvCompareAndSwap.bind(storage);
  let contested = false;
  vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
    if (!contested && args[0].startsWith('hostext:autonomy:veto:')) {
      contested = true;
      vi.setSystemTime(new Date(Date.parse(record.deadline) + 1));
      return { swapped: false, actual: args[1] };
    }
    return original(...args);
  });
  expect(await castVeto({ tenantId: 't', campaignId: 'c', vetoId: record.vetoId, by: 'u' })).toEqual({ ok: false, reason: 'past_deadline' });
  expect(contested).toBe(true);
  expect((await getVeto('t', 'c', record.vetoId))?.status).toBe('open');
});

it('retries a contended erasure and removes the vetoer attribution and free-text reason', async () => {
  const { record } = await window();
  expect((await castVeto({ tenantId: 't', campaignId: 'c', vetoId: record.vetoId, by: 'u', reason: 'private attribution' })).ok).toBe(true);
  const original = storage.kvCompareAndSwap.bind(storage);
  let contested = false;
  vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
    if (!contested && args[0].startsWith('hostext:autonomy:veto:')) {
      contested = true;
      return { swapped: false, actual: args[1] };
    }
    return original(...args);
  });
  expect(await eraseVetoSubjects('t', new Set(['u']), '[erased]')).toBe(1);
  expect(contested).toBe(true);
  const stored = await getVeto('t', 'c', record.vetoId);
  expect(stored).toMatchObject({ status: 'vetoed', vetoedBy: '[erased]' });
  expect(stored?.reason).toBeUndefined();
});

it('reports erasure failure if every CAS loses, preserving a retryable row', async () => {
  const { record } = await window();
  await castVeto({ tenantId: 't', campaignId: 'c', vetoId: record.vetoId, by: 'u' });
  const original = storage.kvCompareAndSwap.bind(storage);
  vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => args[0].startsWith('hostext:autonomy:veto:')
    ? { swapped: false, actual: args[1] } : original(...args));
  await expect(eraseVetoSubjects('t', new Set(['u']), '[erased]')).rejects.toThrow('erasure remained contended');
  expect((await getVeto('t', 'c', record.vetoId))?.vetoedBy).toBe('u');
});
