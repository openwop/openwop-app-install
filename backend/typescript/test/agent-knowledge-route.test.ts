/**
 * Agent Knowledge & Memory (ADR 0038) — ROUTE-level harness. Boots the real app
 * and drives the per-agent knowledge curation surface over HTTP:
 *   - always-on (no toggle — graduated 2026-06-16, ADR 0038 § Correction): an
 *     owned agent's knowledge view serves 200 with no feature gate
 *   - requireOwnedAgent IDOR (a cross-tenant agent id → 404, fail-closed)
 *   - RBAC (workspace:read view; workspace:write to bind/ingest/note)
 *   - create+bind a collection → ingest a doc → retrieve (deterministic embed
 *     ranks the relevant chunk, with its source title for citation)
 *   - private notes gated on `memoryWritable` (403 fail-closed when off)
 *   - ADR 0036 profile-policy enforcement (a `permissions.never` action class
 *     denies the write, 403)
 *   - ctx.features.agentKnowledge.retrieve via the host-ext retrieve route
 *
 * Sabotage that turns this red (grade-tests w11 probes): dropping `requireOwnedAgent`'s 404
 * (IDOR); `workspace:read` on bind or on the org-scoped ingest (RBAC viewer); dropping the
 * `memoryWritable` gate (notes); dropping the `deny` verdict (policy); counting the recall
 * store instead of the notes store (noteCount); reversing KB ranking; stamping every KB chunk
 * trusted (trust flow); an unbind that keeps the id; `>` for `>=` on the binding cap;
 * dropping the bound-check in `mustOwnedCollectionBound` (both unbound legs); not registering
 * the auto-ingest chain at feature boot.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createAgentMemoryPort, agentMemoryScope } from '../src/host/agentMemoryAdapter.js';
import { ingestDocToBoundCollection } from '../src/features/agent-knowledge/service.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';

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
  for (const id of ['users', 'kb']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = unknown> { status: number; body: T }
interface Client {
  get: <T = unknown>(p: string) => Promise<Res<T>>;
  post: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
  put: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
  del: <T = unknown>(p: string) => Promise<Res<T>>;
}
/** The response shapes this file reads (`features/agent-knowledge/service.ts`). */
interface KnowledgeView {
  agentId: string; knowledgeEnabled: boolean; memoryWritable: boolean; noteCount: number;
  collections: Array<{ collectionId: string; documents: Array<{ title: string }> }>;
}
interface RetrieveBody { hasResults: boolean; chunks: Array<{ title?: string; content: string; contentTrust?: string }> }
interface ErrorBody { error: string; message: string }
function client(): Client {
  let cookie = '';
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    // The JSON boundary: the caller names the response shape it reads (typed per call site).
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  };
  return {
    get: <T,>(p: string) => call<T>('GET', p),
    post: <T,>(p: string, b?: unknown) => call<T>('POST', p, b),
    put: <T,>(p: string, b?: unknown) => call<T>('PUT', p, b),
    del: <T,>(p: string) => call<T>('DELETE', p),
  };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: uniqEmail('ak'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
/** A tenant owner client + a standing agent in that tenant + a fresh org. */
async function ownerWithAgent(): Promise<{ owner: Client; rosterId: string; orgId: string }> {
  const owner = client();
  await signup(owner);
  const r = await owner.post<{ rosterId: string }>('/host/openwop-app/roster', { persona: 'Researcher', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, rosterId: r.body.rosterId, orgId: org.body.orgId };
}

/** Co-tenant owner + member-with-`role`, plus a standing agent + org. */
async function ownerMemberAgent(role: string): Promise<{ owner: Client; member: Client; rosterId: string; orgId: string }> {
  const tenantId = `org:ak-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, { tenantId });
  const member = client();
  const memberUser = await signup(member, { tenantId });
  const r = await owner.post<{ rosterId: string }>('/host/openwop-app/roster', { persona: 'R', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  const orgId = org.body.orgId;
  const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, rosterId: r.body.rosterId, orgId };
}

const k = (rosterId: string, suffix = ''): string => `/host/openwop-app/agents/${encodeURIComponent(rosterId)}/knowledge${suffix}`;
const viewOf = (c: Client, rosterId: string): Promise<Res<KnowledgeView>> => c.get<KnowledgeView>(k(rosterId));
const retrieveFor = (c: Client, rosterId: string, query: string): Promise<Res<RetrieveBody>> => c.post<RetrieveBody>(k(rosterId, '/retrieve'), { query });
/** Create a collection BOUND to the agent and return its id. */
async function boundCollection(c: Client, rosterId: string, orgId: string, name: string): Promise<string> {
  const r = await c.post<{ collectionId: string }>(k(rosterId, '/collections'), { orgId, name });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.collectionId;
}
/** The agent's real session tenant, read back off its roster entry. */
async function rosterTenant(c: Client, rosterId: string): Promise<string> {
  const r = await c.get<{ tenantId: string }>(`/host/openwop-app/roster/${encodeURIComponent(rosterId)}`);
  expect(typeof r.body.tenantId).toBe('string');
  return r.body.tenantId;
}
const FELINE = 'Feline companions: cats groom themselves with their tongue and purr when content. A kitten is a young cat that loves to play and pounce.';
const DB = 'Relational databases use B-tree indexes to speed up SQL query execution and JOIN operations across large tables.';

describe('agent-knowledge — always-on (no toggle)', () => {
  it('serves an owned agent with no feature gate (200)', async () => {
    const { owner, rosterId } = await ownerWithAgent();
    const r = await viewOf(owner, rosterId);
    expect(r.status).toBe(200);
    // The VIEW, not just a 200: a fresh agent's knowledge panel, empty and notes-off.
    expect(r.body).toMatchObject({ agentId: rosterId, collections: [], noteCount: 0, memoryWritable: false });
  });
});

describe('agent-knowledge — IDOR (requireOwnedAgent)', () => {
  it('a cross-tenant agent id is fail-closed (404, never leaks existence)', async () => {
    const { rosterId } = await ownerWithAgent();
    const stranger = client();
    await signup(stranger);
    // The stranger is a different tenant → the agent is not theirs → 404…
    const foreign = await stranger.get<ErrorBody>(k(rosterId));
    expect(foreign.status).toBe(404);
    // …indistinguishable from an id that never existed anywhere (never leaks existence).
    const ghost = await stranger.get<ErrorBody>(k(`roster-never-existed-${n++}`));
    expect(ghost.status).toBe(404);
    expect({ error: foreign.body.error, message: foreign.body.message }).toEqual({ error: ghost.body.error, message: ghost.body.message });
    // Double-guarded write leg (kept as a tripwire, not as the IDOR witness): `'x'` exists in
    // no tenant, so this 404s with or without `requireOwnedAgent`.
    expect((await stranger.post(k(rosterId, '/bindings'), { collectionId: 'x' })).status).toBe(404);
  });
});

describe('agent-knowledge — documents: create + ingest + retrieve', () => {
  it('creates a bound collection, ingests text, and retrieve ranks the relevant chunk with its title', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    const cid = await boundCollection(owner, rosterId, orgId, 'Handbook');

    const dA = await owner.post(k(rosterId, `/collections/${cid}/documents`), { orgId, title: 'Cats', text: FELINE });
    const dB = await owner.post(k(rosterId, `/collections/${cid}/documents`), { orgId, title: 'Databases', text: DB });
    expect(dA.status, JSON.stringify(dA.body)).toBe(201);
    expect(dB.status).toBe(201);

    // The view lists the bound collection with its documents.
    const view = await viewOf(owner, rosterId);
    expect(view.status).toBe(200);
    expect(view.body.knowledgeEnabled).toBe(true);
    expect(view.body.collections.length).toBe(1);
    expect(view.body.collections[0].documents.length).toBe(2);

    // Deterministic embed: the feline doc outranks the database doc, and the
    // chunk carries its source title for citation.
    const ret = await retrieveFor(owner, rosterId, 'how do cats groom and purr');
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);
    expect(ret.body.hasResults).toBe(true);
    expect(ret.body.chunks.length).toBeGreaterThan(0);
    expect(ret.body.chunks[0].title).toBe('Cats');
    expect(ret.body.chunks[0].content).toContain('cats');
  });

  it('unbinding a collection drops it from the agent view (but does not delete the KB collection)', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    const cid = await boundCollection(owner, rosterId, orgId, 'Temp');
    expect((await owner.del(k(rosterId, `/bindings/${cid}`))).status).toBe(204);
    const view = await viewOf(owner, rosterId);
    expect(view.body.collections.length).toBe(0);
    // The KB collection still exists (shareable across twins).
    const kbCol = await owner.get<{ collectionId: string }>(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${cid}`);
    expect(kbCol.status).toBe(200);
    expect(kbCol.body.collectionId).toBe(cid);
  });
});

