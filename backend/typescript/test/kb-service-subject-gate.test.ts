/**
 * `KBC-1` (ADR 0643 D2 PRECONDITION) — the ADR 0608 `boundSubject` gate, asserted
 * at the SERVICE rather than at the HTTP door.
 *
 * WHY THIS FILE EXISTS AND `project-knowledge-visibility.test.ts` DOES NOT COVER IT.
 * That file is the CPC-2 witness and it is a good one — but every assertion in it
 * goes over HTTP. The gate it pins was mounted on `kb/routes.ts` alone
 * (`resolveSubjectAccess` appeared for KB at exactly two sites, both there), so a
 * suite that only ever knocks on the HTTP door cannot tell a gate mounted on the
 * DOOR from a gate mounted on the ROWS. Everything that is not a door — the
 * `ctx.features.kb` surface, `ctx.knowledge` (every workflow run and every agent
 * chat turn), `ctx.features.docs` — read straight past it, and the suite stayed
 * green throughout. That is the read side of the H1 leak whose birth site was
 * closed at create time.
 *
 * So these legs deliberately call the SERVICE and the SURFACE, never `fetch`. The
 * HTTP legs stay where they are; a door test cannot witness a door-shaped bug.
 *
 * The two lanes the precondition names by name:
 *   - a WORKFLOW RUN — `buildHostSurfaceBundle({ tenantId, actingUserId })`, the
 *     exact scope `executor.ts` builds per run.
 *   - an AGENT CHAT TURN — `ctx.knowledge`, whose backend IS `tenantRetrieve`
 *     (`features/kb/feature.ts` installs it at boot).
 *
 * BORN-RED, both of them, on `5cb15bcc1`: with the gate reverted the non-member
 * run reads the verbatim chunk text of a private project's corpus.
 *
 * @see docs/adr/0643-kb-reindex-orchestration-write-surface-lifecycle-events.md (D2 precondition)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember } from '../src/host/accessControlService.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { getCollection, listCollections, listDocuments, search, tenantRetrieve } from '../src/features/kb/kbService.js';

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
  for (const id of ['users', 'kb', 'projects', 'notebooks', 'docs']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const P = '/v1/host/openwop-app/projects';
const SECRET = 'ACQUIRE ACME FOR 40M. Board only.';
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

/** Owner + a PRIVATE project + a project-bound collection holding one secret doc,
 *  plus a real org VIEWER of the same org who is NOT a project member. */
