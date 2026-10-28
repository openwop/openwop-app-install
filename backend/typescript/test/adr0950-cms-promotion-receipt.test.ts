/** ADR 0950: real CMS primary commits, acknowledgement loss and restart.
 * The winner, original draft and approval posture are observable product state;
 * a terminal receipt must prevent a paused finalizer from publishing afterwards. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createPage, getPage, listVersions, offerSeedVersion, restoreVersion, transitionPage, updatePage, type Page } from '../src/features/cms/cmsService.js';
import { checkArmPromotable, finalizePagePromotion, restorePageBaseline, stopExperiment } from '../src/features/cms/pageExperimentsService.js';
import { findPendingContentApprovalForPage } from '../src/host/approvalService.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerCmsExperimentSurface } from '../src/features/cms/experimentSurface.js';
import { getExperimentRow, mutateExperimentRow, putExperimentRow } from '../src/host/experiments/store.js';
import { finalize as finalizeExperiment, rollback as rollbackExperiment } from '../src/host/experiments/promote.js';

const tenantId = 'cms-promotion-receipt';
const orgId = 'client';
const experimentId = 'experiment';
const gate = { id: 'cms-approval-gate', label: 'CMS approval', description: 'Review before publish', category: 'Marketing',
  bucketUnit: 'tenant' as const, salt: 'cms-receipt', status: 'off' as const };
const sections = (heading: string) => [{ type: 'hero', data: { heading } }];
let directory: string;
let database: string;
let storage: Storage;
let pageId: string;
let winnerRef: string;
const current = () => getPage(tenantId, orgId, pageId);
const publish = () => finalizePagePromotion(tenantId, orgId, pageId, winnerRef, 'editor', 'Hero', experimentId);
const restore = () => restorePageBaseline(tenantId, orgId, pageId, null, 'editor', 'Hero', experimentId, winnerRef);
const heading = (page: Page | null) => page?.sections[0]?.data.heading;
const context = { actor: 'editor', now: '2026-10-24T00:00:00.000Z' };
async function rampedExperiment(): Promise<void> {
  registerCmsExperimentSurface();
  await putExperimentRow({ experimentId, tenantId, orgId, name: 'Hero', hypothesis: '',
    surface: { kind: 'cms.page', ref: pageId }, unit: 'visitor', design: { type: 'ab' },
    arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: winnerRef, weight: 50 }],
    mode: 'decide', status: 'running', salt: 'salt', epochs: [{ epoch: 1, weights: { control: 2, b: 98 }, at: context.now, reason: 'ramp', stage: 3 }],
    promotion: { winner: 'b', holdoutPct: 2 }, createdBy: 'editor', createdAt: context.now, updatedAt: context.now });
}
function writtenPage(next: string): Page | undefined {
  const row = JSON.parse(next) as { ext?: { page?: Omit<Page, 'sections'>; blocks?: Page['sections'] } };
  return row.ext?.page?.pageId === pageId ? { ...row.ext.page, sections: row.ext.blocks ?? [] } : undefined;
}
async function reopen(): Promise<void> { await storage.close(); storage = openSqliteStorage(database); initHostExtPersistence(storage); }
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'owp-cms-receipt-')); database = join(directory, 'state.sqlite');
  storage = openSqliteStorage(database); initHostExtPersistence(storage);
  registerToggleDefault(gate); await saveConfig(gate, 'operator');
  const page = await createPage({ tenantId, orgId, title: 'Original', createdBy: 'editor', sections: sections('Original draft') });
  pageId = page.pageId;
  await transitionPage(tenantId, orgId, pageId, 'submit', 'editor');
  const baseline = (await listVersions(tenantId, orgId, pageId))[0]!.versionId;
  await transitionPage(tenantId, orgId, pageId, 'reject', 'editor');
  await updatePage(tenantId, orgId, pageId, { title: 'Winner', sections: sections('Winning content') }, 'editor');
  await transitionPage(tenantId, orgId, pageId, 'submit', 'editor');
  winnerRef = (await listVersions(tenantId, orgId, pageId))[0]!.versionId;
  await restoreVersion(tenantId, orgId, pageId, baseline, 'editor');
});
afterEach(async () => { vi.restoreAllMocks(); await storage.close(); __resetHostExtPersistence(); rmSync(directory, { recursive: true }); });

describe('CMS-owned promotion receipts', () => {
  it('retains and restores an original draft that was never published', async () => {
    expect((await current())?.status).toBe('draft');
    expect(await publish()).toMatchObject({ baselineRef: null, pendingApproval: false });
    expect(heading(await current())).toBe('Winning content');
    const receipt = (await current())!.promotionReceipts![experimentId]!;
    expect(await checkArmPromotable(tenantId, orgId, pageId, receipt.restoreRef, 'capture')).toEqual({ ok: false, reason: 'internal_snapshot' });
    await reopen(); await restore();
    expect(heading(await current())).toBe('Original draft');
    expect((await current())?.status).toBe('draft');
    await expect(publish()).rejects.toMatchObject({ details: { reason: 'promotion_rolled_back' } });
  });

  it('protects the rollback capture when ordinary version history reaches its cap', async () => {
    await publish();
    const page = (await current())!;
    for (let i = 0; i < 52; i++) await offerSeedVersion(page, { title: `Offer ${i}`, sections: page.sections }, 'seed');
    expect(await listVersions(tenantId, orgId, pageId)).toHaveLength(50);
    await restore();
    expect(heading(await current())).toBe('Original draft');
    expect((await current())?.status).toBe('draft');
  });

  it.each(['restored', 'finalized'] as const)('reconciles a committed %s phase with a lost acknowledgement after restart', async (phase) => {
    const cas = storage.kvCompareAndSwap.bind(storage); let failed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const result = await cas(key, expected, next);
      if (!failed && result.swapped && writtenPage(next)?.promotionReceipts?.[experimentId]?.phase === phase) {
        failed = true; throw new Error('page ack lost');
      }
      return result;
    });
    await expect(publish()).rejects.toThrow('page ack lost');
    expect(failed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await publish()).toMatchObject({ baselineRef: null, pendingApproval: false });
    const version = (await current())?.version;
    await publish(); expect((await current())?.version).toBe(version);
    await restore(); expect(heading(await current())).toBe('Original draft');
  });

  it('a rollback closes a finalizer paused before its content CAS', async () => {
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!crossed && writtenPage(next)?.promotionReceipts?.[experimentId]?.phase === 'restored') { crossed = true; await restore(); }
      return cas(key, expected, next);
    });
    await expect(publish()).rejects.toMatchObject({ details: { reason: 'promotion_rolled_back' } });
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(heading(await current())).toBe('Original draft');
    expect((await current())?.status).toBe('draft');
  });

  it('a lost restoration acknowledgement remains retryable after restart', async () => {
    await publish(); const cas = storage.kvCompareAndSwap.bind(storage); let failed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const result = await cas(key, expected, next);
      if (!failed && result.swapped && writtenPage(next)?.promotionReceipts?.[experimentId]?.phase === 'rolled_back') { failed = true; throw new Error('restore ack lost'); }
      return result;
    });
    await expect(restore()).rejects.toThrow('restore ack lost');
    expect(failed).toBe(true); vi.restoreAllMocks(); await reopen(); await restore();
    expect(heading(await current())).toBe('Original draft');
    expect((await current())?.status).toBe('draft');
  });

  it('the engine does not report finalization before a committed surface acknowledgement is reconciled', async () => {
    await rampedExperiment(); const cas = storage.kvCompareAndSwap.bind(storage); let failed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const result = await cas(key, expected, next);
      if (!failed && result.swapped && writtenPage(next)?.promotionReceipts?.[experimentId]?.phase === 'finalized') { failed = true; throw new Error('surface ack lost'); }
      return result;
    });
    await expect(finalizeExperiment(tenantId, orgId, experimentId, context)).rejects.toThrow('surface ack lost');
    expect((await getExperimentRow(tenantId, orgId, experimentId))?.promotion?.finalizedAt).toBeUndefined();
    expect(heading(await current())).toBe('Winning content');
    expect(failed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect((await finalizeExperiment(tenantId, orgId, experimentId, context)).outcome).toBe('finalized');
    await rollbackExperiment(tenantId, orgId, experimentId, { ...context, reason: 'manual' });
    expect(heading(await current())).toBe('Original draft');
  });

  it('a CMS stop preserves promotion intent committed after its lifecycle read', async () => {
    await rampedExperiment(); const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const candidate = JSON.parse(next) as { experimentId?: string; status?: string };
      if (!crossed && candidate.experimentId === experimentId && candidate.status === 'stopped') {
        crossed = true;
        await mutateExperimentRow(tenantId, orgId, experimentId, (row) => ({ ...row,
          promotionRunId: 'publishing-run', promotion: { ...row.promotion!, finalizeRequestedAt: context.now } }));
      }
      return cas(key, expected, next);
    });
    await stopExperiment(tenantId, orgId, pageId, experimentId, 'editor', { managed: true });
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await getExperimentRow(tenantId, orgId, experimentId)).toMatchObject({ status: 'stopped',
      promotionRunId: 'publishing-run', promotion: { finalizeRequestedAt: context.now } });
  });

  it.each([false, true])('stop after content publication restores the original draft; lost acknowledgement=%s', async (loseAck) => {
    await rampedExperiment(); const cas = storage.kvCompareAndSwap.bind(storage); let stopped = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const result = await cas(key, expected, next);
      if (!stopped && result.swapped && writtenPage(next)?.promotionReceipts?.[experimentId]?.phase === 'finalized') {
        stopped = true;
        await mutateExperimentRow(tenantId, orgId, experimentId, (row) => ({ ...row, status: 'stopped', stoppedAt: context.now }));
        if (loseAck) throw new Error('stopped after surface commit');
      }
      return result;
    });
    await expect(finalizeExperiment(tenantId, orgId, experimentId, context)).rejects.toThrow();
    expect(stopped).toBe(true);
    vi.restoreAllMocks(); await reopen();
    await expect(finalizeExperiment(tenantId, orgId, experimentId, context)).rejects.toMatchObject({ details: { reason: 'not_running' } });
    expect(heading(await current())).toBe('Original draft');
    expect((await current())?.status).toBe('draft');
    expect((await getExperimentRow(tenantId, orgId, experimentId))?.status).toBe('stopped');
    expect((await getExperimentRow(tenantId, orgId, experimentId))?.promotion?.finalizedAt).toBeUndefined();
  });

  it('the engine retries restoration when traffic/status rolled back but the content write failed', async () => {
    await rampedExperiment(); await finalizeExperiment(tenantId, orgId, experimentId, context);
    const cas = storage.kvCompareAndSwap.bind(storage); let failed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!failed && writtenPage(next)?.promotionReceipts?.[experimentId]?.phase === 'rolled_back') { failed = true; throw new Error('restore unavailable'); }
      return cas(key, expected, next);
    });
    await expect(rollbackExperiment(tenantId, orgId, experimentId, { ...context, reason: 'breach' })).rejects.toThrow('restore unavailable');
    const pending = await getExperimentRow(tenantId, orgId, experimentId);
    expect(pending?.status).toBe('rolled_back');
    expect(pending?.promotion?.contentRestoredAt).toBeUndefined();
    expect(heading(await current())).toBe('Winning content');
    expect(failed).toBe(true); vi.restoreAllMocks(); await reopen();
    await rollbackExperiment(tenantId, orgId, experimentId, { ...context, reason: 'retry' });
    expect(heading(await current())).toBe('Original draft');
    expect((await getExperimentRow(tenantId, orgId, experimentId))?.promotion?.contentRestoredAt).toBeTruthy();
  });

  it('a concurrent editor cannot erase the receipt, and rollback cannot overwrite a later human edit', async () => {
    const cas = storage.kvCompareAndSwap.bind(storage); let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!crossed && writtenPage(next)?.title === 'Stale edit') { crossed = true; await publish(); }
      return cas(key, expected, next);
    });
    await expect(updatePage(tenantId, orgId, pageId, { title: 'Stale edit' }, 'editor')).rejects.toMatchObject({ httpStatus: 409 });
    expect(crossed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect((await current())?.promotionReceipts?.[experimentId]?.phase).toBe('finalized');
    await updatePage(tenantId, orgId, pageId, { sections: sections('Later human edit') }, 'editor');
    await expect(restore()).rejects.toMatchObject({ httpStatus: 409 });
    expect(heading(await current())).toBe('Later human edit');
  });

  it('a lost submit acknowledgement queues exactly one review and keeps pending-approval truth on retry', async () => {
    await restoreVersion(tenantId, orgId, pageId, winnerRef, 'editor');
    await transitionPage(tenantId, orgId, pageId, 'publish', 'editor');
    winnerRef = (await listVersions(tenantId, orgId, pageId)).find((v) => v.origin === 'publish')!.versionId;
    await updatePage(tenantId, orgId, pageId, { sections: sections('Original published baseline') }, 'editor');
    await saveConfig({ ...gate, status: 'on' }, 'operator');
    const cas = storage.kvCompareAndSwap.bind(storage); let failed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const result = await cas(key, expected, next);
      if (!failed && result.swapped && writtenPage(next)?.promotionReceipts?.[experimentId]?.phase === 'submitted') { failed = true; throw new Error('submit ack lost'); }
      return result;
    });
    await expect(publish()).rejects.toThrow('submit ack lost');
    expect(failed).toBe(true); vi.restoreAllMocks(); await reopen();
    expect(await publish()).toMatchObject({ pendingApproval: true });
    const pending = await findPendingContentApprovalForPage(tenantId, pageId);
    expect(pending?.pageVersion).toBe((await current())?.version);
    expect((await current())?.status).toBe('in_review');
    expect(await publish()).toMatchObject({ pendingApproval: true });
    expect((await findPendingContentApprovalForPage(tenantId, pageId))?.approvalId).toBe(pending?.approvalId);
  });
});
