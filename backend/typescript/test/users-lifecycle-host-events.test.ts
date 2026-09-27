/**
 * ADR 0617 D1 / D1a — the four `host.users.user.*` lifecycle events: ONE emit
 * site each, TRANSITION-guarded, ids-only payloads, and the dispatcher's
 * self-trigger guard.
 *
 * Unit-style over the REAL `usersService` / `scimProvisioningService` / real
 * dispatcher with FAKE fanout deps (the `host-event-pii-strip.test.ts` shape),
 * so every emit is observable as a captured envelope + a captured `startRun`
 * call. The app-level lanes (conformance seam, `/scim/v2` PATCH, admin Disable
 * over HTTP) are `users-lifecycle-event-lanes.test.ts`.
 *
 * What is pinned here and WHY each pin is load-bearing:
 *   - the LITERAL payload key set per event — `stripPiiPayload` only strips
 *     `email`/`phone`-shaped keys, so `userName`/`externalId`/`nameId` would
 *     pass the dispatcher; the emitter's discipline is the only rule;
 *   - no emit on the idempotent `createUser` return, on `{silent:true}`, or on
 *     a status write that changes nothing (the SCIM retry on an already-disabled
 *     row is the D5 compensation and must NOT start a second offboarding run);
 *   - the D1a guard: an emit carrying `origin.workflowId === binding.workflowId`
 *     starts NO run, while a different workflow still does — so the guard is
 *     proven to discriminate, not to blanket-suppress.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createHostEventBinding,
  emitHostEvent,
  initHostEventDispatcher,
  __clearHostEventBindings,
  __resetHostEventDispatcher,
  type HostEventEnvelope,
} from '../src/host/hostEventDispatcher.js';
import {
  __resetUsersStore,
  bumpSessionEpoch,
  createUser,
  getUser,
  setUserStatus,
  upsertFromPrincipal,
  resolveCanonicalUserForTenant,
} from '../src/features/users/usersService.js';
import { deactivateUser, provisionUser, setScimActive } from '../src/host/auth/scimProvisioningService.js';
import { __resetSubjectLinkStore, isLinkedSubjectDenied } from '../src/host/auth/subjectLinkService.js';
import {
  USER_DEACTIVATED_EVENT,
  USER_ERASED_EVENT,
  USER_PROVISIONED_EVENT,
  USER_REACTIVATED_EVENT,
  userErased,
} from '../src/features/users/emit.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import { defaultWorkflowChainPackRoots, expandChain, getChain, loadWorkflowChainPacks } from '../src/host/workflowChainPackLoader.js';

/** Definitions the fake catalog serves by id — a from-chain instance registered
 *  here carries its real `metadata.expandedFrom.chainId` stamp; anything else
 *  resolves to an authored (chain-less) definition. */
const catalogDefs = new Map<string, WorkflowDefinition>();
const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: catalogDefs.get(id) ?? { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

let storage: Storage;
let delivered: HostEventEnvelope[];
let startRunCalls: Array<{ tenantId: string; workflowId: string; metadata?: Record<string, unknown> }>;

const T = 'users-events-t1';
/** `emitHostEvent` is fire-and-forget (`void`), so give the microtask queue a
 *  tick before reading the captured envelopes. */
const settle = () => new Promise((r) => setTimeout(r, 10));
const ofType = (type: string) => delivered.filter((e) => e.type === type);
/** The PII-shaped keys the dispatcher would NOT strip — the emitter's rule. */
const FORBIDDEN_KEY = /email|username|externalid|nameid|displayname|principalid/i;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __clearHostEventBindings();
  await __resetUsersStore();
  await __resetSubjectLinkStore();
  delivered = [];
  startRunCalls = [];
  initHostEventDispatcher({
    storage,
    hostSuite,
    deliverWebhooks: async (event) => { delivered.push(event); },
    startRun: async (_deps, input) => { startRunCalls.push(input); return `run:fake-${startRunCalls.length}`; },
  });
});

