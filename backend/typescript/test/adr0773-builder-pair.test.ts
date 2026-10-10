/**
 * ADR 0773 — Builder Pair Canvas. Route-level (createApp + real principals) for
 * the gates, plus the two chat-time tools invoked through the registered
 * builtin, so what is asserted is what the Architect actually gets.
 *
 *   - the toggle gates every route (and the witness can tell "disabled" from
 *     "not found": ADR 0773 A8 — a bare 404 cannot);
 *   - context ids are closed-world: unknown ids are dropped and reported;
 *   - `read-canvas` returns the fresh head + revision + selection, and refuses
 *     with a typed `no_pairing_context` when the conversation is not paired;
 *   - `suggest-edits` NEVER writes the workflow, refuses a moved head, refuses
 *     invalid ops with per-op reasons, refuses a viewer, and refuses inside a
 *     replay fork (Architect review A1);
 *   - `persist` requires the revision it read to overwrite (D8, `WBWF-17`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import { readRegisteredWorkflowFresh, registerWorkflowDurable } from '../src/host/workflowsRegistry.js';
import { recordOwnership } from '../src/host/workflowOwnership.js';
import { revisionHashOf } from '../src/host/definitionHash.js';
import { writePairContext } from '../src/features/builder-pair/pairService.js';
import { BUILDER_PAIR_READ_CANVAS_TOOL_ID, BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID } from '../src/features/builder-pair/agentTools.js';
import { WORKFLOW_AUTHOR_GET_TOOL_ID, WORKFLOW_AUTHOR_PERSIST_TOOL_ID } from '../src/features/workflow-author/agentTools.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { getConversationMeta, setConversationCapabilityScope } from '../src/host/conversationStore.js';
import { PAIR_TOOL_SCOPE } from '../src/features/builder-pair/pairToolScope.js';
import { readFileSync } from 'node:fs';

const TENANT = 'tenant-0773';
const TENANT_ENV_KEY = 'tenv0773-tenant-operator-key';
const EDITOR_SUBJECT = 'user:editor-0773';
const VIEWER_SUBJECT = 'user:viewer-0773';
let EDITOR = '';
let VIEWER = '';
const saved: Record<string, string | undefined> = {};
let BASE = '';
let server: http.Server;
/** Only `getRun` is read (for `lastRunId`), and these tests pass none. */
const storage = { getRun: async () => null } as unknown as Parameters<typeof writePairContext>[0];

async function call(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? TENANT_ENV_KEY}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const host = (p: string) => `/host/openwop-app${p}`;

const WF = 'wf.adr0773.lead-intake';
const def = () => ({
  workflowId: WF,
  metadata: { name: 'Lead intake' },
  nodes: [
    { nodeId: 'score', typeId: 'core.noop', name: 'Score lead', config: { threshold: 40 } },
    { nodeId: 'crm', typeId: 'core.noop', name: 'Write to CRM' },
    { nodeId: 'gate', typeId: 'core.approvalGate', name: 'Approve', config: { prompt: 'OK?' } },
  ],
  edges: [
    { edgeId: 'e1', sourceNodeId: 'score', targetNodeId: 'crm' },
    { edgeId: 'e2', sourceNodeId: 'crm', targetNodeId: 'gate' },
  ],
});

const scopeFor = (actingUserId: string | undefined, conversationId = 'sess-0773', runId = 'run-conv-0773'): BundleScope =>
  ({ tenantId: TENANT, runId, ...(actingUserId ? { actingUserId } : {}), conversationId } as BundleScope);

async function tool(id: string, input: Record<string, unknown>, scope: BundleScope): Promise<{ json: any; isError: boolean }> {
  const t = builtinAgentTool(id);
  if (!t) throw new Error(`tool ${id} is not registered`);
  const out = await t.run(input, scope) as { content: string; isError?: boolean };
  return { json: JSON.parse(out.content), isError: out.isError === true };
}

