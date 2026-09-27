/**
 * CMNT-4 / CMNT-5 — the workflow surface was the ONE lane with no org-membership
 * predicate, and its `resolve` handed the author-only guard its own comparand.
 *
 * CMNT-4. `buildCommentsSurface` derived `tenantId` from the run scope (correct)
 * and took `orgId` VERBATIM from node args, while `routes.ts` went through
 * `authorizeOrgScope` → `requireOrgScope` and `agentTools.ts` through
 * `resolveReadOrgScope`/`resolveActionOrgScope`. So a chain node in a tenant with
 * several orgs could read and write comment threads in an org the run had no
 * membership in. Intra-tenant cross-org: the tenant boundary held.
 *
 * REACHABILITY PER LANE — the point of this file. `scope.actingUserId` is present
 * for a human-initiated run and ABSENT for a system run (schedule / inbound
 * webhook). Both are real, and neither branch is assumed away:
 *   - MEMBER lane            → allowed (and it must be, or the gate is a wall);
 *   - NON-MEMBER lane        → 403, same org, same tenant;
 *   - FOREIGN-ORG lane       → 404, indistinguishable from absent (no existence leak);
 *   - SYSTEM-RUN lane        → 403 with a NAMED EXIT, not a bare refusal.
 *
 * CMNT-5. `resolve` passed `existing.authorId` as the `actorId` — precisely the
 * value `updateComment` compares against for its author-only body-edit guard, so
 * the guard was tautologically satisfied by the row it protects. Nothing was
 * bypassed while only `{status:'resolved'}` is patched; the assertion below pins
 * the actor so the landmine cannot be re-armed by adding `body` to that call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { createPage, __resetCms } from '../src/features/cms/cmsService.js';
import { createComment, getComment, listThread, __resetCommentsStore } from '../src/features/comments/commentsService.js';
import { buildCommentsSurface } from '../src/features/comments/surface.js';
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

const T = 'cmt-authz';
const OTHER_TENANT = 'cmt-authz-other';
const MEMBER = 'user_member';
const STRANGER = 'user_stranger';
const READER = 'user_reader';
let ORG = '';
let FOREIGN_ORG = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });

  ORG = (await createOrg({ tenantId: T, createdBy: MEMBER, name: 'Acme', ownerSubject: MEMBER })).orgId;
  // A VIEWER in the same org: has `workspace:read`, must not have `workspace:write`.
  await createMember({ tenantId: T, orgId: ORG, subject: READER, displayName: 'Reader', roles: ['viewer'] });
  // An org in ANOTHER tenant — the cross-tenant arm.
  FOREIGN_ORG = (await createOrg({ tenantId: OTHER_TENANT, createdBy: 'somebody', name: 'Foreign', ownerSubject: 'somebody' })).orgId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => { await __resetCommentsStore(); await __resetCms(); });

/** A HUMAN-INITIATED run: `actingUserId` is stamped at creation and survives `:fork`. */
const asUser = (subject: string) => buildCommentsSurface({ tenantId: T, runId: 'run-1', actingUserId: subject });
/** A SYSTEM run: schedule / inbound webhook. No principal exists. */
const asSystem = () => buildCommentsSurface({ tenantId: T, runId: 'run-sys' });

async function page() {
  return createPage({ tenantId: T, orgId: ORG, title: 'Doc', createdBy: MEMBER });
}

describe('CMNT-4 — the MEMBER lane still works (a gate that blocks everyone is a wall)', () => {
  it('a member of the org can post, list and resolve', async () => {
    const p = await page();
    const s = asUser(MEMBER);
    expect(await s.post({ orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId, body: 'agent note' })).toBeTruthy();
    expect(((await s.list({ orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId })) as { comments: unknown[] }).comments).toHaveLength(1);
    const row = (await listThreadOrFail(T, ORG, 'cms_page', p.pageId, PREAUTHORIZED_CALLER))[0]!;
    expect((await s.resolve({ orgId: ORG, commentId: row.commentId })) as unknown).toBeTruthy();
  });
});

