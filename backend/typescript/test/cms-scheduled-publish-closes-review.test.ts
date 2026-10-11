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
 *
 * Sabotage (grade-tests w16): dropping the `rejectPendingApprovalForPage` call in
 * `publishSweep.ts` reds the case (the row stays pending); passing `superseded=false`
 * reds the `superseded` assertion. The gate-ON fail-closed control lives in
 * `cms-phase-c.test.ts` › "fail-closed: the gate turning ON after scheduling…".
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
  const submitted = (await getPage(T, ORG, page.pageId))!;
  await createContentApproval({
    tenantId: T, orgId: ORG, pageId: page.pageId, pageTitle: page.title,
    proposal: `Publish CMS page "${page.title}"`, pageVersion: submitted.version,
  });
  return page.pageId;
};

describe('ADR 0672 D2 — the sweep does not strand its review row', () => {
  it('the sweep publishes and closes the review row as SUPERSEDED — never a pending row, never "rejected" for a live page', async () => {
    const pageId = await submittedPage();
    expect(await findPendingContentApprovalForPage(T, pageId), 'precondition: a row is pending').toBeTruthy();

    await setScheduledPublish(T, ORG, pageId, new Date(Date.now() + 1000).toISOString(), 'u-admin');
    await processScheduledPublishes(Date.now() + 60_000);

    expect((await getPage(T, ORG, pageId))?.status, 'the page really published').toBe('published');
    expect(await findPendingContentApprovalForPage(T, pageId),
      'the inbox must not advertise a review for a page that is already live').toBeNull();
    const row = await findLatestContentApprovalForPage(T, pageId);
    expect(row?.status).toBe('rejected'); // the only terminal non-approved status
    expect(row?.superseded,
      'a sweep publish overtakes the review; recording a rejection would contradict the live page').toBe(true);
  });
});
