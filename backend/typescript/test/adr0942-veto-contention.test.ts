/**
 * ADR 0942 P4b — veto-window records under storage contention. Real KV rows
 * (memory storage, fake `Date`) exercise each retry boundary and the state it
 * leaves behind:
 *  - a window nobody was notified of cannot elapse, and a notice cannot be
 *    acknowledged after the deadline;
 *  - a veto whose first CAS loses re-checks the deadline on the retry, so
 *    contention cannot extend the window;
 *  - subject erasure retries a lost CAS and removes `vetoedBy` and the
 *    free-text `reason`; when every CAS loses it throws and keeps the row
 *    retryable, never reporting success.
 *
 * Sabotage (each run, w74 grade-tests): `closeVetoWindow` skipping the
 * `notifiedAt` check, or `markVetoNotified` skipping its deadline check, reds
 * case 1; `castVeto` checking the deadline on its first attempt only reds
 * case 2; `eraseVetoSubjects` giving up after one lost CAS, or keeping
 * `reason`, reds case 3; returning silently when every CAS loses reds case 4.
 */
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
const openWindow = () => openVetoWindow({ tenantId: 't', campaignId: 'c', runId: 'r', gateKey: 'g', actionClass: 'plan.approve', ruleId: 'rule', notify: { roleRefs: ['admin'], channels: ['inbox'], digest: 'immediate' }, windowMs: 1000 });

it('an unnotified window cannot elapse, including after its deadline', async () => {
  const { record } = await openWindow();
  vi.setSystemTime(new Date(Date.parse(record.deadline) + 1));
  expect((await closeVetoWindow('t', 'c', record.vetoId, 'r'))?.status).toBe('open');
  await expect(markVetoNotified('t', 'c', record.vetoId, 'r')).rejects.toThrow('after its review deadline');
  expect((await getVeto('t', 'c', record.vetoId))?.notifiedAt).toBeUndefined();
});

it('rechecks the deadline when a losing CAS retries after expiry', async () => {
  const { record } = await openWindow();
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
  const { record } = await openWindow();
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
  const { record } = await openWindow();
  await castVeto({ tenantId: 't', campaignId: 'c', vetoId: record.vetoId, by: 'u' });
  const original = storage.kvCompareAndSwap.bind(storage);
  vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => args[0].startsWith('hostext:autonomy:veto:')
    ? { swapped: false, actual: args[1] } : original(...args));
  await expect(eraseVetoSubjects('t', new Set(['u']), '[erased]')).rejects.toThrow('erasure remained contended');
  expect((await getVeto('t', 'c', record.vetoId))?.vetoedBy).toBe('u');
});
