/**
 * ADR 0601 — `DELETE` on a notebook must not destroy first and validate after
 * (NBC-1), and `facet:'notebook'` must not be used as a discriminator that
 * `getNotebook` no longer agrees with.
 *
 * THE DEFECT. The ADR 0084 correction made a notebook "ANY project with a bound
 * KB collection" and dropped the facet check from `getNotebook`. Two delete doors
 * kept it, and `ensureNotebookForProject` never stamps `facet` — so a project
 * provisioned through `POST /:id/ensure` (which is what opening the Sources tab
 * does) is a first-class notebook to READS and something else entirely to DELETES:
 *
 *  1. `DELETE /notebooks/:id` ran `deleteConversationCompletely` FIRST, then
 *     `deleteNotebook` no-opped on `p.facet !== 'notebook'`. Result: HTTP 200
 *     `{"deleted":false, …, "conversationsDeleted":1}` — the project, its sources
 *     and its notes all survive, the entire group conversation is irrecoverably
 *     gone, and the response tells the user nothing was destroyed. Validation
 *     after an irreversible write.
 *
 *  2. `DELETE /projects/:id` branched `if (project?.facet === 'notebook')` before
 *     delegating to `deleteNotebook`. For the same ensure-provisioned project that
 *     branch is FALSE, so the plain `deleteProject` ran and the exclusive KB
 *     collection was left with no owner, no surface and no eraser — the exact R2
 *     PRJ2-B2 orphaned-corpus defect that branch exists to prevent, still live on
 *     the lane the correction created. Fixing only (1) leaves this one open: the
 *     guard is at the CALLER here, not inside `deleteNotebook`.
 *
 * The ordinary delete's conversation cascade (count 1, session + meta gone) is
 * witnessed in `notebooks-delete-cascade-reachability.test.ts` CONTROL, and a
 * PLAIN project's delete by the parity case's "nothing bound" lane below.
 *
 * Sabotage witnesses (grade-tests wave 20): restoring the `facet !== 'notebook'`
 * guard in `deleteNotebook` reds the ensure-provisioned cases + parity; a
 * `facet`-based discriminator at the projects door reds the /projects ensure case
 * + parity; a `facet`-based `deletesCorpus` advertisement reds parity; a
 * binding-position-0 eraser reds the SHARED control + parity; never deleting the
 * corpus reds every corpus case; a plain delete that claims a corpus reds parity.
 *
 * @see docs/adr/0601-notebooks-trust-boundary-and-mcp-authz.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { ProjectKnowledgeView } from '../src/features/projects/projectKnowledgeService.js';

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
  for (const id of ['notebooks', 'kb', 'users', 'projects']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface OrgBody { orgId: string }
interface IdBody { id: string }
interface CreatedBody { notebook: { id: string }; collectionId: string }
interface EnsureBody { collectionId: string }
interface ChatBody { conversationId: string }
interface CollectionBody { collectionId: string }
interface DeleteBody { deleted: boolean; collectionDeleted?: boolean; notebookCorpusDeleted?: boolean; conversationsDeleted: number }
interface ProjectView { deletesCorpus: boolean }
interface Client {
  get: <T = unknown>(p: string) => Promise<Res<T>>;
  post: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
  del: <T = unknown>(p: string) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const decoded: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: decoded as T };
  };
  return {
    get: <T = unknown>(p: string) => call<T>('GET', p),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
    del: <T = unknown>(p: string) => call<T>('DELETE', p),
  };
}

const NB = '/host/openwop-app/notebooks';
const PROJ = '/host/openwop-app/projects';

async function ownerWithOrg(who: string): Promise<{ c: Client; orgId: string }> {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await c.post<OrgBody>('/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId };
}

/** A PLAIN project (no `facet`) turned into a notebook the way the Sources tab
 *  does it — `POST /:id/ensure`. With a source, a note, and a real group
 *  conversation, so a delete has something to destroy. */
async function ensureProvisionedNotebook(who: string): Promise<{ c: Client; orgId: string; id: string; collectionId: string; conversationId: string }> {
  const { c, orgId } = await ownerWithOrg(who);
  const plain = await c.post<IdBody>(PROJ, { orgId, name: 'Regular project' });
  expect(plain.status, JSON.stringify(plain.body)).toBe(201);
  const id = plain.body.id;
  const ens = await c.post<EnsureBody>(`${NB}/${id}/ensure`);
  expect(ens.status, JSON.stringify(ens.body)).toBe(200);
  const collectionId = ens.body.collectionId;
  const src = await c.post(`${NB}/${id}/sources`, { title: 'Paper', text: 'Mitochondria are the powerhouse of the cell.' });
  expect(src.status).toBe(201);
  const chat = await c.post<ChatBody>(`${NB}/${id}/chat`);
  expect([200, 201], JSON.stringify(chat.body)).toContain(chat.status);
  // It reads as a notebook — which is precisely why the delete doors must agree.
  expect((await c.get(`${NB}/${id}`)).status).toBe(200);
  return { c, orgId, id, collectionId, conversationId: chat.body.conversationId };
}

