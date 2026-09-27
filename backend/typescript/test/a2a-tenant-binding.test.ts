/**
 * ADR 0552 P2 / RFC 0152 §E — identity: `tenant` is a hint, never a selector,
 * and a task the caller cannot read is INDISTINGUISHABLE from one that does not
 * exist.
 *
 * Two real principals against one real store, because the failure this guards
 * is only visible with two: a codec that ignores the binding entirely passes
 * every single-tenant test ever written. The store is the production
 * `DurableCollection` over `memory://` storage and the runs are real runs —
 * a stubbed store would be asserting the stub's isolation, not the host's.
 *
 * @see spec/v1/a2a-integration.md §"A2A 1.0 versioned composition" §E
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleA2aRequest10 } from '../src/host/a2aServer10.js';
import { handleA2aRequest } from '../src/host/a2aServer.js';
import { initHostExtPersistence, purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { A2aPrincipal, A2aServiceDeps } from '../src/host/a2aService.js';
import { __resetA2aTaskStore, getA2aMessageClaim, getA2aTask, upsertA2aTask } from '../src/host/a2aTaskStore.js';

let storage: Storage;
let deps: A2aServiceDeps;

const ALICE: A2aPrincipal = { tenantId: 'tenant-alice', principalId: 'p-alice', protocolVersion: '1.0' };
const MALLORY: A2aPrincipal = { tenantId: 'tenant-mallory', principalId: 'p-mallory', protocolVersion: '1.0' };

function req(method: string, params: unknown, id = 1) {
  return { jsonrpc: '2.0' as const, id, method, params: params as Record<string, unknown> };
}

async function send(principal: A2aPrincipal, method: string, params: unknown, id = 1) {
  return handleA2aRequest10(req(method, params, id), { agentCard: {}, principal, deps });
}

beforeAll(async () => {
  // The push-config leg needs the capability ON, or it short-circuits on
  // PUSH_NOTIFICATION_NOT_SUPPORTED and never reaches the §E check it exists to
  // exercise — a green that measures the wrong refusal.
  process.env.OPENWOP_A2A_DURABLE_TASKS = 'true';
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  deps = { storage, hostSuite: createHostAdapterSuite({ storage }) };
});

beforeEach(async () => {
  await __resetA2aTaskStore();
});

afterAll(() => {
  delete process.env.OPENWOP_A2A_DURABLE_TASKS;
});

/** Open a real task under `principal` and return its id (= the run id). */
async function openTask(principal: A2aPrincipal, messageId: string): Promise<string> {
  const sent = await send(principal, 'SendMessage', {
    message: { messageId, role: 'ROLE_USER', parts: [{ text: 'hello' }] },
  });
  const id = ((sent.result as { task?: { id?: string } } | undefined)?.task?.id) ?? '';
  expect(id, 'the fixture failed to open a task — every assertion below would be vacuous').not.toBe('');
  return id;
}

describe('RFC 0152 §E — no enumeration across tenants', () => {
  it('GetTask on another tenant\'s task answers TASK_NOT_FOUND, exactly as a missing id does', async () => {
    const alicesTask = await openTask(ALICE, 'm-1');
    // Non-vacuity: Alice CAN read it, so a not-found for Mallory is isolation
    // rather than a broken fixture.
    const mine = await send(ALICE, 'GetTask', { id: alicesTask }, 2);
    expect(mine.error).toBeUndefined();
    expect((mine.result as { id?: string }).id).toBe(alicesTask);

    const theirs = await send(MALLORY, 'GetTask', { id: alicesTask }, 3);
    const absent = await send(MALLORY, 'GetTask', { id: 'run_no_such_thing' }, 4);
    expect(theirs.result).toBeUndefined();
    expect(theirs.error?.code).toBe(-32001);
    // The two answers must be BYTE-identical apart from the id echoed back, or
    // the difference is the enumeration oracle §E forbids.
    expect(theirs.error?.data).toEqual(absent.error?.data);
    expect(theirs.error?.code).toBe(absent.error?.code);
    // ADR 0744 — and the shared answer is the A2A 1.0.1 §9.5 `Any[]` with no
    // metadata at all, so the equality above compares real ErrorInfo content
    // rather than two empty objects (an `Object.keys` comparison of a
    // one-element array would be `["0"]` either way — vacuous).
    expect(absent.error?.data).toEqual([
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org' },
    ]);
  });

  it('CancelTask on another tenant\'s task is TASK_NOT_FOUND and does NOT move the run', async () => {
    const alicesTask = await openTask(ALICE, 'm-2');
    const before = await storage.getRun(alicesTask);
    const denied = await send(MALLORY, 'CancelTask', { id: alicesTask }, 5);
    expect(denied.error?.code).toBe(-32001);
    expect(denied.error?.data).toEqual([
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org' },
    ]);
    // The dangerous half: a refused cancel that cancelled anyway.
    expect((await storage.getRun(alicesTask))?.status).toBe(before?.status);
  });

  it('ListTasks never returns another tenant\'s task', async () => {
    const alicesTask = await openTask(ALICE, 'm-3');
    await openTask(MALLORY, 'm-4');
    const listed = await send(MALLORY, 'ListTasks', {}, 6);
    const ids = ((listed.result as { tasks?: Array<{ id?: string }> }).tasks ?? []).map((t) => t.id);
    expect(ids).not.toContain(alicesTask);
    // Non-vacuity: Mallory sees her OWN task, so the filter is not "return
    // nothing".
    expect(ids.length).toBeGreaterThan(0);
  });

  it('a push config cannot be attached to (or used to probe for) another tenant\'s task', async () => {
    const alicesTask = await openTask(ALICE, 'm-5');
    const denied = await send(
      MALLORY,
      'CreateTaskPushNotificationConfig',
      { taskId: alicesTask, url: 'https://cb.example/hook' },
      7,
    );
    expect(denied.error?.code).toBe(-32001);
    expect((await getA2aTask(alicesTask))?.pushConfig).toBeUndefined();
  });
});