afterEach(() => {
  __resetHostEventDispatcher();
  __resetHostExtPersistence();
});

describe('host.users.user.provisioned — ONE site (createUser), new row only', () => {
  it('emits exactly the ids-only key set on a NEW row; nothing on the idempotent return', async () => {
    const u = await createUser({ tenantId: T, principalId: 'oidc:new', source: 'oidc', email: 'leak@example.test', displayName: 'Leak' });
    await settle();
    const evs = ofType(USER_PROVISIONED_EVENT);
    expect(evs).toHaveLength(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['source', 'tenantId', 'userId']);
    expect(evs[0]!.payload).toEqual({ userId: u.userId, tenantId: T, source: 'oidc' });
    expect(evs[0]!.tenantId).toBe(T);
    // `origin` is dispatcher routing state, never a wire field.
    expect('origin' in evs[0]!).toBe(false);

    await createUser({ tenantId: T, principalId: 'oidc:new', source: 'oidc' }); // idempotent return
    await settle();
    expect(ofType(USER_PROVISIONED_EVENT)).toHaveLength(1);
  });

  it('every creator delegates to createUser — no second emit site (upsertFromPrincipal, provisionUser, canonical fold)', async () => {
    await upsertFromPrincipal({ tenantId: T, principalId: 'saml:sso-first', source: 'saml' });
    await provisionUser({ tenantId: T, userName: 'scim.joiner', externalId: 'ext-j' });
    await resolveCanonicalUserForTenant({ homeTenant: 'user:canon1', principalId: 'oidc:canon', source: 'oidc' });
    await settle();
    const evs = ofType(USER_PROVISIONED_EVENT);
    expect(evs.map((e) => e.payload.source).sort()).toEqual(['oidc', 'saml', 'scim']);
    // A mover (re-provision) and a re-login are NOT new rows.
    await upsertFromPrincipal({ tenantId: T, principalId: 'saml:sso-first', source: 'saml', displayName: 'Renamed' });
    await provisionUser({ tenantId: T, userName: 'scim.joiner', displayName: 'Renamed' });
    await settle();
    expect(ofType(USER_PROVISIONED_EVENT)).toHaveLength(3);
  });

  it('`{ silent: true }` (the demo seed) emits nothing', async () => {
    await createUser({ tenantId: T, principalId: 'demo:p1', source: 'manual' }, { silent: true });
    await settle();
    expect(ofType(USER_PROVISIONED_EVENT)).toHaveLength(0);
  });
});

