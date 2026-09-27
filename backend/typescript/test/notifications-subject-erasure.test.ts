/**
 * CMNT-11 — a DSAR must reclaim the notifications that NAME the subject, not
 * just the comment rows.
 *
 * Found in the Comments grade: `deleteSubjectComments` erased the comment and
 * left standing a notification carrying `recipientUserId`, `metadata.actorId`,
 * `metadata.recipientId` and the parent resource's title. The only reclamation
 * was `deleteAllTenantNotifications` ("used by account-delete") — tenant-level,
 * never per-subject.
 *
 * Both arms everywhere: the subject's rows go AND a bystander's rows survive. A
 * subject eraser that over-reaches is unrecoverable, which makes the second arm
 * the more important of the two.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { deleteSubjectNotifications } from '../src/host/notificationSubjectErasure.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { createPage, __resetCms } from '../src/features/cms/cmsService.js';
import { createComment, listThread, __resetCommentsStore } from '../src/features/comments/commentsService.js';
import { emitCommentNotification } from '../src/features/comments/notifications.js';
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

async function rows(tenantId: string) {
  return hostExtStorage().listNotifications({ tenantId, includeArchived: true, limit: 500 });
}

describe('CMNT-11 — per-subject notification erasure', () => {
  it('reaches all three places a subject is named, and touches nobody else', async () => {
    const T = 'cmt-erase-1';
    const s = hostExtStorage();
    const base = { tenantId: T, priority: 'normal' as const, status: 'unread' as const, createdAt: new Date().toISOString() };
    await s.insertNotification({ ...base, notificationId: 'n-recipient', type: 'comment.added', title: 'a', message: 'a', recipientUserId: 'subject' });
    await s.insertNotification({ ...base, notificationId: 'n-actor', type: 'comment.added', title: 'b', message: 'b', recipientUserId: 'other', metadata: { actorId: 'subject' } });
    await s.insertNotification({ ...base, notificationId: 'n-meta-recipient', type: 'comment.reply', title: 'c', message: 'c', metadata: { recipientId: 'subject' } });
    await s.insertNotification({ ...base, notificationId: 'n-bystander', type: 'comment.added', title: 'd', message: 'd', recipientUserId: 'other', metadata: { actorId: 'someone-else' } });
    await s.insertNotification({ ...base, notificationId: 'n-no-metadata', type: 'run.failed', title: 'e', message: 'e' });

    expect(await deleteSubjectNotifications(T, 'subject')).toBe(3);

    const left = (await rows(T)).map((r) => r.notificationId).sort();
    expect(left).toEqual(['n-bystander', 'n-no-metadata']);
  });

  it('is tenant-scoped — another tenant’s rows for the same subject key are untouched', async () => {
    const A = 'cmt-erase-a';
    const B = 'cmt-erase-b';
    const s = hostExtStorage();
    for (const t of [A, B]) {
      await s.insertNotification({
        tenantId: t, notificationId: `n-${t}`, type: 'comment.added', priority: 'normal', status: 'unread',
        title: 'x', message: 'x', createdAt: new Date().toISOString(), recipientUserId: 'subject',
      });
    }
    expect(await deleteSubjectNotifications(A, 'subject')).toBe(1);
    expect((await rows(B)).length).toBe(1);
  });

  it('fails CLOSED on an empty tenant or subject — never a widened purge', async () => {
    const T = 'cmt-erase-closed';
    await hostExtStorage().insertNotification({
      tenantId: T, notificationId: 'n-keep', type: 'comment.added', priority: 'normal', status: 'unread',
      title: 'x', message: 'x', createdAt: new Date().toISOString(), recipientUserId: 'subject',
    });
    expect(await deleteSubjectNotifications('', 'subject')).toBe(0);
    expect(await deleteSubjectNotifications(T, '')).toBe(0);
    expect((await rows(T)).length).toBe(1);
  });

  it('END TO END: a DSAR erases the comment AND the notification it produced', async () => {
    // The residual as it actually arises: an owner is notified about a comment
    // someone else left, then that someone else exercises their erasure right.
    const T = 'cmt-erase-e2e';
    const page = await createPage({ tenantId: T, orgId: 'o1', title: 'Home', createdBy: 'owner' });
    const c = await createComment({ tenantId: T, orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'a note', authorId: 'author' , caller: { subject: 'author' }});
    await emitCommentNotification(c.comment, c.notify);
    expect((await rows(T)).length, 'the notification must exist before erasure or this proves nothing').toBe(1);

    const out = await eraseSubject(T, 'author');
    expect(out.failed).toBe(0);

    expect((await listThreadOrFail(T, 'o1', 'cms_page', page.pageId, PREAUTHORIZED_CALLER)).length).toBe(0);
    expect((await rows(T)).length, 'the notification naming the erased author must be gone too').toBe(0);
  });
});
