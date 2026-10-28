/** ADR 0950 recovery — physical SQLite commit/ack and late-CAS witnesses.
 * Pointer, original baseline and terminal rollback fence must survive together;
 * removing the receipt or replacing a funnel CAS with put loses these cases. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { attachStepExperiment, createFunnel, getFunnel, reconcileStepPromotion, updateFunnel } from '../src/features/funnels/funnelsService.js';

const tenantId = 'promotion-receipt';
const orgId = 'client';
const experimentId = 'receipt-experiment';
let storage: Storage;
let directory: string;
let database: string;
let funnelId: string;
let stepId: string;
let baselineRef: string;
let winnerRef: string;
const key = () => `hostext:funnels:funnel:${funnelId}`;
const apply = (operation: 'finalize' | 'rollback') => reconcileStepPromotion(tenantId, orgId, funnelId, stepId, experimentId, winnerRef, operation);
const currentStep = async () => (await getFunnel(tenantId, orgId, funnelId))?.steps.find((step) => step.stepId === stepId);
async function reopen(): Promise<void> {
  await storage.close(); storage = openSqliteStorage(database); initHostExtPersistence(storage);
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'owp-funnel-receipt-'));
  database = join(directory, 'state.sqlite'); storage = openSqliteStorage(database); initHostExtPersistence(storage);
  const baseline = await createPage({ tenantId, orgId, title: 'Baseline', createdBy: 'editor' });
  const winner = await createPage({ tenantId, orgId, title: 'Winner', createdBy: 'editor' });
  baselineRef = baseline.pageId; winnerRef = winner.pageId;
  await transitionPage(tenantId, orgId, winnerRef, 'publish', 'editor');
  const funnel = await createFunnel({ tenantId, orgId, createdBy: 'editor', name: 'Receipt test', steps: [{ kind: 'landing', pageId: baselineRef }] });
  funnelId = funnel.funnelId; stepId = funnel.steps[0]!.stepId;
  await attachStepExperiment(tenantId, orgId, funnelId, stepId, { experimentId, status: 'running', salt: 'salt', variants: [], createdAt: new Date().toISOString() });
});
afterEach(async () => { vi.restoreAllMocks(); await storage.close(); __resetHostExtPersistence(); rmSync(directory, { recursive: true }); });

describe('surface-owned funnel promotion receipts', () => {
  it('a lost finalize acknowledgement survives restart without replacing the baseline with the winner', async () => {
    const cas = storage.kvCompareAndSwap.bind(storage); let failed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (rowKey, expected, next) => {
      const result = await cas(rowKey, expected, next);
      if (!failed && rowKey === key() && result.swapped) { failed = true; throw new Error('commit ack lost'); }
      return result;
    });
    await expect(apply('finalize')).rejects.toThrow('commit ack lost');
    vi.restoreAllMocks(); await reopen();
    expect(await apply('finalize')).toEqual({ baselineRef });
    expect((await currentStep())?.pageId).toBe(winnerRef);
    expect(await apply('rollback')).toEqual({ baselineRef });
    await reopen();
    expect((await currentStep())?.pageId).toBe(baselineRef);
    await expect(apply('finalize')).rejects.toMatchObject({ details: { reason: 'promotion_rolled_back' } });
    expect((await currentStep())?.pageId).toBe(baselineRef);
  });

  it('a finalize paused at its primary CAS cannot publish after rollback closes the receipt', async () => {
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (rowKey, expected, next) => {
      if (!crossed && rowKey === key()) { crossed = true; await apply('rollback'); }
      return cas(rowKey, expected, next);
    });
    await expect(apply('finalize')).rejects.toMatchObject({ details: { reason: 'promotion_rolled_back' } });
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect((await currentStep())?.pageId).toBe(baselineRef);
    expect((await getFunnel(tenantId, orgId, funnelId))?.promotionReceipts?.[experimentId]).toMatchObject({ outcome: 'rolled_back', baselineRef });
  });

  it('a lost rollback acknowledgement remains retryable and preserves the terminal fence after restart', async () => {
    await apply('finalize');
    const cas = storage.kvCompareAndSwap.bind(storage); let failed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (rowKey, expected, next) => {
      const result = await cas(rowKey, expected, next);
      if (!failed && rowKey === key() && result.swapped) { failed = true; throw new Error('restore ack lost'); }
      return result;
    });
    await expect(apply('rollback')).rejects.toThrow('restore ack lost');
    vi.restoreAllMocks(); await reopen();
    expect(await apply('rollback')).toEqual({ baselineRef });
    expect((await currentStep())?.pageId).toBe(baselineRef);
    await expect(apply('finalize')).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('a stale editor write cannot erase a concurrently committed promotion receipt or pointer', async () => {
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (rowKey, expected, next) => {
      if (!crossed && rowKey === key() && JSON.parse(next).name === 'Stale edit') { crossed = true; await apply('finalize'); }
      return cas(rowKey, expected, next);
    });
    await expect(updateFunnel(tenantId, orgId, funnelId, { name: 'Stale edit' })).rejects.toMatchObject({ details: { reason: 'funnel_changed' } });
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    const funnel = await getFunnel(tenantId, orgId, funnelId);
    expect(funnel?.name).toBe('Receipt test');
    expect(funnel?.steps[0]?.pageId).toBe(winnerRef);
    expect(funnel?.promotionReceipts?.[experimentId]).toMatchObject({ outcome: 'finalized', baselineRef });
    await expect(reconcileStepPromotion('foreign', orgId, funnelId, stepId, experimentId, winnerRef, 'rollback')).rejects.toMatchObject({ httpStatus: 404 });
    expect((await currentStep())?.pageId).toBe(winnerRef);
  });
});