async function setToggle(on: boolean) {
  const d = getToggleDefault('builder-pair');
  if (!d) throw new Error('builder-pair toggle default is not registered');
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

beforeAll(async () => {
  for (const k of ['OPENWOP_API_KEYS', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_API_KEYS = `${TENANT_ENV_KEY}:${TENANT}`;
  process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
  process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await createOrg({ tenantId: TENANT, orgId: TENANT, name: 'Root', createdBy: 'test' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: EDITOR_SUBJECT, displayName: 'Editor', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: VIEWER_SUBJECT, displayName: 'Viewer', roles: ['viewer'] });
  EDITOR = (await issueApiKey({ tenantId: TENANT, name: 'editor', createdBy: EDITOR_SUBJECT })).token;
  VIEWER = (await issueApiKey({ tenantId: TENANT, name: 'viewer', createdBy: VIEWER_SUBJECT })).token;
  expect((await call('POST', host('/workflows'), { body: def() })).status).toBe(201);
  await setToggle(true);
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

/** Pair `conversationId` for `userId` exactly as the route does (the service it calls). */
async function pair(userId: string, conversationId = 'sess-0773', selection: unknown = { nodeIds: ['score'], edgeIds: [] }) {
  const out = await writePairContext(storage, { tenantId: TENANT, actingUserId: userId }, { conversationId, workflowId: WF, selection });
  if ('refused' in out) throw new Error(`pair refused: ${out.code}`);
  return out;
}

describe('ADR 0773 — routes are toggle-gated, and the witness can tell disabled from missing (A8)', () => {
  it('the same request answers 200 when on and a builder-pair 404 when off', async () => {
    const body = { conversationId: 'sess-route', workflowId: WF, selection: { nodeIds: ['score'] } };
    const on = await call('PUT', host('/builder-pair/context'), { key: EDITOR, body });
    expect(on.status).toBe(200);
    await setToggle(false);
    try {
      const off = await call('PUT', host('/builder-pair/context'), { key: EDITOR, body });
      expect(off.status).toBe(404);
      // A plain not-found carries no feature marker; the toggle gate does.
      expect(off.json.details?.feature ?? off.json.feature).toBe('builder-pair');
    } finally {
      await setToggle(true);
    }
  });

  it('context ids are closed-world: unknown ids are dropped and reported, never trusted', async () => {
    const r = await call('PUT', host('/builder-pair/context'), {
      key: EDITOR,
      body: { conversationId: 'sess-drop', workflowId: WF, selection: { nodeIds: ['score', 'ghost-node'], edgeIds: ['e1', 'nope'] } },
    });
    expect(r.status).toBe(200);
    expect(r.json.selection).toEqual({ nodeIds: ['score'], edgeIds: ['e1'] });
    expect(r.json.droppedIds.sort()).toEqual(['ghost-node', 'nope']);
  });

  it('a viewer may pair (read-only), and a workflow outside the tenant is a 404', async () => {
    expect((await call('PUT', host('/builder-pair/context'), { key: VIEWER, body: { conversationId: 'sess-v', workflowId: WF } })).status).toBe(200);
    // A workflow ANOTHER tenant owns is a miss — never an empty draft to pair with.
    const foreign = { workflowId: 'wf.adr0773.foreign', nodes: [{ nodeId: 'x', typeId: 'core.noop' }], edges: [] };
    await registerWorkflowDurable(foreign as never);
    await recordOwnership('tenant-someone-else', foreign.workflowId, { nodeCount: 1 });
    expect((await call('PUT', host('/builder-pair/context'), { key: EDITOR, body: { conversationId: 'sess-x', workflowId: foreign.workflowId } })).status).toBe(404);
    // An id nobody registered is a new, never-saved draft (review CR-1).
    expect((await call('PUT', host('/builder-pair/context'), { key: EDITOR, body: { conversationId: 'sess-y', workflowId: 'wf.adr0773.not-yet-saved' } })).status).toBe(200);
  });
});

describe('ADR 0773 D2 — read-canvas', () => {
  it('refuses with a typed no_pairing_context when the conversation is not paired', async () => {
    const r = await tool(BUILDER_PAIR_READ_CANVAS_TOOL_ID, {}, scopeFor(EDITOR_SUBJECT, 'sess-never-paired'));
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe('no_pairing_context');
  });

  it('returns the fresh head, its revision and the selection', async () => {
    await pair(EDITOR_SUBJECT);
    const r = await tool(BUILDER_PAIR_READ_CANVAS_TOOL_ID, {}, scopeFor(EDITOR_SUBJECT));
    expect(r.isError).toBe(false);
    const fresh = await readRegisteredWorkflowFresh(WF);
    expect(r.json.revision).toBe(revisionHashOf(fresh.def!));
    expect(r.json.selection.nodeIds).toEqual(['score']);
    expect(r.json.definition.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual(['score', 'crm', 'gate']);
  });

  it('is empty-and-typed without an acting user, and never reads another user\'s pairing', async () => {
    expect((await tool(BUILDER_PAIR_READ_CANVAS_TOOL_ID, {}, scopeFor(undefined))).json.error).toBe('acting_user_required');
    expect((await tool(BUILDER_PAIR_READ_CANVAS_TOOL_ID, {}, scopeFor(VIEWER_SUBJECT))).json.error).toBe('no_pairing_context');
  });
});

describe('ADR 0773 D4 — suggest-edits never writes the workflow', () => {
  it('stores a suggestion with minted ids, dependencies, preimages and gate flags, and leaves the head untouched', async () => {
    await pair(EDITOR_SUBJECT);
    const before = await readRegisteredWorkflowFresh(WF);
    const rev = revisionHashOf(before.def!);
    const r = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, {
      baseRevision: rev,
      summary: 'Route low scores to nurture',
      ops: [
        { kind: 'addNode', ref: 'nurture', typeId: 'core.noop', name: 'Add to nurture list' },
        { kind: 'addEdge', source: 'score', target: 'nurture', condition: { path: 'score', op: 'eq', value: 'low' } },
        { kind: 'setConfig', nodeId: 'score', path: 'threshold', value: 50 },
        { kind: 'setCondition', edgeId: 'e2', condition: { path: 'ok', op: 'truthy' } },
      ],
    }, scopeFor(EDITOR_SUBJECT));
    expect(r.isError, JSON.stringify(r.json)).toBe(false);
    expect(r.json.ops).toHaveLength(4);
    expect(r.json.ops[1].dependsOn).toEqual([0]);
    expect(r.json.ops[3].gateSensitive, 'an edge into an approval gate is gate-sensitive').toBe(true);
    expect(r.json.ops[2].gateSensitive).toBe(false);

    const after = await readRegisteredWorkflowFresh(WF);
    expect(after.raw, 'suggest-edits must not write the workflow').toBe(before.raw);

    const got = await call('GET', host('/builder-pair/suggestions/sess-0773'), { key: TENANT_ENV_KEY });
    // The env key is not the requester; a private suggestion is invisible to it.
    expect(got.status).toBe(404);
  });

  it('refuses a moved head, telling the model to read again', async () => {
    await pair(EDITOR_SUBJECT);
    const r = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, { baseRevision: 'stale', ops: [{ kind: 'renameNode', nodeId: 'crm', name: 'CRM' }] }, scopeFor(EDITOR_SUBJECT));
    expect(r.json.error).toBe('workflow_head_moved');
  });

  it('refuses invalid ops with a reason per op, and a cycle as a typed failure', async () => {
    await pair(EDITOR_SUBJECT);
    const rev = revisionHashOf((await readRegisteredWorkflowFresh(WF)).def!);
    const bad = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, {
      baseRevision: rev,
      ops: [
        { kind: 'addNode', ref: 'x', typeId: 'not.a.real.type' },
        { kind: 'setCondition', edgeId: 'e1', condition: { path: 'a', op: 'truthy', value: true } },
      ],
    }, scopeFor(EDITOR_SUBJECT));
    expect(bad.json.error).toBe('invalid_ops');
    expect(bad.json.errors.map((e: { index: number }) => e.index)).toEqual([0, 1]);

    const cycle = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, {
      baseRevision: rev, ops: [{ kind: 'addEdge', source: 'gate', target: 'score' }],
    }, scopeFor(EDITOR_SUBJECT));
    expect(cycle.json.error).toBe('invalid_ops');
    expect(JSON.stringify(cycle.json.errors)).toMatch(/cycl|acyclic/i);
  });

  it('refuses a viewer (typed forbidden) — a suggestion they could never keep is never drawn', async () => {
    await pair(VIEWER_SUBJECT, 'sess-viewer');
    const rev = revisionHashOf((await readRegisteredWorkflowFresh(WF)).def!);
    const r = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, { baseRevision: rev, ops: [{ kind: 'renameNode', nodeId: 'crm', name: 'CRM' }] }, scopeFor(VIEWER_SUBJECT, 'sess-viewer'));
    expect(r.json.error).toBe('forbidden');
    // …but the viewer can still read the canvas.
    expect((await tool(BUILDER_PAIR_READ_CANVAS_TOOL_ID, {}, scopeFor(VIEWER_SUBJECT, 'sess-viewer'))).isError).toBe(false);
  });

  it('a fork of the paired conversation is refused — it copies chatSessionId but runs under a NEW run id (review CR-4)', async () => {
    // The live conversation run binds the pairing on its first tool call…
    await pair(EDITOR_SUBJECT, 'sess-fork');
    const rev = revisionHashOf((await readRegisteredWorkflowFresh(WF)).def!);
    expect((await tool(BUILDER_PAIR_READ_CANVAS_TOOL_ID, {}, scopeFor(EDITOR_SUBJECT, 'sess-fork', 'run-live'))).isError).toBe(false);
    // …so a fork (same session id, copied metadata, different run) reads and writes nothing.
    const forkRead = await tool(BUILDER_PAIR_READ_CANVAS_TOOL_ID, {}, scopeFor(EDITOR_SUBJECT, 'sess-fork', 'run-fork'));
    expect(forkRead.json.error).toBe('replay_refused');
    const forkWrite = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, { baseRevision: rev, ops: [{ kind: 'renameNode', nodeId: 'crm', name: 'CRM' }] }, scopeFor(EDITOR_SUBJECT, 'sess-fork', 'run-fork'));
    expect(forkWrite.json.error).toBe('replay_refused');
    const { readSuggestionFor } = await import('../src/features/builder-pair/pairService.js');
    expect(await readSuggestionFor({ tenantId: TENANT, actingUserId: EDITOR_SUBJECT, granted: new Set(['workspace:read']) }, 'sess-fork')).toBeNull();
    // Belt: an executor replay context refuses too.
    const r = await runWithEffectContext({ runId: 'run-live', replaying: true }, () =>
      tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, { baseRevision: rev, ops: [{ kind: 'renameNode', nodeId: 'crm', name: 'CRM' }] }, scopeFor(EDITOR_SUBJECT, 'sess-fork', 'run-live')));
    expect(r.json.error).toBe('replay_refused');
  });

  it('pairs a brand-new, never-saved workflow as an EMPTY draft (review CR-1)', async () => {
    const out = await writePairContext(storage, { tenantId: TENANT, actingUserId: EDITOR_SUBJECT }, { conversationId: 'sess-new', workflowId: 'wf.adr0773.brand-new', selection: {} });
    expect('refused' in out).toBe(false);
    const read = await tool(BUILDER_PAIR_READ_CANVAS_TOOL_ID, {}, scopeFor(EDITOR_SUBJECT, 'sess-new'));
    expect(read.json.revision).toBe('absent');
    expect(read.json.definition.nodes).toEqual([]);
    const s = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, {
      // B.6: a first draft on an empty canvas states its plan (the refusal without it is pinned below).
      baseRevision: 'absent', plannedOps: 3,
      ops: [
        { kind: 'addNode', ref: 't', typeId: 'core.noop', name: 'Start' },
        { kind: 'addNode', ref: 'u', typeId: 'core.noop', name: 'Then' },
        { kind: 'addEdge', source: 't', target: 'u' },
      ],
    }, scopeFor(EDITOR_SUBJECT, 'sess-new'));
    expect(s.isError, JSON.stringify(s.json)).toBe(false);
    expect(s.json.ops).toHaveLength(3);
    expect((await readRegisteredWorkflowFresh('wf.adr0773.brand-new')).def, 'still never written').toBeNull();
  });

  it('one member cannot overwrite another member\'s suggestion by reusing their conversation id (review CR-3)', async () => {
    await pair(EDITOR_SUBJECT, 'sess-shared-id');
    const rev = revisionHashOf((await readRegisteredWorkflowFresh(WF)).def!);
    const mine = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, { baseRevision: rev, ops: [{ kind: 'renameNode', nodeId: 'crm', name: 'Mine' }] }, scopeFor(EDITOR_SUBJECT, 'sess-shared-id'));
    const OTHER = 'user:other-editor-0773';
    await createMember({ tenantId: TENANT, orgId: TENANT, subject: OTHER, displayName: 'Other', roles: ['editor'] });
    await pair(OTHER, 'sess-shared-id');
    await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, { baseRevision: rev, ops: [{ kind: 'renameNode', nodeId: 'crm', name: 'Theirs' }] }, scopeFor(OTHER, 'sess-shared-id'));
    const { readSuggestionFor } = await import('../src/features/builder-pair/pairService.js');
    const got = await readSuggestionFor({ tenantId: TENANT, actingUserId: EDITOR_SUBJECT, granted: new Set(['workspace:read']) }, 'sess-shared-id');
    expect(got?.id).toBe(mine.json.suggestionId);
  });
});

