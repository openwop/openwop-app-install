/**
 * ADR 0838 — the documents store's integrity witnesses (feature loop 2026-10 row 24).
 *
 * D1 `DOCWF2-1` — `documents:doc` is keyed by `documentId` ALONE. `createDocument`'s
 * caller-supplied-id short-circuit checked only `getDocument(tenant, org, id)`, so an
 * id already held by ANOTHER tenant (or another org) read as "absent" and the blind
 * `docs.put` overwrote that row: the victim's document moved into the caller's tenant.
 * Reachable without guessing: the content-marketing demo seeder writes the SAME
 * `doc:demo-cm-<slug>` ids in every tenant it seeds.
 *
 * D2 `DOCWF2-2` — approval gates a document, but the public share served the CURRENT
 * version. Any `workspace:write` holder (or a run / agent) could add a version to an
 * approved document and the new, never-approved text went public at once.
 *
 * D3 `DOCWF2-3` — the current-version pointer was a blind put, so a concurrent PATCH
 * (or an older addVersion finishing late) could move it backwards.
 *
 * Sabotage-witnessed (grade-tests w14): an owner predicate that ignores org, an
 * owned-insert that converges instead of 409ing, a public view of the current (not
 * approved) version, approved→final re-pinning, keeping the pin on demote, approving
 * an empty document, skipping the legacy pin, a backward pointer move, a blind put in
 * `mutateDocument`, ignoring the named approval version, a lax stale-base check, a
 * retry at n+1 after a lost slot, and no pointer heal each turn a case red.
 */
import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { buildDocumentsSurface } from '../src/features/documents/surface.js';
import {
  createDocument, getDocument, addVersion, updateDocument, publicDocumentView, listVersions,
  _putDocumentForTest, _putVersionForTest, __setBeforeDocSwapHook,
} from '../src/features/documents/documentsService.js';

const TENANT_A = 'org:adr0838-a';
const TENANT_B = 'org:adr0838-b';
let ORG_A = '';
let ORG_A2 = '';
let ORG_B = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  ORG_A = (await createOrg({ tenantId: TENANT_A, createdBy: 'u-a', name: 'A', ownerSubject: 'u-a' })).orgId;
  ORG_A2 = (await createOrg({ tenantId: TENANT_A, createdBy: 'u-a', name: 'A2', ownerSubject: 'u-a' })).orgId;
  ORG_B = (await createOrg({ tenantId: TENANT_B, createdBy: 'u-b', name: 'B', ownerSubject: 'u-b' })).orgId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const user = (id: string) => ({ kind: 'user' as const, id });

