/**
 * CMNT-2 — deleting a commentable resource must take its comment threads with it.
 *
 * Three of the six types had NO cascade: `cms_page` (`cmsService.deletePage`,
 * which already cascaded versions, redirects, experiments, share links and media
 * usage), `kb_collection` (`kbService.deleteCollection`, which already cascaded
 * docs, vectors, revisions and share links) and `priority_idea`
 * (`priorityMatrixService.deleteList` / `deleteIdea`, whose own R2 review closed
 * exactly this class for intake/evidence/score rows and stopped short of
 * comments).
 *
 * WHY IT MATTERS BEYOND TIDINESS. A comment `body` is DECLARED PII
 * (`declarePiiFields('comments.comment', ['body'])`) and `listThread` never
 * re-derives visibility from the parent — it filters the comment ROW only — so an
 * orphaned thread stays API-readable to anyone with `workspace:read` on the org
 * who knows the id, for up to the retention window. And once the parent row is
 * gone nothing resolves the thread's tenant from the product side, which is the
 * same argument the priority-matrix R2 review used for its own rows.
 *
 * Every case carries BOTH arms: the deleted resource's thread is gone AND a
 * SIBLING resource's thread survives. A one-armed cascade test cannot tell a
 * correct cascade from one that deletes the whole tenant's comments.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createPage, deletePage, __resetCms } from '../src/features/cms/cmsService.js';
import { createCollection, deleteCollection } from '../src/features/kb/kbService.js';
import { createList, submitIdea, deleteIdea, deleteList } from '../src/features/priority-matrix/priorityMatrixService.js';
import { createComment, listThread, __resetCommentsStore } from '../src/features/comments/commentsService.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';

/** ADR 0659 D1 — `listThread` now answers `null` when the target is absent OR invisible.
 *  Every fixture here creates a real resource and is not testing that gate, so a null is
 *  a genuine failure rather than an expected branch. */
async function listThreadOrFail(...args: Parameters<typeof listThread>): Promise<NonNullable<Awaited<ReturnType<typeof listThread>>>> {
  const rows = await listThread(...args);
  if (rows === null) throw new Error('listThread resolved no target — the fixture did not create it');
  return rows;
}

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => { await __resetCommentsStore(); await __resetCms(); });

const ORG = 'o1';

describe('CMNT-2 — cms_page', () => {
  it('deleting a page removes its thread and leaves a sibling page’s thread intact', async () => {
    const T = 'cmt-casc-cms';
    const doomed = await createPage({ tenantId: T, orgId: ORG, title: 'Doomed', createdBy: 'u1' });
    const keeper = await createPage({ tenantId: T, orgId: ORG, title: 'Keeper', createdBy: 'u1' });
    for (const p of [doomed, keeper]) {
      await createComment({ tenantId: T, orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId, body: 'a note naming a person', authorId: 'u2' , caller: { subject: 'u2' }});
    }
    expect((await listThreadOrFail(T, ORG, 'cms_page', doomed.pageId, PREAUTHORIZED_CALLER)).length).toBe(1);

    expect(await deletePage(T, ORG, doomed.pageId)).toBe(true);

    expect(await listThread(T, ORG, 'cms_page', doomed.pageId, PREAUTHORIZED_CALLER), 'ADR 0659 D1 — the target is gone, so the thread does not resolve at all (stronger than an empty list)').toBeNull();
    expect((await listThreadOrFail(T, ORG, 'cms_page', keeper.pageId, PREAUTHORIZED_CALLER)).length).toBe(1);
  });
});