describe('ADR 0773 D4 — keep/drop and sharing are the requester\'s, over the route', () => {
  it('records opState, rejects a stale suggestion id, and shares with the room', async () => {
    await pair(EDITOR_SUBJECT, 'sess-patch');
    const rev = revisionHashOf((await readRegisteredWorkflowFresh(WF)).def!);
    const s = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, { baseRevision: rev, ops: [{ kind: 'renameNode', nodeId: 'crm', name: 'CRM' }] }, scopeFor(EDITOR_SUBJECT, 'sess-patch'));
    expect(s.isError).toBe(false);
    const { patchSuggestion, readSuggestionFor } = await import('../src/features/builder-pair/pairService.js');
    const who = { tenantId: TENANT, actingUserId: EDITOR_SUBJECT };
    const stale = await patchSuggestion(who, 'sess-patch', { suggestionId: 'nope', opState: [{ index: 0, state: 'kept' }] });
    expect('refused' in stale && stale.code).toBe('workflow_head_moved');
    const kept = await patchSuggestion(who, 'sess-patch', { suggestionId: s.json.suggestionId, opState: [{ index: 0, state: 'kept' }], visibility: 'room' });
    expect('refused' in kept).toBe(false);
    // A peer never reaches it by conversation id, and cannot resolve it…
    const peer = { tenantId: TENANT, actingUserId: VIEWER_SUBJECT };
    expect(await readSuggestionFor(peer, 'sess-patch')).toBeNull();
    const peerPatch = await patchSuggestion(peer, 'sess-patch', { opState: [{ index: 0, state: 'dropped' }] });
    expect('refused' in peerPatch && peerPatch.code).toBe('not_found');
    // …it sees the shared suggestion only through the room listing, sanitized:
    // no requester or conversation id to target (review CR-3).
    const room = await call('GET', host(`/builder-pair/suggestions?workflowId=${encodeURIComponent(WF)}`), { key: VIEWER });
    expect(room.status).toBe(200);
    const shared = room.json.suggestions.find((x: { id: string }) => x.id === s.json.suggestionId);
    expect(shared?.opState).toEqual(['kept']);
    expect(shared).not.toHaveProperty('conversationId');
    expect(shared).not.toHaveProperty('requestedBy');
  });
});