describe('ADR 0601 / NBC-1 — DELETE /notebooks/:id validates BEFORE it destroys', () => {
  it('an /ensure-provisioned project deletes for real — no 200 that claims deleted:false', async () => {
    const { c, orgId, id, collectionId } = await ensureProvisionedNotebook('nb-del-ensure');

    const del = await c.del<DeleteBody>(`${NB}/${id}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    // THE defect: this used to be `false` while the conversation was already gone.
    expect(del.body.deleted, JSON.stringify(del.body)).toBe(true);
    expect(del.body.collectionDeleted, JSON.stringify(del.body)).toBe(true);

    // …and the claim is TRUE: the project, its sources and its corpus are gone.
    expect((await c.get(`${NB}/${id}`)).status).toBe(404);
    expect((await c.get(`${PROJ}/${id}`)).status).toBe(404);
    expect((await c.get(`/host/openwop-app/kb/orgs/${orgId}/collections/${collectionId}`)).status).toBe(404);
  });

  it('a notebook created through POST /notebooks (facet:notebook) still deletes — no regression', async () => {
    const { c, orgId } = await ownerWithOrg('nb-del-classic');
    const created = await c.post<CreatedBody>(NB, { orgId, name: 'Classic notebook' });
    expect(created.status).toBe(201);
    const id = created.body.notebook.id;
    const collectionId = created.body.collectionId;
    await c.post(`${NB}/${id}/sources`, { title: 'S', text: 'Some source text for the classic lane.' });

    const del = await c.del<DeleteBody>(`${NB}/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    expect(del.body.collectionDeleted).toBe(true);
    expect((await c.get(`/host/openwop-app/kb/orgs/${orgId}/collections/${collectionId}`)).status).toBe(404);
  });
});

describe('ADR 0601 / NBC-1 — the SIBLING door: DELETE /projects/:id', () => {
  it('deleting an /ensure-provisioned project through /projects also drops its corpus', async () => {
    const { c, orgId, id, collectionId } = await ensureProvisionedNotebook('nb-del-proj');

    const del = await c.del<DeleteBody>(`${PROJ}/${id}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.deleted).toBe(true);
    // The guard here was at the CALLER (`if (project?.facet === 'notebook')`), so
    // removing the one inside `deleteNotebook` does nothing for this lane. Without
    // fixing the discriminator too, the collection survives with no owner.
    expect(del.body.notebookCorpusDeleted, JSON.stringify(del.body)).toBe(true);
    expect((await c.get(`/host/openwop-app/kb/orgs/${orgId}/collections/${collectionId}`)).status).toBe(404);
  });

  it('CONTROL — a SHARED collection NAMED LIKE A PROVISIONED ONE is not destroyed, and the other project keeps it', async () => {
    // REWRITTEN (ADR 0601 § Corrections / HIGH-1). This test used to name the
    // collection `Company handbook`, which DODGES the `Notebook: ` / `Sources: `
    // prefix the eraser's last-resort guard tested — so it proved the guard
    // fired, not that the guard DISCRIMINATED. The name a user gives a shared
    // research corpus is very often exactly `Sources: <topic>`, and that name was
    // the only thing standing between it and deletion. PROVED against the guard:
    // shared collection 200 → 404, and a second project's knowledge list → [].
    //
    // The name is now the WORST case for the old guard. It survives because the
    // predicate is `notebookCollectionId` — provenance stamped at the two sites
    // that MINT a corpus — and this collection was minted by the KB surface, so
    // it is not stamped on anyone and cannot be erased by anyone's delete.
    const { c, orgId } = await ownerWithOrg('nb-del-shared');
    const shared = await c.post<CollectionBody>(`/host/openwop-app/kb/orgs/${orgId}/collections`, { name: 'Sources: Q3 research', description: 'Shared corpus' });
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);
    const sharedId = shared.body.collectionId;

    // TWO projects bound to it — "shared" has to be real, or "it survived" is
    // just "nothing else wanted it".
    const a = await c.post<IdBody>(PROJ, { orgId, name: 'Project A' });
    const b = await c.post<IdBody>(PROJ, { orgId, name: 'Project B' });
    const idA = a.body.id;
    const idB = b.body.id;
    for (const id of [idA, idB]) {
      const bound = await c.post(`${PROJ}/${id}/knowledge/bindings`, { collectionId: sharedId });
      expect([200, 201], JSON.stringify(bound.body)).toContain(bound.status);
    }

    const del = await c.del<DeleteBody>(`${PROJ}/${idA}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    expect(del.body.notebookCorpusDeleted, 'A delete that erases nothing must not claim it did').toBe(false);
    // The shared corpus other projects still use MUST survive…
    expect((await c.get(`/host/openwop-app/kb/orgs/${orgId}/collections/${sharedId}`)).status).toBe(200);
    // …and Project B must still SEE it. A 200 on the collection with an empty
    // binding list would be the same outage wearing a different status code.
    const knowledgeB = await c.get<ProjectKnowledgeView>(`${PROJ}/${idB}/knowledge`);
    expect(knowledgeB.status, JSON.stringify(knowledgeB.body)).toBe(200);
    expect(knowledgeB.body.collections.map((x) => x.collectionId), JSON.stringify(knowledgeB.body)).toContain(sharedId);
  });
});

describe('ADR 0601 § Corrections (HIGH-2) — the consent gate and the eraser share ONE predicate', () => {
  /** Read the project's projection and return the `deletesCorpus` the confirm
   *  dialog keys off. */
  const advertised = async (c: Client, id: string): Promise<unknown> => {
    const r = await c.get<ProjectView>(`${PROJ}/${id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.deletesCorpus;
  };

  it('what the project ADVERTISES is exactly what the delete DOES, on every provisioning lane', async () => {
    // THE defect this closes: the dialog asked `facet === 'notebook'` and the
    // backend asked something else, so the ensure-provisioned lane — the one
    // opening the Sources tab creates — was warned about a board and some notes
    // and then silently lost its entire source corpus, learning about it from
    // the SUCCESS TOAST. Consent after an irreversible act is not consent.
    //
    // This does not assert a hard-coded table of lanes; it asserts PARITY, so a
    // new provisioning lane cannot drift the two apart without failing here.
    const lanes: Array<{ name: string; make: () => Promise<{ c: Client; id: string }> }> = [
      {
        name: 'ensure-provisioned (no facet stamp — the population that got no warning)',
        make: async () => { const { c, id } = await ensureProvisionedNotebook('nb-consent-ensure'); return { c, id }; },
      },
      {
        name: 'classic POST /notebooks (facet:notebook)',
        make: async () => {
          const { c, orgId } = await ownerWithOrg('nb-consent-classic');
          const created = await c.post<CreatedBody>(NB, { orgId, name: 'Classic notebook' });
          expect(created.status).toBe(201);
          return { c, id: created.body.notebook.id };
        },
      },
      {
        name: 'plain project, nothing bound',
        make: async () => {
          const { c, orgId } = await ownerWithOrg('nb-consent-plain');
          const plain = await c.post<IdBody>(PROJ, { orgId, name: 'Nothing bound' });
          return { c, id: plain.body.id };
        },
      },
      {
        name: 'plain project bound to a SHARED corpus named like a provisioned one',
        make: async () => {
          const { c, orgId } = await ownerWithOrg('nb-consent-shared');
          const shared = await c.post<CollectionBody>(`/host/openwop-app/kb/orgs/${orgId}/collections`, { name: 'Sources: shared', description: 'Shared' });
          const sharedId = shared.body.collectionId;
          const plain = await c.post<IdBody>(PROJ, { orgId, name: 'Bound to shared' });
          const id = plain.body.id;
          await c.post(`${PROJ}/${id}/knowledge/bindings`, { collectionId: sharedId });
          return { c, id };
        },
      },
    ];
    // A floor: an empty lane list would make the loop below prove nothing.
    expect(lanes.length).toBeGreaterThanOrEqual(4);
    const seen = new Set<boolean>();
    for (const lane of lanes) {
      const { c, id } = await lane.make();
      const claim = await advertised(c, id);
      expect(typeof claim, `${lane.name}: the projection must ANSWER, not omit`).toBe('boolean');
      const del = await c.del<DeleteBody>(`${PROJ}/${id}`);
      expect(del.status, `${lane.name}: ${JSON.stringify(del.body)}`).toBe(200);
      // Every lane — including a plain project with nothing bound — really deletes.
      expect(del.body.deleted, `${lane.name}: ${JSON.stringify(del.body)}`).toBe(true);
      expect((await c.get(`${PROJ}/${id}`)).status, `${lane.name}: the project is gone`).toBe(404);
      expect(del.body.notebookCorpusDeleted, `${lane.name}: warned ${String(claim)}, did ${String(del.body.notebookCorpusDeleted)}`).toBe(claim);
      seen.add(claim === true);
    }
    // BOTH answers must have occurred, or the parity above is satisfied by a
    // predicate that is constant — the classic vacuity.
    expect([...seen].sort(), 'both a corpus-erasing and a non-erasing lane must be covered').toEqual([false, true]);
  });
});
