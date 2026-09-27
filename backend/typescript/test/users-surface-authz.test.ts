/**
 * ADR 0617 D2 — `ctx.features.users.{deactivate,reactivate}` authority, per
 * LANE (the `comments-surface-authz.test.ts` shape: no lane is assumed
 * unreachable), over the REAL app (`createApp` registers the ADR 0621 session
 * authority + the surface) with the host-event dispatcher re-pointed at FAKE
 * fanout deps so every emit is observable.
 *
 *   SYSTEM-RUN lane      → 403 `forbidden_scope` with a NAMED exit (no acting user);
 *   NON-MANAGER lane     → 403 (a seated editor without `host:members:manage`);
 *   DISABLED-ACTOR lane  → 403 (`acting_user_disabled` — SHOULD-10, the run
 *                          resumed after its actor was disabled);
 *   ERASED-ACTOR lane    → 403 (`acting_user_erased`);
 *   SELF lane            → 409 `self_lockout`;
 *   IDOR lanes           → 404 for a foreign-tenant or unknown target, 400 for none;
 *   MANAGER lane         → success: ONE `host.users.user.deactivated` with
 *                          `reason:'workflow'`, `origin:{runId,workflowId}` threaded
 *                          so the bound workflow is NOT restarted while another
 *                          bound workflow is; a repeat is silent (transition guard);
 *   PERSONAL-OWNER lane  → success in the owner's own `user:` tenant (implicit
 *                          owner — the ONLY shape that short-circuits membership).
 *
 * Plus the pack body's `userId` precedence (inputs → triggerData.payload →
 * config) and its typed refusal on an empty id.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import {
  createHostEventBinding,
  initHostEventDispatcher,
  __clearHostEventBindings,
  type HostEventEnvelope,
} from '../src/host/hostEventDispatcher.js';
import { createUser, getUser, sessionEpochOf, setUserStatus, deleteUser, type User } from '../src/features/users/usersService.js';
import { buildUsersSurface } from '../src/features/users/surface.js';
import { OpenwopError } from '../src/types.js';

const usersPack = await import(
  /* @vite-ignore */ new URL('../../../packs/feature.users.nodes/index.mjs', import.meta.url).href
) as { nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: Record<string, unknown> }>> };

let server: http.Server;
let app: Express;
let storage: Storage;
let WS = '';
let OTHER = '';
let admin: User;
let editor: User;
let foreign: User;

/** Definitions the fake catalog serves by id (a chain-expanded stamp lives here). */
const catalogDefs = new Map<string, WorkflowDefinition>();
let delivered: HostEventEnvelope[];
let startRunCalls: Array<{ tenantId: string; workflowId: string; metadata?: Record<string, unknown> }>;
const settle = () => new Promise((r) => setTimeout(r, 15));
const DEACTIVATED = 'host.users.user.deactivated';
const REACTIVATED = 'host.users.user.reactivated';
const ofType = (t: string) => delivered.filter((e) => e.type === t);

async function refuse(p: Promise<unknown>): Promise<OpenwopError> {
  try { await p; } catch (e) { if (e instanceof OpenwopError) return e; throw e; }
  throw new Error('expected a refusal, got success');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_DEMO_MODE;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });

  const ws = await createWorkspace({ name: 'ADR 0617 workspace', ownerSubject: 'oidc:u617-founder' });
  WS = ws.orgId ?? ws.tenantId;
  const other = await createWorkspace({ name: 'Elsewhere', ownerSubject: 'oidc:u617-other-founder' });
  OTHER = other.orgId ?? other.tenantId;

  admin = await createUser({ tenantId: WS, principalId: 'oidc:u617-admin', source: 'oidc' }, { silent: true });
  editor = await createUser({ tenantId: WS, principalId: 'oidc:u617-editor', source: 'oidc' }, { silent: true });
  foreign = await createUser({ tenantId: OTHER, principalId: 'oidc:u617-foreign', source: 'oidc' }, { silent: true });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: admin.userId, roles: ['admin'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: editor.userId, roles: ['editor'] });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

