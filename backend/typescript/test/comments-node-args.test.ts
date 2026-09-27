/**
 * WF-CMNT-2 / WF-CMNT-3 / WF-CMNT-6 — the node lane's own witness.
 *
 * The ONE pre-existing witness (`comments-route.test.ts`) drove `post` only,
 * only through `inputs`, with a hand-built `ctx = (i) => ({features, inputs: i})`.
 * So `list` and `resolve` were never driven through the node at all, and the
 * `config` channel — where RFC 0013 Path A puts a `{{params.X}}` token bound in
 * the node's config block — was supplied by NOTHING, making `WF-CMNT-3`
 * invisible by construction. Step-3.5 class 6.
 *
 * This file drives all three nodes through BOTH channels and asserts the read
 * lane fails TYPED rather than answering success-with-empty.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createPage, __resetCms } from '../src/features/cms/cmsService.js';
import { createComment, listThread, __resetCommentsStore } from '../src/features/comments/commentsService.js';
import { buildCommentsSurface } from '../src/features/comments/surface.js';
import { createOrg } from '../src/host/accessControlService.js';
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
let nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>>;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  const mod = await import('../../../packs/feature.comments.nodes/index.mjs');
  nodes = mod.nodes;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => { await __resetCommentsStore(); await __resetCms(); });

const T = 'cmt-node-args';
const MEMBER = 'user_member';
/** CMNT-4 — the surface now needs a real org the acting user is a member of.
 *  `o1` is minted once with `MEMBER` as its owner, in this tenant. */
beforeAll(async () => {
  await createOrg({ tenantId: T, createdBy: MEMBER, name: 'Acme', orgId: 'o1', ownerSubject: MEMBER });
});
const surf = () => buildCommentsSurface({ tenantId: T, runId: 'run-1', actingUserId: MEMBER });
/** The two channels RFC 0013 Path A can freeze a param into. */
const viaInputs = (i: Record<string, unknown>) => ({ features: { comments: surf() }, inputs: i });
const viaConfig = (c: Record<string, unknown>) => ({ features: { comments: surf() }, config: c });

describe('WF-CMNT-3 — a param frozen into `config` reaches the node', () => {
  it('post: works through `config` alone (Path A binds the token where the author put it)', async () => {
    const page = await createPage({ tenantId: T, orgId: 'o1', title: 'Doc', createdBy: 'owner1' });
    const args = { orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'from config' };

    const r = await nodes['feature.comments.nodes.post']!(viaConfig(args));

    expect(r.status).toBe('success');
    const rows = await listThreadOrFail(T, 'o1', 'cms_page', page.pageId, PREAUTHORIZED_CALLER);
    expect(rows.map((c) => c.body)).toEqual(['from config']);
  });

  it('list: works through `config` alone', async () => {
    const page = await createPage({ tenantId: T, orgId: 'o1', title: 'Doc', createdBy: 'owner1' });
    await createComment({ tenantId: T, orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'x', authorId: 'u' , caller: { subject: 'u' }});

    const r = await nodes['feature.comments.nodes.list']!(viaConfig({ orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId }));

    expect(r.status).toBe('success');
    expect((r.outputs!.comments as unknown[]).length).toBe(1);
  });

  it('resolve: works through `config` alone', async () => {
    const page = await createPage({ tenantId: T, orgId: 'o1', title: 'Doc', createdBy: 'owner1' });
    const c = await createComment({ tenantId: T, orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'x', authorId: 'u' , caller: { subject: 'u' }});

    const r = await nodes['feature.comments.nodes.resolve']!(viaConfig({ orgId: 'o1', commentId: c.comment.commentId }));

    expect(r.status).toBe('success');
    expect((await listThreadOrFail(T, 'o1', 'cms_page', page.pageId, PREAUTHORIZED_CALLER))[0]!.status).toBe('resolved');
  });

  it('INPUTS WIN over config on a conflict (a DAG value is a runtime fact)', async () => {
    const page = await createPage({ tenantId: T, orgId: 'o1', title: 'Doc', createdBy: 'owner1' });
    const ctx = {
      features: { comments: surf() },
      config: { orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'the config default' },
      inputs: { body: 'the runtime value' },
    };

    await nodes['feature.comments.nodes.post']!(ctx);

    expect((await listThreadOrFail(T, 'o1', 'cms_page', page.pageId, PREAUTHORIZED_CALLER)).map((c) => c.body)).toEqual(['the runtime value']);
  });

  it('CONTROL: the `inputs` channel still works (the merge must not break the old lane)', async () => {
    const page = await createPage({ tenantId: T, orgId: 'o1', title: 'Doc', createdBy: 'owner1' });
    const r = await nodes['feature.comments.nodes.post']!(viaInputs({ orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'from inputs' }));
    expect(r.status).toBe('success');
  });
});

describe('WF-CMNT-2 — the read lane fails TYPED, never success-with-empty', () => {
  it('an unknown resourceType throws and NAMES the valid enum', async () => {
    await expect(nodes['feature.comments.nodes.list']!(viaInputs({ orgId: 'o1', resourceType: 'not_a_type', resourceId: 'x' })))
      .rejects.toThrow(/MUST be one of/);
  });

  it('an ABSENT orgId throws instead of reporting an empty thread', async () => {
    // `surfaceStr` coerced a missing org to `''`, `listThread` filtered on it,
    // matched nothing, and the node reported `status:'success', comments: []`.
    await expect(nodes['feature.comments.nodes.list']!(viaInputs({ resourceType: 'cms_page', resourceId: 'x' })))
      .rejects.toThrow(/`orgId` is required/);
  });

  it('CONTROL: a genuinely empty thread STILL answers success with an empty list', async () => {
    // The fix must distinguish "bad input" from "nothing here" — not turn every
    // empty read into an error.
    const page = await createPage({ tenantId: T, orgId: 'o1', title: 'Doc', createdBy: 'owner1' });
    const r = await nodes['feature.comments.nodes.list']!(viaInputs({ orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId }));
    expect(r.status).toBe('success');
    expect(r.outputs!.comments).toEqual([]);
  });

  it('the WRITE lanes reject the same bad input typed (siblings stay consistent)', async () => {
    await expect(nodes['feature.comments.nodes.post']!(viaInputs({ orgId: 'o1', resourceType: 'nope', resourceId: 'x', body: 'b' })))
      .rejects.toThrow(/MUST be one of/);
    await expect(nodes['feature.comments.nodes.resolve']!(viaInputs({ commentId: 'cmt:x' })))
      .rejects.toThrow(/`orgId` is required/);
  });
});