describe('RFC 0152 §E — `tenant` is a hint, never a selector', () => {
  it('a disagreeing tenant hint is NEUTRALIZED to the principal\'s binding', async () => {
    // The run must be created in Mallory's tenant, not the one she asked for,
    // and nothing in the answer may reveal whether `tenant-alice` exists.
    const sent = await send(MALLORY, 'SendMessage', {
      tenant: ALICE.tenantId,
      message: { messageId: 'm-hint', role: 'ROLE_USER', parts: [{ text: 'take me to alice' }] },
    });
    const id = (sent.result as { task?: { id?: string } }).task?.id;
    expect(id).toBeDefined();
    expect((await storage.getRun(id!))?.tenantId).toBe(MALLORY.tenantId);
    expect((await getA2aTask(id!))?.tenantId).toBe(MALLORY.tenantId);
    // And the hint is not echoed back as if it had been honoured.
    expect(JSON.stringify(sent.result)).not.toContain(ALICE.tenantId);
  });

  it('a ListTasks tenant hint does not widen the result', async () => {
    const alicesTask = await openTask(ALICE, 'm-6');
    await openTask(MALLORY, 'm-7');
    const listed = await send(MALLORY, 'ListTasks', { tenant: ALICE.tenantId }, 8);
    const ids = ((listed.result as { tasks?: Array<{ id?: string }> }).tasks ?? []).map((t) => t.id);
    expect(ids).not.toContain(alicesTask);
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe('ADR 0464 / ADR 0284 — the tenant-teardown claim is enforced, not asserted', () => {
  it('tenant teardown reaches BOTH the a2a task row and its messageId claim', async () => {
    // `subject-erasure-coverage.test.ts` exempts `a2a:task` and `a2a:msgclaim`
    // with `tenantTeardownClaim: true`. That registry entry is prose; this is
    // the check. The claim row is the one at risk: its identity lives in a
    // COMPOSITE KEY, so before `tenantId` was denormalized onto it the purge
    // could reach neither through `tenantOf` nor through the JSON probe, and
    // the row would have outlived the task it points at.
    const taskId = await openTask(ALICE, 'm-teardown');
    expect(await getA2aMessageClaim(ALICE.tenantId, ALICE.principalId, 'm-teardown')).toBe(taskId);

    await purgeTenantHostExt(ALICE.tenantId);

    expect(await getA2aTask(taskId), 'the durable task survived tenant teardown').toBeNull();
    expect(
      await getA2aMessageClaim(ALICE.tenantId, ALICE.principalId, 'm-teardown'),
      'the messageId claim survived tenant teardown — the exemption reason would be false',
    ).toBeNull();
  });

  it('teardown of ANOTHER tenant leaves these rows alone', async () => {
    // Non-vacuity: a purge that deleted everything would pass the case above.
    const taskId = await openTask(ALICE, 'm-teardown-2');
    await purgeTenantHostExt(MALLORY.tenantId);
    expect(await getA2aTask(taskId)).not.toBeNull();
    expect(await getA2aMessageClaim(ALICE.tenantId, ALICE.principalId, 'm-teardown-2')).toBe(taskId);
  });
});

describe('ADR 0552 P2 — the strict / legacy read arms are BOTH real', () => {
  it('the 1.0 arm is STRICT: an unbound pre-P2 record is unreadable, not readable-by-all', async () => {
    // The permissive-resolver trap: a single lenient rule would serve unbound
    // rows to every tenant forever and nothing would notice, because the
    // migration has no deadline. 1.0 requires the binding.
    await upsertA2aTask({ taskId: 'legacy-task', runId: 'legacy-task', state: 'working' });
    const got = await send(ALICE, 'GetTask', { id: 'legacy-task' }, 9);
    expect(got.result).toBeUndefined();
    expect(got.error?.code).toBe(-32001);
  });

  it('the 0.3 arm is LEGACY: the same unbound record IS readable, so no existing peer loses its task', async () => {
    await upsertA2aTask({ taskId: 'legacy-task', runId: 'legacy-task', state: 'working' });
    const got = await handleA2aRequest(req('tasks/get', { id: 'legacy-task' }, 10), {
      agentCard: {},
      durableTasks: true,
      tenantId: ALICE.tenantId,
    });
    expect(got.error).toBeUndefined();
    expect((got.result as { id?: string }).id).toBe('legacy-task');
  });

  it('the 0.3 arm still refuses a record BOUND to another tenant', async () => {
    // Leniency is scoped to "no binding", not to "0.3". A bound record is a
    // decision someone made; the legacy arm does not undo it.
    await upsertA2aTask({ taskId: 'bound-task', runId: 'bound-task', state: 'working', tenantId: ALICE.tenantId });
    const got = await handleA2aRequest(req('tasks/get', { id: 'bound-task' }, 11), {
      agentCard: {},
      durableTasks: true,
      tenantId: MALLORY.tenantId,
    });
    expect(got.result).toBeUndefined();
    expect(got.error?.code).toBe(-32001);
  });
});
