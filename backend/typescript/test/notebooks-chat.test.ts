/**
 * Research Notebooks — grounded chat (ADR 0084 Phase 2).
 *
 * Proves:
 *   - POST /:id/chat ensures the notebook's PROJECT group conversation and returns
 *     its conversationId, with `ownerSubject` SERVER-SET to `project:<notebookId>`
 *     (the grounding key `conversationExchange` reads). Idempotent (re-open = same id).
 *   - A different tenant / non-member caller is DENIED (uniform 404) — the IDOR guard
 *     on the chat-ensure route (no existence leak, no foreign group-chat hijack).
 *   - `composeKnowledgeForSubject` returns a FENCED block carrying a notebook source's
 *     text for a subject with a bound collection, and '' for a subject with none
 *     (the self-gating + shared-fence invariant — unit level, no live model).
 *
 * @see docs/adr/0084-research-notebooks.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getConversationMeta } from '../src/host/conversationStore.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { projectSubject } from '../src/features/projects/projectsService.js';
import { composeKnowledgeForSubject } from '../src/host/agentKnowledgeComposition.js';
import { setSubjectKnowledge } from '../src/host/subjectKnowledge.js';
import { createCollection, ingestDocument } from '../src/features/kb/kbService.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['notebooks', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string): Promise<{ c: Client; orgId: string; tenantId: string }> {
  const c = client();
  const login = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail(who) });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  // The login response carries the resolved tenant for the cookie session.
  return { c, orgId: org.body.orgId, tenantId: login.body.user.tenantId as string };
}

const NB = '/v1/host/openwop-app/notebooks';

describe('notebooks — grounded chat ensure (ADR 0084 Phase 2)', () => {
  it('POST /:id/chat returns a conversationId whose ownerSubject is project:<notebookId> (idempotent)', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg('nbchat-owner');
    const id = (await c.post(NB, { orgId, name: 'Grounded notebook' })).body.notebook.id as string;

    const open = await c.post(`${NB}/${id}/chat`);
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    const conversationId = open.body.conversationId as string;
    expect(conversationId).toBeTruthy();

    // ownerSubject SERVER-SET to the notebook's project subject — the grounding key.
    const meta = await getConversationMeta(tenantId, conversationId);
    expect(meta?.ownerSubject).toEqual(projectSubject(id));
    expect(meta?.type).toBe('group');
    // The Notebook Research Analyst is in the room (the grounded analyst — a
    // conversation participant; ADR 0084 Phase 4 repointed off the KB Researcher).
    expect((meta?.participants ?? []).some((p) => p.subjectRef === 'agent:feature.notebooks.agents.researcher')).toBe(true);
    expect((meta?.participants ?? []).some((p) => p.subjectRef === 'agent:feature.kb.agents.researcher')).toBe(false);

    // Idempotent: re-opening returns the SAME deterministic conversation id.
    const reopen = await c.post(`${NB}/${id}/chat`);
    expect(reopen.status).toBe(201);
    expect(reopen.body.conversationId).toBe(conversationId);
  });

  it('a different tenant / non-member caller is denied (uniform 404 — the IDOR guard)', async () => {
    const a = await ownerWithOrg('nbchat-a');
    const id = (await a.c.post(NB, { orgId: a.orgId, name: 'A-notebook' })).body.notebook.id as string;

    const stranger = await ownerWithOrg('nbchat-stranger');
    expect((await stranger.c.post(`${NB}/${id}/chat`)).status).toBe(404);
  });
});

describe('feature.notebooks.agents.researcher — Research Analyst pack (ADR 0084 Phase 4)', () => {
  it('is loaded into the agent registry at boot, scoped to RESEARCH/research', async () => {
    const agent = await getAgentRegistry().resolve('feature.notebooks.agents.researcher');
    expect(agent).not.toBeNull();
    expect(agent!.persona).toBe('RESEARCH');
    expect(agent!.modelClass).toBe('research');
    // The system prompt resolved from prompts/notebook-researcher.md (DISTINCT from
    // the KB researcher — notebook-scoped wording).
    expect(agent!.systemPrompt).toContain('notebook');
  });

  it('is tool-allowlisted to the notebooks feature nodes only (NOT the kb nodes)', async () => {
    const agent = await getAgentRegistry().resolve('feature.notebooks.agents.researcher');
    const allow = (agent!.toolAllowlist ?? []) as string[];
    expect(allow).toContain('openwop:feature.notebooks.nodes.ask');
    expect(allow).toContain('openwop:feature.notebooks.nodes.search');
    // Phase 5 / Transformations T3 — chat can author + persist a transformation
    // Document (the agent+nodes realization of "AI-chat envelopes"; no bespoke kind).
    expect(allow).toContain('openwop:feature.notebooks.nodes.write-transformation');
    // No tool outside the notebooks feature surface — in particular, no kb nodes, and
    // NOT the internal summarize-workflow nodes (read-source / store-summary).
    expect(allow.every((t) => t.startsWith('openwop:feature.notebooks.nodes.'))).toBe(true);
    expect(allow).not.toContain('openwop:feature.notebooks.nodes.read-source');
    expect(allow).not.toContain('openwop:feature.notebooks.nodes.store-summary');
  });
});

describe('composeKnowledgeForSubject — shared composition (ADR 0084 Phase 2)', () => {
  it('returns a fenced block carrying a notebook source text for a bound subject, and "" for an unbound one', async () => {
    const tenantId = `t-compose-${Date.now()}`;
    const orgId = `org-${Date.now()}`;
    const subject = projectSubject(`nb-${Date.now()}`);

    // No binding ⇒ self-gating: empty.
    expect(await composeKnowledgeForSubject(tenantId, subject, 'anything')).toBe('');

    // Bind a KB collection with an UNTRUSTED source (notebook sources are fenced).
    const col = await createCollection(tenantId, orgId, 'tester', { name: 'Sources' });
    const NEEDLE = 'Photosynthesis converts sunlight into chemical energy in chloroplasts.';
    await ingestDocument(tenantId, orgId, 'tester', col.collectionId, { title: 'Bio', text: NEEDLE, contentTrust: 'untrusted' });
    await setSubjectKnowledge(tenantId, subject, { collectionIds: [col.collectionId] });

    const block = await composeKnowledgeForSubject(tenantId, subject, 'how does photosynthesis work', { topK: 6 });
    expect(block.length).toBeGreaterThan(0);
    // The source text is present, and (being untrusted) it is wrapped in the fence.
    expect(block.toLowerCase()).toContain('photosynthesis');
    expect(block).toContain('BEGIN UNTRUSTED CONTENT');
  });
});