describe('ADR 0838 D1 — a caller-supplied document id never overwrites another tenant or org', () => {
  it('another tenant creating the same id is refused, and the owner keeps its row', async () => {
    const id = 'doc:adr0838-shared-id';
    await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'A secret', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a', documentId: id });
    await addVersion(TENANT_A, ORG_A, id, { content: 'A body', producedBy: user('u-a') });

    await expect(createDocument({ tenantId: TENANT_B, orgId: ORG_B, title: 'B', kind: 'doc', provenance: { producedBy: user('u-b') }, createdBy: 'u-b', documentId: id }))
      .rejects.toMatchObject({ httpStatus: 409 });

    const still = await getDocument(TENANT_A, ORG_A, id);
    expect(still?.title).toBe('A secret');
    expect(await getDocument(TENANT_B, ORG_B, id)).toBeNull();
  });

  it('another org in the SAME tenant is refused too', async () => {
    const id = 'doc:adr0838-cross-org';
    await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'Org A', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a', documentId: id });
    await expect(createDocument({ tenantId: TENANT_A, orgId: ORG_A2, title: 'Org A2', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a', documentId: id }))
      .rejects.toMatchObject({ httpStatus: 409 });
    expect((await getDocument(TENANT_A, ORG_A, id))?.title).toBe('Org A');
  });

  it('the run surface lane (caller-chosen documentId / idemBase) cannot take another tenant\'s row', async () => {
    const id = 'doc:adr0838-surface';
    await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'A via route', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a', documentId: id });
    const surfaceB = buildDocumentsSurface({ tenantId: TENANT_B, runId: 'run-b' });
    await expect(surfaceB.createDocument!({ orgId: ORG_B, title: 'stolen', kind: 'doc', documentId: id })).rejects.toMatchObject({ httpStatus: 409 });
    await expect(surfaceB.createDraftDocument!({ orgId: ORG_B, title: 'stolen', content: 'x', idemBase: 'adr0838-surface' })).rejects.toMatchObject({ httpStatus: 409 });
    expect((await getDocument(TENANT_A, ORG_A, id))?.title).toBe('A via route');
  });

  it('a same-tenant same-org replay still converges on the prior row (idempotency kept)', async () => {
    const id = 'doc:adr0838-replay';
    const first = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'R', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a', documentId: id });
    const again = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'R2', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a', documentId: id });
    expect(again.documentId).toBe(first.documentId);
    expect(again.title).toBe('R');
  });
});

describe('ADR 0838 D2 — the public share serves the APPROVED version, not whatever was written since', () => {
  it('a version added after approval does not reach the public view until re-approved', async () => {
    const doc = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'SOW', kind: 'sow', provenance: { producedBy: user('u-a') }, createdBy: 'u-a' });
    await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'APPROVED TEXT', producedBy: user('u-a') });
    await updateDocument(TENANT_A, ORG_A, doc.documentId, 'u-a', { status: 'approved' });
    expect((await publicDocumentView(TENANT_A, ORG_A, doc.documentId))?.content).toBe('APPROVED TEXT');

    // A writer (or a run, or an agent) adds a version without the approver.
    await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'UNAPPROVED EDIT', producedBy: { kind: 'run', id: 'run-x' } });
    const view = await publicDocumentView(TENANT_A, ORG_A, doc.documentId);
    expect(view?.content).toBe('APPROVED TEXT');
    expect(view?.version).toBe(1);

    // The document records that the published text is behind the latest draft.
    const after = await getDocument(TENANT_A, ORG_A, doc.documentId);
    expect(after?.approvedVersionId).toBe(`${doc.documentId}:1`);
    expect(after?.currentVersionId).toBe(`${doc.documentId}:2`);

    // approved → final with no version named keeps the pin: finalising must not
    // publish text nobody approved (grade-code improvement 1).
    await updateDocument(TENANT_A, ORG_A, doc.documentId, 'u-a', { status: 'final' });
    expect((await publicDocumentView(TENANT_A, ORG_A, doc.documentId))?.content).toBe('APPROVED TEXT');
    // Approving the latest version by name publishes the new text.
    await updateDocument(TENANT_A, ORG_A, doc.documentId, 'u-a', { status: 'final', approvedVersionId: `${doc.documentId}:2` });
    expect((await publicDocumentView(TENANT_A, ORG_A, doc.documentId))?.content).toBe('UNAPPROVED EDIT');
  });

  it('demoting below approved clears the pin; the link goes dark', async () => {
    const doc = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'Demote', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a' });
    await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'v1', producedBy: user('u-a') });
    await updateDocument(TENANT_A, ORG_A, doc.documentId, 'u-a', { status: 'approved' });
    await updateDocument(TENANT_A, ORG_A, doc.documentId, 'u-a', { status: 'draft' });
    expect(await publicDocumentView(TENANT_A, ORG_A, doc.documentId)).toBeNull();
    expect((await getDocument(TENANT_A, ORG_A, doc.documentId))?.approvedVersionId).toBeUndefined();
  });

  it('approving a document with no content is refused (nothing to publish)', async () => {
    const doc = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'Empty', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a' });
    await expect(updateDocument(TENANT_A, ORG_A, doc.documentId, 'u-a', { status: 'approved' })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('a LEGACY approved row (no pin) keeps publishing its current text, and the next write pins it first', async () => {
    const doc = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'Legacy', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a' });
    await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'legacy approved', producedBy: user('u-a') });
    const row = await getDocument(TENANT_A, ORG_A, doc.documentId);
    const legacy = { ...row!, status: 'approved' as const };
    delete (legacy as { approvedVersionId?: string }).approvedVersionId;
    await _putDocumentForTest(legacy);
    // Not dark at deploy: unchanged from before ADR 0838.
    expect((await publicDocumentView(TENANT_A, ORG_A, doc.documentId))?.content).toBe('legacy approved');
    await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'written after deploy', producedBy: user('u-a') });
    expect((await publicDocumentView(TENANT_A, ORG_A, doc.documentId))?.content).toBe('legacy approved');
    expect((await getDocument(TENANT_A, ORG_A, doc.documentId))?.approvedVersionId).toBe(`${doc.documentId}:1`);
  });

  it('approve-what-you-see: an approver naming the version on screen pins THAT version, not a newer one', async () => {
    const doc = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'Seen', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a' });
    const v1 = await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'what the approver read', producedBy: user('u-a') });
    await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'saved while they read', producedBy: user('u-b') });
    await updateDocument(TENANT_A, ORG_A, doc.documentId, 'u-a', { status: 'approved', approvedVersionId: v1.versionId });
    expect((await publicDocumentView(TENANT_A, ORG_A, doc.documentId))?.content).toBe('what the approver read');
    await expect(updateDocument(TENANT_A, ORG_A, doc.documentId, 'u-a', { status: 'approved', approvedVersionId: 'doc:nope:1' })).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe('ADR 0838 D4 / A2 — the current-version pointer only moves forward', () => {
  it('concurrent versions leave the pointer on the highest version', async () => {
    const doc = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'Race', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a' });
    await Promise.all(Array.from({ length: 6 }, (_, i) => addVersion(TENANT_A, ORG_A, doc.documentId, { content: `c${i}`, producedBy: user('u-a') })));
    const vs = await listVersions(TENANT_A, ORG_A, doc.documentId);
    const after = await getDocument(TENANT_A, ORG_A, doc.documentId);
    expect(after?.currentVersionId).toBe(vs[0]!.versionId);
  });

  it('a PATCH that read the row BEFORE a version landed does not roll the pointer back (deterministic interleave)', async () => {
    const doc = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'Patch race', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a' });
    await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'one', producedBy: user('u-a') });
    let fired = false;
    __setBeforeDocSwapHook(async () => {
      if (fired) return;
      fired = true;
      // The PATCH has read the row (pointer at :1); a version lands now.
      await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'two', producedBy: user('u-a') });
    });
    try {
      await updateDocument(TENANT_A, ORG_A, doc.documentId, 'u-a', { title: 'renamed' });
    } finally {
      __setBeforeDocSwapHook(undefined);
    }
    const after = await getDocument(TENANT_A, ORG_A, doc.documentId);
    expect(fired).toBe(true);
    expect(after?.currentVersionId).toBe(`${doc.documentId}:2`);
    expect(after?.title).toBe('renamed');
  });

  it('an approval that read the row before a version landed pins the version it re-read, never a stale row', async () => {
    const doc = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'Approve race', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a' });
    const v1 = await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'one', producedBy: user('u-a') });
    let fired = false;
    __setBeforeDocSwapHook(async () => {
      if (fired) return;
      fired = true;
      await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'two', producedBy: user('u-b') });
    });
    try {
      await updateDocument(TENANT_A, ORG_A, doc.documentId, 'u-a', { status: 'approved', approvedVersionId: v1.versionId });
    } finally {
      __setBeforeDocSwapHook(undefined);
    }
    const after = await getDocument(TENANT_A, ORG_A, doc.documentId);
    expect(after?.currentVersionId).toBe(`${doc.documentId}:2`);
    expect(after?.approvedVersionId).toBe(v1.versionId);
    expect((await publicDocumentView(TENANT_A, ORG_A, doc.documentId))?.content).toBe('one');
  });
});

