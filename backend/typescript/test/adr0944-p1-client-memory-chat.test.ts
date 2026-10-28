/**
 * ADR 0944 P1 — the chat lane's client binding (D2) and the client-note lane (D4).
 *
 * Covers D7 tests 2 (a run stamped A whose arguments name B is refused
 * `wrong_client` before anything is read) and 3 (a person with rows on A only,
 * in a conversation bound to B: refused at binding, and an empty recall plus the
 * degradation notice when speaking in it), plus the route-level RBAC of the note
 * and proposal routes, through `createApp` + `app.listen` + a session cookie.
 *
 * Sabotage-witnessed (P1): dropping `assertOrgScope` from `assertClientBindable`
 * reds "refuses a client the creator cannot read"; dropping the client from the
 * branch's init reds "a branch keeps its parent's client"; returning
 * `{orgId: clientOrgId}` unchecked from `resolveConversationMemoryClient` reds
 * "a speaker without the client recalls nothing"; removing the CAS in
 * `decideClientNoteProposal` reds "a proposal is decided once".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';
import { composeChatContext } from '../src/host/chatContext.js';
import { getConversationMeta } from '../src/host/conversationStore.js';
import { buildCampaignOpsSurface, CAMPAIGN_OPS_RUN_STAMP } from '../src/features/campaign-ops/surface.js';
import { clientRunStamp, runClientStamp } from '../src/host/runClientOrg.js';
import { eraseSubjectMemory, listSubjectNotes } from '../src/host/subjectMemory.js';
import { orgSubject } from '../src/host/subject.js';
import { ERASED_USER_REF } from '../src/host/subjectErasureRedaction.js';
import { decideClientNoteProposal, getClientNoteProposal, proposeClientNote } from '../src/features/campaign-ops/clientMemory.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';

const AGENT = 'test.adr0944-p1-strategist';

let BASE: string;
let server: http.Server;
let TENANT: string;
let orgA: string;
let orgB: string;
let admin: string;
let both: string;
let onlyA: string;
let viewerA: string;
const cookies: Record<string, string> = {};

function cookieFor(userId: string, home: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant: home, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

async function call<T = Record<string, unknown>>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; raw: string }> {
  const res = await fetch(`${BASE}/host/openwop-app${path}`, {
    method,
    headers: { cookie: cookies[who]!, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:p1-owner' });
  TENANT = ws.tenantId;
  const mk = async (p: string): Promise<string> => (await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:p1-${p}`, source: 'oidc' })).userId;
  admin = await mk('admin'); both = await mk('both'); onlyA = await mk('only-a'); viewerA = await mk('viewer-a');
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin, displayName: 'Admin', roles: ['admin'] });
  // Workspace members (a root row, no client access) — the campaign-ops test's shape.
  for (const u of [both, onlyA, viewerA]) await createMember({ tenantId: TENANT, orgId: TENANT, subject: u, displayName: u, roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  for (const [who, org, role] of [[both, orgA, 'editor'], [both, orgB, 'editor'], [onlyA, orgA, 'editor'], [viewerA, orgA, 'viewer']] as const) {
    await createMember({ tenantId: TENANT, orgId: org, subject: who, displayName: who, roles: [role] });
  }
  for (const [k, u] of Object.entries({ admin, both, onlyA, viewerA })) cookies[k] = cookieFor(u, `ws:home-${k}`);
  expect((await call('admin', 'POST', '/campaign-ops/clients', { name: 'Client A', orgId: orgA })).status).toBe(201);
  expect((await call('admin', 'POST', '/campaign-ops/clients', { name: 'Client B', orgId: orgB })).status).toBe(201);
  await upsertAgentProfile(TENANT, AGENT, { roleKey: 'strategist', autonomy: { specLevel: 'recommend' }, memoryScope: 'per-org', capabilities: ['knowledge'] });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

beforeEach(() => {
  const registry = getAgentRegistry();
  registry._resetForTest();
  registry.register({
    agentId: AGENT, persona: 'Strategist', modelClass: 'chat', systemPrompt: 'You plan campaigns.',
    packName: 'test', packVersion: '0', toolAllowlist: [], memoryShape: { longTerm: true },
  } as ResolvedAgentManifest);
});

const newSession = (who: string, clientOrgId?: string) =>
  call<{ sessionId: string; client?: { orgId: string; name: string } }>(who, 'POST', '/chat/sessions', {
    sessionId: `s-${randomBytes(6).toString('hex')}`, ...(clientOrgId !== undefined ? { clientOrgId } : {}),
  });

describe('ADR 0944 D2 — binding a conversation to a client (route level)', () => {
  it('binds once at creation and returns the client for the chip', async () => {
    const r = await newSession('both', orgA);
    expect(r.status, r.raw).toBe(201);
    expect(r.body.client).toEqual({ orgId: orgA, name: 'Client A' });
    expect((await getConversationMeta(TENANT, r.body.sessionId))?.client?.orgId).toBe(orgA);
  });

  it('test 3: refuses a client the creator cannot read, the workspace root, and an unknown org', async () => {
    expect((await newSession('onlyA', orgB)).status).toBe(403);
    expect((await newSession('both', TENANT)).status).toBe(404);
    expect((await newSession('both', 'org-that-does-not-exist')).status).toBe(404);
    expect((await call('both', 'POST', '/chat/sessions', { clientOrgId: 42 })).status).toBe(400);
  });

  it('a branch keeps its parent client', async () => {
    const parent = await newSession('both', orgA);
    const branch = await call<{ sessionId: string; client?: { orgId: string } }>('both', 'POST', `/chat/sessions/${parent.body.sessionId}/branch`, {});
    expect(branch.status, branch.raw).toBe(201);
    expect(branch.body.client?.orgId).toBe(orgA);
  });
});

describe('ADR 0944 D2 — the chat lane recalls only the bound client', () => {
  it('recalls A in an A conversation, never B; a speaker without the client gets the notice (test 3)', async () => {
    expect((await call('both', 'POST', `/campaign-ops/clients/${orgA}/memory/notes`, { content: 'NOTE-ALPHA: never mention the rival brand' })).status).toBe(201);
    expect((await call('both', 'POST', `/campaign-ops/clients/${orgB}/memory/notes`, { content: 'NOTE-BETA: B prefers green' })).status).toBe(201);
    const convA = (await newSession('both', orgA)).body.sessionId;
    const convB = (await newSession('both', orgB)).body.sessionId;

    const inA = await composeChatContext(TENANT, { agentId: AGENT, conversationId: convA, callerUserId: both, seedText: 'brand rules for the hero line' });
    expect(inA.systemPrompt).toContain('NOTE-ALPHA');
    expect(inA.systemPrompt).not.toContain('NOTE-BETA');
    expect(inA.degraded).not.toContain('client_memory');

    const inB = await composeChatContext(TENANT, { agentId: AGENT, conversationId: convB, callerUserId: both, seedText: 'brand rules for the hero line' });
    expect(inB.systemPrompt).toContain('NOTE-BETA');
    expect(inB.systemPrompt).not.toContain('NOTE-ALPHA');

    // onlyA speaking in the B conversation: no B memory, and the model is told.
    const denied = await composeChatContext(TENANT, { agentId: AGENT, conversationId: convB, callerUserId: onlyA, seedText: 'brand rules for the hero line' });
    expect(denied.systemPrompt).not.toContain('NOTE-BETA');
    expect(denied.systemPrompt).not.toContain('NOTE-ALPHA');
    expect(denied.degraded).toContain('client_memory');
    expect(denied.systemPrompt).toContain("this client's shared memory");

    // A per-org agent in a conversation with no client: told, never a fallback.
    const unbound = (await newSession('both')).body.sessionId;
    const none = await composeChatContext(TENANT, { agentId: AGENT, conversationId: unbound, callerUserId: both, seedText: 'brand rules for the hero line' });
    expect(none.systemPrompt).not.toContain('NOTE-ALPHA');
    expect(none.degraded).toContain('client_memory');
  });

  it('a deep-run stamp from a client conversation names that client', () => {
    expect(runClientStamp(clientRunStamp('org-x'))).toEqual({ orgId: 'org-x' });
    expect(Object.keys(clientRunStamp('org-x'))).toEqual([CAMPAIGN_OPS_RUN_STAMP]);
  });
});

describe('ADR 0944 D4 — client notes and agent proposals', () => {
  it('an unconfirmed proposal insert never returns a phantom pending proposal', async () => {
    const storage = hostExtStorage();
    const cas = storage.kvCompareAndSwap.bind(storage);
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (args[0].startsWith('hostext:campaign-ops:client-note-proposal:')) return { swapped: false, actual: null };
      return cas(...args);
    });
    try {
      await expect(proposeClientNote({ tenantId: TENANT, orgId: orgA, content: 'Unconfirmed proposal',
        proposedBy: { runId: `unconfirmed-${randomBytes(4).toString('hex')}`, nodeId: 'propose' } })).rejects.toMatchObject({ httpStatus: 409 });
    } finally { spy.mockRestore(); }
  });

  it('a lost note-write acknowledgement resumes one approval and recalls exactly one note', async () => {
    const content = 'RECOVERED-ACK: preserve the approved client fact';
    const { proposal } = await proposeClientNote({ tenantId: TENANT, orgId: orgA, content,
      proposedBy: { runId: `ack-${randomBytes(4).toString('hex')}`, nodeId: 'propose' } });
    const storage = hostExtStorage();
    const cas = storage.kvCompareAndSwap.bind(storage);
    let lost = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      const result = await cas(...args);
      if (!lost && args[0].startsWith('hostext:subject-memory:note:') && result.swapped) {
        lost = true;
        throw new Error('lost-note-ack');
      }
      return result;
    });
    try {
      await expect(decideClientNoteProposal(TENANT, orgA, proposal.proposalId, 'approve', both)).rejects.toThrow('lost-note-ack');
      expect((await getClientNoteProposal(TENANT, orgA, proposal.proposalId))?.status).toBe('approving');
      await expect(decideClientNoteProposal(TENANT, orgA, proposal.proposalId, 'reject', admin)).rejects.toMatchObject({ httpStatus: 409 });
      const completed = await decideClientNoteProposal(TENANT, orgA, proposal.proposalId, 'approve', admin);
      expect(completed).toMatchObject({ status: 'approved', decidedBy: both });
      const notes = (await listSubjectNotes(TENANT, orgSubject(orgA))).filter((note) => note.content === content);
      expect(notes).toEqual([expect.objectContaining({ id: completed.noteId, authoredBy: both })]);
      const conversationId = (await newSession('both', orgA)).body.sessionId;
      expect((await composeChatContext(TENANT, { agentId: AGENT, conversationId, callerUserId: both, seedText: 'approved client fact' })).systemPrompt).toContain(content);
    } finally { spy.mockRestore(); }
  });

  it('a failed proposal finalization retries the existing note without claiming success early', async () => {
    const content = 'RECOVERED-FINALIZE: keep one note after a process retry';
    const { proposal } = await proposeClientNote({ tenantId: TENANT, orgId: orgA, content,
      proposedBy: { runId: `finalize-${randomBytes(4).toString('hex')}`, nodeId: 'propose' } });
    const storage = hostExtStorage();
    const cas = storage.kvCompareAndSwap.bind(storage);
    let failed = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (!failed && args[0].startsWith('hostext:campaign-ops:client-note-proposal:')
        && typeof args[2] === 'string' && JSON.parse(args[2]).status === 'approved') {
        failed = true;
        throw new Error('proposal-finalize-unavailable');
      }
      return cas(...args);
    });
    try {
      await expect(decideClientNoteProposal(TENANT, orgA, proposal.proposalId, 'approve', both)).rejects.toThrow('proposal-finalize-unavailable');
      expect((await getClientNoteProposal(TENANT, orgA, proposal.proposalId))?.status).toBe('approving');
      const completed = await decideClientNoteProposal(TENANT, orgA, proposal.proposalId, 'approve', both);
      expect(completed.status).toBe('approved');
      expect((await listSubjectNotes(TENANT, orgSubject(orgA))).filter((note) => note.content === content)).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it('notes: read on workspace:read, write on workspace:write, invisible to non-members', async () => {
    expect((await call('viewerA', 'GET', `/campaign-ops/clients/${orgA}/memory/notes`)).status).toBe(200);
    expect((await call('viewerA', 'POST', `/campaign-ops/clients/${orgA}/memory/notes`, { content: 'x' })).status).toBe(403);
    expect((await call('onlyA', 'GET', `/campaign-ops/clients/${orgB}/memory/notes`)).status).toBe(404);
    const created = await call<{ noteId: string }>('onlyA', 'POST', `/campaign-ops/clients/${orgA}/memory/notes`, { content: 'NOTE-DELETE-ME' });
    expect(created.status).toBe(201);
    const listed = await call<{ notes: Array<{ id: string; contentTrust: string; authoredBy?: string }> }>('viewerA', 'GET', `/campaign-ops/clients/${orgA}/memory/notes`);
    const note = listed.body.notes.find((n) => n.id === created.body.noteId);
    expect(note).toMatchObject({ contentTrust: 'trusted', authoredBy: onlyA });
    expect((await call('viewerA', 'DELETE', `/campaign-ops/clients/${orgA}/memory/notes/${created.body.noteId}`)).status).toBe(403);
    expect((await call('onlyA', 'DELETE', `/campaign-ops/clients/${orgA}/memory/notes/${created.body.noteId}`)).status).toBe(204);
    expect((await call('onlyA', 'DELETE', `/campaign-ops/clients/${orgA}/memory/notes/${created.body.noteId}`)).status).toBe(404);
  });

  it('test 2: a run stamped A whose arguments name B is refused before anything is read', async () => {
    const runId = `run-p1-${randomBytes(4).toString('hex')}`;
    await hostExtStorage().insertRun({
      runId, workflowId: 'w', tenantId: TENANT, status: 'running', inputs: null,
      metadata: { [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA } }, configurable: {}, createdAt: 'x', updatedAt: 'x',
    });
    const surface = buildCampaignOpsSurface({ tenantId: TENANT, runId, actingUserId: both } as BundleScope);
    await expect(surface.listClientNotes!({ orgId: orgB })).rejects.toMatchObject({ details: { reason: 'wrong_client' } });
    await expect(surface.proposeClientNote!({ orgId: orgB, content: 'leak' })).rejects.toMatchObject({ details: { reason: 'wrong_client' } });
    const notesA = await surface.listClientNotes!({ orgId: orgA }) as { notes: Array<{ content: string }> };
    expect(notesA.notes.map((n) => n.content).join('\n')).toContain('NOTE-ALPHA');
    expect(notesA.notes.map((n) => n.content).join('\n')).not.toContain('NOTE-BETA');
  });

  it('a proposal is untrusted until a person with write approves it, and is decided once', async () => {
    const runId = `run-p1-${randomBytes(4).toString('hex')}`;
    await hostExtStorage().insertRun({
      runId, workflowId: 'w', tenantId: TENANT, status: 'running', inputs: null,
      metadata: { [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA } }, configurable: {}, createdAt: 'x', updatedAt: 'x',
    });
    const surface = buildCampaignOpsSurface({ tenantId: TENANT, runId, actingUserId: both } as BundleScope);
    const first = await surface.proposeClientNote!({ orgId: orgA, content: 'PROPOSED-GAMMA: Q4 launches on Tuesdays', nodeId: 'n1' }) as { proposalId: string; status: string; created: boolean };
    expect(first).toMatchObject({ status: 'pending', created: true });
    const again = await surface.proposeClientNote!({ orgId: orgA, content: 'PROPOSED-GAMMA: Q4 launches on Tuesdays', nodeId: 'n1' }) as { proposalId: string; created: boolean };
    expect(again).toMatchObject({ proposalId: first.proposalId, created: false }); // a re-execution adds nothing
    expect((await listSubjectNotes(TENANT, orgSubject(orgA))).map((n) => n.content).join('\n')).not.toContain('PROPOSED-GAMMA');

    const pending = await call<{ proposals: Array<{ proposalId: string }> }>('viewerA', 'GET', `/campaign-ops/clients/${orgA}/memory/proposals?status=pending`);
    expect(pending.body.proposals.map((p) => p.proposalId)).toContain(first.proposalId);
    expect((await call('viewerA', 'POST', `/campaign-ops/clients/${orgA}/memory/proposals/${first.proposalId}/approve`)).status).toBe(403);
    expect((await call('both', 'POST', `/campaign-ops/clients/${orgB}/memory/proposals/${first.proposalId}/approve`)).status).toBe(404);
    const approved = await call<{ proposal: { status: string; noteId?: string; decidedBy?: string } }>('onlyA', 'POST', `/campaign-ops/clients/${orgA}/memory/proposals/${first.proposalId}/approve`);
    expect(approved.status, approved.raw).toBe(200);
    expect(approved.body.proposal).toMatchObject({ status: 'approved', decidedBy: onlyA });
    const notes = await listSubjectNotes(TENANT, orgSubject(orgA));
    expect(notes.find((n) => n.id === approved.body.proposal.noteId)).toMatchObject({ contentTrust: 'trusted', authoredBy: onlyA });
    expect((await call('both', 'POST', `/campaign-ops/clients/${orgA}/memory/proposals/${first.proposalId}/reject`)).status).toBe(409);
  });

  it('DSAR: the author of a client note is tombstoned; the client keeps the note', async () => {
    const created = await call<{ noteId: string }>('both', 'POST', `/campaign-ops/clients/${orgA}/memory/notes`, { content: 'NOTE-AUTHOR-ERASE' });
    expect(created.status).toBe(201);
    await eraseSubjectMemory(TENANT, both);
    const note = (await listSubjectNotes(TENANT, orgSubject(orgA))).find((n) => n.id === created.body.noteId);
    expect(note?.content).toBe('NOTE-AUTHOR-ERASE');
    expect(note?.authoredBy).toBe(ERASED_USER_REF);
  });
});