describe('ADR 0773 D8 — persist requires the revision it read to overwrite (WBWF-17)', () => {
  it('refuses an overwrite without baseRevision or with a stale one, and accepts the current one', async () => {
    const scope = scopeFor(EDITOR_SUBJECT);
    const got = await tool(WORKFLOW_AUTHOR_GET_TOOL_ID, { workflowId: WF }, scope);
    expect(typeof got.json.revision).toBe('string');
    const next = { ...got.json.definition, nodes: got.json.definition.nodes.map((n: { nodeId: string }) => (n.nodeId === 'crm' ? { ...n, name: 'CRM upsert' } : n)) };
    const missing = await tool(WORKFLOW_AUTHOR_PERSIST_TOOL_ID, { definition: next }, scope);
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.json)).toMatch(/base_revision_required|baseRevision/);
    const stale = await tool(WORKFLOW_AUTHOR_PERSIST_TOOL_ID, { definition: next, baseRevision: 'stale' }, scope);
    expect(JSON.stringify(stale.json)).toMatch(/workflow_head_moved|changed since you read it/);
    const ok = await tool(WORKFLOW_AUTHOR_PERSIST_TOOL_ID, { definition: next, baseRevision: got.json.revision }, scope);
    expect(ok.isError, JSON.stringify(ok.json)).toBe(false);
    const after = await readRegisteredWorkflowFresh(WF);
    expect(after.def!.nodes.find((n) => n.nodeId === 'crm')?.name).toBe('CRM upsert');
  });
});

