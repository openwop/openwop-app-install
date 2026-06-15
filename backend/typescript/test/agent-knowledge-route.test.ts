/**
 * Agent Knowledge & Memory (ADR 0038) — ROUTE-level harness. Boots the real app
 * and drives the per-agent knowledge curation surface over HTTP:
 *   - toggle gating (404 when `agent-knowledge` is off)
 *   - requireOwnedAgent IDOR (a cross-tenant agent id → 404, fail-closed)
 *   - RBAC (workspace:read view; workspace:write to bind/ingest/note)
 *   - create+bind a collection → ingest a doc → retrieve (deterministic embed
 *     ranks the relevant chunk, with its source title for citation)
 *   - private notes gated on `memoryWritable` (403 fail-closed when off)
 *   - ADR 0036 profile-policy enforcement (a `permissions.never` action class
 *     denies the write, 403)
 *   - ctx.features.agentKnowledge.retrieve via the host-ext retrieve route
 */

import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createAgentMemoryPort, agentMemoryScope } from '../src/host/agentMemoryAdapter.js';
import { ingestDocToBoundCollection } from '../src/features/agent-knowledge/service.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';

const PORT = 18753;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
  for (const id of ['users', 'kb', 'agent-knowledge']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('ak'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enable = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

/** A tenant owner client + a standing agent in that tenant + a fresh org. */
async function ownerWithAgent(): Promise<{ owner: Client; rosterId: string; orgId: string }> {
  const owner = client();
  await signup(owner);
  const r = await owner.post('/v1/host/openwop-app/roster', { persona: 'Researcher', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
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
  const r = await owner.post('/v1/host/openwop-app/roster', { persona: 'R', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, rosterId: r.body.rosterId, orgId };
}

const k = (rosterId: string, suffix = ''): string => `/v1/host/openwop-app/agents/${encodeURIComponent(rosterId)}/knowledge${suffix}`;
const FELINE = 'Feline companions: cats groom themselves with their tongue and purr when content. A kitten is a young cat that loves to play and pounce.';
const DB = 'Relational databases use B-tree indexes to speed up SQL query execution and JOIN operations across large tables.';

describe('agent-knowledge — toggle gating', () => {
  it('404s when the agent-knowledge toggle is off', async () => {
    await enable('agent-knowledge', 'off');
    const { owner, rosterId } = await ownerWithAgent();
    expect((await owner.get(k(rosterId))).status).toBe(404);
    await enable('agent-knowledge', 'on');
  });
});

describe('agent-knowledge — IDOR (requireOwnedAgent)', () => {
  it('a cross-tenant agent id is fail-closed (404, never leaks existence)', async () => {
    const { rosterId } = await ownerWithAgent();
    const stranger = client();
    await signup(stranger);
    // The stranger is a different tenant → the agent is not theirs → 404.
    expect((await stranger.get(k(rosterId))).status).toBe(404);
    expect((await stranger.post(k(rosterId, '/bindings'), { collectionId: 'x' })).status).toBe(404);
  });
});

describe('agent-knowledge — documents: create + ingest + retrieve', () => {
  it('creates a bound collection, ingests text, and retrieve ranks the relevant chunk with its title', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    const col = await owner.post(k(rosterId, '/collections'), { orgId, name: 'Handbook' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const cid = col.body.collectionId;

    const dA = await owner.post(k(rosterId, `/collections/${cid}/documents`), { orgId, title: 'Cats', text: FELINE });
    const dB = await owner.post(k(rosterId, `/collections/${cid}/documents`), { orgId, title: 'Databases', text: DB });
    expect(dA.status, JSON.stringify(dA.body)).toBe(201);
    expect(dB.status).toBe(201);

    // The view lists the bound collection with its documents.
    const view = await owner.get(k(rosterId));
    expect(view.status).toBe(200);
    expect(view.body.knowledgeEnabled).toBe(true);
    expect(view.body.collections.length).toBe(1);
    expect(view.body.collections[0].documents.length).toBe(2);

    // Deterministic embed: the feline doc outranks the database doc, and the
    // chunk carries its source title for citation.
    const ret = await owner.post(k(rosterId, '/retrieve'), { query: 'how do cats groom and purr' });
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);
    expect(ret.body.hasResults).toBe(true);
    expect(ret.body.chunks.length).toBeGreaterThan(0);
    expect(ret.body.chunks[0].title).toBe('Cats');
    expect(ret.body.chunks[0].content).toContain('cats');
  });

  it('unbinding a collection drops it from the agent view (but does not delete the KB collection)', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    const cid = (await owner.post(k(rosterId, '/collections'), { orgId, name: 'Temp' })).body.collectionId;
    expect((await owner.del(k(rosterId, `/bindings/${cid}`))).status).toBe(204);
    const view = await owner.get(k(rosterId));
    expect(view.body.collections.length).toBe(0);
    // The KB collection still exists (shareable across twins).
    expect((await owner.get(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${cid}`)).status).toBe(200);
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
    const view = await owner.get(k(rosterId));
    expect(view.body.memoryWritable).toBe(true);
    expect(view.body.noteCount).toBeGreaterThan(0);
    // The note is recalled (memory source) by retrieve.
    const ret = await owner.post(k(rosterId, '/retrieve'), { query: 'when does the CFO want updates' });
    expect(ret.body.hasResults).toBe(true);
    expect(JSON.stringify(ret.body.chunks)).toContain('CFO');
  });

  it('noteCount counts ONLY curated notes, not dispatch turn summaries (ADR 0038 review fix)', async () => {
    const { owner, rosterId } = await ownerWithAgent();
    // The agent's real session tenant (so we plant the turn summary in the exact
    // namespace the note route writes to). Read it back off the roster entry.
    const tenantId = (await owner.get(`/v1/host/openwop-app/roster/${encodeURIComponent(rosterId)}`)).body.tenantId;
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
    const ret = await owner.post(k(rosterId, '/retrieve'), { query: 'weekly brief drafted' });
    expect(JSON.stringify(ret.body.chunks)).toContain('weekly brief');

    // …yet noteCount is exactly 1 — the turn summary is excluded (pre-fix: 2).
    const view = await owner.get(k(rosterId));
    expect(view.body.noteCount).toBe(1);
  });
});

describe('agent-knowledge — import from connection (ADR 0038 follow-on)', () => {
  const FILE_ID = '1AbcDEF_ghiJKL-mnoPQRstuVWxyz0123456789';

  it('unsupported provider → 400; google-with-no-connection → 409; unbound collection → 404; missing ref → 400', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    const cid = (await owner.post(k(rosterId, '/collections'), { orgId, name: 'Imports' })).body.collectionId;
    const fc = (cidOrMissing: string): string => k(rosterId, `/collections/${cidOrMissing}/documents/from-connection`);

    // Unsupported provider (collection bound) → 400 validation.
    const bad = await owner.post(fc(cid), { orgId, provider: 'dropbox', ref: FILE_ID });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);

    // Google but the user has no Google connection → fail-closed 409.
    const noConn = await owner.post(fc(cid), { orgId, provider: 'google', ref: FILE_ID });
    expect(noConn.status, JSON.stringify(noConn.body)).toBe(409);
    expect(JSON.stringify(noConn.body)).toContain('credential_required');

    // A collection not bound to this agent → 404 (before any fetch).
    const unbound = await owner.post(fc(`nope-${Date.now()}`), { orgId, provider: 'google', ref: FILE_ID });
    expect(unbound.status).toBe(404);

    // Missing ref → 400.
    const noRef = await owner.post(fc(cid), { orgId, provider: 'google' });
    expect(noRef.status).toBe(400);
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
    const cid = (await owner.post(k(rosterId, '/collections'), { orgId, name: 'KB' })).body.collectionId;

    // Viewer (workspace:read) can view…
    expect((await member.get(k(rosterId))).status).toBe(200);
    // …but cannot bind (needs workspace:write).
    expect((await member.post(k(rosterId, '/bindings'), { collectionId: cid })).status).toBe(403);
    // …nor ingest into the org (needs workspace:write in the org).
    expect((await member.post(k(rosterId, `/collections/${cid}/documents`), { orgId, text: 'x' })).status).toBe(403);
  });

  it('an editor member can ingest', async () => {
    const { owner, member, rosterId, orgId } = await ownerMemberAgent('editor');
    const cid = (await owner.post(k(rosterId, '/collections'), { orgId, name: 'KB' })).body.collectionId;
    const doc = await member.post(k(rosterId, `/collections/${cid}/documents`), { orgId, title: 'Cats', text: FELINE });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
  });
});

describe('agent-knowledge — ADR 0036 profile policy', () => {
  it('a permissions.never action class denies the write (403)', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    // Set a profile that forbids the knowledge.ingest action class.
    const put = await owner.put(`/v1/host/openwop-app/agents/${encodeURIComponent(rosterId)}/profile`, {
      roleKey: 'researcher',
      permissions: { read: [], write: [], never: ['knowledge.ingest'] },
      autonomy: { specLevel: 'draft-only' },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const cid = (await owner.post(k(rosterId, '/collections'), { orgId, name: 'KB' })).body.collectionId;
    // The ingest is denied by the agent's profile policy (fail-closed).
    const doc = await owner.post(k(rosterId, `/collections/${cid}/documents`), { orgId, title: 'X', text: FELINE });
    expect(doc.status, JSON.stringify(doc.body)).toBe(403);
  });
});

describe('agent-knowledge — ingest node write path (ADR 0038 §B)', () => {
  it('ingestDocToBoundCollection writes a cited doc into a bound collection; unbound → 404; memory untouched', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    const cid = (await owner.post(k(rosterId, '/collections'), { orgId, name: 'Auto-ingest' })).body.collectionId;
    const tenantId = (await owner.get(`/v1/host/openwop-app/roster/${encodeURIComponent(rosterId)}`)).body.tenantId;

    // The write path the trigger→workflow ingest node calls: org resolved from the
    // binding (no orgId supplied). Writes the KB-document side only.
    const doc = await ingestDocToBoundCollection(tenantId, 'run:test', rosterId, cid, { title: 'Incident report', text: DB });
    expect(doc.documentId).toBeTruthy();

    const view = await owner.get(k(rosterId));
    const col = (view.body.collections as Array<{ collectionId: string; documents: Array<{ title: string }> }>).find((c) => c.collectionId === cid);
    expect(col?.documents.some((d) => d.title === 'Incident report')).toBe(true);
    // Read-only line holds: the ingest never wrote the agent's memory/notes side.
    expect(view.body.noteCount).toBe(0);

    // A collection NOT bound to the agent → 404 (can't write an arbitrary collection).
    await expect(
      ingestDocToBoundCollection(tenantId, 'run:test', rosterId, `unbound-${Date.now()}`, { title: 'x', text: 'y' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('contentTrust flows doc→chunk→retrieval: untrusted ingest is marked untrusted, manual is trusted (ADR 0038 §C)', async () => {
    const { owner, rosterId, orgId } = await ownerWithAgent();
    const cid = (await owner.post(k(rosterId, '/collections'), { orgId, name: 'Mixed-trust' })).body.collectionId;
    const tenantId = (await owner.get(`/v1/host/openwop-app/roster/${encodeURIComponent(rosterId)}`)).body.tenantId;

    // Manual ingest (trusted) + a simulated trigger/provider ingest (untrusted).
    await ingestDocToBoundCollection(tenantId, 'run:test', rosterId, cid, { title: 'Curated cats', text: FELINE });
    await ingestDocToBoundCollection(tenantId, 'run:test', rosterId, cid, { title: 'Webhook payload', text: DB, contentTrust: 'untrusted' });

    // Retrieve each; the chunk carries the document's contentTrust.
    const cats = await owner.post(k(rosterId, '/retrieve'), { query: 'how do cats groom and purr' });
    const db = await owner.post(k(rosterId, '/retrieve'), { query: 'b-tree index sql joins' });
    const trustOf = (r: Res, title: string): string | undefined =>
      (r.body.chunks as Array<{ title?: string; contentTrust?: string }>).find((c) => c.title === title)?.contentTrust;
    expect(trustOf(cats, 'Curated cats')).toBe('trusted');
    expect(trustOf(db, 'Webhook payload')).toBe('untrusted');
  });

  it('registers the §B auto-ingest workflow in the catalog at feature boot', () => {
    const wf = getRegisteredWorkflow('feature.agent-knowledge.auto-ingest');
    expect(wf, 'auto-ingest workflow must be registered when the feature is composed').toBeDefined();
    expect(wf?.nodes.some((n) => n.typeId === 'feature.agent-knowledge.nodes.ingest')).toBe(true);
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
