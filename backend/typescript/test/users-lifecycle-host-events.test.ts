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
 *   - the D1a chain-LINEAGE guard (review BLOCKER-1): a run of from-chain
 *     instance B does not start instance A of the same REAL chain, nor a
 *     builder copy that keeps the `expandedFrom` stamp, while an unrelated
 *     workflow still starts — so the guard discriminates.
 *
 * Covered ELSEWHERE (cases cut from this file, each red under the same break):
 *   - the plain `origin.workflowId` self-trigger skip and `setUserStatus`
 *     threading `origin` → `users-surface-authz.test.ts` "deactivate: status →
 *     disabled, epoch bumped, exactly one deactivated event…";
 *   - the `erased` key set → `users-lifecycle-event-lanes.test.ts` lanes C + D
 *     (pinned over the real erase route, not the emitter in isolation);
 *   - a blanket PII-key sweep → implied by the exact `toEqual` payload pins below.
 *
 * Sabotage that turns it red (`src/features/users/usersService.ts` unless noted):
 * `if (existing) return existing;` deleted (idempotent return emits);
 * `if (!opts.silent) userProvisioned(` → `if (true) …`; the disable mutate's
 * `changed = row.status !== status` → `changed = true` (repeat disable emits);
 * the re-enable mutate deciding `changed` once instead of per CAS attempt
 * (concurrent re-enables emit twice); `reason` derived from `source`;
 * `scimProvisioningService.ts` re-hire skipping `clearLinkedSubjectDeny`;
 * `hostEventDispatcher.ts` lineage check disabled.
 *
 * BARRIER. `emitHostEvent` calls `deliverWebhooks` in its first synchronous
 * segment, so `delivered` is complete the moment the emitting call returns —
 * no wait is needed for it. The binding loop (→ `startRun`) is a pure
 * microtask chain over the memory storage, so `drain()` (one macrotask turn,
 * repeated) settles it without a wall-clock sleep.
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
  USER_PROVISIONED_EVENT,
  USER_REACTIVATED_EVENT,
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
/** Settle the fire-and-forget binding loop: a few macrotask turns drain every
 *  pending microtask (the memory-storage pipeline has no timers or I/O). */
const drain = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };
const ofType = (type: string) => delivered.filter((e) => e.type === type);

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
  catalogDefs.clear();
  __resetHostEventDispatcher();
  __resetHostExtPersistence();
});

describe('host.users.user.provisioned — ONE site (createUser), new row only', () => {
  it('emits exactly the ids-only key set on a NEW row; nothing on the idempotent return', async () => {
    const u = await createUser({ tenantId: T, principalId: 'oidc:new', source: 'oidc', email: 'leak@example.test', displayName: 'Leak' });
    await drain();
    const evs = ofType(USER_PROVISIONED_EVENT);
    expect(evs).toHaveLength(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['source', 'tenantId', 'userId']);
    expect(evs[0]!.payload).toEqual({ userId: u.userId, tenantId: T, source: 'oidc' });
    expect(evs[0]!.tenantId).toBe(T);
    // `origin` is dispatcher routing state, never a wire field.
    expect('origin' in evs[0]!).toBe(false);

    await createUser({ tenantId: T, principalId: 'oidc:new', source: 'oidc' }); // idempotent return
    await drain();
    expect(ofType(USER_PROVISIONED_EVENT)).toHaveLength(1);
  });

  it('every creator delegates to createUser — no second emit site (upsertFromPrincipal, provisionUser, canonical fold)', async () => {
    await upsertFromPrincipal({ tenantId: T, principalId: 'saml:sso-first', source: 'saml' });
    await provisionUser({ tenantId: T, userName: 'scim.joiner', externalId: 'ext-j' });
    await resolveCanonicalUserForTenant({ homeTenant: 'user:canon1', principalId: 'oidc:canon', source: 'oidc' });
    await drain();
    const evs = ofType(USER_PROVISIONED_EVENT);
    expect(evs.map((e) => e.payload.source).sort()).toEqual(['oidc', 'saml', 'scim']);
    // A mover (re-provision) and a re-login are NOT new rows.
    await upsertFromPrincipal({ tenantId: T, principalId: 'saml:sso-first', source: 'saml', displayName: 'Renamed' });
    await provisionUser({ tenantId: T, userName: 'scim.joiner', displayName: 'Renamed' });
    await drain();
    expect(ofType(USER_PROVISIONED_EVENT)).toHaveLength(3);
  });

  it('`{ silent: true }` (the demo seed) emits nothing', async () => {
    await createUser({ tenantId: T, principalId: 'demo:p1', source: 'manual' }, { silent: true });
    await drain();
    expect(ofType(USER_PROVISIONED_EVENT)).toHaveLength(0);
  });
});

