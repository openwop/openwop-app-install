/**
 * ADR 0822 — the AI Workflow Author's write lanes carry the SAME authority the
 * builder's REST lane does (ADR 0770 D1 / ADR 0794). Route-level where the lane
 * is a route (createApp + real principals); tool-level through the real
 * registered tool where the lane is a chat tool.
 *
 *   - D1: a VIEWER member cannot write a workflow through the Workflow Architect's
 *     `persist` tool, nor through the meta-workflow's `persistDraft` surface; an
 *     editor can.
 *   - D2: `POST …/workflow-author/draft` starts a billed, workflow-writing run, so
 *     it needs `runs:create` AND `workspace:write` — a viewer is refused before
 *     any run exists.
 *   - D3: the author lane never CREATES a server-minted id (`wf.sub.*`,
 *     `wf.cadence.*`, `wf.copy.*`, `wf.fork.*`, `wf.seed.*`). `sub`/`cadence` ids
 *     are derived from a tenant id, so a free one is pre-squattable by any other
 *     tenant — the hole ADR 0794 closed on the REST lane and left open here.
 *
 * Sabotage-witnessed (grade-tests w18, probes `w18g1-a-*`): removing the gate
 * from the Architect's persist tool, from `persistDraft`, or from compose-and-run;
 * either of the draft route's two scope checks (`workspace:write` reds the Viewer
 * case; `runs:create` reds the write-only-key case); the
 * operator-key branch or its tenant binding; the personal-tenant stamp, its
 * own-tenant comparison, or the executor's threading of it; the deterministic /
 * server-minted id refusals on either door; the D4 diff (position-blind nodes,
 * hash-decided `unchanged`, `inHistory`, create-carries-nothing); the D5
 * approval eligibility; or gating `propose` — each turns a case red.
 * CEILING: "a run with no acting user is refused" is double-guarded
 * (`hasWorkflowScope`'s own check AND `assertTenantScope`'s `!subject` refusal),
 * so no single sabotage of the posture can turn it red; it is kept as the
 * posture's statement and asserts nothing was written. Likewise there is no
 * "runs-only key" case: `keyVendorGate` refuses every vendor POST from a key
 * that does not declare `workspace:write` BEFORE the route runs, so the route's
 * own `workspace:write` check can never be the one that refuses such a key
 * (w18 reprobe a-d2-write-gate left that case green).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import type { NodeContext, NodeOutcome, WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { getRegisteredWorkflowAsync } from '../src/host/workflowsRegistry.js';
import { getOwned } from '../src/host/workflowOwnership.js';
import { subWorkflowId, cadenceWorkflowId } from '../src/host/workflowId.js';
import { buildWorkflowAuthorSurface } from '../src/features/workflow-author/surface.js';
import { WORKFLOW_AUTHOR_GET_TOOL_ID, WORKFLOW_AUTHOR_PERSIST_TOOL_ID } from '../src/features/workflow-author/agentTools.js';
import { COMPOSE_AND_RUN_TOOL_ID, PROPOSE_TOOL_ID } from '../src/host/workflowComposeTool.js';

const TENANT = 'tenant-0822';
const VICTIM = 'tenant-0822-victim';
const TENANT_ENV_KEY = 'tenv0822-tenant-operator-key';
const EDITOR_SUBJECT = 'user:editor-0822';
const VIEWER_SUBJECT = 'user:viewer-0822';
let EDITOR = '';
let VIEWER = '';
/** ADR 0822 D2 — an editor-issued key DECLARING `workspace:write` but not
 *  `runs:create`: the only principal on which the route's `runs:create` check
 *  decides alone (a Viewer is refused by `workspace:write` first, and in the
 *  default posture `runs:create` narrows only `owk_` keys). */
let WRITE_ONLY = '';
const saved: Record<string, string | undefined> = {};
let BASE = '';
let server: http.Server;

async function call(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? TENANT_ENV_KEY}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
const host = (p: string) => `/host/openwop-app${p}`;

