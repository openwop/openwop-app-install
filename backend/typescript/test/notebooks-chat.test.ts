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
 * The DELETE→conversation cascade (WF-PRJ-1) is witnessed in
 * `notebooks-delete-cascade-reachability.test.ts` (CONTROL: count, session and
 * meta all gone); the pack-FILE allowlist in `notebooks-podcasts-agent-tools`.
 *
 * Sabotage witnesses (grade-tests wave 20): a client/foreign `ownerSubject` or
 * the KB researcher in place of the notebook analyst reds case 1; dropping the
 * `'none'` half of `requireNotebook` reds case 2's co-tenant leg (a cross-tenant
 * caller is double-guarded by the tenant-scoped `getProject`); a wrong pack
 * persona or an extra allowlisted tool reds the pack case; a KB leg that drops
 * `contentTrust` reds the compose case, and so does removing its no-binding
 * early return (a subject with MEMORY but no collection must still compose '').
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
import { getConversationMeta, subjectConversationId } from '../src/host/conversationStore.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { projectSubject } from '../src/features/projects/projectsService.js';
import { composeKnowledgeForSubject } from '../src/host/agentKnowledgeComposition.js';
import { setSubjectKnowledge } from '../src/host/subjectKnowledge.js';
import { createCollection, ingestDocument } from '../src/features/kb/kbService.js';
import { addSubjectNote } from '../src/host/subjectMemory.js';
import {
  NOTEBOOKS_ASK_TOOL_ID, NOTEBOOKS_SEARCH_TOOL_ID, NOTEBOOKS_WRITE_TRANSFORMATION_TOOL_ID,
} from '../src/features/notebooks/agentTools.js';

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
  for (const id of ['notebooks', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface LoginBody { user: { userId: string; tenantId: string } }
interface OrgBody { orgId: string }
interface CreatedBody { notebook: { id: string } }
interface ChatBody { conversationId: string }
interface Client {
  post: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const decoded: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: decoded as T };
  };
  return { post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string): Promise<{ c: Client; orgId: string; tenantId: string }> {
  const c = client();
  const login = await c.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail(who) });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post<OrgBody>('/host/openwop-app/orgs', { name: 'Acme' });
  // The login response carries the resolved tenant for the cookie session.
  return { c, orgId: org.body.orgId, tenantId: login.body.user.tenantId };
}

const NB = '/host/openwop-app/notebooks';

describe('notebooks — grounded chat ensure (ADR 0084 Phase 2)', () => {
  it('POST /:id/chat returns a conversationId whose ownerSubject is project:<notebookId> (idempotent)', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg('nbchat-owner');
    const id = (await c.post<CreatedBody>(NB, { orgId, name: 'Grounded notebook' })).body.notebook.id;

    const open = await c.post<ChatBody>(`${NB}/${id}/chat`);
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    const conversationId = open.body.conversationId;
    expect(conversationId).toBeTruthy();

    // ownerSubject SERVER-SET to the notebook's project subject — the grounding key.
    const meta = await getConversationMeta(tenantId, conversationId);
    expect(meta?.ownerSubject).toEqual(projectSubject(id));
    expect(meta?.type).toBe('group');
    // The Notebook Research Analyst is in the room (the grounded analyst — a
    // conversation participant; ADR 0084 Phase 4 repointed off the KB Researcher).
    expect((meta?.participants ?? []).some((p) => p.subjectRef === 'agent:vendor.openwop-app.notebooks.agents.researcher')).toBe(true);
    expect((meta?.participants ?? []).some((p) => p.subjectRef === 'agent:vendor.openwop-app.kb.agents.researcher')).toBe(false);

    // Idempotent: re-opening returns the SAME deterministic conversation id.
    const reopen = await c.post<ChatBody>(`${NB}/${id}/chat`);
    expect(reopen.status).toBe(201);
    expect(reopen.body.conversationId).toBe(conversationId);
  });

  it('a different tenant / non-member caller is denied (uniform 404 — the IDOR guard)', async () => {
    const a = await ownerWithOrg('nbchat-a');
    const id = (await a.c.post<CreatedBody>(NB, { orgId: a.orgId, name: 'A-notebook' })).body.notebook.id;

    // Cross-TENANT: double-guarded (the tenant-scoped getProject already reads null).
    const stranger = await ownerWithOrg('nbchat-stranger');
    expect((await stranger.c.post(`${NB}/${id}/chat`)).status).toBe(404);
    expect(await getConversationMeta(a.tenantId, subjectConversationId(a.tenantId, projectSubject(id))), 'no group chat was minted').toBeNull();

    // A CO-TENANT with no org membership reaches the `'none'` access branch itself.
    const tenantId = `t-nbchat-co-${Date.now()}-${n++}`;
    const owner = client();
    expect((await owner.post('/host/openwop-app/test/login', { email: uniqEmail('nbchat-co-owner'), tenantId })).status).toBe(201);
    const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    const coId = (await owner.post<CreatedBody>(NB, { orgId, name: 'Co-tenant notebook' })).body.notebook.id;
    const outsider = client();
    expect((await outsider.post('/host/openwop-app/test/login', { email: uniqEmail('nbchat-outsider'), tenantId })).status).toBe(201);
    expect((await outsider.post(`${NB}/${coId}/chat`)).status).toBe(404);
    expect(await getConversationMeta(tenantId, subjectConversationId(tenantId, projectSubject(coId))), 'a denied open must not mint the room').toBeNull();
  });
});