describe('CMNT-2 — kb_collection', () => {
  it('deleting a collection removes its thread and leaves a sibling collection’s thread intact', async () => {
    const T = 'cmt-casc-kb';
    const doomed = await createCollection(T, ORG, 'u1', { name: 'Doomed' });
    const keeper = await createCollection(T, ORG, 'u1', { name: 'Keeper' });
    for (const c of [doomed, keeper]) {
      await createComment({ tenantId: T, orgId: ORG, resourceType: 'kb_collection', resourceId: c.collectionId, body: 'a note naming a person', authorId: 'u2' , caller: { subject: 'u2' }});
    }
    expect((await listThreadOrFail(T, ORG, 'kb_collection', doomed.collectionId, PREAUTHORIZED_CALLER)).length).toBe(1);

    await deleteCollection(T, ORG, doomed.collectionId);

    expect(await listThread(T, ORG, 'kb_collection', doomed.collectionId, PREAUTHORIZED_CALLER), 'ADR 0659 D1 — the target is gone, so the thread does not resolve at all (stronger than an empty list)').toBeNull();
    expect((await listThreadOrFail(T, ORG, 'kb_collection', keeper.collectionId, PREAUTHORIZED_CALLER)).length).toBe(1);
  });
});

describe('CMNT-2 — priority_idea', () => {
  it('deleting ONE idea removes only that idea’s thread', async () => {
    const T = 'cmt-casc-idea';
    const list = await createList(T, ORG, 'u1', { name: 'Roadmap' });
    const doomed = await submitIdea(T, list.id, 'u1', { title: 'Doomed' });
    const keeper = await submitIdea(T, list.id, 'u1', { title: 'Keeper' });
    for (const cardId of [doomed.id, keeper.id]) {
      await createComment({ tenantId: T, orgId: ORG, resourceType: 'priority_idea', resourceId: `${list.id}#${cardId}`, body: 'a note naming a person', authorId: 'u2' , caller: { subject: 'u2' }});
    }

    expect(await deleteIdea(T, list.id, doomed.id, 'u1')).toBe(true);

    expect(await listThread(T, ORG, 'priority_idea', `${list.id}#${doomed.id}`, PREAUTHORIZED_CALLER), 'ADR 0659 D1 — the target is gone, so the thread does not resolve at all (stronger than an empty list)').toBeNull();
    expect((await listThreadOrFail(T, ORG, 'priority_idea', `${list.id}#${keeper.id}`, PREAUTHORIZED_CALLER)).length).toBe(1);
  });

  it('deleting the LIST removes every idea’s thread — the cardIds die with the board', async () => {
    const T = 'cmt-casc-list';
    const doomedList = await createList(T, ORG, 'u1', { name: 'Doomed' });
    const otherList = await createList(T, ORG, 'u1', { name: 'Other' });
    const a = await submitIdea(T, doomedList.id, 'u1', { title: 'A' });
    const b = await submitIdea(T, doomedList.id, 'u1', { title: 'B' });
    const c = await submitIdea(T, otherList.id, 'u1', { title: 'C' });
    for (const [lid, cid] of [[doomedList.id, a.id], [doomedList.id, b.id], [otherList.id, c.id]] as const) {
      await createComment({ tenantId: T, orgId: ORG, resourceType: 'priority_idea', resourceId: `${lid}#${cid}`, body: 'a note naming a person', authorId: 'u2' , caller: { subject: 'u2' }});
    }

    expect(await deleteList(T, doomedList.id, 'u1')).toBe(true);

    expect(await listThread(T, ORG, 'priority_idea', `${doomedList.id}#${a.id}`, PREAUTHORIZED_CALLER), 'ADR 0659 D1 — the target is gone, so the thread does not resolve at all (stronger than an empty list)').toBeNull();
    expect(await listThread(T, ORG, 'priority_idea', `${doomedList.id}#${b.id}`, PREAUTHORIZED_CALLER), 'ADR 0659 D1 — the target is gone, so the thread does not resolve at all (stronger than an empty list)').toBeNull();
    // The `#`-boundary match must not sweep a sibling LIST.
    expect((await listThreadOrFail(T, ORG, 'priority_idea', `${otherList.id}#${c.id}`, PREAUTHORIZED_CALLER)).length).toBe(1);
  });
});