describe('ADR 0773 P7/P9 — why, follow-ups, append batches, chain as ghost, create-only node lane', () => {
  it('append mode lands a draft in batches: ids continue, later ops depend on earlier adds, planned + follow-ups kept', async () => {
    await pair(EDITOR_SUBJECT, 'sess-append');
    const rev = revisionHashOf((await readRegisteredWorkflowFresh(WF)).def!);
    const b1 = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, {
      baseRevision: rev, mode: 'append', plannedOps: 3, followUps: ['Test with a 95-score lead', '', 'Who approves?'],
      ops: [{ kind: 'addNode', ref: 'n', typeId: 'core.noop', name: 'Nurture', why: 'Low scores get a slower path.' }],
    }, scopeFor(EDITOR_SUBJECT, 'sess-append'));
    expect(b1.isError, JSON.stringify(b1.json)).toBe(false);
    const minted = b1.json.ops[0].nodeId as string;
    expect(minted).toMatch(/^sg_/);
    const b2 = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, {
      baseRevision: rev, mode: 'append',
      ops: [
        { kind: 'addEdge', source: 'score', target: minted },
        { kind: 'setConfig', nodeId: minted, path: 'label', value: 'slow' },
      ],
    }, scopeFor(EDITOR_SUBJECT, 'sess-append'));
    expect(b2.isError, JSON.stringify(b2.json)).toBe(false);
    expect(b2.json.mode).toBe('append');
    expect(b2.json.ops.map((o: { index: number }) => o.index)).toEqual([1, 2]);
    expect(b2.json.ops[0].dependsOn).toEqual([0]);
    expect(b2.json.ops[1].dependsOn).toEqual([0]);
    const { readSuggestionFor } = await import('../src/features/builder-pair/pairService.js');
    const s = await readSuggestionFor({ tenantId: TENANT, actingUserId: EDITOR_SUBJECT, granted: new Set(['workspace:read']) }, 'sess-append');
    expect(s?.ops).toHaveLength(3);
    expect(s?.plannedOps).toBe(3);
    expect(s?.followUps).toEqual(['Test with a 95-score lead', 'Who approves?']);
    expect(s?.ops[0]?.why).toBe('Low scores get a slower path.');
    expect(new Set(s?.ops.filter((o) => o.op.kind === 'addNode').map((o) => (o.op as { nodeId: string }).nodeId)).size).toBe(1);
  });

  it('draws a template onto an EMPTY draft as a ghost suggestion — never registered — and refuses one that needs inputs', async () => {
    const { listChains } = await import('../src/host/workflowChainPackLoader.js');
    const chains = listChains();
    const simple = chains.find((c) => !c.chain.subChains?.length && !((c.chain.parameters as { required?: unknown[] }).required?.length) && c.chain.dag.nodes.length > 0);
    expect(simple, 'the test pack set has at least one input-free, single-level chain').toBeDefined();
    const { suggestFromChain } = await import('../src/features/builder-pair/pairService.js');
    const who = { tenantId: TENANT, actingUserId: EDITOR_SUBJECT, granted: new Set(['workspace:read', 'workspace:write'] as const) };
    const out = await suggestFromChain(who, { conversationId: 'sess-chain', workflowId: 'wf.adr0773.chain-draft', chainId: simple!.chain.chainId });
    expect('refused' in out, JSON.stringify(out)).toBe(false);
    expect((await readRegisteredWorkflowFresh('wf.adr0773.chain-draft')).def, 'drawn, not registered').toBeNull();
    const needsInputs = chains.find((c) => !c.chain.subChains?.length && ((c.chain.parameters as { required?: unknown[] }).required?.length ?? 0) > 0);
    if (needsInputs) {
      const refused = await suggestFromChain(who, { conversationId: 'sess-chain2', workflowId: 'wf.adr0773.chain-draft2', chainId: needsInputs.chain.chainId });
      expect('refused' in refused && refused.code).toBe('validation_error');
    }
    // A non-empty workflow is refused (a template never overwrites a canvas).
    const onFull = await suggestFromChain(who, { conversationId: 'sess-chain3', workflowId: WF, chainId: simple!.chain.chainId });
    expect('refused' in onFull && onFull.code).toBe('validation_error');
  });

  it('the meta-workflow NODE lane is create-only: an overwrite without the read revision is refused (G-10c, WBWF-17)', async () => {
    const { buildWorkflowAuthorSurface } = await import('../src/features/workflow-author/surface.js');
    const surface = buildWorkflowAuthorSurface({ tenantId: TENANT, actingUserId: EDITOR_SUBJECT } as never);
    const id = 'wf.adr0773.node-lane';
    const def = { workflowId: id, nodes: [{ nodeId: 'a', typeId: 'core.noop' }], edges: [] };
    await surface.persistDraft?.({ definition: def });
    await expect(surface.persistDraft?.({ definition: def })).rejects.toMatchObject({ details: { reason: 'base_revision_required' } });
    const ok = await surface.persistDraft?.({ definition: def, baseRevision: revisionHashOf((await readRegisteredWorkflowFresh(id)).def!) } as never);
    expect((ok as { workflowId: string }).workflowId).toBe(id);
  });
});