const noop = (workflowId: string): WorkflowDefinition => ({
  workflowId,
  nodes: [{ nodeId: 'n1', typeId: 'core.noop', outputRole: 'primary' }],
});
/** The run-scoped surface a meta-workflow node sees, built on a typed scope. */
const surfaceFor = (scope: BundleScope) => buildWorkflowAuthorSurface(scope);
/** Loose read of a JSON tool/route body — no `any`. */
type Body = Record<string, unknown>;

async function toolAs(name: string, scope: { tenantId?: string; actingUserId?: string; personalTenant?: string }, input: Record<string, unknown>) {
  const { executeTool } = createAgentToolProvider({ tenantId: scope.tenantId ?? TENANT, runId: 'r-0822', ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}), ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}) });
  const out = await executeTool({ name, input });
  return { isError: out.isError === true, body: JSON.parse(out.content) as Body };
}
const persistAs = (actingUserId: string, definition: unknown, extra: Record<string, unknown> = {}) =>
  toolAs(WORKFLOW_AUTHOR_PERSIST_TOOL_ID, { actingUserId }, { definition, ...extra });

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
  WRITE_ONLY = (await issueApiKey({ tenantId: TENANT, name: 'write-only', createdBy: EDITOR_SUBJECT, scopes: ['workspace:write'] })).token;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0822 D1 — the Architect\'s persist tool needs workspace:write', () => {
  it('refuses a viewer with forbidden_scope and writes nothing', async () => {
    const id = 'wf.adr0822.viewer-tool';
    const out = await persistAs(VIEWER_SUBJECT, noop(id));
    expect(out.isError).toBe(true);
    expect(out.body.error).toBe('forbidden_scope');
    expect(await getRegisteredWorkflowAsync(id)).toBeNull();
    expect(await getOwned(TENANT, id)).toBeNull();
  });

  it('lets an editor write (the refusal is the role, not the lane)', async () => {
    const id = 'wf.adr0822.editor-tool';
    const out = await persistAs(EDITOR_SUBJECT, noop(id));
    expect(out.isError).toBe(false);
    expect(out.body.workflowId).toBe(id);
    expect(await getOwned(TENANT, id)).not.toBeNull();
  });
});

describe('ADR 0822 D1 — the meta-workflow persistDraft surface needs workspace:write', () => {
  it('refuses a run acting for a viewer', async () => {
    const id = 'wf.adr0822.viewer-surface';
    const surface = surfaceFor({ tenantId: TENANT, actingUserId: VIEWER_SUBJECT });
    await expect(surface.persistDraft({ definition: noop(id) }))
      .rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(await getRegisteredWorkflowAsync(id)).toBeNull();
  });

  it('lets a run acting for an editor write', async () => {
    const id = 'wf.adr0822.editor-surface';
    const surface = surfaceFor({ tenantId: TENANT, actingUserId: EDITOR_SUBJECT });
    await expect(surface.persistDraft({ definition: noop(id) }))
      .resolves.toMatchObject({ workflowId: id });
  });
});

describe('ADR 0822 D2 — POST workflow-author/draft needs runs:create + workspace:write', () => {
  it('refuses a viewer before any run exists', async () => {
    const r = await call('POST', host('/workflow-author/draft'), { key: VIEWER, body: { intent: 'email me every morning' } });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('forbidden_scope');
    expect(r.json.runId).toBeUndefined();
  });

  it('refuses a key that may write the workspace but not create runs', async () => {
    const r = await call('POST', host('/workflow-author/draft'), { key: WRITE_ONLY, body: { intent: 'email me every morning' } });
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(r.json.runId).toBeUndefined();
  });

  it('admits an editor (201 + a runId)', async () => {
    const r = await call('POST', host('/workflow-author/draft'), { key: EDITOR, body: { intent: 'email me every morning' } });
    expect(r.status).toBe(201);
    expect(typeof r.json.runId).toBe('string');
  });
});