beforeEach(async () => {
  delivered = [];
  startRunCalls = [];
  await __clearHostEventBindings();
  const hostSuite: StartRunDeps['hostSuite'] = {
    workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: catalogDefs.get(id) ?? { workflowId: id, nodes: [] } }) },
    providerPolicyResolver: { resolveForRun: async () => [] },
  };
  initHostEventDispatcher({
    storage,
    hostSuite,
    deliverWebhooks: async (event) => { delivered.push(event); },
    startRun: async (_deps, input) => { startRunCalls.push(input); return `run:fake-${startRunCalls.length}`; },
  });
});

let n = 0;
async function target(tenantId = WS): Promise<User> {
  return createUser({ tenantId, principalId: `oidc:u617-target-${n++}`, source: 'manual' }, { silent: true });
}
/** A HUMAN-started run of workflow `wf:offboarding` in WS. */
const asUser = (actingUserId: string, tenantId = WS) =>
  buildUsersSurface({ tenantId, runId: 'run:617', workflowId: 'wf:offboarding', actingUserId });
/** A SYSTEM run (schedule / webhook / host-event-started): no principal. */
const asSystem = () => buildUsersSurface({ tenantId: WS, runId: 'run:sys', workflowId: 'wf:offboarding' });

describe('SYSTEM-RUN lane — fail-closed with a named exit', () => {
  it('no acting user → 403 forbidden_scope / no_acting_user; nothing written, nothing emitted', async () => {
    const t = await target();
    const err = await refuse(asSystem().deactivate({ userId: t.userId }));
    expect(err.httpStatus).toBe(403);
    expect(err.code).toBe('forbidden_scope');
    expect((err.details as { reason?: string }).reason).toBe('no_acting_user');
    expect(err.message).toMatch(/human-initiated context/);
    expect((await getUser(t.userId))!.status).toBe('active');
    await settle();
    expect(delivered).toEqual([]);
  });
});

describe('NON-MANAGER / DISABLED / ERASED actor lanes', () => {
  it('a seated EDITOR (no host:members:manage) → 403; target untouched', async () => {
    const t = await target();
    const err = await refuse(asUser(editor.userId).deactivate({ userId: t.userId }));
    expect(err.httpStatus).toBe(403);
    expect(err.code).toBe('forbidden_scope');
    expect((await getUser(t.userId))!.status).toBe('active');
    await settle();
    expect(delivered).toEqual([]);
  });

  it('a DISABLED admin (run resumed after its actor was disabled) → 403 acting_user_disabled', async () => {
    const t = await target();
    const stale = await createUser({ tenantId: WS, principalId: 'oidc:u617-stale-admin', source: 'oidc' }, { silent: true });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Stale', subject: stale.userId, roles: ['admin'] });
    await setUserStatus(stale.userId, 'disabled', { reason: 'admin' });
    delivered = [];
    const err = await refuse(asUser(stale.userId).deactivate({ userId: t.userId }));
    expect(err.httpStatus).toBe(403);
    expect((err.details as { reason?: string }).reason).toBe('acting_user_disabled');
    expect((await getUser(t.userId))!.status).toBe('active');
  });

  it('an ERASED acting user (row gone) → 403 acting_user_erased', async () => {
    const t = await target();
    const gone = await createUser({ tenantId: WS, principalId: 'oidc:u617-gone-admin', source: 'oidc' }, { silent: true });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Gone', subject: gone.userId, roles: ['admin'] });
    await deleteUser(gone.userId);
    const err = await refuse(asUser(gone.userId).deactivate({ userId: t.userId }));
    expect(err.httpStatus).toBe(403);
    expect((err.details as { reason?: string }).reason).toBe('acting_user_erased');
  });
});