describe('ADR 0773 B.2 — a paired conversation is offered only the Pair tools', () => {
  it('PUT /context records PAIR_TOOL_SCOPE as the conversation\'s capability scope (by the chat session id)', async () => {
    const r = await call('PUT', host('/builder-pair/context'), { key: EDITOR, body: { conversationId: 'sess-b2', workflowId: WF } });
    expect(r.status).toBe(200);
    expect((await getConversationMeta(TENANT, 'sess-b2'))?.capabilityScope).toEqual({ mode: 'restricted', enabled: [...PAIR_TOOL_SCOPE] });
  });

  it('NARROWS an existing scope, never widens it (a user who turned off draft keeps it off)', async () => {
    await setConversationCapabilityScope(TENANT, 'sess-b2-narrow', {
      mode: 'restricted', enabled: ['openwop:feature.builder-pair.nodes.read-canvas', 'openwop:feature.builder-pair.nodes.suggest-edits', 'openwop:kanban.add-todo'],
    });
    await pair(EDITOR_SUBJECT, 'sess-b2-narrow');
    const scope = (await getConversationMeta(TENANT, 'sess-b2-narrow'))?.capabilityScope;
    expect(scope?.enabled?.sort()).toEqual(['openwop:feature.builder-pair.nodes.read-canvas', 'openwop:feature.builder-pair.nodes.suggest-edits']);
  });

  it('every PAIR_TOOL_SCOPE id is a registered tool AND on the Workflow Architect\'s allowlist (or the scope silently offers nothing)', () => {
    const pack = JSON.parse(readFileSync(new URL('../../../packs/vendor.openwop-app.workflow-author.agents/pack.json', import.meta.url), 'utf8')) as {
      agents: Array<{ agentId: string; toolAllowlist: string[] }>;
    };
    const architect = pack.agents.find((a) => a.agentId.endsWith('workflow-architect'));
    expect(architect).toBeDefined();
    for (const id of PAIR_TOOL_SCOPE) {
      expect(architect!.toolAllowlist, id).toContain(id);
      expect(builtinAgentTool(id), id).toBeDefined();
    }
  });
});