describe('ADR 0822 D3 — the author lane never creates a server-minted id', () => {
  const squats = (): Array<[string, string]> => [
    ['sub (derived from the VICTIM tenant id)', subWorkflowId(VICTIM, 'example.child', '1.0.0')],
    ['cadence (derived from the VICTIM tenant id)', cadenceWorkflowId(VICTIM, 'example.chain')],
    ['copy', 'wf.copy.example.0123456789abcdef'],
    ['fork', 'wf.fork.example.0123456789abcdef'],
  ];
  for (const [label, _] of squats()) {
    it(`refuses ${label}`, async () => {
      const id = squats().find(([l]) => l === label)![1];
      const out = await persistAs(EDITOR_SUBJECT, noop(id));
      expect(out.isError).toBe(true);
      expect(out.body.reason).toBe(/^(sub|cadence)/.test(label) ? 'deterministic_workflow_id' : 'server_minted_workflow_id');
      expect(await getRegisteredWorkflowAsync(id)).toBeNull();
      expect(await getOwned(TENANT, id)).toBeNull();
    });
  }
});

describe('ADR 0822 D1 — the predicate judges the actor by provenance (no legitimate lane locked out)', () => {
  it('an operator env key\'s run actor (`bearer:<8>`) persists through the surface', async () => {
    const id = 'wf.adr0822.env-key-surface';
    const surface = surfaceFor({ tenantId: TENANT, actingUserId: `bearer:${TENANT_ENV_KEY.slice(0, 8)}` });
    await expect(surface.persistDraft({ definition: noop(id) }))
      .resolves.toMatchObject({ workflowId: id });
  });

  it('a configured key is nobody in a tenant it is NOT bound to (grade-code WFAC-17)', async () => {
    const surface = surfaceFor({ tenantId: VICTIM, actingUserId: `bearer:${TENANT_ENV_KEY.slice(0, 8)}` });
    await expect(surface.persistDraft({ definition: noop('wf.adr0822.key-wrong-tenant') }))
      .rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(await getRegisteredWorkflowAsync('wf.adr0822.key-wrong-tenant')).toBeNull();
  });

  it('an unconfigured `bearer:` actor is nobody', async () => {
    const surface = surfaceFor({ tenantId: TENANT, actingUserId: 'bearer:notakey0' });
    await expect(surface.persistDraft({ definition: noop('wf.adr0822.stale-key') }))
      .rejects.toMatchObject({ code: 'forbidden_scope' });
  });

  it('a solo user persists in their OWN personal workspace (request-stamped personalTenant), in-run and in chat', async () => {
    const solo = 'user:solo0822hash';
    const surface = surfaceFor({ tenantId: solo, actingUserId: 'user:solo-0822', personalTenant: solo });
    await expect(surface.persistDraft({ definition: noop('wf.adr0822.solo-surface') }))
      .resolves.toMatchObject({ workflowId: 'wf.adr0822.solo-surface' });
    const chat = await toolAs(WORKFLOW_AUTHOR_PERSIST_TOOL_ID, { tenantId: solo, actingUserId: 'user:solo-0822', personalTenant: solo }, { definition: noop('wf.adr0822.solo-chat') });
    expect(chat.isError).toBe(false);
    expect(await getOwned(solo, 'wf.adr0822.solo-chat')).not.toBeNull();
  });

  it('an anon session persists in its own anon: sandbox, and not in a workspace it merely names', async () => {
    const own = await toolAs(WORKFLOW_AUTHOR_PERSIST_TOOL_ID, { tenantId: 'anon:sid0822', actingUserId: 'session:sid0822', personalTenant: 'anon:sid0822' }, { definition: noop('wf.adr0822.anon') });
    expect(own.isError).toBe(false);
    expect(await getOwned('anon:sid0822', 'wf.adr0822.anon')).not.toBeNull();
    const foreign = await toolAs(WORKFLOW_AUTHOR_PERSIST_TOOL_ID, { tenantId: TENANT, actingUserId: 'session:sid0822', personalTenant: 'anon:sid0822' }, { definition: noop('wf.adr0822.anon-foreign') });
    expect(foreign.body.error).toBe('forbidden_scope');
  });

  it('a personal-SHAPED tenant is not enough: the stamp must be the actor\'s own', async () => {
    const surface = surfaceFor({ tenantId: 'user:someone-else', actingUserId: 'user:solo-0822', personalTenant: 'user:solo0822hash' });
    await expect(surface.persistDraft({ definition: noop('wf.adr0822.not-mine') }))
      .rejects.toMatchObject({ code: 'forbidden_scope' });
  });

  it('a run with no acting user is refused (the ADR 0775 D7 posture)', async () => {
    const surface = surfaceFor({ tenantId: TENANT });
    await expect(surface.persistDraft({ definition: noop('wf.adr0822.actorless') }))
      .rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(await getRegisteredWorkflowAsync('wf.adr0822.actorless')).toBeNull();
  });
});