describe('host.users.user.deactivated / reactivated — ONE site (setUserStatus), transition-guarded', () => {
  it('disable emits ONCE with {userId, tenantId, source, reason}; a repeat disable of an already-disabled row emits NOTHING', async () => {
    const u = await createUser({ tenantId: T, principalId: 'oidc:d1', source: 'oidc' });
    await setUserStatus(u.userId, 'disabled', { reason: 'admin' });
    await settle();
    let evs = ofType(USER_DEACTIVATED_EVENT);
    expect(evs).toHaveLength(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['reason', 'source', 'tenantId', 'userId']);
    expect(evs[0]!.payload).toEqual({ userId: u.userId, tenantId: T, source: 'oidc', reason: 'admin' });

    await setUserStatus(u.userId, 'disabled', { reason: 'admin' }); // no transition
    await setUserStatus(u.userId, 'disabled', { reason: 'scim' }); // the IdP retry shape
    await settle();
    evs = ofType(USER_DEACTIVATED_EVENT);
    expect(evs).toHaveLength(1);
    expect((await getUser(u.userId))!.status).toBe('disabled');
  });

  it('reactivate emits ONCE; a repeat enable emits nothing; a status write on a missing row emits nothing', async () => {
    const u = await createUser({ tenantId: T, principalId: 'oidc:r1', source: 'password' });
    await setUserStatus(u.userId, 'active', { reason: 'admin' }); // already active — no transition
    await settle();
    expect(ofType(USER_REACTIVATED_EVENT)).toHaveLength(0);
    await setUserStatus(u.userId, 'disabled', { reason: 'admin' });
    await setUserStatus(u.userId, 'active', { reason: 'admin' });
    await setUserStatus(u.userId, 'active', { reason: 'admin' });
    await settle();
    const evs = ofType(USER_REACTIVATED_EVENT);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({ userId: u.userId, tenantId: T, source: 'password', reason: 'admin' });
    expect(await setUserStatus('user:does-not-exist', 'disabled', { reason: 'admin' })).toBeNull();
    await settle();
    expect(ofType(USER_DEACTIVATED_EVENT)).toHaveLength(1);
  });

  it('CONCURRENT re-enables (review SHOULD-3): two setUserStatus(active) racing on one disabled row emit exactly ONE reactivated', async () => {
    const u = await createUser({ tenantId: T, principalId: 'oidc:race', source: 'oidc' });
    await setUserStatus(u.userId, 'disabled', { reason: 'admin' });
    await settle();
    // Both read the disabled row before either writes — the get→put shape
    // decided `changed` on the stale pre-read and emitted twice.
    const [a, b] = await Promise.all([
      setUserStatus(u.userId, 'active', { reason: 'admin' }),
      setUserStatus(u.userId, 'active', { reason: 'scim' }),
    ]);
    expect(a?.status).toBe('active');
    expect(b?.status).toBe('active');
    await settle();
    expect(ofType(USER_REACTIVATED_EVENT)).toHaveLength(1);
    // The re-enable never clobbers an epoch bump that landed between its read
    // and its write: the disable bumped to 1 and the row still says 1.
    expect((await getUser(u.userId))!.sessionEpoch).toBe(1);
  });

  it('a re-enable racing an epoch bump does not clobber the bump (review SHOULD-3)', async () => {
    const u = await createUser({ tenantId: T, principalId: 'oidc:race-epoch', source: 'oidc' });
    await setUserStatus(u.userId, 'disabled', { reason: 'admin' }); // epoch 1
    const [row] = await Promise.all([
      setUserStatus(u.userId, 'active', { reason: 'admin' }),
      bumpSessionEpoch(u.userId), // "sign out everywhere" landing mid-flight
    ]);
    expect(row?.status).toBe('active');
    const landed = (await getUser(u.userId))!;
    expect(landed.status).toBe('active');
    expect(landed.sessionEpoch).toBe(2);
  });

  it('`reason` is the explicit argument, never inferred from user.source (an admin disabling a SCIM row)', async () => {
    const u = await provisionUser({ tenantId: T, userName: 'scim.rowa', externalId: 'ext-rowa' });
    await setUserStatus(u.userId, 'disabled', { reason: 'admin' });
    await settle();
    const ev = ofType(USER_DEACTIVATED_EVENT)[0]!;
    expect(ev.payload.source).toBe('scim');
    expect(ev.payload.reason).toBe('admin');
  });

  it('SCIM lanes carry reason:scim, and the D5 retry on an already-disabled row starts NO second run', async () => {
    const u = await provisionUser({ tenantId: T, userName: 'scim.leaver', externalId: 'ext-leaver' });
    await createHostEventBinding({ tenantId: T, eventType: USER_DEACTIVATED_EVENT, workflowId: 'wf:offboarding', createdBy: 'test' });
    await deactivateUser({ tenantId: T, externalId: 'ext-leaver' });
    await settle();
    expect(ofType(USER_DEACTIVATED_EVENT)).toHaveLength(1);
    expect(ofType(USER_DEACTIVATED_EVENT)[0]!.payload.reason).toBe('scim');
    expect(startRunCalls).toHaveLength(1);
    expect(startRunCalls[0]!.metadata?.triggerData).toEqual({
      eventName: USER_DEACTIVATED_EVENT,
      payload: { userId: u.userId, tenantId: T, source: 'scim', reason: 'scim' },
    });
    expect(await isLinkedSubjectDenied(T, 'ext-leaver')).toBe(true);

    // The IdP retries the PATCH (both lanes) — idempotent, silent.
    await deactivateUser({ tenantId: T, externalId: 'ext-leaver' });
    await setScimActive((await getUser(u.userId))!, false);
    await settle();
    expect(ofType(USER_DEACTIVATED_EVENT)).toHaveLength(1);
    expect(startRunCalls).toHaveLength(1);

    // Re-hire: one reactivated, and it clears the deny.
    await setScimActive((await getUser(u.userId))!, true);
    await settle();
    expect(ofType(USER_REACTIVATED_EVENT)).toHaveLength(1);
    expect(ofType(USER_REACTIVATED_EVENT)[0]!.payload.reason).toBe('scim');
    expect(await isLinkedSubjectDenied(T, 'ext-leaver')).toBe(false);
  });
});