describe('ADR 0838 D5 — a checked edit cannot land on text it did not read', () => {
  it('baseVersionId must be current; a stale base is a typed 409 naming the current version', async () => {
    const doc = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'Checked', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a' });
    const v1 = await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'one', producedBy: user('u-a') });
    const v2 = await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'two', producedBy: user('u-a'), baseVersionId: v1.versionId });
    expect(v2.version).toBe(2);
    await expect(addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'stale', producedBy: user('u-b'), baseVersionId: v1.versionId }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'stale_base', currentVersionId: v2.versionId } });
    expect((await listVersions(TENANT_A, ORG_A, doc.documentId)).length).toBe(2);
  });

  it('a concurrent writer that has taken the next slot but not yet moved the pointer still makes the edit fail (no retry at n+1)', async () => {
    const doc = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'In flight', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a' });
    await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'one', producedBy: user('u-a') });
    const vrow = (n: number, content: string) => ({ versionId: `${doc.documentId}:${n}`, documentId: doc.documentId, tenantId: TENANT_A, orgId: ORG_A, version: n, content, producedBy: user('u-b'), createdAt: new Date().toISOString() });
    // Version 2 exists with the pointer lagging at :1, so the checked save below heals
    // the pointer first — and the swap hook lands ANOTHER writer's version 3 in that
    // window: after the edit's base check (base :2 is the newest it saw), before its
    // insert. Its slot (:3) is taken, and it must fail rather than retry at :4.
    await _putVersionForTest(vrow(2, 'two'));
    let fired = false;
    __setBeforeDocSwapHook(async () => {
      if (fired) return;
      fired = true;
      await _putVersionForTest(vrow(3, 'theirs'));
    });
    try {
      await expect(addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'mine', producedBy: user('u-a'), baseVersionId: `${doc.documentId}:2` }))
        .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'stale_base' } });
    } finally {
      __setBeforeDocSwapHook(undefined);
    }
    expect(fired).toBe(true);
    const contents = (await listVersions(TENANT_A, ORG_A, doc.documentId)).map((v) => v.content);
    expect(contents).not.toContain('mine');
    expect(contents).toHaveLength(3);
  });

  it('a pointer left one behind (row inserted, pointer move lost) heals, so checked saves are not refused forever (grade-code H2)', async () => {
    const doc = await createDocument({ tenantId: TENANT_A, orgId: ORG_A, title: 'Lagging', kind: 'doc', provenance: { producedBy: user('u-a') }, createdBy: 'u-a' });
    const v1 = await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'one', producedBy: user('u-a') });
    await _putVersionForTest({ versionId: `${doc.documentId}:2`, documentId: doc.documentId, tenantId: TENANT_A, orgId: ORG_A, version: 2, content: 'two', producedBy: user('u-a'), createdAt: new Date().toISOString() });
    // A client that loaded the lagging pointer is told the real latest, and the pointer heals.
    await expect(addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'x', producedBy: user('u-a'), baseVersionId: v1.versionId }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'stale_base', currentVersionId: `${doc.documentId}:2` } });
    expect((await getDocument(TENANT_A, ORG_A, doc.documentId))?.currentVersionId).toBe(`${doc.documentId}:2`);
    // After a reload the save goes through.
    const v3 = await addVersion(TENANT_A, ORG_A, doc.documentId, { content: 'three', producedBy: user('u-a'), baseVersionId: `${doc.documentId}:2` });
    expect(v3.version).toBe(3);
  });
});