describe('SELF + IDOR lanes', () => {
  it('an admin cannot deactivate their OWN row from a workflow → 409 self_lockout', async () => {
    const err = await refuse(asUser(admin.userId).deactivate({ userId: admin.userId }));
    expect(err.httpStatus).toBe(409);
    expect(err.code).toBe('self_lockout');
    expect((await getUser(admin.userId))!.status).toBe('active');
  });

  it('a foreign-tenant target and an unknown target are a uniform 404; a missing userId is 400', async () => {
    const s = asUser(admin.userId);
    expect((await refuse(s.deactivate({ userId: foreign.userId }))).httpStatus).toBe(404);
    expect((await refuse(s.deactivate({ userId: 'user:does-not-exist' }))).httpStatus).toBe(404);
    expect((await refuse(s.deactivate({}))).httpStatus).toBe(400);
    expect((await getUser(foreign.userId))!.status).toBe('active');
    await settle();
    expect(delivered).toEqual([]);
  });
});

describe('MANAGER lane — success, ONE event with reason:workflow + origin, self-trigger guard, transition guard', () => {
  it('deactivate: status → disabled, epoch bumped, exactly one deactivated event; the executing workflow is NOT restarted, another bound workflow IS', async () => {
    const t = await target();
    await createHostEventBinding({ tenantId: WS, eventType: DEACTIVATED, workflowId: 'wf:offboarding', createdBy: 'test' });
    await createHostEventBinding({ tenantId: WS, eventType: DEACTIVATED, workflowId: 'wf:security-audit', createdBy: 'test' });

    const out = await asUser(admin.userId).deactivate({ userId: t.userId });
    expect(out).toEqual({ userId: t.userId, status: 'disabled' });
    const row = (await getUser(t.userId))!;
    expect(row.status).toBe('disabled');
    expect(sessionEpochOf(row)).toBe(1);
    await settle();
    const evs = ofType(DEACTIVATED);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({ userId: t.userId, tenantId: WS, source: 'manual', reason: 'workflow' });
    expect('origin' in evs[0]!).toBe(false); // never a wire field
    // D1a: the run's own workflow is skipped; the other binding still starts.
    expect(startRunCalls.map((c) => c.workflowId)).toEqual(['wf:security-audit']);

    // Repeat from a workflow — success (idempotent), but NO second event / run.
    const again = await asUser(admin.userId).deactivate({ userId: t.userId });
    expect(again.status).toBe('disabled');
    await settle();
    expect(ofType(DEACTIVATED)).toHaveLength(1);
    expect(startRunCalls).toHaveLength(1);
  });

  it('review BLOCKER-1: the surface stamps origin.chainId from the scope, so a SIBLING from-chain instance of the same chain is not started either', async () => {
    const t = await target();
    // `wf:sibling` was expanded from the same chain as the executing run (the
    // fake catalog serves the stamp); `wf:security-audit` is authored.
    catalogDefs.set('wf:sibling', { workflowId: 'wf:sibling', nodes: [], metadata: { expandedFrom: { chainId: 'people-hr.offboarding' } } });
    await createHostEventBinding({ tenantId: WS, eventType: DEACTIVATED, workflowId: 'wf:sibling', createdBy: 'test' });
    await createHostEventBinding({ tenantId: WS, eventType: DEACTIVATED, workflowId: 'wf:security-audit', createdBy: 'test' });
    const surface = buildUsersSurface({ tenantId: WS, runId: 'run:617', workflowId: 'people-hr.offboarding:deadbeef0001', chainId: 'people-hr.offboarding', actingUserId: admin.userId });
    const out = await surface.deactivate({ userId: t.userId });
    expect(out.status).toBe('disabled');
    await settle();
    expect(ofType(DEACTIVATED)).toHaveLength(1);
    expect(startRunCalls.map((c) => c.workflowId)).toEqual(['wf:security-audit']);
    catalogDefs.clear();
  });

  it('reactivate: status → active, exactly one reactivated event with reason:workflow; a repeat is silent', async () => {
    const t = await target();
    await setUserStatus(t.userId, 'disabled', { reason: 'admin' });
    delivered = [];
    const out = await asUser(admin.userId).reactivate({ userId: t.userId });
    expect(out).toEqual({ userId: t.userId, status: 'active' });
    await asUser(admin.userId).reactivate({ userId: t.userId });
    await settle();
    const evs = ofType(REACTIVATED);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({ userId: t.userId, tenantId: WS, source: 'manual', reason: 'workflow' });
  });

  it('PERSONAL-OWNER lane: the owner of a `user:` tenant is its implicit manager (the only short-circuit shape)', async () => {
    const home = 'user:' + 'a'.repeat(32);
    const owner = await createUser({ tenantId: home, principalId: 'oidc:u617-owner', source: 'oidc' }, { silent: true });
    const t = await target(home);
    const out = await asUser(owner.userId, home).deactivate({ userId: t.userId });
    expect(out.status).toBe('disabled');
    // …but a user whose home tenant is NOT personal-shaped gets no such short-circuit
    // in a tenant they are not seated in (the USERS-19 rule applied to the run lane).
    const err = await refuse(asUser(foreign.userId, OTHER).deactivate({ userId: (await target(OTHER)).userId }));
    expect(err.httpStatus).toBe(403);
  });
});

