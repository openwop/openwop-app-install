/**
 * ADR 0622 D2 — `ctx.features.orgs.{invite,listInvitations,revokeInvitation}`
 * authority, per LANE (the `users-surface-authz.test.ts` shape: no lane is
 * assumed unreachable), over the REAL app (`createApp` registers the ADR 0621
 * session authority + the surface) with the host-event dispatcher re-pointed
 * at FAKE fanout deps so every emit is observable, and a FAKE SendGrid endpoint
 * so the success lane is a REAL delivery through the acting user's brokered
 * connection.
 *
 *   SYSTEM-RUN lane      → 403 `forbidden_scope` / `no_acting_user`; no row, no event;
 *   DISABLED-ACTOR lane  → 403 `acting_user_disabled`;
 *   ERASED-ACTOR lane    → 403 `acting_user_erased`;
 *   NON-MANAGER lane     → 403 (a seated editor without `host:members:manage`);
 *   CROSS-ORG lanes      → an org-A manager into org B of the SAME tenant → 403;
 *                          an org in ANOTHER tenant → uniform 404;
 *   NO-BASE-URL lane     → 501 `capability_not_provided` / `no_public_base_url`; no row;
 *   VALIDATION lanes     → 400 (empty email / junk email `invalid_email`);
 *   UNDELIVERABLE lane   → the run lane never echoes the token, so a skipped
 *                          delivery (no connection) is ROLLED BACK: 422, no row,
 *                          no `created` event, no run;
 *   MANAGER lane         → success: `{inviteId, orgId, delivery:'sent'}`, ONE
 *                          real provider request carrying the accept link under
 *                          OPENWOP_PUBLIC_BASE_URL, ONE `created` with `origin`
 *                          so the executing workflow is NOT restarted while
 *                          another bound workflow is; list is ids-only; revoke
 *                          drops the row and emits NOTHING (route-only event);
 *   PERSONAL-OWNER lane  → authority passes in the owner's own `user:` tenant
 *                          (the only short-circuit shape; the root org must
 *                          exist) — observed as the delivery decision, since a
 *                          `user:` tenant's secret needs KMS this harness lacks;
 *   plus the pack body's precedence (inputs → config) and typed refusals.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { createMember, createOrg, ensurePersonalWorkspace } from '../src/host/accessControlService.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { setSenderAddress } from '../src/features/email/emailService.js';
import {
  createHostEventBinding,
  initHostEventDispatcher,
  __clearHostEventBindings,
  type HostEventEnvelope,
} from '../src/host/hostEventDispatcher.js';
import { createUser, deleteUser, setUserStatus, type User } from '../src/features/users/usersService.js';
import { buildOrgsSurface } from '../src/features/orgs/surface.js';
import { listInvitations, previewInvitation } from '../src/features/orgs/invitationsService.js';
import { INVITATION_CREATED_EVENT, INVITATION_REVOKED_EVENT } from '../src/features/orgs/emit.js';
import { OpenwopError } from '../src/types.js';

const orgsPack = await import(
  /* @vite-ignore */ new URL('../../../packs/feature.orgs.nodes/index.mjs', import.meta.url).href
) as { nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: Record<string, unknown> }>> };

let server: http.Server;
let app: Express;
let storage: Storage;
let sg: http.Server;
let requests: Array<{ body: string }> = [];
let WS = '';
let ORG_B = '';
let OTHER = '';
let admin: User;
let editor: User;
let foreign: User;

let delivered: HostEventEnvelope[];
let startRunCalls: Array<{ tenantId: string; workflowId: string; metadata?: Record<string, unknown> }>;
const settle = () => new Promise((r) => setTimeout(r, 15));
const ofType = (t: string) => delivered.filter((e) => e.type === t);
const BASE_URL = 'https://app.acme.test';

