/**
 * ADR 0672 D2 (`CMSAWF-12`) — the scheduled-publish sweep closes its approval row, and
 * closes it as SUPERSEDED.
 *
 * Born red on both halves: the sweep published and left the row pending (the inbox then
 * advertised an outstanding review for a page that was already live), and there was no
 * superseding closure to use.
 *
 * This is the FOURTH row-stranding producer. Four siblings already had the cure and
 * ADR 0593 D2's own enumeration named three — the class was closed three times and this
 * lane was never in it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createPage, setScheduledPublish, getPage, transitionPage } from '../src/features/cms/cmsService.js';
import { processScheduledPublishes } from '../src/features/cms/publishSweep.js';
import { findPendingContentApprovalForPage, findLatestContentApprovalForPage, createContentApproval } from '../src/host/approvalService.js';

const T = 'tSweepRow';
const ORG = 'org-1';

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

const submittedPage = async (): Promise<string> => {
  const page = await createPage({ tenantId: T, orgId: ORG, title: 'Scheduled', createdBy: 'u1', sections: [] });
  await transitionPage(T, ORG, page.pageId, 'submit', 'u-author');
  await createContentApproval({
    tenantId: T, orgId: ORG, pageId: page.pageId, slug: page.slug, title: page.title,
    proposal: `Publish CMS page "${page.title}"`, requestedBy: 'u-author',
  } as never);
  return page.pageId;
};

describe('ADR 0672 D2 — the sweep does not strand its review row', () => {
  it('leg 1: after a scheduled publish fires, NO pending review remains', async () => {
    const pageId = await submittedPage();
    expect(await findPendingContentApprovalForPage(T, pageId), 'precondition: a row is pending').toBeTruthy();

    await setScheduledPublish(T, ORG, pageId, new Date(Date.now() + 1000).toISOString(), 'u-admin');
    await processScheduledPublishes(Date.now() + 60_000);

    expect((await getPage(T, ORG, pageId))?.status, 'the page really published').toBe('published');
    expect(await findPendingContentApprovalForPage(T, pageId),
      'the inbox must not advertise a review for a page that is already live').toBeNull();
  });

  it('leg 2: the closure is SUPERSEDED — not "the review was rejected" for a live page', async () => {
    const pageId = await submittedPage();
    await setScheduledPublish(T, ORG, pageId, new Date(Date.now() + 1000).toISOString(), 'u-admin');
    await processScheduledPublishes(Date.now() + 60_000);

    const row = await findLatestContentApprovalForPage(T, pageId);
    expect(row?.status).toBe('rejected'); // the only terminal non-approved status
    expect(row?.superseded,
      'a sweep publish overtakes the review; recording a rejection would contradict the live page').toBe(true);
  });

  it('leg 3 (control): with the gate ON the sweep does NOT publish, so there is nothing to close', async () => {
    // Proves legs 1-2 are about the CLEANUP, not about the sweep being inert.
    const pageId = await submittedPage();
    await setScheduledPublish(T, ORG, pageId, new Date(Date.now() + 1000).toISOString(), 'u-admin');
    // The toggle DEFAULT is registered inside the feature's `registerRoutes`, not at import
    // (measured: `getToggleDefault('cms-approval-gate')` is undefined in a bare test). The
    // first version of this leg did `if (d) saveConfig(...)`, which SILENTLY SKIPPED — so
    // the gate was never on and the leg failed while telling me nothing about the gate.
    const { cmsFeature } = await import('../src/features/cms/feature.js');
    try {
      (cmsFeature as unknown as { registerRoutes: (d: unknown) => void }).registerRoutes({
        app: { get() {}, post() {}, put() {}, patch() {}, delete() {}, use() {} },
      });
    } catch { /* the route wiring needs a real app; the toggle default lands first */ }
    const { saveConfig } = await import('../src/host/featureToggles/service.js');
    const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
    const d = getToggleDefault('cms-approval-gate');
    expect(d, 'PRECONDITION: without the default this leg cannot turn the gate on').toBeTruthy();
    await saveConfig({ ...d!, status: 'on' }, 'test');
    const { isApprovalGateOn } = await import('../src/features/cms/contentApproval.js');
    expect(await isApprovalGateOn(T), 'PRECONDITION: the gate must really be ON').toBe(true);

    await processScheduledPublishes(Date.now() + 60_000);
    expect((await getPage(T, ORG, pageId))?.status, 'fail-closed: the gate turned ON after scheduling').not.toBe('published');
  });
});