describe('vendor.openwop-app.notebooks.agents.researcher — Research Analyst pack (ADR 0084 Phase 4)', () => {
  it('is loaded into the agent registry at boot: RESEARCH/research, notebook prompt, exactly the notebooks chat tools', async () => {
    const agent = await getAgentRegistry().resolve('vendor.openwop-app.notebooks.agents.researcher');
    expect(agent).not.toBeNull();
    expect(agent!.persona).toBe('RESEARCH');
    expect(agent!.modelClass).toBe('research');
    // The system prompt resolved from prompts/notebook-researcher.md (DISTINCT from
    // the KB researcher — notebook-scoped wording).
    expect(agent!.systemPrompt).toContain('inside a single research notebook');
    // CFP-1: the REGISTRY-resolved allowlist is exactly the feature's registered chat
    // tools (the pack FILE is pinned in notebooks-podcasts-agent-tools.test.ts) — no
    // kb node, no raw node typeId.
    expect([...(agent!.toolAllowlist ?? [])].sort()).toEqual(
      [NOTEBOOKS_ASK_TOOL_ID, NOTEBOOKS_SEARCH_TOOL_ID, NOTEBOOKS_WRITE_TRANSFORMATION_TOOL_ID].sort(),
    );
  });
});

describe('composeKnowledgeForSubject — shared composition (ADR 0084 Phase 2)', () => {
  it('returns a fenced block carrying a notebook source text for a bound subject, and "" for an unbound one', async () => {
    const tenantId = `t-compose-${Date.now()}`;
    const orgId = `org-${Date.now()}`;
    const subject = projectSubject(`nb-${Date.now()}`);

    // No binding ⇒ self-gating: empty — even though the subject HAS memory that
    // matches the query (without the gate the memory leg would compose it).
    await addSubjectNote(tenantId, subject, 'Photosynthesis memory fact: chloroplasts capture light.');
    expect(await composeKnowledgeForSubject(tenantId, subject, 'how does photosynthesis work')).toBe('');

    // Bind a KB collection with an UNTRUSTED source (notebook sources are fenced).
    const col = await createCollection(tenantId, orgId, 'tester', { name: 'Sources' });
    const NEEDLE = 'Photosynthesis converts sunlight into chemical energy in chloroplasts.';
    await ingestDocument(tenantId, orgId, 'tester', col.collectionId, { title: 'Bio', text: NEEDLE }, { contentTrust: 'untrusted' });
    await setSubjectKnowledge(tenantId, subject, { collectionIds: [col.collectionId] });

    const block = await composeKnowledgeForSubject(tenantId, subject, 'how does photosynthesis work', { topK: 6 });
    expect(block.length).toBeGreaterThan(0);
    // The source text sits INSIDE the untrusted fence.
    const fenceAt = block.indexOf('BEGIN UNTRUSTED CONTENT');
    expect(fenceAt).toBeGreaterThanOrEqual(0);
    const fenceEnd = block.indexOf('\nEND UNTRUSTED CONTENT', fenceAt);
    expect(fenceEnd).toBeGreaterThan(fenceAt);
    expect(block.slice(fenceAt, fenceEnd)).toContain('chemical energy');
  });
});