describe('ADR 0822 D1 (architect B1) — the compose doors', () => {
  it('compose-and-run: a viewer behind the turn is refused before anything is registered', async () => {
    const id = 'wf.adr0822.viewer-compose';
    const out = await toolAs(COMPOSE_AND_RUN_TOOL_ID, { actingUserId: VIEWER_SUBJECT }, { definition: noop(id) });
    expect(out.isError).toBe(true);
    expect(out.body.error).toBe('forbidden_scope');
    expect(await getRegisteredWorkflowAsync(id)).toBeNull();
  });

  it('compose-and-run: an editor passes the gate, and the headless (no person) lane is unchanged', async () => {
    const editor = await toolAs(COMPOSE_AND_RUN_TOOL_ID, { actingUserId: EDITOR_SUBJECT }, { definition: noop('wf.adr0822.editor-compose'), dryRun: true });
    expect(editor.body.valid).toBe(true);
    const headless = await toolAs(COMPOSE_AND_RUN_TOOL_ID, {}, { definition: noop('wf.adr0822.headless-compose'), dryRun: true });
    expect(headless.body.valid).toBe(true);
  });

  it('propose stays open to a viewer: a proposal is a REQUEST an approver must decide (ADR 0473)', async () => {
    const out = await toolAs(PROPOSE_TOOL_ID, { actingUserId: VIEWER_SUBJECT }, { definition: noop('wf.adr0822.viewer-propose'), summary: 's', dryRun: true });
    expect(out.isError, JSON.stringify(out.body)).toBe(false);
    expect(out.body.valid).toBe(true);
  });

  for (const tool of [PROPOSE_TOOL_ID, COMPOSE_AND_RUN_TOOL_ID]) {
    it(`${tool}: never composes a server-minted id`, async () => {
      const id = subWorkflowId(VICTIM, 'example.child', '2.0.0');
      const out = await toolAs(tool, { actingUserId: EDITOR_SUBJECT }, { definition: noop(id), summary: 's', dryRun: true });
      expect(out.isError).toBe(true);
      expect(String(out.body.message)).toMatch(/only the host mints/);
    });
  }
});

describe('ADR 0822 D3 — owned random origins stay editable; owned deterministic ones do not', () => {
  it('an owner may still revise its own wf.copy.* through the Architect', async () => {
    const { recordOwnership } = await import('../src/host/workflowOwnership.js');
    const { registerWorkflowDurable } = await import('../src/host/workflowsRegistry.js');
    const id = 'wf.copy.example.00000000000c0822';
    await registerWorkflowDurable(noop(id));
    await recordOwnership(TENANT, id, { nodeCount: 1 });
    const got = await toolAs(WORKFLOW_AUTHOR_GET_TOOL_ID, { actingUserId: EDITOR_SUBJECT }, { workflowId: id });
    const out = await persistAs(EDITOR_SUBJECT, { ...noop(id), metadata: { name: 'renamed' } }, { baseRevision: got.body.revision });
    expect(out.isError).toBe(false);
  });

  it('an OWNED wf.sub.* id is still refused (a pre-guard squat survives as co-ownership)', async () => {
    const { recordOwnership } = await import('../src/host/workflowOwnership.js');
    const { registerWorkflowDurable } = await import('../src/host/workflowsRegistry.js');
    const id = subWorkflowId(TENANT, 'example.owned', '1.0.0');
    await registerWorkflowDurable(noop(id));
    await recordOwnership(TENANT, id, { nodeCount: 1 });
    const out = await persistAs(EDITOR_SUBJECT, noop(id));
    expect(out.body.reason).toBe('deterministic_workflow_id');
  });
});

