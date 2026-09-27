/**
 * `KBC-4` (Blocker) / ADR 0643 — the ADR 0610 D3' `assertOwnerReadable` membership
 * check across the by-id door CLASS in `features/documents/routes.ts`.
 *
 * CORRECTED after an adversarial review BLOCKED the first pass. That pass asserted
 * `ingest-to-kb` was "the ONE by-id door in this file that skips the check". It was
 * FALSE, and being false is why a live leak survived a commit whose entire purpose was
 * to close that leak. Counted by CALL GRAPH rather than by the filed gap's wording:
 *
 *   grep -n 'documents/:documentId'   routes.ts  →  9 doors (10 incl. /locate/)
 *   grep -n 'await assertOwnerReadable' routes.ts →  5 call sites
 *
 * So FIVE doors skipped it — PATCH, DELETE, `POST …/versions`, `render` and
 * `promote-html` — not one. (The review named four; `POST …/versions` is the fifth.)
 *
 * The compounding error was ruling the assessment's original exploit out from the one
 * door under repair. `ingest-to-kb` gates on `workspace:write`, and `levelFor:356`
 * hands `'write'` (⇒ read) to every `workspace:write` holder in the owning org before
 * visibility is read — so no caller reaching THAT door can be refused by visibility.
 * That fact describes one door's scope, never the class's. `promote-html` gates on
 * `workspace:read`, where `levelFor` walks a non-member org viewer on a `private`
 * project all the way to `'none'` — and it returned the FULL body. The filed exploit
 * was real, one door away, and measured here before the fix:
 *   {"html":"<p>BOARD-ONLY: acquire Globex for 42M before Q3</p>","title":"Merger plan"}
 * returned to a caller with no project membership.
 *
 * WHAT THIS FILE PINS, per door:
 *   • egress doors — `ingest-to-kb` (copies content into a KB collection the caller
 *     reads back), `promote-html` (returns the body as html), `render` (mints a
 *     durable PDF Media token of the body): all must ask the seam.
 *   • write doors — PATCH / DELETE / `POST versions`: deliberately NOT gated, with the
 *     premise ("the refusal population is exactly 'owning project deleted', and gating
 *     it would be a gate with no exit") pinned by its own tests so the decision fails
 *     loudly if the premise stops holding. See the block comment above `app.patch` in
 *     `routes.ts` and the "write doors" describe below.
 *
 * Positive controls throughout guard against a dead cure.
 *
 * @see docs/adr/0643-kb-reindex-orchestration-write-surface-lifecycle-events.md
 * @see docs/adr/0610-owner-subject-access-and-egress-allowlist.md (D3')
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember } from '../src/host/accessControlService.js';
import { registerSubjectAccessResolver } from '../src/host/subjectAccess.js';
import { resolveProjectAccess } from '../src/features/projects/projectsService.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'projects', 'documents']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
// Any test that swaps the seam puts the REAL resolver back, so ordering can never
// leak a stubbed predicate into a sibling test.
afterEach(() => { registerSubjectAccessResolver('project', async (t, s, c) => resolveProjectAccess(t, s.id, c)); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

const P = '/v1/host/openwop-app/projects';
const DOC = (orgId: string): string => `/v1/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}/documents`;
const KB = (orgId: string): string => `/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections`;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

const TITLE = 'Merger plan';
const SECRET = 'BOARD-ONLY: acquire Globex for 42M before Q3';

/** Owner + a project + a project-owned document that HAS content. */
async function fixture(visibility: 'private' | 'org' = 'private') {
  const tenantId = `org:kbc4-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('own'), tenantId });
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'PrivCo' })).body.orgId;
  const projectId = (await owner.post(P, { orgId, name: 'Secret' })).body.id;
  const create = await owner.post(DOC(orgId), {
    title: TITLE, kind: 'note', format: 'markdown',
    ownerSubject: { kind: 'project', id: projectId },
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const documentId: string = create.body.documentId;
  // Content is load-bearing: with no current version the route 400s on "no content
  // to ingest" BEFORE it would leak, which would make the witness pass for the
  // wrong reason.
  const ver = await owner.post(`${DOC(orgId)}/${documentId}/versions`, { content: SECRET });
  expect(ver.status, JSON.stringify(ver.body)).toBe(201);
  expect((await owner.patch(`${P}/${projectId}/visibility`, { visibility })).body.visibility).toBe(visibility);
  return { tenantId, orgId, projectId, documentId, owner };
}

/** A real org EDITOR (workspace:write — what this door gates on) who is NOT a project member. */
async function orgEditor(tenantId: string, orgId: string): Promise<Client & { userId: string }> {
  const c = client();
  const userId = (await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('edit'), tenantId })).body.user.userId;
  await createMember({ tenantId, orgId, subject: userId, displayName: 'E', roles: ['editor'] });
  return Object.assign(c, { userId: userId as string });
}

/** A real org VIEWER (workspace:read only) who is NOT a project member — the caller
 *  `levelFor` can actually walk to `'none'`, and the one the write doors exclude. */
async function orgViewer(tenantId: string, orgId: string): Promise<Client & { userId: string }> {
  const c = client();
  const userId = (await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('view'), tenantId })).body.user.userId;
  await createMember({ tenantId, orgId, subject: userId, displayName: 'V', roles: ['viewer'] });
  return Object.assign(c, { userId: userId as string });
}

const newCollection = async (c: Client, orgId: string, name: string): Promise<string> => {
  const col = await c.post(KB(orgId), { name });
  expect(col.status, JSON.stringify(col.body)).toBe(201);
  return col.body.collectionId as string;
};

/** Nothing named the document reached the collection, whatever shape the refusal took. */
async function assertNothingCopied(c: Client, orgId: string, collectionId: string): Promise<void> {
  const listed = await c.get(`${KB(orgId)}/${encodeURIComponent(collectionId)}/documents`);
  expect(listed.status).toBe(200);
  expect(listed.body.documents ?? []).toHaveLength(0);
  expect(JSON.stringify(listed.body)).not.toContain(TITLE);
}

describe('KBC-4 — ingest-to-kb consults the ADR 0610 D3′ owner-readable seam', () => {
  it('refuses a document whose owning project is GONE — the read door already does (born-red)', async () => {
    const { orgId, projectId, documentId, owner } = await fixture('org');
    expect((await owner.del(`${P}/${projectId}`)).status).toBe(200);

    // The precondition that makes this a leak and not a preference: the READ door
    // refuses this row outright.
    expect((await owner.get(`${DOC(orgId)}/${documentId}`)).status).toBe(404);

    // …so the COPY door must refuse it too. Before the fix this returned 201 and
    // wrote the full version text into the collection.
    const collectionId = await newCollection(owner, orgId, 'Sink');
    const copied = await owner.post(`${DOC(orgId)}/${documentId}/ingest-to-kb`, { collectionId });
    expect(copied.status, JSON.stringify(copied.body)).toBe(404);
    expect(JSON.stringify(copied.body ?? {})).not.toContain(TITLE);
    await assertNothingCopied(owner, orgId, collectionId);
  });

  it('refuses whenever the subjectAccess seam denies the caller (born-red)', async () => {
    const { tenantId, orgId, documentId, projectId } = await fixture('private');
    const attacker = await orgEditor(tenantId, orgId);
    const collectionId = await newCollection(attacker, orgId, 'Mine');

    // Control: the attacker really does hold workspace:write in this org, so the
    // 404 below is the owner-subject gate and not a broken login.
    expect((await attacker.post(DOC(orgId), { title: 'scratch', kind: 'note', format: 'markdown' })).status).toBe(201);

    // The seam says NO for this caller on this project (see the header note on why
    // the shipped predicate cannot say that to a `workspace:write` caller today).
    registerSubjectAccessResolver('project', async (t, s, c) => (s.id === projectId && c === attacker.userId ? 'none' : resolveProjectAccess(t, s.id, c)));

    const stolen = await attacker.post(`${DOC(orgId)}/${documentId}/ingest-to-kb`, { collectionId });
    expect(stolen.status, JSON.stringify(stolen.body)).toBe(404);
    expect(JSON.stringify(stolen.body ?? {})).not.toContain(TITLE);
    await assertNothingCopied(attacker, orgId, collectionId);
  });

  it('the OWNER still ingests, and a project MEMBER still ingests (no dead cure)', async () => {
    const { tenantId, orgId, documentId, projectId, owner } = await fixture('private');

    const ok = await owner.post(`${DOC(orgId)}/${documentId}/ingest-to-kb`, { collectionId: await newCollection(owner, orgId, 'Owner KB') });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.document.title).toBe(TITLE);

    const member = await orgEditor(tenantId, orgId);
    expect((await owner.post(`${P}/${projectId}/members`, { ref: `user:${member.userId}`, role: 'observer' })).status).toBe(201);
    const viaMember = await member.post(`${DOC(orgId)}/${documentId}/ingest-to-kb`, { collectionId: await newCollection(member, orgId, 'Member KB') });
    expect(viaMember.status, JSON.stringify(viaMember.body)).toBe(201);
  });
});

/**
 * ─── THE CLASS, enumerated by CALL GRAPH (the correction that BLOCKED the first pass) ───
 *
 * The first version of this file — and the route comment it justified — asserted that
 * `ingest-to-kb` was "the ONE by-id door in this file that skips the check". That was
 * FALSE, and the way it was reached is the whole lesson: the door being fixed was tested,
 * the class was not. `grep -n 'documents/:documentId' routes.ts` returns NINE doors (ten
 * with `/locate/:documentId`); `grep -n 'await assertOwnerReadable'` returns FIVE. So five
 * doors skipped it, not one.
 *
 * Worse, ruling the assessment's original exploit out from `ingest-to-kb` alone was
 * invalid: that door gates on `workspace:write`, and `levelFor:356` hands `'write'`
 * (⇒ read) to every `workspace:write` holder in the project's org, so NO caller who
 * reaches it can be refused by visibility. `promote-html` gates on **`workspace:read`**,
 * and for a non-member org VIEWER on a `private` project `levelFor` walks all the way to
 * `'none'`. The filed exploit was real one door away, and it returns the FULL current
 * version body (`markdownToHtml(current.content)`).
 *
 * The remaining doors, and why each is treated the way it is, are pinned below.
 */
describe('the door CLASS — every by-id door that can EGRESS content asks the seam', () => {
  it('promote-html: a workspace:read NON-MEMBER on a PRIVATE project gets nothing (born-red — this was a live leak)', async () => {
    const { tenantId, orgId, documentId, owner, projectId } = await fixture('private');
    const viewer = await orgViewer(tenantId, orgId);

    // Controls: the viewer is a genuine org reader, and the READ door already
    // refuses this row — so the 404 below is the owner gate, not a broken login,
    // and the leak is "two doors, same row, opposite answers".
    expect((await viewer.get(DOC(orgId))).status, 'the viewer really can read the documents surface').toBe(200);
    expect((await viewer.get(`${DOC(orgId)}/${documentId}`)).status, 'the GET door refuses it').toBe(404);
    expect((await viewer.get(`${P}/${projectId}`)).status, 'the project door refuses it').toBe(404);

    const leaked = await viewer.post(`${DOC(orgId)}/${documentId}/promote-html`);
    expect(leaked.status, JSON.stringify(leaked.body)).toBe(404);
    // The body is the assertion that matters — a status code alone would pass if a
    // future refusal still shipped the html alongside it.
    expect(JSON.stringify(leaked.body ?? {})).not.toContain(SECRET);
    expect(JSON.stringify(leaked.body ?? {})).not.toContain(TITLE);

    // Positive control: the owner still promotes (not a brick).
    const ok = await owner.post(`${DOC(orgId)}/${documentId}/promote-html`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(JSON.stringify(ok.body), 'the owner still gets the html — not a dead cure').toContain(SECRET);
  });

  it('promote-html: also refuses a document whose owning project is GONE (born-red)', async () => {
    const { orgId, projectId, documentId, owner } = await fixture('org');
    expect((await owner.del(`${P}/${projectId}`)).status).toBe(200);
    expect((await owner.get(`${DOC(orgId)}/${documentId}`)).status).toBe(404);
    const gone = await owner.post(`${DOC(orgId)}/${documentId}/promote-html`);
    expect(gone.status, JSON.stringify(gone.body)).toBe(404);
    expect(JSON.stringify(gone.body ?? {})).not.toContain(SECRET);
  });

  it('render: refuses too — it mints a durable PDF media token of the same body (born-red)', async () => {
    // `render` never loaded the row at all, so it had neither the notFound nor the
    // owner gate. It gates on workspace:write, so (per the note above) the reachable
    // refusal is the deleted-owner shape — but the egress is the worst of the set:
    // a Media token outlives the request, exactly the "escapes durably" property the
    // ingest-door fix is justified by.
    const { orgId, projectId, documentId, owner } = await fixture('org');
    expect((await owner.del(`${P}/${projectId}`)).status).toBe(200);
    const rendered = await owner.post(`${DOC(orgId)}/${documentId}/render`, { format: 'pdf' });
    expect(rendered.status, JSON.stringify(rendered.body)).toBe(404);
    expect(JSON.stringify(rendered.body ?? {})).not.toContain('mediaToken');
  });
});

/**
 * The two WRITE doors the review also asked for — and the measured reason they are
 * deliberately NOT gated. Reported as a decision, not an omission.
 *
 * CLAIM (proved by the two tests below): at PATCH / DELETE / POST-versions,
 * `assertOwnerReadable` can refuse EXACTLY ONE population — a document whose owning
 * project no longer exists — and can never refuse an attacker. All three gate on
 * `workspace:write` in the path org; `resolveOwnerSubject:233` pins the owning
 * project's org EQUAL to the document's org at create time; `levelFor:356` returns
 * `'write'` to any `workspace:write` holder in that org before visibility is read.
 * The only branch left is `getProject → null ⇒ 'none'`. (`agent`/`user` ownerSubjects
 * have no registered resolver at all, so they return `null` ⇒ pass.)
 *
 * And in that one population, gating is the GATE-WITH-NO-EXIT shape the codebase has
 * already ruled against in this exact situation: `deleteProject` releases a KB
 * collection's `boundSubject` BEFORE clearing the project precisely because
 * "`resolveSubjectAccess` cannot distinguish 'this project denies you' from 'this
 * project is gone' — both are `'none'`. Leaving it would turn the collection into
 * unreachable dead data for everyone, which is the gate-with-no-exit shape and
 * strictly worse than the leak the stamp closes" (ADR 0608 D4, `projectsService.ts:484-492`).
 * Documents are not cascaded on project delete, so gating PATCH+DELETE would strand
 * the row permanently: unreadable, un-renderable, un-reassignable and UNDELETABLE,
 * with its content still on disk. Neither door egresses content (PATCH returns the row
 * projection, DELETE returns 204), so there is nothing to trade for that.
 */
describe('the write doors: the refusal population is exactly "owner is gone", and it must stay recoverable', () => {
  it('an org WRITER is never refused by visibility — the population is empty for them', async () => {
    // If this ever goes red, the premise above is falsified and PATCH/DELETE/versions
    // must be gated: it would mean a caller CAN reach them while the seam denies.
    const { tenantId, orgId, documentId } = await fixture('private');
    const writer = await orgEditor(tenantId, orgId);
    expect((await writer.get(`${DOC(orgId)}/${documentId}`)).status, 'a workspace:write holder reads a private project doc').toBe(200);
    expect((await writer.post(`${DOC(orgId)}/${documentId}/versions`, { content: 'edit' })).status).toBe(201);
  });

  it('a stranded document (owning project deleted) stays RECOVERABLE and cleanable', async () => {
    const { orgId, projectId, documentId, owner } = await fixture('org');
    expect((await owner.del(`${P}/${projectId}`)).status).toBe(200);
    expect((await owner.get(`${DOC(orgId)}/${documentId}`)).status, 'unreadable while stranded').toBe(404);

    // THE EXIT: re-point ownerSubject, and the row is readable again. Gating PATCH
    // would remove this and make the strand permanent.
    const fixed = await owner.patch(`${DOC(orgId)}/${documentId}`, { ownerSubject: null });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect((await owner.get(`${DOC(orgId)}/${documentId}`)).status, 'recovered').toBe(200);

    // …and a stranded row can always be deleted rather than becoming dead data.
    const second = await fixture('org');
    expect((await second.owner.del(`${P}/${second.projectId}`)).status).toBe(200);
    expect((await second.owner.del(`${DOC(second.orgId)}/${second.documentId}`)).status, 'cleanable').toBe(204);
  });
});
