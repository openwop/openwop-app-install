/**
 * Both real WorkspaceSwitcher error producers must reach the persistent global
 * assertive region. Actual config/client/completion/Notice/announce; only fetch,
 * the final reload effect and brand presentation are controlled.
 * No global clear/reset, private callback call, forged event or client algorithm.
 * Fresh global changes must follow the actual visible producer.
 */
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { t } from 'i18next';

vi.unmock('../../client/config.js');
vi.unmock('../../client/workspaceClient.js');
vi.unmock('../../client/v2Wire.js');
vi.unmock('../../client/requestJson.js');
vi.unmock('../../ui/Notice.js');
vi.unmock('../../ui/announce.js');
vi.mock('../../auth/reloadIntoSession.js', () => ({ reloadIntoSession: vi.fn() }));
vi.mock('../../brand/BrandProvider.js', () => ({
  useBrand: () => ({ productName: 'Test', instanceName: 'Announcement fixture workspace',
    markSrc: '/test.svg', markSrcDark: '' }),
}));

import { WorkspaceSwitcher } from '../WorkspaceSwitcher.js';
import { getCurrentAuthChangeEvent, onAuthChange, type AuthChangeEvent } from '../../client/config.js';
import { getWorkspaceTransitionSnapshot, type MyWorkspaces, type WorkspaceSummary } from '../../client/workspaceClient.js';
import { reloadIntoSession } from '../../auth/reloadIntoSession.js';
import { currentAnnouncements, GlobalLiveRegion } from '../../ui/announce.js';