describe('the pack body — userId precedence and the typed refusal', () => {
  const node = usersPack.nodes['feature.users.nodes.deactivate']!;
  const ctx = (over: Record<string, unknown>) => ({ features: { users: asUser(admin.userId) }, ...over });

  it('inputs.userId wins over the EVENT payload userId, which wins over config.userId', async () => {
    const a = await target(); const b = await target(); const c = await target();
    const r1 = await node(ctx({ inputs: { userId: a.userId }, triggerData: { eventName: DEACTIVATED, payload: { userId: b.userId } }, config: { userId: c.userId } }));
    expect(r1.outputs).toEqual({ userId: a.userId, status: 'disabled' });
    const r2 = await node(ctx({ inputs: {}, triggerData: { eventName: DEACTIVATED, payload: { userId: b.userId } }, config: { userId: c.userId } }));
    expect(r2.outputs).toEqual({ userId: b.userId, status: 'disabled' });
    // The manual lane: `core.trigger.event` outputs payload:null, and the frozen
    // optional param arrives in config.
    const r3 = await node(ctx({ inputs: { payload: null }, triggerData: undefined, config: { userId: c.userId } }));
    expect(r3.outputs).toEqual({ userId: c.userId, status: 'disabled' });
  });

  it('review SHOULD-2 (1.0.1): triggerData.payload is honoured ONLY for a host.users.user.* event — a manual run\'s inputs.payload cannot retarget the frozen param', async () => {
    const hidden = await target(); const frozen = await target();
    // Manual lane: the executor mirrors `run.inputs` into `ctx.triggerData`, so a
    // run started with `inputs: { payload: { userId } }` used to win silently.
    const manual = await node(ctx({ inputs: {}, triggerData: { payload: { userId: hidden.userId } }, config: { userId: frozen.userId } }));
    expect(manual.outputs).toEqual({ userId: frozen.userId, status: 'disabled' });
    expect((await getUser(hidden.userId))!.status).toBe('active');
    // A foreign event name (some other feature's binding) is not a users lane either.
    const other = await target();
    const foreignEvent = await node(ctx({ inputs: {}, triggerData: { eventName: 'host.crm.contact.created', payload: { userId: hidden.userId } }, config: { userId: other.userId } }));
    expect(foreignEvent.outputs).toEqual({ userId: other.userId, status: 'disabled' });
    expect((await getUser(hidden.userId))!.status).toBe('active');
    // The event lane: eventName host.users.user.* ⇒ the payload wins over config.
    const viaEvent = await node(ctx({ inputs: {}, triggerData: { eventName: DEACTIVATED, payload: { userId: hidden.userId } }, config: { userId: (await target()).userId } }));
    expect(viaEvent.outputs).toEqual({ userId: hidden.userId, status: 'disabled' });
  });

  it("an empty userId everywhere (Path A freezes an unset param to '') is a typed validation_error, never success", async () => {
    await expect(node(ctx({ inputs: {}, config: { userId: '' } }))).rejects.toMatchObject({ code: 'validation_error', field: 'userId' });
  });

  it('a host without the surface is host_capability_missing', async () => {
    await expect(node({ features: {}, inputs: { userId: 'user:x' } })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });
});
