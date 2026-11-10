/**
 * ADR 1024 P2 — a DSAR reaches every copy of the person the CDP holds, including the
 * contacts merged into them (feature-loop row 73, `CDP2WF-7/-8`).
 *
 * Before: `resolveCrmSubjectKeys` returned only the surviving contact, so a merged-away
 * contact's analytics sessions, CDP events and journey enrollments survived an erasure
 * that reported clean. Prod holds 2 real merges (read-only, 2026-11-02), so this is live
 * data. And two stores sat outside every eraser: segment snapshots and enrollments.
 *
 * Each case goes through the REAL `eraseSubject` fan-out (resolvers, hop 2, every
 * registered eraser) after a REAL `mergeContacts`, never a hand-built key set.
 *
 * Red when (sabotage-witnessed in this PR, each applied and reverted in one step):
 *  - `resolveCrmSubjectKeys` stops adding the merged-away contacts;
 *  - the merge walk loses BOTH its unmerge guards (skip an UNMERGED event; require
 *    `mergedInto === survivor`). They are a named double guard: either one alone keeps
 *    the re-merge-elsewhere case from over-erasing, so each alone survives its own
 *    sabotage and only the pair goes red;
 *  - `eraseSegmentSnapshotSubject` / `eraseJourneyEnrollmentSubject` is not registered;
 *  - `copyEnrollmentsOnMerge` is not wired (a merge re-arms a journey);
 *  - `removeMergeCopiedEnrollments` is not wired (an unmerge keeps the copy).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { mergeContacts, unmergeContacts } from '../src/features/crm/crmMergeService.js';
import { listMergeEvents } from '../src/features/crm/crmMergeEventsService.js';
import { linkSession, contactForSession } from '../src/features/analytics/identityLinkService.js';
import { collectEvent, listCollectedEvents } from '../src/features/cdp/collectService.js';
import { enroll, listEnrollments } from '../src/features/campaign-journeys/journeyService.js';

const snapshots = new DurableCollection<{ key: string; tenantId: string; segmentId: string; memberIds: string[]; at: string }>(
  'cdp:segment-snapshot', (r) => r.key, undefined, (r) => r.tenantId,
);

let n = 0;
const tenant = (): string => `tenant-1024-erase-${++n}`;
async function contact(t: string, name: string): Promise<string> {
  return (await createContact({ tenantId: t, name, email: `${name.toLowerCase()}@${t}.test` })).contactId;
}

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('D5.2 — a DSAR by the survivor\'s email reaches the merged-away contact', () => {
  it('erases the merged-away contact\'s session link, CDP events, enrollment and snapshot membership', async () => {
    const t = tenant();
    const ada = await contact(t, 'Ada'); // merged away
    const bea = await contact(t, 'Bea'); // survivor
    const session = `sess${t.replace(/[^A-Za-z0-9]/g, '')}`;
    await linkSession(t, session, ada, 'form-submit');
    await collectEvent(t, 'page_view', { contactId: ada, page: '/pricing' });
    await collectEvent(t, 'page_view', { visitor: session, page: '/docs' });
    expect((await enroll(t, 'welcome', ada)).enrolled).toBe(true);
    await snapshots.put({ key: `${t}::seg1`, tenantId: t, segmentId: 'seg1', memberIds: [ada, 'someone-else'], at: new Date().toISOString() });

    await mergeContacts(t, bea, ada);
    expect((await listMergeEvents(t)).length).toBe(1);

    const out = await eraseSubject(t, `bea@${t}.test`);
    expect(out.failed, JSON.stringify(out)).toBe(0);

    expect(await contactForSession(t, session), 'the merged-away contact\'s session link').toBeNull();
    expect(await listCollectedEvents(t), 'events keyed on the merged-away contact or its session').toEqual([]);
    expect((await listEnrollments(t)).filter((e) => e.contactId === ada), 'the merged-away contact\'s enrollment').toEqual([]);
    expect((await snapshots.get(`${t}::seg1`))?.memberIds).toEqual(['someone-else']);
  });
});

describe('D5.3 — an erased contact does not come back into a segment snapshot', () => {
  it('the next segment pass leaves the erased id out (so no entry fires for it)', async () => {
    const { sweepSegmentEntries } = await import('../src/features/cdp/segmentEntryDaemon.js');
    const { createSegment } = await import('../src/features/crm/segmentsService.js');
    const { saveConfig } = await import('../src/host/featureToggles/service.js');
    const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
    const { __hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    for (const id of ['cdp', 'crm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
    const t = tenant();
    const kim = await contact(t, 'Kim');
    const lee = await contact(t, 'Lee');
    const seg = await createSegment({ tenantId: t, name: 'Everyone', filters: [], createdBy: 'test', watchEntries: true });
    // Seed the snapshot as a prior pass would have, then erase Kim.
    await snapshots.put({ key: `${t}::${seg.segmentId}`, tenantId: t, segmentId: seg.segmentId, memberIds: [kim, lee], at: new Date().toISOString() });
    expect((await eraseSubject(t, kim)).failed).toBe(0);
    expect((await snapshots.get(`${t}::${seg.segmentId}`))?.memberIds).toEqual([lee]);

    await sweepSegmentEntries(__hostExtStorage()!, Date.now() + 120_000);
    const after = (await snapshots.get(`${t}::${seg.segmentId}`))!;
    expect(Date.parse(after.at), 'the pass ran over this segment').toBeGreaterThan(Date.now() + 60_000);
    // Kim's anonymised row still matches "Everyone": without the filter the pass would put
    // the id back AND emit crm.segment.entered for it (a new entrant against [lee]).
    expect(after.memberIds, 'the erased id stays out').not.toContain(kim);
    expect(after.memberIds).toContain(lee);
  });
});

describe('D5.1 — an unmerged-then-remerged contact is not erased with its old survivor', () => {
  it('erasing B does not reach A once A was unmerged from B and merged into C; erasing C does', async () => {
    const t = tenant();
    const a = await contact(t, 'Ann');
    const b = await contact(t, 'Bob');
    const c = await contact(t, 'Cat');
    expect((await enroll(t, 'welcome', a)).enrolled).toBe(true);
    await mergeContacts(t, b, a);
    const [ev] = await listMergeEvents(t);
    await unmergeContacts(t, ev!.mergeEventId);
    await mergeContacts(t, c, a);

    expect((await eraseSubject(t, `bob@${t}.test`)).failed).toBe(0);
    expect((await listEnrollments(t)).some((e) => e.contactId === a), 'A is C\'s now: erasing B must not touch it').toBe(true);

    expect((await eraseSubject(t, `cat@${t}.test`)).failed).toBe(0);
    expect((await listEnrollments(t)).some((e) => e.contactId === a)).toBe(false);
  });
});

describe('D5.5 — a merge cannot re-arm a journey, and an unmerge undoes the copy', () => {
  it('the survivor inherits the merged-away contact\'s enrollment; unmerge removes only that copy', async () => {
    const t = tenant();
    const src = await contact(t, 'Sam');
    const surv = await contact(t, 'Sue');
    expect((await enroll(t, 'welcome', src)).enrolled).toBe(true);
    await mergeContacts(t, surv, src);
    expect((await enroll(t, 'welcome', surv)).enrolled, 'the merged person already received this journey').toBe(false);

    const [ev] = await listMergeEvents(t);
    await unmergeContacts(t, ev!.mergeEventId);
    expect((await listEnrollments(t)).some((e) => e.contactId === src), 'the source keeps its own row').toBe(true);
    expect((await enroll(t, 'welcome', surv)).enrolled, 'the copy is gone after the unmerge').toBe(true);
  });
});