describe('host.users.user.erased — the erase route emits after deleteUser (key pin at the emitter)', () => {
  it('carries exactly {userId, tenantId, outcome}', async () => {
    userErased({ userId: 'user:gone', tenantId: T, outcome: 'deleted' });
    await settle();
    const evs = ofType(USER_ERASED_EVENT);
    expect(evs).toHaveLength(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['outcome', 'tenantId', 'userId']);
    expect(evs[0]!.payload).toEqual({ userId: 'user:gone', tenantId: T, outcome: 'deleted' });
  });
});

describe('payload discipline — no PII-shaped key ever leaves the emitter', () => {
  it('across every captured event, no key matches email|userName|externalId|nameId|displayName|principalId', async () => {
    const u = await provisionUser({ tenantId: T, userName: 'pii.probe@example.test', externalId: 'ext-pii', email: 'pii@example.test', displayName: 'PII Probe' });
    await setUserStatus(u.userId, 'disabled', { reason: 'scim' });
    await setUserStatus(u.userId, 'active', { reason: 'admin' });
    userErased({ userId: u.userId, tenantId: T, outcome: 'deleted' });
    await settle();
    expect(delivered.length).toBeGreaterThanOrEqual(4);
    for (const ev of delivered) {
      for (const key of Object.keys(ev.payload)) expect(key, `${ev.type} leaked key ${key}`).not.toMatch(FORBIDDEN_KEY);
      // and no VALUE is the email / userName either
      expect(JSON.stringify(ev.payload)).not.toContain('pii.probe');
      expect(JSON.stringify(ev.payload)).not.toContain('ext-pii');
    }
  });
});

