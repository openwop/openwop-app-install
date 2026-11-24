/**
 * Mounted actual WorkspaceSwitcher/config/client2489. Transport is controlled;
 * only public RESULT DELIVERY is paused after real fulfillment. Completion is
 * real. The unchanged reloadIntoSession primitive is mocked at final effect,
 * following the current auth fixture; no jsdom location rewrite/test-only API.
 * Native/import/setup/behavior all UNRUN; no backend or new-realm guarantee.
 */
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from 'i18next';

const bridge = vi.hoisted(() => ({
  actual: null as typeof import('../../client/workspaceClient.js') | null,
  hold: null as Promise<void> | null,
  onIssued: null as ((value: unknown) => void) | null,
  pending: [] as Promise<unknown>[],
  outcomes: [] as string[],
}));
vi.unmock('../../client/config.js');
vi.unmock('../../client/v2Wire.js');
vi.mock('../../client/entitlementRefresh.js', () => ({ noteRequestStatus: vi.fn() }));
vi.mock('../../client/sessionRefusal.js', () => ({ noteSessionRefusal: vi.fn() }));
vi.mock('../../auth/reloadIntoSession.js', () => ({ reloadIntoSession: vi.fn() }));
vi.mock('../../brand/BrandProvider.js', () => ({ useBrand: () => ({ productName: 'Test', instanceName: 'Test workspace', markSrc: '/test.svg', markSrcDark: '' }) }));
vi.mock('../../client/workspaceClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../client/workspaceClient.js')>();
  bridge.actual = actual;
  const delivered = <T,>(operation: Promise<T>): Promise<T> => {
    const pending = operation.then(async (result) => {
      bridge.onIssued?.(result);
      if (bridge.hold) await bridge.hold;
      return result;
    });
    bridge.pending.push(pending);
    return pending;
  };
  return {
    ...actual,
    switchWorkspace: (id: string) => delivered(actual.switchWorkspace(id)),
    createAndEnterWorkspace: (name: string) => delivered(actual.createAndEnterWorkspace(name)),
    completeWorkspaceTransition: (...args: Parameters<typeof actual.completeWorkspaceTransition>) => {
      const outcome = actual.completeWorkspaceTransition(...args); bridge.outcomes.push(outcome); return outcome;
    },
  };
});
import { WorkspaceSwitcher } from '../WorkspaceSwitcher.js';
import { fireAuthChanged, getCurrentAuthChangeEvent, onAuthChange, setCurrentIdToken } from '../../client/config.js';
import { reloadIntoSession } from '../../auth/reloadIntoSession.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function real() { if (!bridge.actual) throw new Error('actual_client_factory_not_loaded'); return bridge.actual; }
function observe<T>(promise: Promise<T>) {
  return promise.then((value) => ({ kind: 'fulfilled' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }));
}
let issued = deferred<unknown>();
let releaseDelivery: (() => void) | null = null;
let heldC: ReturnType<typeof deferred<Response>> | null = null;
let pendingC: Promise<unknown> | null = null;
let disposers: Array<() => void> = [];
let serverActive = 'A';
let createdD = false;
let switchStatus = 200;
let fetchMock = vi.fn<typeof fetch>();
function listing() {
  return { active: serverActive, personal: 'personal', workspaces: [...['A', 'B', 'C'], ...(createdD ? ['D'] : [])]
    .map((id) => ({ workspaceId: id, name: `Workspace ${id}`, slug: id.toLowerCase(), roles: ['owner'], kind: 'shared', active: id === serverActive })) };
}
function holdIssuedResult(): void {
  const gate = deferred<void>(); bridge.hold = gate.promise; releaseDelivery = () => { gate.resolve(); };
}
function trustedCopy(key: 'workspaceChangeNotAllowed' | 'workspaceChangeCouldNotFinish'): string {
  const copy = t(`common:${key}`);
  expect(copy).not.toBe(key); expect(copy).not.toBe(`common:${key}`);
  return copy;
}
async function mount(strict = false) {
  const content = <MemoryRouter><WorkspaceSwitcher /></MemoryRouter>;
  const view = render(strict ? <StrictMode>{content}</StrictMode> : content);
  const select = await screen.findByRole('combobox') as HTMLSelectElement;
  expect(select.value, 'actual workspace list settled before action').toBe('A');
  expect(select.querySelector('option[value="B"]')).not.toBeNull();
  return { ...view, select };
}
async function choose(select: HTMLSelectElement, value = 'B'): Promise<unknown> {
  let result: unknown;
  await act(async () => { fireEvent.change(select, { target: { value } }); result = await issued.promise; });
  return result;
}
async function release(select: HTMLSelectElement): Promise<void> {
  const finish = releaseDelivery; if (!finish) throw new Error('delivery_gate_not_armed');
  await act(async () => { finish(); await Promise.all(bridge.pending); });
  await waitFor(() => expect(select.disabled).toBe(false));
}
beforeEach(() => {
  cleanup(); disposers = []; bridge.hold = null; bridge.pending.length = 0; bridge.outcomes.length = 0;
  issued = deferred<unknown>(); bridge.onIssued = issued.resolve; releaseDelivery = null;
  heldC = null; pendingC = null; serverActive = 'A'; createdD = false; switchStatus = 200;
  setCurrentIdToken(null); fireAuthChanged(); vi.mocked(reloadIntoSession).mockClear();
  fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/me/workspaces')) return json(listing());
    if (url.endsWith('/workspaces') && init?.method === 'POST') {
      createdD = true;
      return json({ workspaceId: 'D', name: 'GTM', slug: 'gtm', roles: ['owner'], kind: 'shared', active: false }, 201);
    }
    const match = /\/workspaces\/([^/]+)\/switch$/.exec(url);
    if (match) {
      const active = decodeURIComponent(match[1]!);
      if (active === 'C' && heldC) return heldC.promise;
      if (switchStatus !== 200) return json({ message: 'Switch refused.' }, switchStatus);
      serverActive = active; return json({ ok: true, active });
    }
    throw new Error(`unexpected_test_transport ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    releaseDelivery?.(); heldC?.resolve(json({ ok: true, active: 'C' }));
    await Promise.all(bridge.pending.map((operation) => operation.catch(() => undefined))); await pendingC;
  });
  for (const off of disposers) off(); bridge.hold = null; bridge.onIssued = null; vi.unstubAllGlobals();
});

describe('real WorkspaceSwitcher guarded completion', () => {
  it('StrictMode committed life switches and invokes the existing reload primitive once', async () => {
    const events: unknown[] = []; disposers.push(onAuthChange((event) => { events.push(event); }));
    const { select } = await mount(true); const result = await choose(select);
    expect(result).toEqual({ ok: true, active: 'B' });
    await waitFor(() => expect(reloadIntoSession).toHaveBeenCalledTimes(1));
    expect(bridge.outcomes).toEqual(['completed']); expect(events).toHaveLength(1);
    expect(real().getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });
    const writes = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
    expect(writes).toHaveLength(1); expect(String(writes[0]![0])).toMatch(/\/B\/switch$/);
  });

  it('create path returns the actual private result instead of discarding it before completion', async () => {
    const { select } = await mount(); fireEvent.change(select, { target: { value: '__new__' } });
    const field = screen.getByRole('textbox'); let result: unknown;
    await act(async () => {
      fireEvent.change(field, { target: { value: '  GTM  ' } }); fireEvent.keyDown(field, { key: 'Enter' });
      result = await issued.promise;
    });
    expect(result).toMatchObject({ workspaceId: 'D' });
    await waitFor(() => expect(reloadIntoSession).toHaveBeenCalledTimes(1)); expect(bridge.outcomes).toEqual(['completed']);
    const writes = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
    expect(writes).toHaveLength(2); expect(JSON.parse(String(writes[0]![1]?.body))).toEqual({ name: 'GTM' });
    expect(String(writes[1]![0])).toMatch(/\/D\/switch$/);
  });

  it('actual fulfillment followed by newer C denies old reload/event and retains C claim', async () => {
    holdIssuedResult(); const events: unknown[] = []; disposers.push(onAuthChange((event) => { events.push(event); }));
    const { select } = await mount(); const result = await choose(select); expect(result).toEqual({ ok: true, active: 'B' });
    expect(bridge.outcomes).toEqual([]); heldC = deferred<Response>(); pendingC = observe(real().switchWorkspace('C'));
    expect(real().getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'pending', pendingCount: 1 });
    await release(select);
    expect(bridge.outcomes).toEqual(['retired']); expect(events).toEqual([]); expect(reloadIntoSession).not.toHaveBeenCalled();
    expect(real().getWorkspaceTransitionSnapshot().pendingCount).toBe(1);
    serverActive = 'C'; heldC.resolve(json({ ok: true, active: 'C' })); expect(await pendingC).toMatchObject({ kind: 'fulfilled' });
  });

  it('foreign auth after fulfillment invalidates the old await continuation and reloads (D2a)', async () => {
    holdIssuedResult(); const { select } = await mount(); await choose(select);
    const events: unknown[] = []; disposers.push(onAuthChange((event) => { events.push(event); }));
    setCurrentIdToken('foreign-switcher-token'); const foreign = getCurrentAuthChangeEvent(); await release(select);
    expect(events).toEqual([foreign]); expect(bridge.outcomes).toEqual(['retired']); expect(reloadIntoSession).toHaveBeenCalledTimes(1);
  });

  it('reentrant foreign event during own notification still reloads after the fulfilled switch (D2a)', async () => {
    let armed = true; disposers.push(onAuthChange(() => { if (armed) { armed = false; setCurrentIdToken('nested-switcher-token'); } }));
    const { select } = await mount(); await choose(select); await waitFor(() => expect(select.disabled).toBe(false));
    expect(bridge.outcomes).toEqual(['retired']); expect(reloadIntoSession).toHaveBeenCalledTimes(1);
    expect(getCurrentAuthChangeEvent().reason).toBe('token');
    expect(screen.queryByText(t('common:workspaceChangeNeedsRefresh'))).toBeNull();
  });

  it('current housekeeping after UI unmount still reloads into the switched session (D2a)', async () => {
    holdIssuedResult(); const events: unknown[] = []; disposers.push(onAuthChange((event) => { events.push(event); }));
    const view = await mount(); await choose(view.select); view.unmount();
    const finish = releaseDelivery; expect(finish).not.toBeNull();
    await act(async () => { finish!(); await Promise.all(bridge.pending); });
    await waitFor(() => expect(bridge.outcomes).toEqual(['caller-retired']));
    expect(events).toHaveLength(1); expect(reloadIntoSession).toHaveBeenCalledTimes(1);
  });

  it('current listener failure shows real uncertainty Notice and never retries or leaks diagnostics', async () => {
    const expected = t('common:workspaceChangeNeedsRefresh');
    expect(expected).not.toBe('workspaceChangeNeedsRefresh'); expect(expected).not.toBe('common:workspaceChangeNeedsRefresh');
    disposers.push(onAuthChange(() => { throw new Error('private switcher diagnostic'); }));
    const { select } = await mount(); await choose(select);
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
    expect(bridge.outcomes).toEqual(['failed']); expect(reloadIntoSession).not.toHaveBeenCalled();
    expect(screen.queryByText('private switcher diagnostic')).toBeNull();
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it('real known switch refusal uses trusted copy without raw reason or completion', async () => {
    switchStatus = 403; const { select } = await mount(); fireEvent.change(select, { target: { value: 'B' } });
    await waitFor(() => expect(screen.getByText(trustedCopy('workspaceChangeNotAllowed'))).toBeTruthy());
    expect(screen.queryByText('Switch refused.')).toBeNull();
    expect(document.body.textContent).not.toContain('Switch refused.');
    expect(bridge.outcomes).toEqual([]); expect(reloadIntoSession).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it('malformed real switch response uses trusted incomplete-change copy without internal or body text', async () => {
    const { select } = await mount(); const marker = 'PRIVATE_SWITCH_RESPONSE_TEXT';
    fetchMock.mockResolvedValueOnce(json({ ok: true, active: 'A', message: marker }));
    fireEvent.change(select, { target: { value: 'B' } });
    await waitFor(() => expect(screen.getByText(trustedCopy('workspaceChangeCouldNotFinish'))).toBeTruthy());
    const writes = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
    expect(writes).toHaveLength(1); expect(String(writes[0]![0])).toMatch(/\/B\/switch$/);
    expect(real().getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'failed', pendingCount: 0 });
    expect(document.body.textContent).not.toContain('workspace_switch_response_invalid');
    expect(document.body.textContent).not.toContain(marker); expect(bridge.outcomes).toEqual([]);
    expect(reloadIntoSession).not.toHaveBeenCalled();
  });

  it('create201 followed by invalid enter response shows partial-change copy and preserves the typed name', async () => {
    const { select } = await mount(); const marker = 'PRIVATE_PARTIAL_CREATE_TEXT';
    fireEvent.change(select, { target: { value: '__new__' } }); const field = screen.getByRole('textbox') as HTMLInputElement;
    fetchMock.mockResolvedValueOnce(json({ workspaceId: 'D', name: 'GTM', slug: 'gtm', roles: ['owner'], kind: 'shared', active: false }, 201))
      .mockResolvedValueOnce(json({ ok: true, active: 'B', message: marker }));
    fireEvent.change(field, { target: { value: 'GTM' } }); fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(trustedCopy('workspaceChangeCouldNotFinish'))).toBeTruthy());
    const writes = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
    expect(writes).toHaveLength(2); expect(String(writes[0]![0])).toMatch(/\/workspaces$/);
    expect(String(writes[1]![0])).toMatch(/\/D\/switch$/); expect(field.value).toBe('GTM');
    expect(document.body.textContent).not.toContain(marker);
    expect(document.body.textContent).not.toContain('workspace_switch_response_invalid');
    expect(bridge.outcomes).toEqual([]); expect(reloadIntoSession).not.toHaveBeenCalled();
  });

  it('real untrusted switch HTTP500 text is replaced by trusted incomplete-change copy', async () => {
    const { select } = await mount(); const marker = 'PRIVATE_SWITCH_SERVER_TEXT';
    fetchMock.mockResolvedValueOnce(json({ error: { message: marker } }, 500));
    fireEvent.change(select, { target: { value: 'B' } });
    await waitFor(() => expect(screen.getByText(trustedCopy('workspaceChangeCouldNotFinish'))).toBeTruthy());
    expect(document.body.textContent).not.toContain(marker); expect(bridge.outcomes).toEqual([]);
    expect(reloadIntoSession).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });
});