let observers: MutationObserver[] = [];
let disposers: Array<() => void> = [];
beforeEach(() => {
  observers = []; disposers = [];
  vi.mocked(reloadIntoSession).mockClear();
});
afterEach(async () => {
  for (const observer of observers) observer.disconnect();
  for (const dispose of disposers) dispose();
  cleanup();
  // All controlled responses resolve immediately; flush owned continuations
  // after unmount without changing production auth/transition/announcement state.
  await act(async () => {});
  vi.unstubAllGlobals();
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
}
function listing(active: 'A' | 'B', empty = false): MyWorkspaces {
  return { active, personal: 'personal', workspaces: empty ? [] : ['A', 'B'].map((id): WorkspaceSummary => ({
    workspaceId: id, name: `Workspace ${id}`, slug: id.toLowerCase(),
    roles: ['owner'], kind: 'shared', active: id === active,
  })) };
}
function trustedCopy(key: 'workspaceChangeNotAllowed' | 'workspaceChangeNeedsRefresh'): string {
  const copy = t(`common:${key}`);
  expect(copy).not.toBe(key);
  expect(copy).not.toBe(`common:${key}`);
  expect(copy.trim().length).toBeGreaterThan(0);
  return copy;
}
async function mountObserved() {
  const view = render(<MemoryRouter>
    <GlobalLiveRegion />
    <div data-testid="switcher-surface"><WorkspaceSwitcher /></div>
  </MemoryRouter>);
  const widget = within(view.container).getByTestId('switcher-surface');
  const surface = within(widget);
  const control = await surface.findByRole('combobox');
  if (!(control instanceof HTMLSelectElement)) throw new Error('actual_workspace_select_missing');
  await waitFor(() => expect(control.value).toBe('A'));
  const ownedA = within(control).getByRole('option', { name: 'Workspace A' });
  const offeredB = within(control).getByRole('option', { name: 'Workspace B' });
  if (!(ownedA instanceof HTMLOptionElement) || !(offeredB instanceof HTMLOptionElement)) {
    throw new Error('actual_workspace_options_missing');
  }
  expect(ownedA.selected).toBe(true);
  expect(offeredB.value).toBe('B');

  const region = view.container.querySelector('[data-owp-live="assertive"]');
  if (!(region instanceof HTMLDivElement)) throw new Error('real_assertive_region_missing');
  await waitFor(() => expect(region.textContent ?? '').toBe(currentAnnouncements().assertive));
  const baseline = currentAnnouncements().assertive;
  const changes: string[] = [];
  const observer = new MutationObserver(() => { changes.push(region.textContent ?? ''); });
  observer.observe(region, { childList: true, characterData: true, subtree: true });
  observers.push(observer);
  return { surface, control, region, baseline, changes };
}
async function freshAssertive(view: Awaited<ReturnType<typeof mountObserved>>, copy: string) {
  await waitFor(() => {
    const current = currentAnnouncements().assertive;
    expect(current).not.toBe(view.baseline);
    expect(current).toContain(copy);
    expect(view.region.textContent ?? '').toBe(current);
    expect(view.changes.some((text) => text !== view.baseline && text.includes(copy))).toBe(true);
  });
}

it('announces trusted HTTP403 refusal from the actually loaded workspace selector', async () => {
  const copy = trustedCopy('workspaceChangeNotAllowed');
  const marker = 'PRIVATE_WORKSPACE_REFUSAL_DETAIL';
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/me/workspaces') && (!init?.method || init.method === 'GET')) return json(listing('A'));
    if (url.endsWith('/workspaces/B/switch') && init?.method === 'POST') {
      return json({ error: { message: marker } }, 403);
    }
    throw new Error(`unexpected_controlled_transport ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const view = await mountObserved();
  const eventBefore = getCurrentAuthChangeEvent();
  fireEvent.change(view.control, { target: { value: 'B' } });

  await view.surface.findByText(copy, { exact: true });
  await freshAssertive(view, copy);
  await waitFor(() => expect(view.control.disabled).toBe(false));
  expect(view.control.value).toBe('A');
  expect(getCurrentAuthChangeEvent()).toBe(eventBefore);
  expect(getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'failed', pendingCount: 0 });
  const writes = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(String(writes[0]?.[0])).toMatch(/\/workspaces\/B\/switch$/);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(reloadIntoSession).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain(marker);
  expect(currentAnnouncements().assertive).not.toContain(marker);
});

it('announces current completion failure after its own successful switch loads the static fallback', async () => {
  const copy = trustedCopy('workspaceChangeNeedsRefresh');
  const marker = 'PRIVATE_SYNCHRONOUS_WORKSPACE_LISTENER';
  let switched = false;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/me/workspaces') && (!init?.method || init.method === 'GET')) {
      // This is the actual legacy list read made by the mounted caller on its
      // OWN normal completion event, not an accepted-read proof or a fake ACK.
      return json(listing(switched ? 'B' : 'A', switched));
    }
    if (url.endsWith('/workspaces/B/switch') && init?.method === 'POST') {
      switched = true;
      return json({ ok: true, active: 'B' });
    }
    throw new Error(`unexpected_controlled_transport ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const view = await mountObserved();
  const eventBefore = getCurrentAuthChangeEvent();
  const ownEvents: AuthChangeEvent[] = [];
  const ownEventReady = new Promise<AuthChangeEvent>((resolve) => {
    disposers.push(onAuthChange((event) => {
      ownEvents.push(event);
      resolve(event);
      throw new Error(marker);
    }));
  });
  await act(async () => {
    fireEvent.change(view.control, { target: { value: 'B' } });
    await ownEventReady;
  });

  // A real A/B selector was admitted before the action. Its replacement with
  // this link proves the post-event empty list reached the real render branch.
  const fallback = await view.surface.findByRole('link', { name: /Announcement fixture workspace/ });
  expect(fallback.getAttribute('href')).toBe('/orgs');
  await view.surface.findByText(copy, { exact: true });
  await freshAssertive(view, copy);

  expect(ownEvents).toHaveLength(1);
  const ownEvent = ownEvents[0];
  if (!ownEvent) throw new Error('normal_completion_event_not_observed');
  expect(ownEvent.reason).toBe('explicit');
  expect(ownEvent).not.toBe(eventBefore);
  expect(getCurrentAuthChangeEvent()).toBe(ownEvent);
  expect(getWorkspaceTransitionSnapshot()).toMatchObject({ phase: 'unverified', pendingCount: 0 });
  expect(view.surface.queryByRole('combobox')).toBeNull();
  const writes = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(String(writes[0]?.[0])).toMatch(/\/workspaces\/B\/switch$/);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(switched).toBe(true);
  expect(reloadIntoSession).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain(marker);
  expect(document.body.textContent).not.toContain('auth_change_dispatch_failed');
  expect(currentAnnouncements().assertive).not.toContain(marker);
});