describe('ADR 0617 D1a — the self-trigger guard discriminates on origin.workflowId', () => {
  it('an emit whose origin.workflowId equals the bound workflow starts NO run; another workflow still does', async () => {
    await createHostEventBinding({ tenantId: T, eventType: USER_DEACTIVATED_EVENT, workflowId: 'wf:offboarding', createdBy: 'test' });
    await createHostEventBinding({ tenantId: T, eventType: USER_DEACTIVATED_EVENT, workflowId: 'wf:audit-log', createdBy: 'test' });

    await emitHostEvent({
      type: USER_DEACTIVATED_EVENT,
      tenantId: T,
      payload: { userId: 'user:x', tenantId: T, source: 'oidc', reason: 'workflow' },
      origin: { runId: 'run:self', workflowId: 'wf:offboarding' },
    });
    expect(startRunCalls.map((c) => c.workflowId)).toEqual(['wf:audit-log']);
    // The webhook leg still delivered once, and never carried `origin`.
    expect(ofType(USER_DEACTIVATED_EVENT)).toHaveLength(1);
    expect('origin' in ofType(USER_DEACTIVATED_EVENT)[0]!).toBe(false);

    // Same event WITHOUT an origin (the admin/SCIM lanes) starts BOTH bound workflows.
    await emitHostEvent({ type: USER_DEACTIVATED_EVENT, tenantId: T, payload: { userId: 'user:y', tenantId: T, source: 'oidc', reason: 'admin' } });
    expect(startRunCalls.map((c) => c.workflowId).sort()).toEqual(['wf:audit-log', 'wf:audit-log', 'wf:offboarding']);
  });

  it('CHAIN LINEAGE (review BLOCKER-1): a run of instance B of a chain does NOT start a binding on instance A of the SAME chain; an unrelated bound workflow still starts', async () => {
    // Two REAL from-chain instances of people-hr.offboarding — one per departing
    // employee, because `employeeName` is a required Path-A-frozen param and the
    // expansion id folds the params in (`workflowId = chainId:expansionId`).
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    const chain = getChain('people-hr.offboarding')!.chain;
    const alice = expandChain(chain, { params: { employeeName: 'Alice' } });
    const bob = expandChain(chain, { params: { employeeName: 'Bob' } });
    expect(alice.workflowId).not.toBe(bob.workflowId);
    expect((alice.metadata as { expandedFrom?: { chainId?: string } }).expandedFrom?.chainId).toBe('people-hr.offboarding');
    catalogDefs.set(alice.workflowId, alice);
    catalogDefs.set(bob.workflowId, bob);
    // A builder COPY of Alice's instance under an authored id keeps the stamp.
    catalogDefs.set('wf:alice-copy', { ...alice, workflowId: 'wf:alice-copy' });

    await createHostEventBinding({ tenantId: T, eventType: USER_DEACTIVATED_EVENT, workflowId: alice.workflowId, createdBy: 'test' });
    await createHostEventBinding({ tenantId: T, eventType: USER_DEACTIVATED_EVENT, workflowId: 'wf:alice-copy', createdBy: 'test' });
    await createHostEventBinding({ tenantId: T, eventType: USER_DEACTIVATED_EVENT, workflowId: 'wf:audit-log', createdBy: 'test' });

    // Bob's human-started run reaches `deprovision-host` and emits with its lineage.
    await emitHostEvent({
      type: USER_DEACTIVATED_EVENT,
      tenantId: T,
      payload: { userId: 'user:bob', tenantId: T, source: 'oidc', reason: 'workflow' },
      origin: { runId: 'run:bob', workflowId: bob.workflowId, chainId: 'people-hr.offboarding' },
    });
    // Alice's instance (B ≠ A on the id compare alone) and its copy are NOT
    // started — that run would fire Alice's frozen `finalPay`/`deprovision`
    // for the wrong employee. The unrelated workflow still starts.
    expect(startRunCalls.map((c) => c.workflowId)).toEqual(['wf:audit-log']);
    expect(ofType(USER_DEACTIVATED_EVENT)).toHaveLength(1); // webhooks unaffected

    // The same event from the admin/SCIM lanes (no origin) starts all three.
    await emitHostEvent({ type: USER_DEACTIVATED_EVENT, tenantId: T, payload: { userId: 'user:y', tenantId: T, source: 'oidc', reason: 'admin' } });
    expect(startRunCalls.map((c) => c.workflowId).sort()).toEqual([alice.workflowId, 'wf:alice-copy', 'wf:audit-log', 'wf:audit-log'].sort());
    catalogDefs.clear();
  });

  it('setUserStatus threads `origin` through to the dispatcher (the surface lane)', async () => {
    const u = await createUser({ tenantId: T, principalId: 'oidc:origin', source: 'oidc' });
    await createHostEventBinding({ tenantId: T, eventType: USER_DEACTIVATED_EVENT, workflowId: 'wf:offboarding', createdBy: 'test' });
    await setUserStatus(u.userId, 'disabled', { reason: 'workflow', origin: { runId: 'run:1', workflowId: 'wf:offboarding' } });
    await settle();
    expect(ofType(USER_DEACTIVATED_EVENT)).toHaveLength(1);
    expect(ofType(USER_DEACTIVATED_EVENT)[0]!.payload.reason).toBe('workflow');
    expect(startRunCalls).toHaveLength(0);
  });
});