describe('host.users.user.deactivated / reactivated — ONE site (setUserStatus), transition-guarded', () => {
  it('disable emits ONCE with {userId, tenantId, source, reason}; a repeat disable of an already-disabled row emits NOTHING', async () => {
    const u = await createUser({ tenantId: T, principalId: 'oidc:d1', source: 'oidc' });
    await setUserStatus(u.userId, 'disabled', { reason: 'admin' });
    await drain();
    let evs = ofType(USER_DEACTIVATED_EVENT);
    expect(evs).toHaveLength(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['reason', 'source', 'tenantId', 'userId']);
    expect(evs[0]!.payload).toEqual({ userId: u.userId, tenantId: T, source: 'oidc', reason: 'admin' });

    await setUserStatus(u.userId, 'disabled', { reason: 'admin' }); // no transition
    await setUserStatus(u.userId, 'disabled', { reason: 'scim' }); // the IdP retry shape
    await drain();
    evs = ofType(USER_DEACTIVATED_EVENT);
    expect(evs).toHaveLength(1);
    expect((await getUser(u.userId))!.status).toBe('disabled');
  });

  it('reactivate emits ONCE; a repeat enable emits nothing; a status write on a missing row emits nothing', async () => {
    const u = await createUser({ tenantId: T, principalId: 'oidc:r1', source: 'password' });
    await setUserStatus(u.userId, 'active', { reason: 'admin' }); // already active — no transition
    await drain();
    expect(ofType(USER_REACTIVATED_EVENT)).toHaveLength(0);
    await setUserStatus(u.userId, 'disabled', { reason: 'admin' });
    await setUserStatus(u.userId, 'active', { reason: 'admin' });
    await setUserStatus(u.userId, 'active', { reason: 'admin' });
    await drain();
    const evs = ofType(USER_REACTIVATED_EVENT);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({ userId: u.userId, tenantId: T, source: 'password', reason: 'admin' });
    expect(await setUserStatus('user:does-not-exist', 'disabled', { reason: 'admin' })).toBeNull();
    await drain();
    expect(ofType(USER_DEACTIVATED_EVENT)).toHaveLength(1);
  });

  it('CONCURRENT re-enables (review SHOULD-3): two setUserStatus(active) racing on one disabled row emit exactly ONE reactivated', async () => {
    const u = await createUser({ tenantId: T, principalId: 'oidc:race', source: 'oidc' });
    await setUserStatus(u.userId, 'disabled', { reason: 'admin' });
    await drain();
    // Both read the disabled row before either writes. What this guards: the
    // transition is decided INSIDE the CAS mutate, on the row the write lands
    // on — the CAS loser re-reads `active` and emits nothing. A `changed`
    // decided on the stale pre-read (or latched across CAS attempts) emits
    // twice. (Removing only the "no write when unchanged" short-circuit does NOT
    // turn this red, and is not what it claims: the loser's retry still
    // re-decides `changed` = false.)
    const [a, b] = await Promise.all([
      setUserStatus(u.userId, 'active', { reason: 'admin' }),
      setUserStatus(u.userId, 'active', { reason: 'scim' }),
    ]);
    expect(a?.status).toBe('active');
    expect(b?.status).toBe('active');
    await drain();
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
    await drain();
    const ev = ofType(USER_DEACTIVATED_EVENT)[0]!;
    expect(ev.payload.source).toBe('scim');
    expect(ev.payload.reason).toBe('admin');
  });

  it('SCIM lanes carry reason:scim, and the D5 retry on an already-disabled row starts NO second run', async () => {
    const u = await provisionUser({ tenantId: T, userName: 'scim.leaver', externalId: 'ext-leaver' });
    await createHostEventBinding({ tenantId: T, eventType: USER_DEACTIVATED_EVENT, workflowId: 'wf:offboarding', createdBy: 'test' });
    await deactivateUser({ tenantId: T, externalId: 'ext-leaver' });
    await drain();
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
    await drain();
    expect(ofType(USER_DEACTIVATED_EVENT)).toHaveLength(1);
    expect(startRunCalls).toHaveLength(1);

    // Re-hire: one reactivated, and it clears the deny.
    await setScimActive((await getUser(u.userId))!, true);
    await drain();
    expect(ofType(USER_REACTIVATED_EVENT)).toHaveLength(1);
    expect(ofType(USER_REACTIVATED_EVENT)[0]!.payload.reason).toBe('scim');
    expect(await isLinkedSubjectDenied(T, 'ext-leaver')).toBe(false);
  });
});

describe('ADR 0617 D1a — the chain-lineage self-trigger guard discriminates', () => {
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
  });

});