describe('ADR 0822 D4 — persist says what an overwrite changed', () => {
  it('a create carries no overwrite fields', async () => {
    const out = await persistAs(EDITOR_SUBJECT, noop('wf.adr0822.d4-create'));
    expect(out.isError).toBe(false);
    expect(out.body.changes).toBeUndefined();
    expect(out.body.previousRevision).toBeUndefined();
  });

  it('an overwrite reports added / removed / edited steps and wires, and that History holds the old one', async () => {
    const id = 'wf.adr0822.d4-edit';
    const v1 = {
      workflowId: id,
      nodes: [
        { nodeId: 'a', typeId: 'core.noop' },
        { nodeId: 'b', typeId: 'core.noop' },
        { nodeId: 'c', typeId: 'core.noop', position: { x: 1, y: 1 } },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b' }],
    };
    expect((await persistAs(EDITOR_SUBJECT, v1)).isError).toBe(false);
    const got = await toolAs(WORKFLOW_AUTHOR_GET_TOOL_ID, { actingUserId: EDITOR_SUBJECT }, { workflowId: id });
    const v2 = {
      workflowId: id,
      nodes: [
        { nodeId: 'a', typeId: 'core.noop', name: 'Renamed' }, // edited
        { nodeId: 'c', typeId: 'core.noop', position: { x: 500, y: 9 } }, // only moved: NOT a change
        { nodeId: 'd', typeId: 'core.noop' }, // added
      ],
      edges: [{ edgeId: 'e9', sourceNodeId: 'a', targetNodeId: 'd' }],
    };
    const out = await persistAs(EDITOR_SUBJECT, v2, { baseRevision: got.body.revision });
    expect(out.isError, JSON.stringify(out.body)).toBe(false);
    expect(out.body.previousRevision).toBe(got.body.revision);
    expect(out.body.unchanged).toBe(false);
    expect(out.body.changes).toEqual({
      nodesAdded: [{ nodeId: 'd', label: 'core.noop' }],
      nodesRemoved: [{ nodeId: 'b', label: 'core.noop' }],
      nodesChanged: [{ nodeId: 'a', label: 'Renamed' }],
      edgesAdded: 1,
      edgesRemoved: 1,
      workflowFieldsChanged: [],
    });
    expect(out.body.inHistory).toBe(true);
    expect(String(out.body.note)).toMatch(/History/);
  });

  it('a rename-only overwrite is a change (grade-code WFAC-18), and an identical one says so', async () => {
    const id = 'wf.adr0822.d4-rename';
    const base = { workflowId: id, metadata: { name: 'Before' }, nodes: [{ nodeId: 'a', typeId: 'core.noop' }] };
    expect((await persistAs(EDITOR_SUBJECT, base)).isError).toBe(false);
    const r1 = await toolAs(WORKFLOW_AUTHOR_GET_TOOL_ID, { actingUserId: EDITOR_SUBJECT }, { workflowId: id });
    const renamed = await persistAs(EDITOR_SUBJECT, { ...base, metadata: { name: 'After' } }, { baseRevision: r1.body.revision });
    expect(renamed.isError, JSON.stringify(renamed.body)).toBe(false);
    expect(renamed.body.unchanged).toBe(false);
    expect(renamed.body.changes).toMatchObject({ workflowFieldsChanged: ['metadata.name'] });
    expect(String(renamed.body.note)).not.toMatch(/Nothing changed/);
    const r2 = await toolAs(WORKFLOW_AUTHOR_GET_TOOL_ID, { actingUserId: EDITOR_SUBJECT }, { workflowId: id });
    const same = await persistAs(EDITOR_SUBJECT, { ...base, metadata: { name: 'After' } }, { baseRevision: r2.body.revision });
    expect(same.body.unchanged).toBe(true);
    expect(String(same.body.note)).toMatch(/Nothing changed/);
  });
});

describe('ADR 0822 D1 — the executor threads the REQUEST-stamped personalTenant into the in-run surface', () => {
  let inRunSeq = 0;
  async function runPersistInRun(metadata: Record<string, unknown>, tenantId: string, id: string) {
    const { openStorage } = await import('../src/storage/index.js');
    const { executeRun } = await import('../src/executor/executor.js');
    const { getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
    const typeId = 'test.adr0822.persist-via-surface';
    getNodeRegistry().register({
      typeId,
      version: '1.0.0',
      async execute(ctx: NodeContext): Promise<NodeOutcome> {
        const surface = ctx.features?.['workflow-author'];
        if (!surface?.persistDraft) return { status: 'failure', error: { code: 'no_surface', message: 'workflow-author surface missing' } };
        try {
          const out = await surface.persistDraft({ definition: (ctx.inputs as { definition?: unknown }).definition });
          return { status: 'success', outputs: out };
        } catch (e: unknown) {
          const code = typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'x';
          return { status: 'failure', error: { code, message: String((e as Error).message) } };
        }
      },
    });
    const storage = await openStorage('memory://');
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-0822-${++inRunSeq}`,
      workflowId: 'wf.test.adr0822.inrun', tenantId, status: 'pending',
      inputs: { definition: noop(id) }, metadata, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);
    return executeRun(storage, run, { workflowId: 'wf.test.adr0822.inrun', nodes: [{ nodeId: 'p', typeId }] },
      { policyResolver: { async resolveForRun() { return []; } } });
  }

  it('a solo user\'s run in their own personal workspace persists (the stamp reached the surface)', async () => {
    const solo = 'user:soloinrun0822';
    const result = await runPersistInRun({ actingUserId: 'user:solo-inrun', personalTenant: solo }, solo, 'wf.adr0822.inrun-solo');
    expect(result.status).toBe('completed');
    expect(await getOwned(solo, 'wf.adr0822.inrun-solo')).not.toBeNull();
  });

  it('without the stamp the same run is refused (the threading is what grants it)', async () => {
    const solo = 'user:soloinrun0822b';
    const result = await runPersistInRun({ actingUserId: 'user:solo-inrun' }, solo, 'wf.adr0822.inrun-nostamp');
    expect(result.status).toBe('failed');
    expect(await getRegisteredWorkflowAsync('wf.adr0822.inrun-nostamp')).toBeNull();
  });
});

describe('ADR 0822 D5 (grade-ux WFAU-23) — approving a composed-workflow proposal needs workspace:write', () => {
  async function propose(as: string, id: string): Promise<string> {
    const out = await toolAs(PROPOSE_TOOL_ID, { actingUserId: as }, { definition: noop(id), summary: 'probe' });
    expect(out.isError, JSON.stringify(out.body)).toBe(false);
    return String(out.body.approvalId);
  }

  it('a viewer cannot approve-and-run a proposal (not even their own)', async () => {
    const approvalId = await propose(VIEWER_SUBJECT, 'wf.adr0822.d5-viewer-own');
    const r = await call('POST', host(`/approvals/${encodeURIComponent(approvalId)}/claim`), { key: VIEWER, body: {} });
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(r.json.error).toBe('forbidden_scope');
  });

  it('an editor approves the same kind of proposal', async () => {
    const approvalId = await propose(VIEWER_SUBJECT, 'wf.adr0822.d5-editor');
    const r = await call('POST', host(`/approvals/${encodeURIComponent(approvalId)}/claim`), { key: EDITOR, body: {} });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.status).toBe('approved');
  });
});