describe('agent-knowledge — notes (recalled memory)', () => {
  it('a note is 403 until memoryWritable is enabled, then recalled by retrieve', async () => {
    const { owner, rosterId } = await ownerWithAgent();
    // Fail-closed: notes disabled by default.
    expect((await owner.post(k(rosterId, '/notes'), { content: 'The CFO prefers Friday updates.' })).status).toBe(403);
    // Enable curated notes.
    expect((await owner.put(k(rosterId, '/memory-writable'), { writable: true })).status).toBe(200);
    expect((await owner.post(k(rosterId, '/notes'), { content: 'The CFO prefers Friday status updates.' })).status).toBe(201);
    const view = await viewOf(owner, rosterId);
    expect(view.body.memoryWritable).toBe(true);
    expect(view.body.noteCount).toBeGreaterThan(0);
    // The note is recalled (memory source) by retrieve.
    const ret = await retrieveFor(owner, rosterId, 'when does the CFO want updates');
    expect(ret.body.hasResults).toBe(true);
    expect(JSON.stringify(ret.body.chunks)).toContain('CFO');
  });

  it('noteCount counts ONLY curated notes, not dispatch turn summaries (ADR 0038 review fix)', async () => {
    const { owner, rosterId } = await ownerWithAgent();
    // The agent's real session tenant (so we plant the turn summary in the exact
    // namespace the note route writes to). Read it back off the roster entry.
    const tenantId = await rosterTenant(owner, rosterId);
    expect(typeof tenantId).toBe('string');

    // Simulate exactly what `persistTurnSummary` writes for a memoryShape.longTerm
    // agent: via the memory PORT (embeds for recall), same namespace, tagged with
    // the agentId only (NOT the curated-note tag).
    await createAgentMemoryPort(tenantId).write(agentMemoryScope(rosterId), { content: 'Task: write the weekly brief → Result: drafted', tags: [rosterId] });

    // One genuinely-curated note.
    expect((await owner.put(k(rosterId, '/memory-writable'), { writable: true })).status).toBe(200);
    expect((await owner.post(k(rosterId, '/notes'), { content: 'The CFO prefers Friday updates.' })).status).toBe(201);

    // Same-bucket proof: the planted turn summary is retrievable from this agent's
    // memory namespace (so it WOULD inflate an unfiltered count).
    const ret = await retrieveFor(owner, rosterId, 'weekly brief drafted');
    expect(JSON.stringify(ret.body.chunks)).toContain('weekly brief');

    // …yet noteCount is exactly 1 — the turn summary is excluded (pre-fix: 2).
    const view = await viewOf(owner, rosterId);
    expect(view.body.noteCount).toBe(1);
  });
});

