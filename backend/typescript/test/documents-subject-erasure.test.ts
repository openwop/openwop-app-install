/**
 * UX_UPGRADE-documents R2 — DOC2-B1.
 *
 * `documents` is a subject-signalled feature that registered NO subject eraser,
 * NO retention purger and NO PII declaration, so `eraseSubject` fanned out to
 * every feature that HAD registered, skipped this one, and returned success. A
 * compliance path reporting completion having missed a whole store.
 *
 * The design decision under test is anonymize-not-delete: a document is ORG
 * content and the author identifier is the personal data, so deleting the
 * documents would destroy the workspace's records in order to remove a name
 * from them. The host contract sanctions this — `SubjectEraser` "deletes or
 * anonymizes".
 *
 * The exception is a document OWNED BY the erased subject. Dropping the
 * ownership link alone is not enough: `SHAREABLE_STATUSES` is
 * `['approved','final']`, so an `approved` document would stay on the PUBLIC
 * share surface after its owner asked to be erased.
 *
 * Sabotage-witnessed (grade-tests w14): skipping the version/template anonymize
 * or the doc count reds the first case; keeping `approved` or the approval pin reds
 * the unpublish case; matching ANY user producer reds the negative control; writing
 * non-matching rows reds idempotency; erasing in another tenant, or dropping the
 * version/template tenant filters, reds the cross-tenant case; not registering the
 * eraser reds the wiring case. The doc-level outer tenant filter is double-guarded
 * by `mutateDocument`'s fresh-row check (honest ceiling: neither alone can red).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createUser } from '../src/features/users/usersService.js';
import {
  createDocument, getDocument, addVersion, listVersions,
  SHAREABLE_STATUSES, updateDocument, createTemplate, getTemplate,
} from '../src/features/documents/documentsService.js';
import { eraseDocumentSubject, ERASED_SUBJECT } from '../src/features/documents/erasure.js';
import { eraseSubject } from '../src/host/subjectErasure.js';

const TENANT = 'org:doc-erase';
// Real user rows: `resolveOwnerSubject` refuses an `ownerSubject` whose user is
// not in the tenant (the ADR 0046 derived-org invariant), so a made-up id makes
// the owner case unreachable — and a test that never reaches the branch it
// claims to cover reports green.
let SUBJECT = '';
let OTHER = '';
let ORG = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  SUBJECT = (await createUser({ tenantId: TENANT, principalId: 'password:erase@t.test', displayName: 'Erase Me' })).userId;
  OTHER = (await createUser({ tenantId: TENANT, principalId: 'password:keep@t.test', displayName: 'Keep Me' })).userId;
  const org = await createOrg({ tenantId: TENANT, createdBy: SUBJECT, name: 'Doc Erase' });
  ORG = org.orgId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const aDoc = (createdBy: string, extra: { ownerSubject?: { kind: 'user'; id: string } } = {}) =>
  createDocument({
    tenantId: TENANT, orgId: ORG, title: `doc-${Math.round(performance.now() * 1000)}`,
    kind: 'note', format: 'markdown',
    provenance: { producedBy: { kind: 'user', id: createdBy } },
    createdBy,
    ...extra,
  });

describe('DOC2-B1 — erasure reaches documents, and anonymizes rather than deletes', () => {
  it('removes the subject id from documents, versions and templates while KEEPING the content', async () => {
    const doc = await aDoc(SUBJECT);
    await addVersion(TENANT, ORG, doc.documentId, {
      content: 'the org needs this text to survive',
      producedBy: { kind: 'user', id: SUBJECT },
    });
    const tmpl = await createTemplate({ tenantId: TENANT, orgId: ORG, name: 'Their template', kind: 'note', promptBody: 'Write it.', createdBy: SUBJECT });

    // DOCT-4 / WF-DOC-8 — the eraser REPORTS what it touched (doc + version +
    // template = at least 3), so the DSAR seam's `foundNothing` wrong-tenant tell
    // can see this feature instead of a void-return opt-out.
    const report = await eraseDocumentSubject(TENANT, SUBJECT);
    expect(report.rowsTouched).toBeGreaterThanOrEqual(3);

    const after = await getDocument(TENANT, ORG, doc.documentId);
    expect(after, 'the document itself must NOT be deleted — it is org content').toBeTruthy();
    expect(after?.createdBy, 'the author identifier is what gets erased').toBe(ERASED_SUBJECT);
    expect(after?.provenance.producedBy.id).toBe(ERASED_SUBJECT);

    const vs = await listVersions(TENANT, ORG, doc.documentId);
    expect(vs.length, 'versions survive').toBeGreaterThan(0);
    expect(vs[0]?.content, 'and keep their content').toContain('the org needs this text');
    expect(vs[0]?.producedBy.id, 'but not their author').toBe(ERASED_SUBJECT);

    const t = await getTemplate(TENANT, ORG, tmpl.templateId);
    expect(t, 'the template survives').toBeTruthy();
    expect(t?.createdBy, 'and loses its author identifier').toBe(ERASED_SUBJECT);
  });

  it('unpublishes a document the subject OWNED — dropping the link is not enough', async () => {
    // The property found by reading what the statuses actually gate: an
    // `approved` doc is in SHAREABLE_STATUSES, so an owner erasure that only
    // cleared `ownerSubject` would leave it on the PUBLIC share surface.
    const doc = await aDoc(OTHER, { ownerSubject: { kind: 'user', id: SUBJECT } });
    // NOTE the argument order — (tenantId, orgId, documentId, ACTOR, PATCH).
    // The first draft passed these transposed, so `patch` was a string,
    // `patch.status` was undefined, and the call silently changed nothing. Tests
    // are excluded from tsconfig, so nothing typechecked it; `check-test-types`
    // would have caught it at CI, and the precondition below caught it here.
    // ADR 0838 D2 — approval pins a version, so the document needs content first.
    await addVersion(TENANT, ORG, doc.documentId, { content: 'owned text', producedBy: { kind: 'user', id: OTHER } });
    await updateDocument(TENANT, ORG, doc.documentId, OTHER, { status: 'approved' });

    // PRECONDITION, asserted rather than assumed. The first version of this test
    // only checked `SHAREABLE_STATUSES` contains 'approved' — a fact about a
    // CONSTANT, not about this document — and a sabotage probe that removed the
    // unpublish line came back GREEN, because the row was never shareable to
    // begin with. An "X is no longer true" assertion is vacuous until X is shown
    // to have been true.
    const before = await getDocument(TENANT, ORG, doc.documentId);
    expect(before?.status, 'the document really is approved before we erase').toBe('approved');
    expect(SHAREABLE_STATUSES.includes(before!.status), 'and therefore publicly shareable').toBe(true);

    await eraseDocumentSubject(TENANT, SUBJECT);

    const after = await getDocument(TENANT, ORG, doc.documentId);
    expect(after?.ownerSubject, 'the ownership link is gone').toBeUndefined();
    expect(
      SHAREABLE_STATUSES.includes(after!.status),
      'and it is no longer publicly shareable',
    ).toBe(false);
    // ADR 0838 D2 — leaving the shareable statuses clears the approval pin.
    expect(before?.approvedVersionId, 'the pin existed').toBeTruthy();
    expect(after?.approvedVersionId, 'and is cleared with the demotion').toBeUndefined();
  });

  it('leaves ANOTHER subject\'s documents completely untouched (the negative control)', async () => {
    // Without this, "erasure works" would be satisfied by an eraser that
    // anonymizes the whole tenant.
    const mine = await aDoc(OTHER);
    await eraseDocumentSubject(TENANT, SUBJECT);
    const after = await getDocument(TENANT, ORG, mine.documentId);
    expect(after?.createdBy, 'a different subject keeps their attribution').toBe(OTHER);
    expect(after?.provenance.producedBy.id).toBe(OTHER);
  });

  it('is idempotent — the contract invokes it once per linked identity key', async () => {
    const doc = await aDoc(SUBJECT);
    await eraseDocumentSubject(TENANT, SUBJECT);
    const once = await getDocument(TENANT, ORG, doc.documentId);
    await eraseDocumentSubject(TENANT, SUBJECT);
    await eraseDocumentSubject(TENANT, SUBJECT);
    const thrice = await getDocument(TENANT, ORG, doc.documentId);
    expect(thrice).toEqual(once);
  });

  it('does not erase across tenants', async () => {
    const other = await createOrg({ tenantId: 'org:doc-erase-2', createdBy: SUBJECT, name: 'Other' });
    const foreign = await createDocument({
      tenantId: 'org:doc-erase-2', orgId: other.orgId, title: 'foreign', kind: 'note', format: 'markdown',
      provenance: { producedBy: { kind: 'user', id: SUBJECT } }, createdBy: SUBJECT,
    });
    // A version and a template too, so EACH of the eraser's three tenant filters is observable.
    await addVersion('org:doc-erase-2', other.orgId, foreign.documentId, { content: 'foreign text', producedBy: { kind: 'user', id: SUBJECT } });
    const foreignTmpl = await createTemplate({ tenantId: 'org:doc-erase-2', orgId: other.orgId, name: 'Foreign template', kind: 'note', promptBody: 'Write it.', createdBy: SUBJECT });
    const report = await eraseDocumentSubject(TENANT, SUBJECT);
    const after = await getDocument('org:doc-erase-2', other.orgId, foreign.documentId);
    expect(after?.createdBy, 'the same person in a DIFFERENT tenant is out of scope').toBe(SUBJECT);
    const foreignVs = await listVersions('org:doc-erase-2', other.orgId, foreign.documentId);
    expect(foreignVs.map((v) => v.producedBy.id), 'foreign versions keep their author').toEqual([SUBJECT]);
    expect((await getTemplate('org:doc-erase-2', other.orgId, foreignTmpl.templateId))?.createdBy, 'foreign templates keep their author').toBe(SUBJECT);
    // DOCT-4 — and the report says NOTHING was touched here (the tell the
    // WF-PRJ-3 wrong-tenant class rides on): this run had no in-tenant rows
    // for the subject left un-erased by earlier tests in this file, so a
    // nonzero count would mean cross-tenant reach.
    expect(report.rowsTouched, 'a wrong-tenant erasure must report zero, not silence').toBe(0);
  });
});

describe('DOC2-B1 — the eraser is actually WIRED, not merely written', () => {
  it('is registered with the host registry at feature registration', async () => {
    // A handler that exists but was never registered is the exact shape of the
    // original defect. `createApp` above registers the features, so by now the
    // documents eraser must be reachable through the host seam — assert via the
    // observable effect rather than by re-importing our own function.
    const doc = await aDoc(SUBJECT);
    await eraseSubject(TENANT, SUBJECT);
    const after = await getDocument(TENANT, ORG, doc.documentId);
    expect(after?.createdBy, 'the HOST fan-out must reach documents').toBe(ERASED_SUBJECT);
  });
});