describe('ADR 0773 B.6 — a first draft must say how many ops it plans', () => {
  it('refuses a first batch on an EMPTY canvas without plannedOps (typed, repairable), and accepts it with plannedOps', async () => {
    const empty = 'wf.adr0773.first-draft';
    const ctx = await writePairContext(storage, { tenantId: TENANT, actingUserId: EDITOR_SUBJECT }, { conversationId: 'sess-first', workflowId: empty });
    expect('refused' in ctx, JSON.stringify(ctx)).toBe(false);
    const canvas = await tool(BUILDER_PAIR_READ_CANVAS_TOOL_ID, {}, scopeFor(EDITOR_SUBJECT, 'sess-first', 'run-first'));
    const rev = canvas.json.revision as string;
    const op = { kind: 'addNode', ref: 't', typeId: 'core.noop', name: 'Start', why: 'Entry point.' };
    const bare = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, { baseRevision: rev, mode: 'append', ops: [op] }, scopeFor(EDITOR_SUBJECT, 'sess-first', 'run-first'));
    expect(bare.isError).toBe(true);
    expect(bare.json.error).toBe('invalid_ops');
    expect(JSON.stringify(bare.json)).toMatch(/plannedOps/);
    const ok = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, { baseRevision: rev, mode: 'append', plannedOps: 3, ops: [op] }, scopeFor(EDITOR_SUBJECT, 'sess-first', 'run-first'));
    expect(ok.isError, JSON.stringify(ok.json)).toBe(false);
    // The SECOND batch appends to the first and needs no plannedOps again.
    const next = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, {
      baseRevision: rev, mode: 'append', ops: [{ kind: 'addNode', ref: 'u', typeId: 'core.noop', name: 'Then', why: 'Second step.' }],
    }, scopeFor(EDITOR_SUBJECT, 'sess-first', 'run-first'));
    expect(next.isError, JSON.stringify(next.json)).toBe(false);
  });

  it('a change to a NON-empty workflow needs no plannedOps (only first drafts do)', async () => {
    await pair(EDITOR_SUBJECT, 'sess-nonempty');
    const rev = revisionHashOf((await readRegisteredWorkflowFresh(WF)).def!);
    const r = await tool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID, {
      baseRevision: rev, ops: [{ kind: 'setConfig', nodeId: 'score', path: 'threshold', value: 70, why: 'Stricter.' }],
    }, scopeFor(EDITOR_SUBJECT, 'sess-nonempty'));
    expect(r.isError, JSON.stringify(r.json)).toBe(false);
  });
});