describe('agent-knowledge — import from connection (ADR 0038 follow-on)', () => {
  const FILE_ID = '1AbcDEF_ghiJKL-mnoPQRstuVWxyz0123456789';

  it('unsupported provider → 400; google-with-no-connection → 409; unbound collection → 404; missing ref → 400', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    const cid = await boundCollection(owner, rosterId, orgId, 'Imports');
    const fc = (cidOrMissing: string): string => k(rosterId, `/collections/${cidOrMissing}/documents/from-connection`);

    // Unsupported provider (collection bound) → 400 validation.
    const bad = await owner.post(fc(cid), { orgId, provider: 'dropbox', ref: FILE_ID });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('validation_error');

    // Google but the user has no Google connection → fail-closed 409.
    const noConn = await owner.post(fc(cid), { orgId, provider: 'google', ref: FILE_ID });
    expect(noConn.status, JSON.stringify(noConn.body)).toBe(409);
    expect(JSON.stringify(noConn.body)).toContain('credential_required');

    // A collection that EXISTS in this org but is NOT bound to this agent → 404 (before any
    // fetch). It must exist: a never-created id 404s at the KB lookup and cannot witness the
    // bound-check (grade-tests w11 found the old `nope-…` leg vacuous).
    const unboundCid = await boundCollection(owner, rosterId, orgId, 'Unbound');
    expect((await owner.del(k(rosterId, `/bindings/${unboundCid}`))).status).toBe(204);
    const unbound = await owner.post(fc(unboundCid), { orgId, provider: 'google', ref: FILE_ID });
    expect(unbound.status, JSON.stringify(unbound.body)).toBe(404);

    // Missing ref → 400.
    const noRef = await owner.post(fc(cid), { orgId, provider: 'google' });
    expect(noRef.status).toBe(400);
    expect(JSON.stringify(noRef.body)).toContain('validation_error');
  });

  it('IDOR: a cross-tenant agent id is fail-closed (404)', async () => {
    const { rosterId } = await ownerWithAgent();
    const stranger = client();
    await signup(stranger);
    const r = await stranger.post(k(rosterId, `/collections/x/documents/from-connection`), { orgId: 'x', provider: 'google', ref: FILE_ID });
    expect(r.status).toBe(404);
  });
});

