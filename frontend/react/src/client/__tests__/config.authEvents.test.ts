/**
 * Real config + real workspaceClient integration2489, native UNRUN.
 * Only fetch and unused requestJson notification imports are controlled.
 * Registry generations, current events, attempts and completions are the REAL
 * production owners. No mirrored registry/owner algorithm qualifies them.
 * Scope ends at synchronous invocation; UID/backend/realm/chat remain separate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceReadProof } from '../workspaceClient.js';
vi.unmock('../config.js');
vi.unmock('../workspaceClient.js');
vi.unmock('../v2Wire.js');
vi.mock('../entitlementRefresh.js', () => ({ noteRequestStatus: vi.fn() }));
vi.mock('../sessionRefusal.js', () => ({ noteSessionRefusal: vi.fn() }));

type Config = typeof import('../config.js');
type Event = import('../config.js').AuthChangeEvent;
type Client = typeof import('../workspaceClient.js');
let config: Config;
let client: Client;
let wire: typeof import('../v2Wire.js');
let fetchMock = vi.fn<typeof fetch>();
let disposers: Array<() => void> = [];
function subscribe(listener: Parameters<Config['onAuthChange']>[0]): () => void {
  const off = config.onAuthChange(listener); disposers.push(off); return off;
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function caught(fn: () => unknown): unknown { try { fn(); } catch (error) { return error; } return undefined; }
type Observed<T> = { kind: 'fulfilled'; value: T } | { kind: 'rejected'; error: unknown };
type SwitchOutcome = Promise<Observed<{ ok: boolean; active: string }>>;
function observe<T>(promise: Promise<T>): Promise<Observed<T>> {
  return promise.then((value) => ({ kind: 'fulfilled' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }));
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function listing(active = 'A') {
  return { active, personal: 'personal', workspaces: [{ workspaceId: active, name: active,
    slug: active.toLowerCase(), roles: ['owner'], kind: 'shared', active: true }] };
}
async function loadClient(): Promise<void> { client = await import('../workspaceClient.js'); }
async function proof(active = 'A'): Promise<WorkspaceReadProof> {
  fetchMock.mockResolvedValueOnce(json(listing(active)));
  const issued = await client.revalidateWorkspace();
  expect(client.isCurrentWorkspaceRead(issued), 'actual positive proof admission').toBe(true);
  return issued;
}
async function switched(active = 'A') {
  fetchMock.mockResolvedValueOnce(json({ ok: true, active }));
  const result = await client.switchWorkspace(active);
  expect(result).toEqual({ ok: true, active });
  expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });
  return result;
}
function actions() {
  return { isCallerCurrent: vi.fn(() => true), beforeAction: vi.fn(), action: vi.fn(), failed: vi.fn() };
}
beforeEach(async () => {
  vi.resetModules(); disposers = [];
  fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetchMock);
  config = await import('../config.js'); wire = await import('../v2Wire.js');
});
afterEach(() => { for (const off of disposers) off(); vi.unstubAllGlobals(); });

describe('real config registration/event delivery', () => {
  it('publishes immutable current identity before hook/listeners and preserves same-token no-op', () => {
    const log: Array<[string, Event]> = [];
    subscribe((event) => { log.push(['listener', event]); });
    const e = config.fireAuthChanged((event) => { log.push(['hook', config.getCurrentAuthChangeEvent()]); expect(event).toBe(config.getCurrentAuthChangeEvent()); });
    expect(log).toEqual([['hook', e], ['listener', e]]);
    expect(Object.isFrozen(e)).toBe(true);
    config.setCurrentIdToken('unit-token'); const tokenEvent = config.getCurrentAuthChangeEvent();
    expect(tokenEvent).not.toBe(e); expect(tokenEvent.reason).toBe('token');
    const before = log.length; config.setCurrentIdToken('unit-token');
    expect(log).toHaveLength(before); expect(config.getCurrentAuthChangeEvent()).toBe(tokenEvent);
  });

  it('excludes hook-created registration from E and admits it positively in F', () => {
    const calls: Event[] = [];
    const e = config.fireAuthChanged(() => { subscribe((event) => { calls.push(event); }); });
    expect(calls).toEqual([]);
    const f = config.fireAuthChanged(); expect(f).not.toBe(e);
    expect(calls).toEqual([f]); expect(config.getCurrentAuthChangeEvent()).toBe(f);
  });

  it('shares duplicate active ownership without refcounts and protects re-added generation from every old disposer', () => {
    const calls: Event[] = []; const listener = (event: Event) => { calls.push(event); };
    const old1 = subscribe(listener); const old2 = subscribe(listener);
    const e = config.fireAuthChanged(); expect(calls).toEqual([e]);
    old2(); config.fireAuthChanged(); expect(calls).toEqual([e]);
    const replacement = subscribe(listener); old1(); old2();
    const f = config.fireAuthChanged(); expect(calls).toEqual([e, f]);
    replacement(); replacement(); config.fireAuthChanged(); expect(calls).toEqual([e, f]);
  });

  it('hook duplicate of an active callback preserves its existing E slot and shared disposer', () => {
    const log: Array<[string, Event]> = [];
    subscribe((event) => { log.push(['A', event]); });
    const listener = (event: Event) => { log.push(['L', event]); };
    const first = subscribe(listener); let duplicate = () => {};
    const e = config.fireAuthChanged(() => { duplicate = subscribe(listener); });
    expect(log).toEqual([['A', e], ['L', e]]);
    duplicate(); const f = config.fireAuthChanged();
    expect(log.slice(2)).toEqual([['A', f]]); first();
  });

  it('hook remove/re-add cannot inherit E and appends to the future insertion order', () => {
    const log: Array<[string, Event]> = [];
    subscribe((event) => { log.push(['A', event]); });
    const l = (event: Event) => { log.push(['L', event]); };
    const old = subscribe(l); subscribe((event) => { log.push(['Z', event]); });
    const e = config.fireAuthChanged(() => { old(); subscribe(l); old(); });
    expect(log).toEqual([['A', e], ['Z', e]]);
    const f = config.fireAuthChanged();
    expect(log).toEqual([['A', e], ['Z', e], ['A', f], ['Z', f], ['L', f]]);
  });

  it('a listener-created entry waits for a later event snapshot', () => {
    const log: Array<[string, Event]> = []; let e: Event;
    const n = (event: Event) => { log.push(['N', event]); };
    subscribe((event) => { log.push(['A', event]); if (event === e) subscribe(n); });
    e = config.fireAuthChanged((event) => { e = event; });
    expect(log).toEqual([['A', e]]);
    const f = config.fireAuthChanged(); expect(log).toEqual([['A', e], ['A', f], ['N', f]]);
  });

  it('listener mutation then throw skips replaced slot and still delivers remaining entries', () => {
    const log: Array<[string, Event]> = []; let e: Event; let oldL = () => {};
    const listener = (event: Event) => { log.push(['L', event]); };
    subscribe((event) => {
      log.push(['A', event]);
      if (event === e) { oldL(); subscribe(listener); throw new Error('A failed after replacement'); }
    });
    oldL = subscribe(listener); subscribe((event) => { log.push(['Z', event]); });
    const error = caught(() => { config.fireAuthChanged((event) => { e = event; }); });
    expect(error).toBeInstanceOf(config.AuthChangeDispatchError);
    expect(error).toMatchObject({ preparationFailed: false, listenerFailureCount: 1 });
    expect(log).toEqual([['A', e!], ['Z', e!]]);
    oldL(); const f = config.fireAuthChanged();
    expect(log.slice(2)).toEqual([['A', f], ['Z', f], ['L', f]]);
  });

  it('self remove/re-add runs E only once and its replacement positively receives F', () => {
    const log: Event[] = []; let e: Event; let old = () => {};
    const listener = (event: Event) => { log.push(event); if (event === e) { old(); subscribe(listener); } };
    old = subscribe(listener); e = config.fireAuthChanged((event) => { e = event; });
    expect(log).toEqual([e]); const f = config.fireAuthChanged(); expect(log).toEqual([e, f]);
  });

  it('nested hook snapshot admits replacement into F but never E and never rolls current back', () => {
    const log: Array<[string, Event]> = []; let f!: Event;
    subscribe((event) => { log.push(['A', event]); });
    const listener = (event: Event) => { log.push(['L', event]); }; const old = subscribe(listener);
    const e = config.fireAuthChanged(() => { old(); subscribe(listener); f = config.fireAuthChanged(); });
    expect(log).toEqual([['A', f], ['L', f], ['A', e]]);
    expect(config.getCurrentAuthChangeEvent()).toBe(f);
  });

  it('listener-nested F sees new N while outer E resumes only its old live entries', () => {
    const log: Array<[string, Event]> = []; let e!: Event; let f!: Event;
    subscribe((event) => {
      log.push(['A', event]);
      if (event === e) { subscribe((nested) => { log.push(['N', nested]); }); f = config.fireAuthChanged(); }
    });
    subscribe((event) => { log.push(['B', event]); });
    e = config.fireAuthChanged((event) => { e = event; });
    expect(log).toEqual([['A', e], ['A', f], ['B', f], ['N', f], ['B', e]]);
    expect(config.getCurrentAuthChangeEvent()).toBe(f);
  });

  it('replacement after both E and F snapshots waits for G and stale disposer cannot remove it', () => {
    const log: Array<[string, Event]> = []; let f!: Event;
    subscribe((event) => { log.push(['A', event]); });
    const listener = (event: Event) => { log.push(['L', event]); }; const old = subscribe(listener);
    const e = config.fireAuthChanged(() => { f = config.fireAuthChanged(() => { old(); subscribe(listener); }); });
    expect(log).toEqual([['A', f], ['A', e]]); expect(config.getCurrentAuthChangeEvent()).toBe(f);
    old(); const g = config.fireAuthChanged(); expect(log.slice(2)).toEqual([['A', g], ['L', g]]);
  });

  it('preparation mutations survive a throw and do not rebuild E snapshot', () => {
    const log: Array<[string, Event]> = []; let e!: Event;
    subscribe((event) => { log.push(['A', event]); });
    const error = caught(() => { config.fireAuthChanged((event) => {
      e = event; subscribe((nested) => { log.push(['N', nested]); }); throw new Error('hook');
    }); });
    expect(error).toMatchObject({ preparationFailed: true, listenerFailureCount: 0, event: e });
    expect(log).toEqual([['A', e]]); expect(config.getCurrentAuthChangeEvent()).toBe(e);
    const f = config.fireAuthChanged(); expect(log.slice(1)).toEqual([['A', f], ['N', f]]);
  });

  it('nested failure is counted per dispatch and current remains the newer event', () => {
    let e!: Event; let f!: Event; const seen: Event[] = [];
    subscribe((event) => { seen.push(event); if (event === f) throw new Error('nested listener'); });
    const error = caught(() => { config.fireAuthChanged((event) => {
      e = event; config.fireAuthChanged((nested) => { f = nested; });
    }); });
    expect(error).toBeInstanceOf(config.AuthChangeDispatchError);
    expect(error).toMatchObject({ event: e, preparationFailed: true, listenerFailureCount: 0 });
    expect((error as InstanceType<Config['AuthChangeDispatchError']>).causes[0]).toMatchObject({ event: f, listenerFailureCount: 1 });
    expect(seen).toEqual([f, e]); expect(config.getCurrentAuthChangeEvent()).toBe(f);
  });
});

describe('real config + real workspace completion', () => {
  it('revokes old proof inside earlier throwing listener and still delivers every later live listener', async () => {
    const values: boolean[] = []; const log: string[] = [];
    let readOld = (): boolean => { throw new Error('positive proof not established'); };
    subscribe(() => { log.push('early'); values.push(readOld()); throw new Error('early'); });
    await loadClient(); const old = await proof(); readOld = () => client.isCurrentWorkspaceRead(old);
    subscribe(() => { log.push('late'); throw new Error('late'); });
    subscribe(() => { log.push('tail'); });
    const error = caught(() => { config.setCurrentIdToken('new-unit-token'); });
    expect(values).toEqual([false]); expect(log).toEqual(['early', 'late', 'tail']);
    expect(error).toMatchObject({ name: 'AuthChangeDispatchError', listenerFailureCount: 2, preparationFailed: false });
    expect(config.authedHeaders().authorization).toBe('Bearer new-unit-token');
    expect(client.isCurrentWorkspaceRead(old)).toBe(false);
  });

  it('normal completion retires old work, invokes once and refuses raw copy/proxy/replay', async () => {
    await loadClient(); const old = await proof(); const result = await switched('B');
    const matching = await proof('B');
    const events: Event[] = []; subscribe((event) => { events.push(event); });
    const eventBeforeCompletion = config.getCurrentAuthChangeEvent(); const a = actions();
    for (const invalid of [{ ...result }, new Proxy(result, {})]) {
      expect(client.completeWorkspaceTransition(invalid, a)).toBe('retired');
      expect(events).toEqual([]); expect(config.getCurrentAuthChangeEvent()).toBe(eventBeforeCompletion);
      expect(a.beforeAction).not.toHaveBeenCalled(); expect(a.action).not.toHaveBeenCalled(); expect(a.failed).not.toHaveBeenCalled();
      expect(client.isCurrentWorkspaceRead(matching)).toBe(true);
    }
    result.active = 'mutated-public-field';
    expect(client.isCurrentWorkspaceRead(matching), 'matching proof is current immediately before the own completion event').toBe(true);
    expect(client.completeWorkspaceTransition(result, a)).toBe('completed');
    expect(events).toHaveLength(1); expect(events[0]).not.toBe(eventBeforeCompletion); expect(events[0]).toBe(config.getCurrentAuthChangeEvent());
    expect(a.beforeAction).toHaveBeenCalledTimes(1); expect(a.action).toHaveBeenCalledTimes(1); expect(a.failed).not.toHaveBeenCalled();
    expect(client.isCurrentWorkspaceRead(matching)).toBe(false);
    expect(client.isCurrentWorkspaceRead(old)).toBe(false); expect(client.getWorkspaceTransitionSnapshot().phase).toBe('unverified');
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired');
    expect(events).toHaveLength(1); expect(a.beforeAction).toHaveBeenCalledTimes(1); expect(a.action).toHaveBeenCalledTimes(1); expect(a.failed).not.toHaveBeenCalled();
  });

  it('issues distinct results even when transport reuses one decoded object', async () => {
    await loadClient(); const raw = { ok: true, active: 'A' };
    const one = json(raw); const two = json(raw);
    vi.spyOn(one, 'json').mockResolvedValue(raw); vi.spyOn(two, 'json').mockResolvedValue(raw);
    fetchMock.mockResolvedValueOnce(one).mockResolvedValueOnce(two);
    const first = await client.switchWorkspace('A'); const second = await client.switchWorkspace('A');
    expect(first).not.toBe(second); expect(first).not.toBe(raw); expect(second).not.toBe(raw);
    const a = actions(); expect(client.completeWorkspaceTransition(first, a)).toBe('retired');
    expect(a.action).not.toHaveBeenCalled(); expect(client.completeWorkspaceTransition(second, a)).toBe('completed');
    expect(a.action).toHaveBeenCalledTimes(1);
  });

  it('supersession after fulfillment but before completion denies old notification and preserves B claim', async () => {
    await loadClient(); const result = await switched('A'); const held = deferred<Response>();
    const events: Event[] = []; subscribe((event) => { events.push(event); });
    fetchMock.mockReturnValueOnce(held.promise); const b = observe(client.switchWorkspace('B'));
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
    const a = actions(); expect(client.completeWorkspaceTransition(result, a)).toBe('retired');
    expect(events).toEqual([]); expect(a.beforeAction).not.toHaveBeenCalled(); expect(a.action).not.toHaveBeenCalled();
    expect(client.getWorkspaceTransitionSnapshot().pendingCount).toBe(1);
    held.resolve(json({ ok: true, active: 'B' })); expect(await b).toMatchObject({ kind: 'fulfilled', value: { active: 'B' } });
  });

  it('foreign token after fulfillment never becomes the old result own event', async () => {
    await loadClient(); const result = await switched('A'); const events: Event[] = [];
    subscribe((event) => { events.push(event); }); config.setCurrentIdToken('foreign-token');
    const foreign = config.getCurrentAuthChangeEvent(); const a = actions();
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired');
    expect(events).toEqual([foreign]); expect(a.action).not.toHaveBeenCalled(); expect(a.failed).not.toHaveBeenCalled();
  });

  it('nested foreign F before client sees own E cannot be overwritten by late E', async () => {
    let armed = false; let foreign!: Event;
    subscribe(() => { if (armed) { armed = false; config.setCurrentIdToken('nested-foreign'); foreign = config.getCurrentAuthChangeEvent(); } });
    await loadClient(); const result = await switched('A'); armed = true; const a = actions();
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired');
    expect(config.getCurrentAuthChangeEvent()).toBe(foreign);
    expect(a.action).not.toHaveBeenCalled(); expect(a.failed).not.toHaveBeenCalled();
    await proof('A'); // fresh metadata/proof is usable; old context never revived
  });

  it('new intent before current event observation retires A even when B dispatch refuses', async () => {
    let armed = false; let b!: SwitchOutcome;
    subscribe(() => { if (armed) { armed = false; b = observe(client.switchWorkspace('B')); } });
    await loadClient(); const result = await switched('A'); const calls = fetchMock.mock.calls.length; armed = true;
    const a = actions(); expect(client.completeWorkspaceTransition(result, a)).toBe('retired');
    expect(await b).toMatchObject({ kind: 'rejected', error: { code: 'workspace_transition_retired' } });
    expect(fetchMock).toHaveBeenCalledTimes(calls); expect(a.action).not.toHaveBeenCalled();
  });

  it('new intent after client sees E retains B pending claim and denies A final action', async () => {
    await loadClient(); const result = await switched('A'); const held = deferred<Response>();
    let b!: SwitchOutcome;
    const off = subscribe(() => { off(); b = observe(client.switchWorkspace('B')); });
    fetchMock.mockReturnValueOnce(held.promise); const a = actions();
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired');
    expect(client.getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
    expect(a.action).not.toHaveBeenCalled(); held.resolve(json({ ok: true, active: 'B' }));
    expect(await b).toMatchObject({ kind: 'fulfilled', value: { active: 'B' } });
  });

  it('full listener failure emits only a current sanitized failure and consumes completion', async () => {
    await loadClient(); const result = await switched('A'); const off = subscribe(() => { throw new Error('not UI copy'); });
    const a = actions(); expect(client.completeWorkspaceTransition(result, a)).toBe('failed');
    expect(a.action).not.toHaveBeenCalled(); expect(a.beforeAction).not.toHaveBeenCalled();
    expect(a.failed.mock.calls).toEqual([[{ phase: 'notification', listenerFailureCount: 1, mutationMayHaveCompleted: true, actionMayHaveRun: false }]]);
    off(); expect(client.completeWorkspaceTransition(result, a)).toBe('retired'); expect(a.failed).toHaveBeenCalledTimes(1);
  });

  it('reentrant caller guard true cannot authorize action after foreign event', async () => {
    await loadClient(); const result = await switched('A'); const a = actions();
    a.isCallerCurrent.mockImplementation(() => { config.setCurrentIdToken('guard-foreign'); return true; });
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired');
    expect(a.beforeAction).not.toHaveBeenCalled(); expect(a.action).not.toHaveBeenCalled(); expect(a.failed).not.toHaveBeenCalled();
  });

  it('beforeAction new intent cannot reach final action or delete its pending claim', async () => {
    await loadClient(); const result = await switched('A'); const held = deferred<Response>();
    let b!: SwitchOutcome;
    fetchMock.mockReturnValueOnce(held.promise); const a = actions();
    a.beforeAction.mockImplementation(() => { b = observe(client.switchWorkspace('B')); });
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired');
    expect(a.beforeAction).toHaveBeenCalledTimes(1); expect(a.action).not.toHaveBeenCalled();
    expect(client.getWorkspaceTransitionSnapshot().pendingCount).toBe(1);
    held.resolve(json({ ok: true, active: 'B' })); expect(await b).toMatchObject({ kind: 'fulfilled' });
  });

  it('guard throw invokes no UI callbacks and cannot replay consumed result', async () => {
    await loadClient(); const result = await switched('A'); const a = actions();
    a.isCallerCurrent.mockImplementation(() => { throw new Error('guard failed'); });
    expect(() => client.completeWorkspaceTransition(result, a)).toThrow('guard failed');
    expect(a.action).not.toHaveBeenCalled(); expect(a.failed).not.toHaveBeenCalled();
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired');
  });

  it('throwing final action records attempted invocation and remains one-shot', async () => {
    await loadClient(); const result = await switched('A'); const a = actions();
    a.action.mockImplementation(() => { throw new Error('action failed'); });
    expect(() => client.completeWorkspaceTransition(result, a)).toThrow('action failed');
    expect(a.action).toHaveBeenCalledTimes(1);
    expect(a.failed).toHaveBeenCalledWith({ phase: 'action', listenerFailureCount: 0, mutationMayHaveCompleted: true, actionMayHaveRun: true });
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired'); expect(a.action).toHaveBeenCalledTimes(1);
  });

  it('a final action already invoked current is counted once despite reentrancy inside it', async () => {
    await loadClient(); const result = await switched('A'); const a = actions();
    a.action.mockImplementation(() => { config.setCurrentIdToken('after-invocation'); });
    expect(client.completeWorkspaceTransition(result, a)).toBe('completed'); expect(a.action).toHaveBeenCalledTimes(1);
    expect(config.getCurrentAuthChangeEvent().reason).toBe('token');
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired'); expect(a.action).toHaveBeenCalledTimes(1);
  });

  it('completion does not broad-reset immutable per-ID tenant provenance', async () => {
    const id = 'aaaaaaaaaaaaaaaaaaaa'; wire.fromWireRunId(`original/${id}`);
    await loadClient(); const result = await switched('B'); const a = actions();
    expect(client.completeWorkspaceTransition(result, a)).toBe('completed');
    const loader = vi.fn(async () => ({ active: 'must-not-load' }));
    expect(await wire.bindRunIdValue(id, loader)).toBe(`original/${id}`); expect(loader).not.toHaveBeenCalled();
  });

  it('action-reference getter reentrancy retires result before any own notification', async () => {
    await loadClient(); const result = await switched('A'); const events: Event[] = [];
    subscribe((event) => { events.push(event); }); const a = actions();
    Object.defineProperty(a, 'isCallerCurrent', { get: () => {
      config.setCurrentIdToken('getter-foreign'); return () => true;
    } });
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired');
    expect(events).toHaveLength(1); expect(events[0]?.reason).toBe('token');
    expect(a.action).not.toHaveBeenCalled(); expect(a.failed).not.toHaveBeenCalled();
  });

  it('a newly accepted contradictory active workspace retires the older completion', async () => {
    await loadClient(); const result = await switched('B'); const accepted = await proof('A');
    expect(client.isCurrentWorkspaceRead(accepted)).toBe(true);
    const event = config.getCurrentAuthChangeEvent(); const a = actions();
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired');
    expect(config.getCurrentAuthChangeEvent()).toBe(event); expect(a.action).not.toHaveBeenCalled();
  });

  it('caller-only retirement keeps current mutation housekeeping but invokes no UI callbacks', async () => {
    await loadClient(); const result = await switched('A'); const events: Event[] = [];
    subscribe((event) => { events.push(event); }); const a = actions(); a.isCallerCurrent.mockReturnValue(false);
    expect(client.completeWorkspaceTransition(result, a)).toBe('caller-retired');
    expect(events).toHaveLength(1); expect(a.beforeAction).not.toHaveBeenCalled(); expect(a.action).not.toHaveBeenCalled(); expect(a.failed).not.toHaveBeenCalled();
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired'); expect(events).toHaveLength(1);
  });

  it('throwing preparation cannot invoke final action or replay its current failure notice', async () => {
    await loadClient(); const result = await switched('A'); const a = actions();
    a.beforeAction.mockImplementation(() => { throw new Error('preparation failed'); });
    expect(() => client.completeWorkspaceTransition(result, a)).toThrow('preparation failed');
    expect(a.action).not.toHaveBeenCalled();
    expect(a.failed).toHaveBeenCalledWith({ phase: 'before-action', listenerFailureCount: 0, mutationMayHaveCompleted: true, actionMayHaveRun: false });
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired'); expect(a.failed).toHaveBeenCalledTimes(1);
  });

  it('throwing failed callback propagates after consumption without recursive notification', async () => {
    await loadClient(); const result = await switched('A'); const off = subscribe(() => { throw new Error('dispatch failed'); });
    const a = actions(); a.failed.mockImplementation(() => { throw new Error('failure UI failed'); });
    expect(() => client.completeWorkspaceTransition(result, a)).toThrow('failure UI failed');
    expect(a.failed).toHaveBeenCalledTimes(1); expect(a.action).not.toHaveBeenCalled(); off();
    expect(client.completeWorkspaceTransition(result, a)).toBe('retired'); expect(a.failed).toHaveBeenCalledTimes(1);
  });

});