describe('ADR 0773 B.7 — suggest-edits reports an unfinished plan to the chat loop', () => {
  it('arms continueTurn while drawn < plannedOps, and clears it (null) once the plan is drawn', async () => {
    await pair(EDITOR_SUBJECT, 'sess-plan');
    const rev = revisionHashOf((await readRegisteredWorkflowFresh(WF)).def!);
    const t = builtinAgentTool(BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID)!;
    const first = await t.run({
      baseRevision: rev, mode: 'append', plannedOps: 2,
      ops: [{ kind: 'addNode', ref: 'a', typeId: 'core.noop', name: 'Tag', why: 'Tag duplicates.' }],
    }, scopeFor(EDITOR_SUBJECT, 'sess-plan')) as { content: string; continueTurn?: string | null };
    expect(JSON.parse(first.content)).toMatchObject({ drawn: 1, planned: 2 });
    expect(first.continueTurn).toMatch(/planned 2 ops and have drawn 1/);
    const second = await t.run({
      baseRevision: rev, mode: 'append',
      ops: [{ kind: 'renameNode', nodeId: 'crm', name: 'Write lead to CRM', why: 'Clearer name.' }],
    }, scopeFor(EDITOR_SUBJECT, 'sess-plan')) as { content: string; continueTurn?: string | null };
    expect(JSON.parse(second.content)).toMatchObject({ drawn: 2, planned: 2 });
    expect(second.continueTurn).toBeNull();
  });
});