describe('agent-knowledge — RBAC', () => {
  it('a viewer can view but not bind/ingest (403); an editor can', async () => {
    const { owner, member, rosterId, orgId } = await ownerMemberAgent('viewer');
    const cid = await boundCollection(owner, rosterId, orgId, 'KB');

    // Viewer (workspace:read) can view…
    expect((await member.get(k(rosterId))).status).toBe(200);
    // …but cannot bind (needs workspace:write).
    expect((await member.post(k(rosterId, '/bindings'), { collectionId: cid })).status).toBe(403);
    // …nor ingest into the org (needs workspace:write in the org).
    expect((await member.post(k(rosterId, `/collections/${cid}/documents`), { orgId, text: 'x' })).status).toBe(403);
  });

  it('an editor member can ingest', async () => {
    const { owner, member, rosterId, orgId } = await ownerMemberAgent('editor');
    const cid = await boundCollection(owner, rosterId, orgId, 'KB');
    const doc = await member.post(k(rosterId, `/collections/${cid}/documents`), { orgId, title: 'Cats', text: FELINE });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
  });
});

describe('agent-knowledge — ADR 0036 profile policy', () => {
  it('a permissions.never action class denies the write (403)', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    // Set a profile that forbids the knowledge.ingest action class.
    const put = await owner.put(`/host/openwop-app/agents/${encodeURIComponent(rosterId)}/profile`, {
      roleKey: 'researcher',
      permissions: { read: [], write: [], never: ['knowledge.ingest'] },
      autonomy: { specLevel: 'draft-only' },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const cid = await boundCollection(owner, rosterId, orgId, 'KB');
    // The ingest is denied by the agent's profile policy (fail-closed).
    const doc = await owner.post(k(rosterId, `/collections/${cid}/documents`), { orgId, title: 'X', text: FELINE });
    expect(doc.status, JSON.stringify(doc.body)).toBe(403);
  });
});

describe('agent-knowledge — ingest node write path (ADR 0038 §B)', () => {
  it('ingestDocToBoundCollection writes a cited doc into a bound collection; unbound → 404; memory untouched', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    const cid = await boundCollection(owner, rosterId, orgId, 'Auto-ingest');
    const tenantId = await rosterTenant(owner, rosterId);

    // The write path the trigger→workflow ingest node calls: org resolved from the
    // binding (no orgId supplied). Writes the KB-document side only.
    const doc = await ingestDocToBoundCollection(tenantId, 'run:test', rosterId, cid, { title: 'Incident report', text: DB });
    expect(doc.documentId).toBeTruthy();

    const view = await viewOf(owner, rosterId);
    const col = view.body.collections.find((c) => c.collectionId === cid);
    expect(col?.documents.some((d) => d.title === 'Incident report')).toBe(true);
    // Read-only line holds: the ingest never wrote the agent's memory/notes side.
    expect(view.body.noteCount).toBe(0);

    // A collection that EXISTS in the tenant but is NOT bound to the agent → 404 (can't write
    // an arbitrary collection). Bound then unbound, so only the bound-check can refuse it.
    const unboundCid = await boundCollection(owner, rosterId, orgId, 'Was bound');
    expect((await owner.del(k(rosterId, `/bindings/${unboundCid}`))).status).toBe(204);
    await expect(
      ingestDocToBoundCollection(tenantId, 'run:test', rosterId, unboundCid, { title: 'x', text: 'y' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('contentTrust flows doc→chunk→retrieval: untrusted ingest is marked untrusted, manual is trusted (ADR 0038 §C)', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    const cid = await boundCollection(owner, rosterId, orgId, 'Mixed-trust');
    const tenantId = await rosterTenant(owner, rosterId);

    // Manual ingest (trusted) + a simulated trigger/provider ingest (untrusted).
    await ingestDocToBoundCollection(tenantId, 'run:test', rosterId, cid, { title: 'Curated cats', text: FELINE });
    await ingestDocToBoundCollection(tenantId, 'run:test', rosterId, cid, { title: 'Webhook payload', text: DB, contentTrust: 'untrusted' });

    // Retrieve each; the chunk carries the document's contentTrust.
    const cats = await retrieveFor(owner, rosterId, 'how do cats groom and purr');
    const db = await retrieveFor(owner, rosterId, 'b-tree index sql joins');
    const trustOf = (r: Res<RetrieveBody>, title: string): string | undefined =>
      r.body.chunks.find((c) => c.title === title)?.contentTrust;
    expect(trustOf(cats, 'Curated cats')).toBe('trusted');
    expect(trustOf(db, 'Webhook payload')).toBe('untrusted');
  });

  it('resolves the §B auto-ingest workflow by its stable id at feature boot (WF-KB-1)', () => {
    // CORRECTION (WF-KB-1). This used to assert `getRegisteredWorkflow(...)` — the
    // `wfreg:` builder registry — which was asserting the ANTI-PATTERN's own
    // mechanism: the workflow was a code-pinned in-tree definition, so of course it
    // was in that map, and being in that map is exactly what makes a workflow
    // invisible to `/builder` and the `/` picker (both list the tenant OWNERSHIP
    // index, which nothing here ever wrote). The workflow is now chain-backed. What
    // ignition actually needs is that the stable id RESOLVES — the trigger
    // subscription seeded by `exampleDataSeed` passes this literal string — and the
    // catalog resolver (`host/index.ts` source A) consults the chain-backed registry
    // BEFORE the builder registry, so the id resolves unchanged. Assert THAT.
    const wf = getChainBackedWorkflow('feature.agent-knowledge.auto-ingest');
    expect(wf, 'auto-ingest must resolve by its stable id on every instance').toBeDefined();
    expect(wf?.nodes.some((n) => n.typeId === 'feature.agent-knowledge.nodes.ingest')).toBe(true);
    // …and it must NOT have quietly come back as a code-pinned definition.
    expect(getRegisteredWorkflow('feature.agent-knowledge.auto-ingest')).toBeUndefined();
  });
});

describe('agent-knowledge — growth caps (gap fix)', () => {
  it('caps bound collections per agent (the 21st create+bind → 400)', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    for (let i = 0; i < 20; i++) {
      const r = await owner.post(k(rosterId, '/collections'), { orgId, name: `C${i}` });
      expect(r.status, `bind ${i}: ${JSON.stringify(r.body)}`).toBe(201);
    }
    const over = await owner.post(k(rosterId, '/collections'), { orgId, name: 'C20' });
    expect(over.status, JSON.stringify(over.body)).toBe(400);
    expect(JSON.stringify(over.body)).toContain('maximum');
  });
});