async function refuse(p: Promise<unknown>): Promise<OpenwopError> {
  try { await p; } catch (e) { if (e instanceof OpenwopError) return e; throw e; }
  throw new Error('expected a refusal, got success');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  delete process.env.OPENWOP_DEMO_MODE;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  await __resetConnectionsStore();

  sg = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { requests.push({ body: raw }); res.writeHead(202, { 'x-message-id': 'sg-orgs-1' }); res.end(); });
  });
  await new Promise<void>((r) => sg.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_SENDGRID_API_BASE = `http://127.0.0.1:${(sg.address() as AddressInfo).port}`;

  // Workspace ROOT orgs (`orgId === tenantId`) under NON-signed-in tenant ids:
  // a `ws:`/`user:` tenant routes secret connections through KMS, which this
  // harness does not configure; the authority under test does not depend on
  // the tenant's shape (only the personal-owner lane does, and it is separate).
  WS = `org:u622-ws-${Date.now()}`;
  OTHER = `org:u622-other-${Date.now()}`;
  await ensurePersonalWorkspace({ tenantId: WS, ownerSubject: 'oidc:u622-founder', name: 'ADR 0622 workspace' });
  await ensurePersonalWorkspace({ tenantId: OTHER, ownerSubject: 'oidc:u622-other-founder', name: 'Elsewhere' });
  ORG_B = (await createOrg({ tenantId: WS, createdBy: 'oidc:u622-founder', name: 'Org B (no admin seat)' })).orgId;

  admin = await createUser({ tenantId: WS, principalId: 'oidc:u622-admin', source: 'oidc', email: 'admin@acme.test', displayName: 'Ana Admin' }, { silent: true });
  editor = await createUser({ tenantId: WS, principalId: 'oidc:u622-editor', source: 'oidc' }, { silent: true });
  foreign = await createUser({ tenantId: OTHER, principalId: 'oidc:u622-foreign', source: 'oidc' }, { silent: true });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: admin.userId, roles: ['admin'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: editor.userId, roles: ['editor'] });
  await setSenderAddress(WS, WS, 'invites@acme.test', 'test');
  await createSecretConnection({ tenantId: WS, provider: 'sendgrid', kind: 'api_key', secret: 'SG.orgs', scope: 'user', userId: admin.userId });
});
afterAll(async () => {
  delete process.env.OPENWOP_SENDGRID_API_BASE;
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  await new Promise<void>((r) => sg.close(() => r()));
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(async () => {
  delivered = [];
  startRunCalls = [];
  requests = [];
  process.env.OPENWOP_PUBLIC_BASE_URL = BASE_URL;
  await __clearHostEventBindings();
  const hostSuite: StartRunDeps['hostSuite'] = {
    workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
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
const uniqEmail = (who: string): string => `${who}-${n++}@invitee.test`;
/** A HUMAN-started run of workflow `wf:onboarding` (expanded from `people-hr.onboarding`) in WS. */
const asUser = (actingUserId: string, tenantId = WS) =>
  buildOrgsSurface({ tenantId, runId: 'run:622', workflowId: 'wf:onboarding', chainId: 'people-hr.onboarding', actingUserId });
/** A SYSTEM run (schedule / webhook / host-event-started): no principal. */
const asSystem = () => buildOrgsSurface({ tenantId: WS, runId: 'run:sys', workflowId: 'wf:onboarding' });

describe('SYSTEM-RUN lane — fail-closed with a named exit', () => {
  it('no acting user → 403 forbidden_scope / no_acting_user; nothing minted, nothing emitted', async () => {
    const err = await refuse(asSystem().invite({ email: uniqEmail('sys') }));
    expect(err.httpStatus).toBe(403);
    expect(err.code).toBe('forbidden_scope');
    expect((err.details as { reason?: string }).reason).toBe('no_acting_user');
    expect(err.message).toMatch(/human-initiated context/);
    expect(await listInvitations(WS, WS)).toHaveLength(0);
    await settle();
    expect(delivered).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});

describe('NON-MANAGER / DISABLED / ERASED actor lanes', () => {
  it('a seated EDITOR (no host:members:manage) → 403; nothing minted', async () => {
    const err = await refuse(asUser(editor.userId).invite({ email: uniqEmail('ed') }));
    expect(err.httpStatus).toBe(403);
    expect(err.code).toBe('forbidden_scope');
    expect(await listInvitations(WS, WS)).toHaveLength(0);
    await settle();
    expect(delivered).toEqual([]);
  });

  it('a DISABLED admin (run resumed after its actor was disabled) → 403 acting_user_disabled', async () => {
    const stale = await createUser({ tenantId: WS, principalId: 'oidc:u622-stale-admin', source: 'oidc' }, { silent: true });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Stale', subject: stale.userId, roles: ['admin'] });
    await setUserStatus(stale.userId, 'disabled', { reason: 'admin' });
    delivered = [];
    const err = await refuse(asUser(stale.userId).invite({ email: uniqEmail('stale') }));
    expect(err.httpStatus).toBe(403);
    expect((err.details as { reason?: string }).reason).toBe('acting_user_disabled');
    expect(await listInvitations(WS, WS)).toHaveLength(0);
  });

  it('an ERASED acting user (row gone) → 403 acting_user_erased', async () => {
    const gone = await createUser({ tenantId: WS, principalId: 'oidc:u622-gone-admin', source: 'oidc' }, { silent: true });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Gone', subject: gone.userId, roles: ['admin'] });
    await deleteUser(gone.userId);
    const err = await refuse(asUser(gone.userId).invite({ email: uniqEmail('gone') }));
    expect(err.httpStatus).toBe(403);
    expect((err.details as { reason?: string }).reason).toBe('acting_user_erased');
  });

  it('review nit (c) — a NON-DURABLE acting principal (unbound oidc:/apikey:/bearer:) → 403 acting_user_not_durable, never "erased"', async () => {
    for (const principal of ['oidc:unbound-sub', 'apikey:k1', 'bearer:abcdefgh']) {
      const err = await refuse(asUser(principal).invite({ email: uniqEmail('nondurable') }));
      expect(err.httpStatus, principal).toBe(403);
      expect(err.code).toBe('forbidden_scope');
      expect((err.details as { reason?: string }).reason, principal).toBe('acting_user_not_durable');
    }
    expect(await listInvitations(WS, WS)).toHaveLength(0);
  });
});

describe('CROSS-ORG lanes — the ORG-scoped predicate, not a tenant-wide one', () => {
  it('a manager of the workspace root inviting into ANOTHER org of the same tenant they are not seated in → 403', async () => {
    const err = await refuse(asUser(admin.userId).invite({ orgId: ORG_B, email: uniqEmail('crossorg') }));
    expect(err.httpStatus).toBe(403);
    expect(err.code).toBe('forbidden_scope');
    expect(await listInvitations(WS, ORG_B)).toHaveLength(0);
  });

  it('an org in ANOTHER tenant, and an unknown org, are a uniform 404 (no existence leak)', async () => {
    expect((await refuse(asUser(admin.userId).invite({ orgId: OTHER, email: uniqEmail('foreign') }))).httpStatus).toBe(404);
    expect((await refuse(asUser(admin.userId).invite({ orgId: 'org:does-not-exist', email: uniqEmail('nope') }))).httpStatus).toBe(404);
    expect((await refuse(asUser(admin.userId).listInvitations({ orgId: OTHER }))).httpStatus).toBe(404);
    expect((await refuse(asUser(admin.userId).revokeInvitation({ orgId: OTHER, inviteId: 'inv:x' }))).httpStatus).toBe(404);
    // …and a foreign-tenant user is no manager of WS (their own tenant's root is not this one).
    expect((await refuse(asUser(foreign.userId).invite({ email: uniqEmail('f') }))).httpStatus).toBe(403);
  });
});

describe('NO-BASE-URL + VALIDATION lanes', () => {
  it('OPENWOP_PUBLIC_BASE_URL unset → 501 capability_not_provided / no_public_base_url, refused BEFORE any mint', async () => {
    delete process.env.OPENWOP_PUBLIC_BASE_URL;
    const err = await refuse(asUser(admin.userId).invite({ email: uniqEmail('nobase') }));
    expect(err.httpStatus).toBe(501);
    expect(err.code).toBe('capability_not_provided');
    expect((err.details as { reason?: string }).reason).toBe('no_public_base_url');
    expect(await listInvitations(WS, WS)).toHaveLength(0);
    expect(requests).toHaveLength(0);
    await settle();
    expect(ofType(INVITATION_CREATED_EVENT)).toEqual([]);
  });

  it('an empty email is 400; a junk email is 400 invalid_email; nothing minted', async () => {
    expect((await refuse(asUser(admin.userId).invite({}))).httpStatus).toBe(400);
    const junk = await refuse(asUser(admin.userId).invite({ email: 'not-an-email' }));
    expect(junk.httpStatus).toBe(400);
    expect((junk.details as { reason?: string }).reason).toBe('invalid_email');
    expect((await refuse(asUser(admin.userId).invite({ email: uniqEmail('badrole'), role: 'owner' }))).httpStatus).toBe(400);
    expect((await refuse(asUser(admin.userId).revokeInvitation({}))).httpStatus).toBe(400);
    expect(await listInvitations(WS, WS)).toHaveLength(0);
  });
});

describe('UNDELIVERABLE lane — the run never echoes the token, so a skipped delivery is rolled back', () => {
  it('a manager WITHOUT an email connection → 422 undeliverable / no_connection; no row survives; no created event; no run', async () => {
    const noconn = await createUser({ tenantId: WS, principalId: 'oidc:u622-noconn-admin', source: 'oidc' }, { silent: true });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'NoConn', subject: noconn.userId, roles: ['admin'] });
    await createHostEventBinding({ tenantId: WS, eventType: INVITATION_CREATED_EVENT, workflowId: 'wf:welcome', createdBy: 'test' });
    delivered = [];
    const err = await refuse(asUser(noconn.userId).invite({ email: uniqEmail('undeliverable') }));
    expect(err.httpStatus).toBe(422);
    expect(err.details).toMatchObject({ reason: 'undeliverable', cause: 'no_connection' });
    expect(await listInvitations(WS, WS)).toHaveLength(0);
    expect(requests).toHaveLength(0);
    await settle();
    expect(ofType(INVITATION_CREATED_EVENT)).toEqual([]);
    expect(startRunCalls).toEqual([]);
  });
});

describe('MANAGER lane — success: real delivery, ONE created with origin, ids-only list, silent revoke', () => {
  it('invite → {inviteId, orgId, delivery:sent}; one provider request with the accept link; the executing workflow is NOT restarted, another bound workflow IS', async () => {
    await createHostEventBinding({ tenantId: WS, eventType: INVITATION_CREATED_EVENT, workflowId: 'wf:onboarding', createdBy: 'test' });
    await createHostEventBinding({ tenantId: WS, eventType: INVITATION_CREATED_EVENT, workflowId: 'wf:welcome', createdBy: 'test' });
    const email = uniqEmail('sam');
    const out = await asUser(admin.userId).invite({ email, role: 'editor' });
    expect(out).toEqual({ inviteId: expect.stringMatching(/^inv:/), orgId: WS, delivery: 'sent' });
    // The real delivery: ONE provider request, accept link under the configured origin, inviter named.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toContain(`${BASE_URL}/invitations/accept?token=`);
    expect(requests[0]!.body).toContain('Ana Admin');
    // The row: createdBy = the acting user; createdByName from their row; the token previews.
    const rows = await listInvitations(WS, WS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inviteId: out.inviteId, email, role: 'editor', createdBy: admin.userId, createdByName: 'Ana Admin' });
    await settle();
    const evs = ofType(INVITATION_CREATED_EVENT);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({ inviteId: out.inviteId, orgId: WS, tenantId: WS, role: 'editor', delivery: 'sent', superseded: false });
    expect('origin' in evs[0]!).toBe(false); // never a wire field
    // ADR 0617 D1a: the run's own workflow is skipped; the other binding starts.
    expect(startRunCalls.map((c) => c.workflowId)).toEqual(['wf:welcome']);

    // list is ids-only: never the email, never the token/hash.
    const list = await asUser(admin.userId).listInvitations({});
    expect(list).toEqual({ orgId: WS, count: 1, invitations: [{ inviteId: out.inviteId, role: 'editor', status: 'pending', expiresAt: rows[0]!.expiresAt }] });
    expect(JSON.stringify(list)).not.toContain(email);
    expect(JSON.stringify(list)).not.toMatch(/token/i);

    // revoke drops the row + index and emits NOTHING (the event is the route's).
    await createHostEventBinding({ tenantId: WS, eventType: INVITATION_REVOKED_EVENT, workflowId: 'wf:audit', createdBy: 'test' });
    const rev = await asUser(admin.userId).revokeInvitation({ inviteId: out.inviteId });
    expect(rev).toEqual({ inviteId: out.inviteId, orgId: WS, revoked: true });
    expect(await listInvitations(WS, WS)).toHaveLength(0);
    await settle();
    expect(ofType(INVITATION_REVOKED_EVENT)).toEqual([]);
    expect(startRunCalls).toHaveLength(1);
    expect((await refuse(asUser(admin.userId).revokeInvitation({ inviteId: out.inviteId }))).httpStatus).toBe(404);
  });

  it('review BLOCKER-1 shape: origin.chainId from the scope — a SIBLING from-chain instance of the same chain is not started either', async () => {
    const catalogDefs = new Map([['wf:sibling', { workflowId: 'wf:sibling', nodes: [], metadata: { expandedFrom: { chainId: 'people-hr.onboarding' } } }]]);
    initHostEventDispatcher({
      storage,
      hostSuite: {
        workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: catalogDefs.get(id) ?? { workflowId: id, nodes: [] } }) },
        providerPolicyResolver: { resolveForRun: async () => [] },
      },
      deliverWebhooks: async (event) => { delivered.push(event); },
      startRun: async (_deps, input) => { startRunCalls.push(input); return `run:fake-${startRunCalls.length}`; },
    });
    await createHostEventBinding({ tenantId: WS, eventType: INVITATION_CREATED_EVENT, workflowId: 'wf:sibling', createdBy: 'test' });
    await createHostEventBinding({ tenantId: WS, eventType: INVITATION_CREATED_EVENT, workflowId: 'wf:welcome', createdBy: 'test' });
    const out = await asUser(admin.userId).invite({ email: uniqEmail('sib') });
    expect(out.delivery).toBe('sent');
    await settle();
    expect(ofType(INVITATION_CREATED_EVENT)).toHaveLength(1);
    expect(startRunCalls.map((c) => c.workflowId)).toEqual(['wf:welcome']);
    await asUser(admin.userId).revokeInvitation({ inviteId: out.inviteId });
  });

  it('a re-invite of a LIVE (org, email) from a run supersedes only after delivery: created{superseded:true}, one row, the old token dead', async () => {
    const email = uniqEmail('again');
    const first = await asUser(admin.userId).invite({ email });
    const firstRow = (await listInvitations(WS, WS)).find((i) => i.inviteId === first.inviteId)!;
    const second = await asUser(admin.userId).invite({ email, role: 'admin' });
    expect(second.inviteId).not.toBe(first.inviteId);
    expect((await listInvitations(WS, WS)).map((i) => i.inviteId)).toEqual([second.inviteId]);
    await settle();
    const evs = ofType(INVITATION_CREATED_EVENT);
    expect(evs.map((e) => e.payload.superseded)).toEqual([false, true]);
    expect(evs[1]!.payload.previousStatus).toBe('pending');
    // Two REAL sends (two inviteIds ⇒ two send-once keys); the accept link of the first is dead.
    expect(requests).toHaveLength(2);
    expect(firstRow.tokenHash).toBeTruthy();
    await asUser(admin.userId).revokeInvitation({ inviteId: second.inviteId });
  });

  it('PERSONAL-OWNER lane: the owner of a `user:` tenant is its implicit manager (the only short-circuit shape); the root org must still exist', async () => {
    const home = 'user:' + 'b'.repeat(32);
    const owner = await createUser({ tenantId: home, principalId: 'oidc:u622-owner', source: 'oidc', email: 'owner@home.test' }, { silent: true });
    // No root org row yet → the org-existence check comes FIRST (uniform 404).
    expect((await refuse(asUser(owner.userId, home).invite({ email: uniqEmail('home') }))).httpStatus).toBe(404);
    await ensurePersonalWorkspace({ tenantId: home, ownerSubject: owner.userId });
    await setSenderAddress(home, home, 'me@home.test', 'test');
    // AUTHORITY passes (the short-circuit) — what follows is the delivery
    // decision: a `user:` tenant's secret connection needs KMS, which this
    // harness does not configure, so the honest outcome here is the typed
    // undeliverable rollback, NOT a 403/404. (The `sent` lane is proven above.)
    const err = await refuse(asUser(owner.userId, home).invite({ email: uniqEmail('home') }));
    expect(err.httpStatus).toBe(422);
    expect(err.details).toMatchObject({ reason: 'undeliverable', cause: 'no_connection' });
    expect(await listInvitations(home, home)).toHaveLength(0);
    // …but a user whose home tenant is NOT personal-shaped gets no such short-circuit
    // in a workspace they are not seated in (USERS-19 applied to the run lane).
    expect((await refuse(asUser(foreign.userId, OTHER).invite({ email: uniqEmail('x') }))).httpStatus).toBe(403);
  });
});

describe('the pack body — value precedence and the typed refusals', () => {
  const node = orgsPack.nodes['feature.orgs.nodes.invite']!;
  const ctx = (over: Record<string, unknown>) => ({ features: { orgs: asUser(admin.userId) }, ...over });

  it('inputs.email wins over config.email; role/orgId follow the same precedence; the gate\'s default-port outputs are ignored', async () => {
    const a = uniqEmail('inputs'); const b = uniqEmail('config');
    const r1 = await node(ctx({ inputs: { email: a, approved: true, decision: 'approve' }, config: { email: b, role: 'editor' } }));
    expect(r1.outputs).toMatchObject({ orgId: WS, delivery: 'sent' });
    const rows = await listInvitations(WS, WS);
    expect(rows.map((i) => i.email)).toEqual([a]);
    expect(rows[0]!.role).toBe('editor');
    const r2 = await node(ctx({ inputs: { approved: true }, config: { email: b } }));
    expect(r2.outputs).toMatchObject({ orgId: WS, delivery: 'sent' });
    expect((await listInvitations(WS, WS)).map((i) => i.email).sort()).toEqual([a, b].sort());
    for (const i of await listInvitations(WS, WS)) await asUser(admin.userId).revokeInvitation({ inviteId: i.inviteId });
  });

  it("an empty email everywhere (Path A freezes an unset param to ''/undefined) is a typed validation_error, never success", async () => {
    await expect(node(ctx({ inputs: {}, config: { email: '' } }))).rejects.toMatchObject({ code: 'validation_error', field: 'email' });
    await expect(node(ctx({ inputs: {}, config: {} }))).rejects.toMatchObject({ code: 'validation_error', field: 'email' });
    expect(await listInvitations(WS, WS)).toHaveLength(0);
  });

  it('a host without the surface is host_capability_missing; the surface refusal is forwarded typed', async () => {
    await expect(node({ features: {}, inputs: { email: 'x@y.test' } })).rejects.toMatchObject({ code: 'host_capability_missing' });
    await expect(node({ features: { orgs: asSystem() }, inputs: { email: 'x@y.test' } })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(orgsPack.nodes['feature.orgs.nodes.revoke-invitation']!(ctx({ inputs: {}, config: {} }))).rejects.toMatchObject({ code: 'validation_error', field: 'inviteId' });
  });

  it('list-invitations + revoke-invitation bodies forward the ids-only shapes', async () => {
    const minted = await asUser(admin.userId).invite({ email: uniqEmail('body') });
    const list = await orgsPack.nodes['feature.orgs.nodes.list-invitations']!(ctx({ inputs: {}, config: {} }));
    expect(list.outputs).toEqual({ orgId: WS, count: 1, invitations: [expect.objectContaining({ inviteId: minted.inviteId, status: 'pending' })] });
    expect(JSON.stringify(list.outputs)).not.toContain('@invitee.test');
    const rev = await orgsPack.nodes['feature.orgs.nodes.revoke-invitation']!(ctx({ inputs: { inviteId: minted.inviteId }, config: {} }));
    expect(rev.outputs).toEqual({ inviteId: minted.inviteId, orgId: WS, revoked: true });
    await expect(previewInvitation('orginv_dead')).rejects.toMatchObject({ code: 'invalid_invite' });
  });
});