async function fixture() {
  const tenantId = `org:kbc1-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId: string = (await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('kbc1-owner'), tenantId })).body.user.userId;
  const orgId: string = (await owner.post('/v1/host/openwop-app/orgs', { name: 'PrivCo' })).body.orgId;
  const projectId: string = (await owner.post(P, { orgId, name: 'Secret' })).body.id;
  const col = await owner.post(`${P}/${projectId}/knowledge/collections`, { orgId, name: 'Secret notes' });
  expect(col.status, JSON.stringify(col.body)).toBe(201);
  const collectionId: string = col.body.collectionId;
  const ing = await owner.post(`${P}/${projectId}/knowledge/collections/${collectionId}/documents`, { orgId, title: 'Merger plan', text: SECRET });
  expect(ing.status, JSON.stringify(ing.body)).toBe(201);
  expect((await owner.patch(`${P}/${projectId}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');

  const viewer = client();
  const viewerId: string = (await viewer.post('/v1/host/openwop-app/test/login', { email: uniqEmail('kbc1-viewer'), tenantId })).body.user.userId;
  await createMember({ tenantId, orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
  return { tenantId, orgId, projectId, collectionId, ownerId, viewerId };
}

/** The surface bundle a RUN gets. `actingUserId` present = a human-owned run;
 *  absent = a system run (schedule / inbound webhook), which is exactly how
 *  `executor.ts` builds it from `run.metadata.actingUserId`. */
const runBundle = (tenantId: string, actingUserId?: string) =>
  buildHostSurfaceBundle({ tenantId, runId: `run-${n++}`, ...(actingUserId ? { actingUserId } : {}) });

describe('KBC-1 — a workflow run cannot read a project-bound corpus it is not a member of', () => {
  it('ctx.features.kb: search / rag / listCollections are ALL refused for a non-member run (born-red)', async () => {
    const { tenantId, orgId, collectionId, viewerId } = await fixture();
    const kb = runBundle(tenantId, viewerId).features.kb!;

    // A refused collection is a UNIFORM not-found, never "forbidden" — the gate
    // must not become an existence oracle (the same answer the routes give).
    await expect(kb.search!({ orgId, collectionId, query: 'acme merger' })).rejects.toThrow(/not found/i);
    await expect(kb.rag!({ orgId, collectionId, query: 'acme merger' })).rejects.toThrow(/not found/i);
    const listed = (await kb.listCollections!({ orgId })).collections as Array<{ collectionId: string }>;
    expect(listed.some((c) => c.collectionId === collectionId)).toBe(false);
  });

  it('the project OWNER\'s run still reads it — the gate has an EXIT, it is not a brick', async () => {
    const { tenantId, orgId, collectionId, ownerId } = await fixture();
    const kb = runBundle(tenantId, ownerId).features.kb!;
    const hits = (await kb.search!({ orgId, collectionId, query: 'acme merger' })).results as Array<{ text: string }>;
    expect(hits.length).toBeGreaterThan(0);
    expect((await kb.listCollections!({ orgId })).collections as Array<{ collectionId: string }>)
      .toEqual(expect.arrayContaining([expect.objectContaining({ collectionId })]));
  });

  it('a SYSTEM run (no acting user) is refused — the fail-closed decision, asserted', async () => {
    const { tenantId, orgId, collectionId } = await fixture();
    // No `actingUserId`: a schedule-fired or webhook-fired run. It has no
    // membership to resolve, so it may not read a membership-scoped corpus.
    const kb = runBundle(tenantId).features.kb!;
    await expect(kb.search!({ orgId, collectionId, query: 'acme merger' })).rejects.toThrow(/not found/i);
  });

  it('an ORDINARY org collection is untouched — the gate bites only on a bound row', async () => {
    const { tenantId, orgId, viewerId } = await fixture();
    const kb = runBundle(tenantId, viewerId).features.kb!;
    const plain = await kb.listCollections!({ orgId });
    // The viewer creates an ordinary org collection through the KB service face
    // used by every non-project lane, and can read it back in the same run.
    const { createCollection, ingestDocument } = await import('../src/features/kb/kbService.js');
    const col = await createCollection(tenantId, orgId, viewerId, { name: 'Org handbook' });
    await ingestDocument(tenantId, orgId, viewerId, col.collectionId, { title: 'PTO', text: 'Paid time off accrues monthly.' });
    const hits = (await kb.search!({ orgId, collectionId: col.collectionId, query: 'time off' })).results as unknown[];
    expect(hits.length).toBeGreaterThan(0);
    expect((plain.collections as unknown[]).length).toBeGreaterThanOrEqual(0);
  });
});

describe('KBC-1 — an agent chat turn cannot read a project-bound corpus through ctx.knowledge', () => {
  it('ctx.knowledge fans out across the tenant and MUST drop the bound collection (born-red)', async () => {
    const { tenantId, viewerId } = await fixture();
    const knowledge = runBundle(tenantId, viewerId).knowledge;
    const res = await knowledge.retrieve({ query: 'acquire acme merger board' }) as { chunks: Array<{ content: string }>; hasResults: boolean };
    // The leak was VERBATIM chunk text, so assert on the text, not on a count.
    expect(res.chunks.map((c) => c.content).join('\n')).not.toContain('ACQUIRE ACME');
    expect(res.hasResults).toBe(false);
  });

  it('the OWNER\'s chat turn still retrieves it', async () => {
    const { tenantId, ownerId } = await fixture();
    const knowledge = runBundle(tenantId, ownerId).knowledge;
    const res = await knowledge.retrieve({ query: 'acquire acme merger board' }) as { chunks: Array<{ content: string }> };
    expect(res.chunks.map((c) => c.content).join('\n')).toContain('ACQUIRE ACME');
  });

  it('a refused caller gets an honest EMPTY result, never the seeded demo corpus', async () => {
    // The pre-existing `null` contract means "this tenant has no real knowledge —
    // fall back to the demo corpus". A tenant that HAS knowledge but none this
    // caller may read is a different fact, and answering it with `null` would
    // answer a refused query with fabricated content (the LEAK-10 shape).
    const { tenantId, viewerId } = await fixture();
    const res = await tenantRetrieve(tenantId, { query: 'vacation policy handbook' }, { subject: viewerId });
    expect(res).not.toBeNull();
    expect(res!.chunks).toEqual([]);
    expect(res!.hasResults).toBe(false);
  });
});

describe('KBC-1 — the gate is on the ROWS, so every service verb inherits it', () => {
  it('getCollection / listCollections / listDocuments / search all refuse the non-member', async () => {
    const { tenantId, orgId, collectionId, viewerId } = await fixture();
    const caller = { subject: viewerId };
    expect(await getCollection(tenantId, orgId, collectionId, caller)).toBeNull();
    expect((await listCollections(tenantId, orgId, caller)).some((c) => c.collectionId === collectionId)).toBe(false);
    await expect(listDocuments(tenantId, orgId, collectionId, caller)).rejects.toThrow(/not found/i);
    await expect(search(tenantId, orgId, collectionId, 'acme', 5, 'dense', caller)).rejects.toThrow(/not found/i);
  });

  it('OMITTING the caller is refused, not bypassed — a forgotten call site fails CLOSED', async () => {
    // This is the property that makes the optional parameter safe. If an omitted
    // caller meant "system", every lane that forgets would silently reopen the
    // leak and nothing would say so.
    const { tenantId, orgId, collectionId } = await fixture();
    expect(await getCollection(tenantId, orgId, collectionId)).toBeNull();
    await expect(listDocuments(tenantId, orgId, collectionId)).rejects.toThrow(/not found/i);
  });
});
