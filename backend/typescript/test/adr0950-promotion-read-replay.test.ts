/** ADR 0950: later allocations cannot rewrite the checks a promotion executed.
 * Exercise the real metadata CAS, including a committed write whose ack is lost;
 * caller stamps and unclaimed runs must never fabricate safety evidence. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { Experiment } from '../src/host/experiments/types.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { promotionRead } from '../src/host/experiments/promotionRead.js';
import { PROMOTION_READ_PREFIX } from '../src/host/experiments/promotionReadKey.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import { stripReservedRunMetadata } from '../src/host/runDispatch.js';

const workflowId = 'experiments.promote';
const tenantId = 'promotion-reads';
const nodeId = 'require-gates';
const key = `${PROMOTION_READ_PREFIX}${nodeId}`;
const original = { allPass: true, winner: 'b', snapshot: { cellsHash: 'original' }, gates: [{ id: 'G1', status: 'pass' }] };
const experiment: Experiment = { experimentId: 'experiment', tenantId, orgId: 'client', name: 'Hero', hypothesis: '',
  surface: { kind: 'cms.page', ref: 'page' }, unit: 'visitor', design: { type: 'ab' },
  arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: 'version', weight: 50 }],
  mode: 'decide', status: 'running', salt: 'salt', epochs: [], promotionRunId: 'source',
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', createdBy: 'owner' };
let storage: Storage;
async function run(runId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await storage.insertRun({ runId, tenantId, workflowId, inputs: {}, configurable: {}, metadata, status: 'running',
    createdAt: experiment.createdAt, updatedAt: experiment.updatedAt });
}
const read = (runId: string, replaying: boolean, compute: () => Promise<Record<string, unknown>> = vi.fn(async () => original), e = experiment) =>
  runWithEffectContext({ runId, nodeId, tenantId, replaying }, () =>
    promotionRead({ tenantId, runId }, e, workflowId, 'gates', compute));

beforeEach(async () => { storage = await openStorage('memory://'); initHostExtPersistence(storage); await run('source'); });
afterEach(async () => { vi.restoreAllMocks(); await storage.close(); __resetHostExtPersistence(); });

describe('as-executed promotion checks', () => {
  it('inherits the exact source check on a fork instead of observing later allocations', async () => {
    expect(await read('source', false)).toEqual(original);
    await run('fork', (await storage.getRun('source'))!.metadata);
    const later = vi.fn(async () => ({ allPass: false, winner: null }));
    expect(await read('fork', true, later)).toEqual(original);
    expect(later).not.toHaveBeenCalled();
  });

  it('keeps a committed report when its acknowledgement is lost', async () => {
    const merge = storage.mergeRunMetadata.bind(storage); let once = true;
    vi.spyOn(storage, 'mergeRunMetadata').mockImplementation(async (...args) => {
      const result = await merge(...args);
      if (once && result) { once = false; throw new Error('metadata ack lost'); }
      return result;
    });
    await expect(read('source', false)).rejects.toThrow('metadata ack lost');
    const later = vi.fn(async () => ({ allPass: false }));
    expect(await read('source', false, later)).toEqual(original);
    expect(later).not.toHaveBeenCalled();
  });

  it('never overwrites a dotted top-level key and does not confuse a nested path with that key', async () => {
    expect(await storage.mergeRunMetadata('source', { [key]: original }, { ifAbsentKey: key })).toBe(true);
    expect(await storage.mergeRunMetadata('source', { [key]: { allPass: false } }, { ifAbsentKey: key })).toBe(false);
    expect((await storage.getRun('source'))?.metadata?.[key]).toEqual(original);
    await run('nested', { openwop: { decision: 'nested' } });
    expect(await storage.mergeRunMetadata('nested', { 'openwop.decision': 'top-level' }, { ifAbsentKey: 'openwop.decision' })).toBe(true);
    expect((await storage.getRun('nested'))?.metadata).toEqual({ openwop: { decision: 'nested' }, 'openwop.decision': 'top-level' });
  });

  it('refuses an unrecorded replay and an unclaimed recorder', async () => {
    await run('fork');
    const compute = vi.fn(async () => original);
    await expect(read('fork', true, compute)).rejects.toMatchObject({ details: { reason: 'promotion_read_missing' } });
    await expect(read('fork', false, compute)).rejects.toMatchObject({ details: { reason: 'not_the_promotion_run' } });
    expect(compute).not.toHaveBeenCalled();
  });

  it('binds inherited evidence to this experiment, client, node and operation', async () => {
    await read('source', false);
    await run('fork', (await storage.getRun('source'))!.metadata);
    const compute = vi.fn(async () => original);
    await expect(read('fork', true, compute, { ...experiment, experimentId: 'other' })).rejects.toMatchObject({ details: { reason: 'promotion_read_mismatch' } });
    await expect(runWithEffectContext({ runId: 'fork', nodeId, replaying: true }, () =>
      promotionRead({ tenantId, runId: 'fork' }, experiment, workflowId, 'monitor', compute)))
      .rejects.toMatchObject({ details: { reason: 'promotion_read_mismatch' } });
    expect(compute).not.toHaveBeenCalled();
  });

  it('strips every caller-supplied decision key while keeping ordinary metadata', () => {
    expect(stripReservedRunMetadata({ [key]: original, [`${PROMOTION_READ_PREFIX}monitor`]: original, note: 'keep' })).toEqual({ note: 'keep' });
  });

  it('keeps direct dashboard reads live', async () => {
    const compute = vi.fn(async () => ({ allPass: false }));
    expect(await promotionRead({ tenantId }, experiment, workflowId, 'gates', compute)).toEqual({ allPass: false });
    expect(compute).toHaveBeenCalledOnce();
    expect((await storage.getRun('source'))?.metadata).toEqual({});
  });
});
