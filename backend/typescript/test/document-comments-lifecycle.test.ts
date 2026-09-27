/**
 * canvas.document ↔ comments integration (ADR 0334 CMT-1 / CMT-2 / DATA-1).
 * Boots the real app so the comments feature's `onCanvasDeleted('comments')` hook
 * is registered, then proves: (CMT-1) the `canvas_document` comment target
 * validator accepts a real canvas.document and rejects a wrong-type canvas;
 * (CMT-2/DATA-1) firing the canvas-deleted seam prunes the document's comments.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { fireCanvasDeleted } from '../src/host/canvasLifecycle.js';
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

const TENANT = 'tnt-doc';
const ORG = 'org-doc';
const AUTHOR = 'user:doc-author';
const docContent = { type: 'doc', content: [{ type: 'paragraph' }] };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});
afterAll(() => { delete process.env.OPENWOP_STORAGE_DSN; });
beforeEach(() => __resetCommentsStore());

async function makeCanvas(canvasTypeId: string): Promise<string> {
  const c = await createCanvasForTenant(TENANT, { canvasTypeId, name: 'Doc', initialState: { title: 'Doc', content: docContent } });
  return c.canvasId;
}

describe('canvas.document comments (CMT-1 target validator)', () => {
  it('accepts a comment on a real canvas.document (title resolved)', async () => {
    const canvasId = await makeCanvas('canvas.document');
    const { comment } = await createComment({ tenantId: TENANT, orgId: ORG, resourceType: 'canvas_document', resourceId: canvasId, body: 'nice paragraph', authorId: AUTHOR , caller: { subject: AUTHOR }});
    expect(comment.resourceId).toBe(canvasId);
    expect((await listThreadOrFail(TENANT, ORG, 'canvas_document', canvasId, PREAUTHORIZED_CALLER))).toHaveLength(1);
  });

  it('rejects a comment on a non-existent canvas (uniform 404)', async () => {
    await expect(createComment({ tenantId: TENANT, orgId: ORG, resourceType: 'canvas_document', resourceId: 'missing', body: 'x', authorId: AUTHOR , caller: { subject: AUTHOR }}))
      .rejects.toMatchObject({ httpStatus: 404 });
  });

  it('rejects a comment on a WRONG-type canvas (not canvas.document → null → 404)', async () => {
    const drawingId = await makeCanvas('canvas.drawing');
    await expect(createComment({ tenantId: TENANT, orgId: ORG, resourceType: 'canvas_document', resourceId: drawingId, body: 'x', authorId: AUTHOR , caller: { subject: AUTHOR }}))
      .rejects.toMatchObject({ httpStatus: 404 });
  });

  it('accepts an INLINE range-anchored comment (composite `canvasId#threadId`, 6b)', async () => {
    const canvasId = await makeCanvas('canvas.document');
    const resourceId = `${canvasId}#th-abc`;
    const { comment } = await createComment({ tenantId: TENANT, orgId: ORG, resourceType: 'canvas_document', resourceId, body: 'on this phrase', authorId: AUTHOR , caller: { subject: AUTHOR }});
    expect(comment.resourceId).toBe(resourceId);
    // The whole-canvas thread and the inline thread are distinct threads.
    expect(await listThreadOrFail(TENANT, ORG, 'canvas_document', resourceId, PREAUTHORIZED_CALLER)).toHaveLength(1);
    expect(await listThreadOrFail(TENANT, ORG, 'canvas_document', canvasId, PREAUTHORIZED_CALLER)).toHaveLength(0);
  });

  it('rejects an inline comment whose canvasId portion is a wrong-type canvas (6b)', async () => {
    const drawingId = await makeCanvas('canvas.drawing');
    await expect(createComment({ tenantId: TENANT, orgId: ORG, resourceType: 'canvas_document', resourceId: `${drawingId}#th-x`, body: 'x', authorId: AUTHOR , caller: { subject: AUTHOR }}))
      .rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('canvas.document delete → comments prune (CMT-2 / DATA-1)', () => {
  it('prunes a document\'s comments when the canvas-deleted seam fires', async () => {
    const canvasId = await makeCanvas('canvas.document');
    await createComment({ tenantId: TENANT, orgId: ORG, resourceType: 'canvas_document', resourceId: canvasId, body: 'to be orphaned', authorId: AUTHOR , caller: { subject: AUTHOR }});
    expect(await listThreadOrFail(TENANT, ORG, 'canvas_document', canvasId, PREAUTHORIZED_CALLER)).toHaveLength(1);
    // The real comments hook (registered at boot) runs via the seam.
    await fireCanvasDeleted({ tenantId: TENANT, canvasId, canvasTypeId: 'canvas.document' });
    expect(await listThreadOrFail(TENANT, ORG, 'canvas_document', canvasId, PREAUTHORIZED_CALLER)).toHaveLength(0);
  });

  it('does NOT prune when a non-document canvas is deleted (type gate)', async () => {
    const canvasId = await makeCanvas('canvas.document');
    await createComment({ tenantId: TENANT, orgId: ORG, resourceType: 'canvas_document', resourceId: canvasId, body: 'keep me', authorId: AUTHOR , caller: { subject: AUTHOR }});
    await fireCanvasDeleted({ tenantId: TENANT, canvasId, canvasTypeId: 'canvas.drawing' });
    expect(await listThreadOrFail(TENANT, ORG, 'canvas_document', canvasId, PREAUTHORIZED_CALLER)).toHaveLength(1);
  });

  it('cascades BOTH the whole-canvas AND inline range-anchored threads on delete (6b)', async () => {
    const canvasId = await makeCanvas('canvas.document');
    const inlineA = `${canvasId}#th-a`;
    const inlineB = `${canvasId}#th-b`;
    await createComment({ tenantId: TENANT, orgId: ORG, resourceType: 'canvas_document', resourceId: canvasId, body: 'whole', authorId: AUTHOR , caller: { subject: AUTHOR }});
    await createComment({ tenantId: TENANT, orgId: ORG, resourceType: 'canvas_document', resourceId: inlineA, body: 'inline a', authorId: AUTHOR , caller: { subject: AUTHOR }});
    await createComment({ tenantId: TENANT, orgId: ORG, resourceType: 'canvas_document', resourceId: inlineB, body: 'inline b', authorId: AUTHOR , caller: { subject: AUTHOR }});

    // A sibling canvas whose id shares a string prefix must NOT be swept.
    const sibling = await makeCanvas('canvas.document');
    await createComment({ tenantId: TENANT, orgId: ORG, resourceType: 'canvas_document', resourceId: sibling, body: 'sibling keep', authorId: AUTHOR , caller: { subject: AUTHOR }});

    await fireCanvasDeleted({ tenantId: TENANT, canvasId, canvasTypeId: 'canvas.document' });

    expect(await listThreadOrFail(TENANT, ORG, 'canvas_document', canvasId, PREAUTHORIZED_CALLER)).toHaveLength(0);
    expect(await listThreadOrFail(TENANT, ORG, 'canvas_document', inlineA, PREAUTHORIZED_CALLER)).toHaveLength(0);
    expect(await listThreadOrFail(TENANT, ORG, 'canvas_document', inlineB, PREAUTHORIZED_CALLER)).toHaveLength(0);
    expect(await listThreadOrFail(TENANT, ORG, 'canvas_document', sibling, PREAUTHORIZED_CALLER)).toHaveLength(1);
  });
});
