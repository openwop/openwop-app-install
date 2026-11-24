/**
 * Mounted real WorkspaceCreateSection + real config/client completion2489.
 * The public create-result delivery is held AFTER the real client fulfilled,
 * so stale caller oracles cannot pass by testing only pre-fulfillment rejection.
 * No completion/registration algorithm is mocked. Final native reload is the
 * existing unchanged reloadIntoSession boundary. Native/setup all UNRUN.
 */
import { StrictMode, useLayoutEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from 'i18next';

const bridge = vi.hoisted(() => ({
  actual: null as typeof import('../../client/workspaceClient.js') | null,
  hold: null as Promise<void> | null,
  onIssued: null as ((value: unknown) => void) | null,
  pending: null as Promise<unknown> | null,
  outcomes: [] as string[],
}));
vi.unmock('../../client/config.js');
vi.unmock('../../client/v2Wire.js');
vi.mock('../../client/entitlementRefresh.js', () => ({ noteRequestStatus: vi.fn() }));
vi.mock('../../client/sessionRefusal.js', () => ({ noteSessionRefusal: vi.fn() }));
vi.mock('../../auth/reloadIntoSession.js', () => ({ reloadIntoSession: vi.fn() }));
vi.mock('../../client/workspaceClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../client/workspaceClient.js')>();
  bridge.actual = actual;
  return {
    ...actual,
    createAndEnterWorkspace: (name: string) => {
      const delivered = actual.createAndEnterWorkspace(name).then(async (result) => {
        bridge.onIssued?.(result);
        if (bridge.hold) await bridge.hold;
        return result;
      });
      bridge.pending = delivered;
      return delivered;
    },
    completeWorkspaceTransition: (...args: Parameters<typeof actual.completeWorkspaceTransition>) => {
      const outcome = actual.completeWorkspaceTransition(...args);
      bridge.outcomes.push(outcome);
      return outcome;
    },
  };
});
import { WorkspaceCreateSection } from '../WorkspaceCreateSection.js';
import { fireAuthChanged, getCurrentAuthChangeEvent, onAuthChange, setCurrentIdToken } from '../../client/config.js';
import { reloadIntoSession } from '../../auth/reloadIntoSession.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function real() {
  if (!bridge.actual) throw new Error('actual_client_factory_not_loaded');
  return bridge.actual;
}
function observe<T>(promise: Promise<T>) {
  return promise.then((value) => ({ kind: 'fulfilled' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }));
}
let issued = deferred<unknown>();
let releaseDelivery: (() => void) | null = null;
let heldB: ReturnType<typeof deferred<Response>> | null = null;
let pendingB: Promise<unknown> | null = null;
let disposers: Array<() => void> = [];
let createStatus = 201;
let fetchMock = vi.fn<typeof fetch>();
function holdIssuedResult(): void {
  const gate = deferred<void>(); bridge.hold = gate.promise; releaseDelivery = () => { gate.resolve(); };
}
function formButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: t('orgs:createWorkspace') }) as HTMLButtonElement;
}
function CommittedCreate({ onCreated, revision, onCommit }: {
  onCreated: () => void; revision: number; onCommit(handler: () => void, revision: number): void;
}) {
  // Test-only commit witness: no marker is published by an abandoned render.
  useLayoutEffect(() => { onCommit(onCreated, revision); });
  return <WorkspaceCreateSection onCreated={onCreated} />;
}
function trustedCopy(key: 'workspaceChangeNotAllowed' | 'workspaceChangeCouldNotFinish'): string {
  const copy = t(`common:${key}`);
  expect(copy).not.toBe(key); expect(copy).not.toBe(`common:${key}`);
  return copy;
}
async function submit(name = 'Acme'): Promise<unknown> {
  let result: unknown;
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: name } });
    fireEvent.click(formButton());
    result = await issued.promise;
  });
  return result;
}
async function release(): Promise<void> {
  const finish = releaseDelivery;
  if (!finish) throw new Error('delivery_gate_not_armed');
  await act(async () => { finish(); await bridge.pending; });
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(false));
}
beforeEach(() => {
  cleanup(); disposers = []; bridge.hold = null; bridge.pending = null; bridge.outcomes.length = 0;
  issued = deferred<unknown>(); bridge.onIssued = issued.resolve; releaseDelivery = null;
  heldB = null; pendingB = null; createStatus = 201;
  setCurrentIdToken(null); fireAuthChanged(); vi.mocked(reloadIntoSession).mockClear();
  fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/workspaces') && init?.method === 'POST') {
      return createStatus === 201
        ? json({ workspaceId: 'C', name: 'Acme', slug: 'acme', roles: ['owner'], kind: 'shared', active: false }, 201)
        : json({ message: 'Workspace limit reached.' }, createStatus);
    }
    const match = /\/workspaces\/([^/]+)\/switch$/.exec(url);
    if (match) {
      const active = decodeURIComponent(match[1]!);
      if (active === 'B' && heldB) return heldB.promise;
      return json({ ok: true, active });
    }
    throw new Error(`unexpected_test_transport ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    releaseDelivery?.(); heldB?.resolve(json({ ok: true, active: 'B' }));
    await bridge.pending?.catch(() => undefined); await pendingB;
  });
  for (const off of disposers) off();
  bridge.hold = null; bridge.onIssued = null; vi.unstubAllGlobals();
});

describe('real CreateSection completion and committed caller', () => {
  it('StrictMode rearmed committed life invokes current onCreated once through real completion', async () => {
    const onCreated = vi.fn(); const events: unknown[] = [];
    disposers.push(onAuthChange((event) => { events.push(event); }));
    render(<StrictMode><WorkspaceCreateSection onCreated={onCreated} /></StrictMode>);
    const result = await submit();
    expect(result).toMatchObject({ workspaceId: 'C' });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(bridge.outcomes).toEqual(['completed']); expect(events).toHaveLength(1);
    expect(real().getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect(reloadIntoSession).not.toHaveBeenCalled();
  });

  it('default app path invokes only the existing native reload primitive once', async () => {
    render(<WorkspaceCreateSection />); await submit();
    await waitFor(() => expect(reloadIntoSession).toHaveBeenCalledTimes(1));
    expect(bridge.outcomes).toEqual(['completed']);
  });

  it('new B after actual client fulfillment but before caller delivery prevents old callback and name clear', async () => {
    holdIssuedResult(); const onCreated = vi.fn(); const events: unknown[] = [];
    disposers.push(onAuthChange((event) => { events.push(event); }));
    render(<WorkspaceCreateSection onCreated={onCreated} />);
    const result = await submit(); expect(result).toMatchObject({ workspaceId: 'C' });
    expect(bridge.outcomes).toEqual([]); expect(onCreated).not.toHaveBeenCalled();
    heldB = deferred<Response>(); pendingB = observe(real().switchWorkspace('B'));
    expect(real().getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
    await release();
    expect(bridge.outcomes).toEqual(['retired']); expect(events).toEqual([]);
    expect(onCreated).not.toHaveBeenCalled(); expect(reloadIntoSession).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Acme');
    expect(real().getWorkspaceTransitionSnapshot().pendingCount).toBe(1);
    heldB.resolve(json({ ok: true, active: 'B' }));
    expect(await pendingB).toMatchObject({ kind: 'fulfilled', value: { active: 'B' } });
  });

  it('foreign auth after actual fulfillment cannot become the old caller normal event', async () => {
    holdIssuedResult(); const onCreated = vi.fn(); render(<WorkspaceCreateSection onCreated={onCreated} />);
    await submit(); const events: unknown[] = []; disposers.push(onAuthChange((event) => { events.push(event); }));
    setCurrentIdToken('foreign-after-fulfillment'); const foreign = getCurrentAuthChangeEvent();
    await release();
    expect(events).toEqual([foreign]); expect(bridge.outcomes).toEqual(['retired']);
    expect(onCreated).not.toHaveBeenCalled(); expect(reloadIntoSession).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Acme');
  });

  it('foreign event reentered during normal notification prevents final current callback and stale notice', async () => {
    const onCreated = vi.fn(); let armed = true;
    disposers.push(onAuthChange(() => {
      if (armed) { armed = false; setCurrentIdToken('reentrant-foreign'); }
    }));
    render(<WorkspaceCreateSection onCreated={onCreated} />); await submit();
    await waitFor(() => expect(formButton().disabled).toBe(false));
    expect(bridge.outcomes).toEqual(['retired']); expect(onCreated).not.toHaveBeenCalled();
    expect(reloadIntoSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(t('common:workspaceChangeNeedsRefresh'))).toBeNull();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Acme');
  });

  it('unmounted caller allows current mutation housekeeping and a reload but no callback (D2a)', async () => {
    holdIssuedResult(); const onCreated = vi.fn(); const events: unknown[] = [];
    disposers.push(onAuthChange((event) => { events.push(event); }));
    const view = render(<WorkspaceCreateSection onCreated={onCreated} />); await submit(); view.unmount();
    const finish = releaseDelivery; expect(finish).not.toBeNull();
    await act(async () => { finish!(); await bridge.pending; });
    await waitFor(() => expect(bridge.outcomes).toEqual(['caller-retired']));
    expect(events).toHaveLength(1); expect(onCreated).not.toHaveBeenCalled(); expect(reloadIntoSession).toHaveBeenCalledTimes(1);
  });

  it('replaced committed handler cannot receive an older request and old handler cannot win', async () => {
    holdIssuedResult(); const oldHandler = vi.fn(); const newHandler = vi.fn();
    const view = render(<WorkspaceCreateSection onCreated={oldHandler} />); await submit();
    view.rerender(<WorkspaceCreateSection onCreated={newHandler} />); await release();
    expect(bridge.outcomes).toEqual(['caller-retired']); expect(oldHandler).not.toHaveBeenCalled(); expect(newHandler).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Acme');
  });

  it('real known HTTP refusal uses trusted refusal copy without raw reason or final effects', async () => {
    createStatus = 403; const onCreated = vi.fn(); render(<WorkspaceCreateSection onCreated={onCreated} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Acme' } }); fireEvent.click(formButton());
    const expected = trustedCopy('workspaceChangeNotAllowed');
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
    expect(screen.queryByText('Workspace limit reached.')).toBeNull();
    expect(document.body.textContent).not.toContain('Workspace limit reached.');
    expect(bridge.outcomes).toEqual([]); expect(onCreated).not.toHaveBeenCalled(); expect(reloadIntoSession).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Acme'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('listener failure shows only real localized uncertainty copy with no callback, rollback or blind retry', async () => {
    const expected = t('common:workspaceChangeNeedsRefresh');
    expect(expected).not.toBe('workspaceChangeNeedsRefresh'); expect(expected).not.toBe('common:workspaceChangeNeedsRefresh');
    disposers.push(onAuthChange(() => { throw new Error('private diagnostic must not be UI'); }));
    const onCreated = vi.fn(); render(<WorkspaceCreateSection onCreated={onCreated} />); await submit();
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
    expect(bridge.outcomes).toEqual(['failed']); expect(onCreated).not.toHaveBeenCalled(); expect(reloadIntoSession).not.toHaveBeenCalled();
    expect(screen.queryByText('private diagnostic must not be UI')).toBeNull();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Acme'); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('committed A-to-B-to-same-A permanently retires the held request while a fresh returned-A request succeeds', async () => {
    holdIssuedResult(); const handlerA = vi.fn(); const handlerB = vi.fn(); const onCommit = vi.fn();
    const events: unknown[] = []; disposers.push(onAuthChange((event) => { events.push(event); }));
    const view = render(<CommittedCreate onCreated={handlerA} revision={0} onCommit={onCommit} />);
    const oldResult = await submit(); expect(oldResult).toMatchObject({ workspaceId: 'C' });
    expect(bridge.outcomes).toEqual([]); expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
    view.rerender(<CommittedCreate onCreated={handlerB} revision={1} onCommit={onCommit} />);
    expect(onCommit.mock.calls).toEqual([[handlerA, 0], [handlerB, 1]]);
    view.rerender(<CommittedCreate onCreated={handlerA} revision={2} onCommit={onCommit} />);
    expect(onCommit.mock.calls).toEqual([[handlerA, 0], [handlerB, 1], [handlerA, 2]]);
    await release();
    expect(bridge.outcomes).toEqual(['caller-retired']); expect(events).toHaveLength(1);
    expect(handlerA).not.toHaveBeenCalled(); expect(handlerB).not.toHaveBeenCalled();
    expect(reloadIntoSession).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Acme');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // No remount/reset: a genuinely new request captures the new committed A generation.
    bridge.hold = null; releaseDelivery = null; issued = deferred<unknown>(); bridge.onIssued = issued.resolve;
    const freshResult = await submit('Fresh A'); expect(freshResult).not.toBe(oldResult);
    await waitFor(() => expect(handlerA).toHaveBeenCalledTimes(1));
    expect(bridge.outcomes).toEqual(['caller-retired', 'completed']); expect(events).toHaveLength(2);
    expect(handlerB).not.toHaveBeenCalled(); expect(reloadIntoSession).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('an actual unchanged-handler commit preserves the held current generation', async () => {
    holdIssuedResult(); const handlerA = vi.fn(); const onCommit = vi.fn();
    const view = render(<CommittedCreate onCreated={handlerA} revision={0} onCommit={onCommit} />);
    const result = await submit(); expect(result).toMatchObject({ workspaceId: 'C' });
    expect(bridge.outcomes).toEqual([]);
    view.rerender(<CommittedCreate onCreated={handlerA} revision={1} onCommit={onCommit} />);
    expect(onCommit.mock.calls).toEqual([[handlerA, 0], [handlerA, 1]]);
    await release();
    expect(bridge.outcomes).toEqual(['completed']); expect(handlerA).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect(reloadIntoSession).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('malformed real create201 shows trusted incomplete-change copy without internal or response text', async () => {
    const marker = 'PRIVATE_CREATE_RESPONSE_TEXT';
    fetchMock.mockResolvedValueOnce(json({ message: marker }, 201));
    const onIssued = vi.fn(issued.resolve); bridge.onIssued = onIssued;
    const onCreated = vi.fn(); render(<WorkspaceCreateSection onCreated={onCreated} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Acme' } }); fireEvent.click(formButton());
    await waitFor(() => expect(screen.getByText(trustedCopy('workspaceChangeCouldNotFinish'))).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/workspaces$/);
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('POST'); expect(onIssued).not.toHaveBeenCalled();
    expect(real().getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'failed', pendingCount: 0 });
    expect(document.body.textContent).not.toContain('workspace_create_response_invalid');
    expect(document.body.textContent).not.toContain(marker); expect(bridge.outcomes).toEqual([]);
    expect(onCreated).not.toHaveBeenCalled(); expect(reloadIntoSession).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Acme');
  });

  it('create201 followed by enter403 remains partial/unknown in trusted refusal copy and is never retried', async () => {
    const marker = 'PRIVATE_ENTER_REFUSAL_TEXT';
    fetchMock.mockResolvedValueOnce(json({ workspaceId: 'C', name: 'Acme', slug: 'acme', roles: ['owner'], kind: 'shared', active: false }, 201))
      .mockResolvedValueOnce(json({ error: { message: marker } }, 403));
    const onCreated = vi.fn(); render(<WorkspaceCreateSection onCreated={onCreated} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Acme' } }); fireEvent.click(formButton());
    await waitFor(() => expect(screen.getByText(trustedCopy('workspaceChangeNotAllowed'))).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/workspaces$/);
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/\/C\/switch$/);
    expect(document.body.textContent).not.toContain(marker); expect(bridge.outcomes).toEqual([]);
    expect(onCreated).not.toHaveBeenCalled(); expect(reloadIntoSession).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Acme');
  });

  it('real untrusted HTTP500 text is replaced by trusted incomplete-change copy', async () => {
    const marker = 'PRIVATE_SERVER_FAILURE_TEXT';
    fetchMock.mockResolvedValueOnce(json({ error: { message: marker } }, 500));
    const onCreated = vi.fn(); render(<WorkspaceCreateSection onCreated={onCreated} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Acme' } }); fireEvent.click(formButton());
    await waitFor(() => expect(screen.getByText(trustedCopy('workspaceChangeCouldNotFinish'))).toBeTruthy());
    expect(document.body.textContent).not.toContain(marker); expect(bridge.outcomes).toEqual([]);
    expect(onCreated).not.toHaveBeenCalled(); expect(reloadIntoSession).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Acme'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});