describe('CMNT-4 — the NON-MEMBER lane is refused (this is the defect)', () => {
  it('a same-tenant non-member cannot READ another org’s thread', async () => {
    const p = await page();
    await createComment({ tenantId: T, orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId, body: 'private', authorId: MEMBER , caller: { subject: MEMBER }});
    await expect(asUser(STRANGER).list({ orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId }))
      .rejects.toThrow(/Missing required scope: workspace:read/);
  });

  it('a same-tenant non-member cannot WRITE into another org’s thread', async () => {
    const p = await page();
    await expect(asUser(STRANGER).post({ orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId, body: 'intruding' }))
      .rejects.toThrow(/Missing required scope: workspace:write/);
    expect(await listThreadOrFail(T, ORG, 'cms_page', p.pageId, PREAUTHORIZED_CALLER)).toHaveLength(0);
  });

  it('a READ-only member may list but not post (the scope, not just membership, is checked)', async () => {
    const p = await page();
    await createComment({ tenantId: T, orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId, body: 'visible', authorId: MEMBER , caller: { subject: MEMBER }});
    const s = asUser(READER);
    expect(((await s.list({ orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId })) as { comments: unknown[] }).comments).toHaveLength(1);
    await expect(s.post({ orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId, body: 'nope' }))
      .rejects.toThrow(/Missing required scope: workspace:write/);
  });

  it('an org in ANOTHER tenant is a uniform 404 — never a cross-tenant existence leak', async () => {
    await expect(asUser(MEMBER).list({ orgId: FOREIGN_ORG, resourceType: 'cms_page', resourceId: 'x' }))
      .rejects.toThrow(/Organization not found/);
    // An org that does not exist at all fails IDENTICALLY.
    await expect(asUser(MEMBER).list({ orgId: 'org-does-not-exist', resourceType: 'cms_page', resourceId: 'x' }))
      .rejects.toThrow(/Organization not found/);
  });
});

describe('CMNT-4 — the SYSTEM-RUN lane is refused, and the refusal names its exit', () => {
  // NOT deleted as unreachable: a scheduled run or an inbound webhook produces
  // exactly this scope. Membership is not "denied" here, it is UNDEFINED — and
  // answering an undefined authorization question with "yes" was the defect.
  it('all three verbs refuse a run with no acting user', async () => {
    const p = await page();
    const s = asSystem();
    for (const call of [
      () => s.list({ orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId }),
      () => s.post({ orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId, body: 'x' }),
      () => s.resolve({ orgId: ORG, commentId: 'cmt:x' }),
    ]) await expect(call()).rejects.toThrow(/requires an acting user/);
  });

  it('the message TELLS the caller what to do instead (a gate with no exit is a defect)', async () => {
    const p = await page();
    await expect(asSystem().post({ orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId, body: 'x' }))
      .rejects.toThrow(/human-initiated context|chat tools/);
  });
});

describe('CMNT-5 — resolve no longer forges the author-only guard’s own argument', () => {
  it('the actor is the agent principal, not the row’s authorId', async () => {
    const p = await page();
    const c = await createComment({ tenantId: T, orgId: ORG, resourceType: 'cms_page', resourceId: p.pageId, body: 'someone else’s', authorId: 'a-different-human' , caller: { subject: 'a-different-human' }});

    await asUser(MEMBER).resolve({ orgId: ORG, commentId: c.comment.commentId });

    const after = await getComment(T, ORG, c.comment.commentId, PREAUTHORIZED_CALLER);
    expect(after?.status).toBe('resolved');
    // The row's author is untouched — resolve is member-level, not authorship.
    expect(after?.authorId).toBe('a-different-human');
  });

  it('REGRESSION GUARD: the surface source does not pass `existing.authorId` as the actor', async () => {
    // The behavioural assertion above cannot see the defect today, because only
    // `{status:'resolved'}` is patched and the guard fires only for `body`. What
    // made this a finding is the LANDMINE: adding `body` to that call would give
    // an ungated edit-anyone's-comment path. Pin the argument itself.
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/features/comments/surface.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1'); // comments are not code
    expect(/updateComment\s*\(/.test(src), 'the resolve call vanished — this guard is inert, re-point it').toBe(true);
    expect(src).not.toMatch(/existing\.authorId/);
  });
});
