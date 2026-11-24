/**
 * Proposed workspaceClient foundation2463 contract cases, native UNRUN.
 * The subject is the real exported staged client. Only transport, config-event
 * delivery/cache observation, and unused requestJson notification imports are
 * controlled. No copy of the attempt/proof owner algorithm lives in this test.
 * This does NOT qualify config fan-out, UID/bootstrap, React/caller atomicity,
 * new-realm remote settlement, or backend authority.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyWorkspaces, WorkspaceSummary } from '../workspaceClient.js';

const seam = vi.hoisted(() => ({
  unsubscribers: new Set<() => void>(),
  emit: null as (() => void) | null,
  headerHook: null as (() => void) | null,
  remembered: vi.fn<(tenant: string) => void>(),
}));
// Delegate event identity/registration/fan-out to REAL config. Only header
// reentrancy and per-case subscription cleanup are wrapped, never mirrored.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  seam.emit = () => { actual.fireAuthChanged(); };
  return {
    ...actual,
    config: { ...actual.config, baseUrl: 'https://workspace.test.invalid' },
    onAuthChange: (listener: Parameters<typeof actual.onAuthChange>[0]) => {
      const unsubscribe = actual.onAuthChange(listener);
      seam.unsubscribers.add(unsubscribe);
      return () => { unsubscribe(); seam.unsubscribers.delete(unsubscribe); };
    },
    authedHeaders: (extra?: Record<string, string>) => {
      const hook = seam.headerHook;
      seam.headerHook = null;
      hook?.();
      return actual.authedHeaders(extra);
    },
  };
});
vi.mock('../v2Wire.js', () => ({ rememberWireTenant: seam.remembered }));
// Keep actual ApiError; these notification functions belong to requestJson's
// other export and are never part of workspaceClient's asJson operation.
vi.mock('../entitlementRefresh.js', () => ({ noteRequestStatus: vi.fn() }));
vi.mock('../sessionRefusal.js', () => ({ noteSessionRefusal: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ kind: 'fulfilled' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function workspaces(active = 'A'): MyWorkspaces {
  return {
    active, personal: 'personal',
    workspaces: [{ workspaceId: active, name: active, slug: active.toLowerCase(),
      roles: ['owner'], kind: 'shared', active: true, chatAgent: 'strategist' }],
  };
}
function created(workspaceId = 'C'): WorkspaceSummary {
  return { workspaceId, name: 'Created', slug: 'created', roles: ['owner'], kind: 'shared', active: false };
}
function authChanged(): void {
  const emit = seam.emit;
  if (!emit) throw new Error('config_fixture_not_initialized');
  emit();
}

let client: typeof import('../workspaceClient.js');
let fetchMock = vi.fn<typeof fetch>();
beforeEach(async () => {
  vi.resetModules();
  for (const unsubscribe of Array.from(seam.unsubscribers)) unsubscribe();
  seam.unsubscribers.clear();
  seam.headerHook = null;
  seam.remembered.mockReset();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  client = await import('../workspaceClient.js');
});
afterEach(() => {
  for (const unsubscribe of Array.from(seam.unsubscribers)) unsubscribe();
  seam.unsubscribers.clear();
  vi.unstubAllGlobals();
});

async function accepted(active = 'A') {
  fetchMock.mockResolvedValueOnce(json(workspaces(active)));
  const proof = await client.revalidateWorkspace();
  expect(client.isCurrentWorkspaceRead(proof), 'positive admission before retirement control').toBe(true);
  return proof;
}

describe('workspaceClient transition foundation — real exports', () => {
  it('issues a current accepted server projection, not ACK-ready or caller authority', async () => {
    expect(client.getWorkspaceTransitionSnapshot().phase).toBe('unverified');
    const raw = { ...workspaces(), ignoredConfiguration: { prompt: 'not exported' } };
    fetchMock.mockResolvedValueOnce(json(raw));
    const proof = await client.revalidateWorkspace();
    expect(proof.result.active).toBe('A');
    expect(proof.result.workspaces[0]?.roles).toEqual(['owner']);
    expect(Reflect.has(proof.result, 'ignoredConfiguration')).toBe(false);
    expect(client.isCurrentWorkspaceRead(proof)).toBe(true);
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'ready', pendingCount: 0 });
    expect(seam.remembered.mock.calls).toEqual([['A']]);
  });

  it('copies decoded aliases and makes returned proof, root, array, rows and roles immutable', async () => {
    const raw = workspaces();
    const res = json(raw);
    vi.spyOn(res, 'json').mockResolvedValue(raw); // EXACT decoded object alias, not a JSON reparse copy
    fetchMock.mockResolvedValueOnce(res);
    const proof = await client.revalidateWorkspace();
    const issuedResult = proof.result;
    expect(proof.result).not.toBe(raw);
    expect(proof.result.workspaces).not.toBe(raw.workspaces);
    expect(proof.result.workspaces[0]?.roles).not.toBe(raw.workspaces[0]?.roles);
    raw.active = 'changed';
    raw.workspaces[0]!.roles.push('injected');
    raw.workspaces.push(created('raw-array-injected'));
    expect(Reflect.set(proof, 'result', workspaces('forged-proof-result'))).toBe(false);
    expect(Reflect.set(proof.result, 'active', 'changed')).toBe(false);
    expect(Reflect.set(proof.result.workspaces, '0', created('exposed-array-injected'))).toBe(false);
    expect(Reflect.set(proof.result.workspaces[0]!, 'workspaceId', 'changed')).toBe(false);
    expect(Reflect.set(proof.result.workspaces[0]!.roles, '0', 'injected')).toBe(false);
    expect(proof.result).toBe(issuedResult);
    expect(proof.result.active).toBe('A');
    expect(proof.result.workspaces).toHaveLength(1);
    expect(proof.result.workspaces[0]?.workspaceId).toBe('A');
    expect(proof.result.workspaces[0]?.roles).toEqual(['owner']);
    expect(client.isCurrentWorkspaceRead(proof)).toBe(true);
  });

  it('rejects copied, altered and proxy proof identities while the issued proof remains current', async () => {
    const proof = await accepted();
    expect(client.isCurrentWorkspaceRead({ ...proof })).toBe(false);
    expect(client.isCurrentWorkspaceRead({ ...proof, result: { ...proof.result, active: 'other' } })).toBe(false);
    expect(client.isCurrentWorkspaceRead(new Proxy(proof, {}))).toBe(false);
    expect(client.isCurrentWorkspaceRead(proof)).toBe(true);
  });

  it('denies an active workspace absent from the actual server-listed projection', async () => {
    const prior = await accepted();
    seam.remembered.mockClear();
    const absent = workspaces();
    absent.active = 'not-listed';
    absent.workspaces[0]!.active = false; // Coherent row flags reach the actual membership guard.
    fetchMock.mockResolvedValueOnce(json(absent));
    await expect(client.revalidateWorkspace()).rejects.toThrow('workspace_read_response_invalid');
    expect(client.getWorkspaceTransitionSnapshot().phase).toBe('failed');
    expect(client.isCurrentWorkspaceRead(prior)).toBe(false);
    expect(seam.remembered).not.toHaveBeenCalled();
  });

  it('admits concurrent successful reads without retiring their shared current lifetime', async () => {
    const a = deferred<Response>(); const b = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = client.revalidateWorkspace(); const second = client.revalidateWorkspace();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    a.resolve(json(workspaces())); const firstProof = await first;
    b.resolve(json(workspaces())); const secondProof = await second;
    expect(client.isCurrentWorkspaceRead(firstProof)).toBe(true);
    expect(client.isCurrentWorkspaceRead(secondProof)).toBe(true);
  });

  it('observed auth renewal retires an issued proof and requires a fresh proof identity', async () => {
    const old = await accepted();
    const oldAuth = client.getWorkspaceTransitionSnapshot().authRevision;
    authChanged();
    expect(client.isCurrentWorkspaceRead(old)).toBe(false);
    expect(client.getWorkspaceTransitionSnapshot().authRevision).not.toBe(oldAuth);
    expect(client.getWorkspaceTransitionSnapshot().phase).toBe('unverified');
    const renewed = await accepted();
    expect(renewed).not.toBe(old);
    expect(client.isCurrentWorkspaceRead(old)).toBe(false);
    expect(client.isCurrentWorkspaceRead(renewed)).toBe(true);
  });

  it('preserves legacy list/create-only payload behavior without granting proof', async () => {
    fetchMock.mockResolvedValueOnce(json(workspaces())).mockResolvedValueOnce(json(created()));
    expect((await client.listMyWorkspaces()).active).toBe('A');
    expect(await client.createWorkspace({ name: 'Created' })).toEqual(created());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/\/workspaces$/);
    expect(seam.remembered.mock.calls).toEqual([['A']]);
    expect(client.getWorkspaceTransitionSnapshot().phase).toBe('unverified');
  });

  it('does not warm a legacy list response captured before auth changed', async () => {
    const held = deferred<Response>(); fetchMock.mockReturnValueOnce(held.promise);
    const list = client.listMyWorkspaces();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    authChanged(); held.resolve(json(workspaces()));
    expect((await list).active).toBe('A');
    expect(seam.remembered).not.toHaveBeenCalled();
  });

  it('stale read success cannot warm or replace a newer ready proof', async () => {
    const held = deferred<Response>(); fetchMock.mockReturnValueOnce(held.promise);
    const old = observe(client.revalidateWorkspace());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    authChanged(); const fresh = await accepted('B');
    const ready = client.getWorkspaceTransitionSnapshot();
    held.resolve(json(workspaces('A')));
    expect(await old).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(client.isCurrentWorkspaceRead(fresh)).toBe(true);
    expect(seam.remembered.mock.calls).toEqual([['B']]);
  });

  it('stale read failure cannot fail a newer ready proof', async () => {
    const held = deferred<Response>(); fetchMock.mockReturnValueOnce(held.promise);
    const old = observe(client.revalidateWorkspace());
    authChanged(); const fresh = await accepted('B');
    const ready = client.getWorkspaceTransitionSnapshot();
    held.reject(new TypeError('held old read failed'));
    expect(await old).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(client.isCurrentWorkspaceRead(fresh)).toBe(true);
    expect(seam.remembered.mock.calls).toEqual([['B']]);
  });

  it('invalidates inside the first switch fetch and requires GET after successful ACK', async () => {
    const prior = await accepted(); seam.remembered.mockClear();
    const held = deferred<Response>();
    fetchMock.mockImplementationOnce(async () => {
      expect(client.isCurrentWorkspaceRead(prior)).toBe(false);
      expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
      return held.promise;
    });
    const switching = client.switchWorkspace('B');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    held.resolve(json({ ok: true, active: 'B' }));
    expect(await switching).toEqual({ ok: true, active: 'B' });
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });
    expect(client.isCurrentWorkspaceRead(prior)).toBe(false);
    expect(seam.remembered.mock.calls).toEqual([['B']]);
    await accepted('B');
  });

  it('invalidates before CREATE fetch and keeps one claim through create-and-enter', async () => {
    const prior = await accepted(); seam.remembered.mockClear();
    const create = deferred<Response>(); const enter = deferred<Response>(); const entered = deferred<void>();
    fetchMock.mockImplementationOnce(async () => {
      expect(client.isCurrentWorkspaceRead(prior)).toBe(false);
      expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
      return create.promise;
    }).mockImplementationOnce(async () => { entered.resolve(); return enter.promise; });
    const operation = client.createAndEnterWorkspace('Created');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    create.resolve(json(created())); await entered.promise;
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
    expect(String(fetchMock.mock.calls[2]![0])).toMatch(/\/workspaces\/C\/switch$/);
    enter.resolve(json({ ok: true, active: 'C' }));
    expect(await operation).toEqual(created());
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });
    expect(seam.remembered.mock.calls).toEqual([['C']]);
  });

  it('newer-first overlap rejects both normal completions and settles only each own claim', async () => {
    const a = deferred<Response>(); const b = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const old = observe(client.switchWorkspace('A')); const newer = observe(client.switchWorkspace('B'));
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 2 });
    b.resolve(json({ ok: true, active: 'B' }));
    expect(await newer).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_overlap' } });
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
    a.resolve(json({ ok: true, active: 'A' }));
    expect(await old).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });
    expect(seam.remembered).not.toHaveBeenCalled();
  });

  it('older-first cleanup leaves newer claim intact and permits only the current completion', async () => {
    const a = deferred<Response>(); const b = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const old = observe(client.switchWorkspace('A')); const newer = observe(client.switchWorkspace('B'));
    a.resolve(json({ ok: true, active: 'A' }));
    expect(await old).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
    b.resolve(json({ ok: true, active: 'B' }));
    expect(await newer).toEqual({ kind: 'fulfilled', value: { ok: true, active: 'B' } });
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });
    expect(seam.remembered.mock.calls).toEqual([['B']]);
  });

  it('stale HTTP failure after auth cannot release the newer owner claim', async () => {
    const a = deferred<Response>(); const b = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const old = observe(client.switchWorkspace('A')); authChanged();
    const newer = observe(client.switchWorkspace('B'));
    const currentAuth = client.getWorkspaceTransitionSnapshot().authRevision;
    a.resolve(json({ message: 'denied old owner' }, 403));
    expect(await old).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1, authRevision: currentAuth });
    b.resolve(json({ ok: true, active: 'B' }));
    expect(await newer).toMatchObject({ kind: 'fulfilled', value: { active: 'B' } });
    expect(seam.remembered.mock.calls).toEqual([['B']]);
  });

  it('auth change while response body is held rejects old success without warming', async () => {
    const body = deferred<unknown>(); const reading = deferred<void>();
    const res = json({ ok: true, active: 'A' });
    vi.spyOn(res, 'json').mockImplementation(() => { reading.resolve(); return body.promise; });
    fetchMock.mockResolvedValueOnce(res);
    const operation = observe(client.switchWorkspace('A')); await reading.promise;
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
    authChanged(); body.resolve({ ok: true, active: 'A' });
    expect(await operation).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });
    expect(seam.remembered).not.toHaveBeenCalled();
  });

  it('superseded create ACK cannot enter or claim that creation was rolled back', async () => {
    const create = deferred<Response>(); const b = deferred<Response>();
    fetchMock.mockReturnValueOnce(create.promise).mockReturnValueOnce(b.promise);
    const old = observe(client.createAndEnterWorkspace('Created'));
    const newer = observe(client.switchWorkspace('B'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    create.resolve(json(created()));
    expect(await old).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired', creationMayHaveCompleted: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2); // no third fetch to enter C
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
    b.resolve(json({ ok: true, active: 'B' }));
    expect(await newer).toMatchObject({ kind: 'fulfilled', value: { active: 'B' } });
    expect(seam.remembered.mock.calls).toEqual([['B']]);
  });

  it('header-preparation auth renewal retires before dispatch', async () => {
    const prior = await accepted(); seam.remembered.mockClear(); fetchMock.mockClear();
    seam.headerHook = authChanged;
    await expect(client.switchWorkspace('B')).rejects.toMatchObject({ code: 'workspace_transition_retired' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.isCurrentWorkspaceRead(prior)).toBe(false);
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });
    expect(seam.remembered).not.toHaveBeenCalled();
  });

  it('throwing/reentrant own subscribers cannot dispatch superseded A or erase B', async () => {
    const held = deferred<Response>(); fetchMock.mockReturnValueOnce(held.promise);
    const started = deferred<{ operation: Promise<{ ok: boolean; active: string }> }>();
    client.subscribeWorkspaceTransition(() => { throw new Error('observer'); });
    let unsubscribe = () => {};
    unsubscribe = client.subscribeWorkspaceTransition(() => {
      unsubscribe();
      started.resolve({ operation: client.switchWorkspace('B') });
    });
    const a = observe(client.switchWorkspace('A')); const b = await started.promise;
    expect(await a).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/workspaces\/B\/switch$/);
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
    held.resolve(json({ ok: true, active: 'B' }));
    expect(await b.operation).toEqual({ ok: true, active: 'B' });
    expect(seam.remembered.mock.calls).toEqual([['B']]);
  });

  it('known HTTP refusal is failed and recoverable by a fresh GET, not uncertainty or success', async () => {
    const prior = await accepted(); seam.remembered.mockClear();
    fetchMock.mockResolvedValueOnce(json({ message: 'not allowed' }, 403));
    await expect(client.switchWorkspace('B')).rejects.toMatchObject({ name: 'ApiError', status: 403, message: 'not allowed' });
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'failed', pendingCount: 0 });
    expect(client.isCurrentWorkspaceRead(prior)).toBe(false);
    expect(seam.remembered).not.toHaveBeenCalled();
    await accepted('A');
  });

  it('unknown dispatched transport remains uncertain through auth and refuses new owned work', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('transport failed after invocation'));
    await expect(client.switchWorkspace('A')).rejects.toMatchObject({ code: 'workspace_transition_uncertain' });
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'uncertain', pendingCount: 0 });
    authChanged();
    await expect(client.revalidateWorkspace()).rejects.toMatchObject({ code: 'workspace_transition_uncertain' });
    await expect(client.switchWorkspace('B')).rejects.toMatchObject({ code: 'workspace_transition_uncertain' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.getWorkspaceTransitionSnapshot().phase).toBe('uncertain');
    expect(seam.remembered).not.toHaveBeenCalled();
  });

  // 2563: accepted-target contradictions are local observed evidence. These
  // cases keep the real client/config subject and observe only public proof,
  // snapshot and the existing tenant-cache write seam.
  it('retires an accepted A proof when B is accepted and notifies predicate consumers', async () => {
    const a = await accepted('A');
    const aReady = client.getWorkspaceTransitionSnapshot();
    const observations: { aCurrent: boolean; phase: string }[] = [];
    const changed = vi.fn(() => {
      observations.push({ aCurrent: client.isCurrentWorkspaceRead(a),
        phase: client.getWorkspaceTransitionSnapshot().phase });
    });
    const unsubscribe = client.subscribeWorkspaceTransition(changed);
    const b = await accepted('B');
    const bReady = client.getWorkspaceTransitionSnapshot();
    expect(client.isCurrentWorkspaceRead(a)).toBe(false);
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    expect(bReady).not.toBe(aReady);
    expect(bReady.authRevision).toBe(aReady.authRevision);
    expect(bReady.revision).toBe(aReady.revision);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([{ aCurrent: false, phase: 'ready' }]);
    const freshB = await accepted('B');
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    expect(client.isCurrentWorkspaceRead(freshB)).toBe(true);
    expect(client.getWorkspaceTransitionSnapshot()).toBe(bReady);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(seam.remembered.mock.calls).toEqual([['A'], ['B'], ['B']]);
    unsubscribe();
  });

  it('A to B to A never reactivates either retired issued proof', async () => {
    const oldA = await accepted('A');
    const b = await accepted('B');
    expect(client.isCurrentWorkspaceRead(oldA)).toBe(false);
    const currentA = await accepted('A');
    expect(client.isCurrentWorkspaceRead(oldA)).toBe(false);
    expect(client.isCurrentWorkspaceRead(b)).toBe(false);
    expect(client.isCurrentWorkspaceRead(currentA)).toBe(true);
    expect(currentA).not.toBe(oldA);
    const freshA = await accepted('A');
    expect(client.isCurrentWorkspaceRead(oldA)).toBe(false);
    expect(client.isCurrentWorkspaceRead(currentA)).toBe(true);
    expect(client.isCurrentWorkspaceRead(freshA)).toBe(true);
    expect(seam.remembered.mock.calls).toEqual([['A'], ['B'], ['A'], ['A']]);
  });

  it('rejects an older held A after accepted B before any stale cache warming', async () => {
    const priorA = await accepted('A');
    const held = deferred<Response>();
    fetchMock.mockReturnValueOnce(held.promise);
    const oldA = observe(client.revalidateWorkspace());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/\/me\/workspaces$/);
    const b = await accepted('B');
    const ready = client.getWorkspaceTransitionSnapshot();
    expect(client.isCurrentWorkspaceRead(priorA)).toBe(false);
    seam.remembered.mockClear();
    held.resolve(json(workspaces('A')));
    expect(await oldA).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    expect(seam.remembered).not.toHaveBeenCalled();
    const freshB = await accepted('B');
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    expect(client.isCurrentWorkspaceRead(freshB)).toBe(true);
    expect(seam.remembered.mock.calls).toEqual([['B']]);
  });

  it('does not revive a held old A when newer accepted targets return from B to A', async () => {
    const priorA = await accepted('A');
    const held = deferred<Response>();
    fetchMock.mockReturnValueOnce(held.promise);
    const oldA = observe(client.revalidateWorkspace());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const b = await accepted('B');
    const currentA = await accepted('A');
    const ready = client.getWorkspaceTransitionSnapshot();
    expect(client.isCurrentWorkspaceRead(priorA)).toBe(false);
    expect(client.isCurrentWorkspaceRead(b)).toBe(false);
    seam.remembered.mockClear();
    held.resolve(json(workspaces('A')));
    expect(await oldA).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(client.isCurrentWorkspaceRead(currentA)).toBe(true);
    expect(client.isCurrentWorkspaceRead(priorA)).toBe(false);
    expect(seam.remembered).not.toHaveBeenCalled();
    const freshA = await accepted('A');
    expect(client.isCurrentWorkspaceRead(currentA)).toBe(true);
    expect(client.isCurrentWorkspaceRead(freshA)).toBe(true);
  });

  it('admits reverse-completion A reads without retiring either same-target proof', async () => {
    const first = deferred<Response>(); const second = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const older = client.revalidateWorkspace(); const newer = client.revalidateWorkspace();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.resolve(json(workspaces('A'))); const newerA = await newer;
    expect(client.isCurrentWorkspaceRead(newerA)).toBe(true);
    const ready = client.getWorkspaceTransitionSnapshot();
    first.resolve(json(workspaces('A'))); const olderA = await older;
    expect(client.isCurrentWorkspaceRead(olderA)).toBe(true);
    expect(client.isCurrentWorkspaceRead(newerA)).toBe(true);
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(seam.remembered.mock.calls).toEqual([['A'], ['A']]);
  });

  it('admits both reverse-completion B reads even when their first acceptance contradicts prior A', async () => {
    const a = await accepted('A');
    const first = deferred<Response>(); const second = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const older = client.revalidateWorkspace(); const newer = client.revalidateWorkspace();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    second.resolve(json(workspaces('B'))); const newerB = await newer;
    expect(client.isCurrentWorkspaceRead(newerB)).toBe(true);
    expect(client.isCurrentWorkspaceRead(a)).toBe(false);
    const ready = client.getWorkspaceTransitionSnapshot();
    first.resolve(json(workspaces('B'))); const olderB = await older;
    expect(client.isCurrentWorkspaceRead(olderB)).toBe(true);
    expect(client.isCurrentWorkspaceRead(newerB)).toBe(true);
    expect(client.isCurrentWorkspaceRead(a)).toBe(false);
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(seam.remembered.mock.calls).toEqual([['A'], ['B'], ['B']]);
  });

  it('admits newer concurrent B after earlier A resolves instead of blanket retiring concurrent reads', async () => {
    const first = deferred<Response>(); const second = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const older = client.revalidateWorkspace(); const newer = client.revalidateWorkspace();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    first.resolve(json(workspaces('A'))); const a = await older;
    expect(client.isCurrentWorkspaceRead(a)).toBe(true);
    second.resolve(json(workspaces('B'))); const b = await newer;
    expect(client.isCurrentWorkspaceRead(a)).toBe(false);
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    expect(seam.remembered.mock.calls).toEqual([['A'], ['B']]);
  });

  it('an older read transport failure cannot fail the newer accepted B projection', async () => {
    await accepted('A');
    const held = deferred<Response>();
    fetchMock.mockReturnValueOnce(held.promise);
    const older = observe(client.revalidateWorkspace());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const b = await accepted('B');
    const ready = client.getWorkspaceTransitionSnapshot();
    seam.remembered.mockClear();
    held.reject(new TypeError('held old read failed after B acceptance'));
    expect(await older).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(seam.remembered).not.toHaveBeenCalled();
    await accepted('B');
  });

  it('an older malformed read cannot fail the newer accepted B projection', async () => {
    await accepted('A');
    const held = deferred<Response>();
    fetchMock.mockReturnValueOnce(held.promise);
    const older = observe(client.revalidateWorkspace());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const b = await accepted('B');
    const ready = client.getWorkspaceTransitionSnapshot();
    seam.remembered.mockClear();
    held.resolve(json({ active: 'A', personal: 'personal', workspaces: null }));
    expect(await older).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(seam.remembered).not.toHaveBeenCalled();
    await accepted('B');
  });

  it('target-retirement notification cannot bypass a reentrant mutation fence or warm B', async () => {
    const a = await accepted('A');
    seam.remembered.mockClear();
    const switching = deferred<Response>();
    fetchMock.mockResolvedValueOnce(json(workspaces('B'))).mockReturnValueOnce(switching.promise);
    const started = deferred<{ operation: Promise<{ ok: boolean; active: string }> }>();
    let unsubscribe = () => {};
    unsubscribe = client.subscribeWorkspaceTransition(() => {
      unsubscribe();
      started.resolve({ operation: client.switchWorkspace('C') });
    });
    const b = observe(client.revalidateWorkspace());
    expect(await b).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    const c = await started.promise;
    expect(client.isCurrentWorkspaceRead(a)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]![0])).toMatch(/\/workspaces\/C\/switch$/);
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
    expect(seam.remembered).not.toHaveBeenCalled();
    switching.resolve(json({ ok: true, active: 'C' }));
    expect(await c.operation).toEqual({ ok: true, active: 'C' });
    expect(seam.remembered.mock.calls).toEqual([['C']]);
    await accepted('C');
  });

  // 2568: qB precedes qA, but both are captured while accepted A is still
  // current. Invocation order cannot renew that retired observed-target owner.
  it('retires later-invoked held A captured before B acceptance without warming or downgrading B', async () => {
    const priorA = await accepted('A');
    const heldB = deferred<Response>(); const heldA = deferred<Response>();
    fetchMock.mockReturnValueOnce(heldB.promise).mockReturnValueOnce(heldA.promise);
    const readingB = client.revalidateWorkspace();
    const oldA = observe(client.revalidateWorkspace());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/\/me\/workspaces$/);
    expect(String(fetchMock.mock.calls[2]![0])).toMatch(/\/me\/workspaces$/);
    expect(client.isCurrentWorkspaceRead(priorA)).toBe(true);
    heldB.resolve(json(workspaces('B'))); const b = await readingB;
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    expect(client.isCurrentWorkspaceRead(priorA)).toBe(false);
    const ready = client.getWorkspaceTransitionSnapshot();
    seam.remembered.mockClear();
    heldA.resolve(json(workspaces('A')));
    expect(await oldA).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    expect(seam.remembered).not.toHaveBeenCalled();
    const freshB = await accepted('B');
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    expect(client.isCurrentWorkspaceRead(freshB)).toBe(true);
    expect(seam.remembered.mock.calls).toEqual([['B']]);
  });

  it('a later-invoked pre-B A cannot join the genuinely fresh post-B A lifetime', async () => {
    const priorA = await accepted('A');
    const heldB = deferred<Response>(); const heldA = deferred<Response>();
    fetchMock.mockReturnValueOnce(heldB.promise).mockReturnValueOnce(heldA.promise);
    const readingB = client.revalidateWorkspace();
    const oldA = observe(client.revalidateWorkspace());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(client.isCurrentWorkspaceRead(priorA)).toBe(true);
    heldB.resolve(json(workspaces('B'))); const b = await readingB;
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    const freshA = await accepted('A'); // actually invoked after accepted B
    expect(client.isCurrentWorkspaceRead(priorA)).toBe(false);
    expect(client.isCurrentWorkspaceRead(b)).toBe(false);
    const ready = client.getWorkspaceTransitionSnapshot();
    seam.remembered.mockClear();
    heldA.resolve(json(workspaces('A')));
    expect(await oldA).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(client.isCurrentWorkspaceRead(freshA)).toBe(true);
    expect(client.isCurrentWorkspaceRead(priorA)).toBe(false);
    expect(seam.remembered).not.toHaveBeenCalled();
    const coalescedA = await accepted('A');
    expect(client.isCurrentWorkspaceRead(freshA)).toBe(true);
    expect(client.isCurrentWorkspaceRead(coalescedA)).toBe(true);
    expect(seam.remembered.mock.calls).toEqual([['A']]);
  });

  it('later-invoked pre-B transport failure preserves the accepted B ready identity', async () => {
    const priorA = await accepted('A');
    const heldB = deferred<Response>(); const heldA = deferred<Response>();
    fetchMock.mockReturnValueOnce(heldB.promise).mockReturnValueOnce(heldA.promise);
    const readingB = client.revalidateWorkspace();
    const oldA = observe(client.revalidateWorkspace());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(client.isCurrentWorkspaceRead(priorA)).toBe(true);
    heldB.resolve(json(workspaces('B'))); const b = await readingB;
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    const ready = client.getWorkspaceTransitionSnapshot();
    seam.remembered.mockClear();
    heldA.reject(new TypeError('later invoked old-target transport failure'));
    expect(await oldA).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    expect(seam.remembered).not.toHaveBeenCalled();
    await accepted('B');
  });

  it('later-invoked pre-B malformed response preserves the accepted B ready identity', async () => {
    const priorA = await accepted('A');
    const heldB = deferred<Response>(); const heldA = deferred<Response>();
    fetchMock.mockReturnValueOnce(heldB.promise).mockReturnValueOnce(heldA.promise);
    const readingB = client.revalidateWorkspace();
    const oldA = observe(client.revalidateWorkspace());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(client.isCurrentWorkspaceRead(priorA)).toBe(true);
    heldB.resolve(json(workspaces('B'))); const b = await readingB;
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    const ready = client.getWorkspaceTransitionSnapshot();
    seam.remembered.mockClear();
    heldA.resolve(json({ active: 'A', personal: 'personal', workspaces: null }));
    expect(await oldA).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    expect(seam.remembered).not.toHaveBeenCalled();
    await accepted('B');
  });

  it('a captured A read cannot skip B and join a later freshly admitted C lifetime', async () => {
    const priorA = await accepted('A');
    const heldB = deferred<Response>(); const heldC = deferred<Response>();
    fetchMock.mockReturnValueOnce(heldB.promise).mockReturnValueOnce(heldC.promise);
    const readingB = client.revalidateWorkspace();
    const oldC = observe(client.revalidateWorkspace());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(client.isCurrentWorkspaceRead(priorA)).toBe(true);
    heldB.resolve(json(workspaces('B'))); const b = await readingB;
    expect(client.isCurrentWorkspaceRead(b)).toBe(true);
    const freshC = await accepted('C'); // captures B, rather than the old A
    const ready = client.getWorkspaceTransitionSnapshot();
    expect(client.isCurrentWorkspaceRead(b)).toBe(false);
    seam.remembered.mockClear();
    heldC.resolve(json(workspaces('C')));
    expect(await oldC).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(client.getWorkspaceTransitionSnapshot()).toBe(ready);
    expect(client.isCurrentWorkspaceRead(freshC)).toBe(true);
    expect(seam.remembered).not.toHaveBeenCalled();
    const coalescedC = await accepted('C');
    expect(client.isCurrentWorkspaceRead(freshC)).toBe(true);
    expect(client.isCurrentWorkspaceRead(coalescedC)).toBe(true);
  });
});
