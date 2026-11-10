/**
 * ADR 0488 / ADR 0435 (TOUR-ENTRY-1, 2bb779381) — a shipped tutorial's "Show me" checks
 * the CURRENT campaign sample (`getWorkflowDefinitionRaw`) only on explicit launch, and
 * never seeds or rewrites it. Absent → setup link, no player launch. A failed or refused
 * read → retry, never "missing". A result from a superseded auth epoch (including
 * A→B→A) or after unmount is dropped. Repeated clicks while checking coalesce.
 * Real tutorial UI and launch bus; the catalog read is mocked, and `fetch` is a spy that
 * must stay uncalled, so no write leaves the page.
 *
 * Guards (TutorialLaunchButton, TutorialsPage.tsx): `if (!current()) return` after the read,
 * the auth `invalidate` generation bump, the unmount pair (`mounted=false` + generation
 * bump: a recorded double guard, witnessed by one edit breaking both), and `busy`.
 * Sabotage-witnessed (w94 probes): launching on a missing sample, reporting a failure as
 * missing, dropping the `current()` return, a parity-flip generation, the unmount pair,
 * and the busy guard each red their case.
 */
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import { onWalkthroughLaunchRequest } from '../../../walkthroughs/walkthroughBus.js';
import { fireAuthChanged } from '../../../client/config.js';
import { i18n } from '../../../i18n/index.js';

type Client = typeof import('../tutorialsClient.js');
const client = vi.hoisted(() => ({
  fetchTutorialProgress: vi.fn<Client['fetchTutorialProgress']>(), saveTutorialProgress: vi.fn<Client['saveTutorialProgress']>(),
  fetchTutorials: vi.fn<Client['fetchTutorials']>(), fetchTutorial: vi.fn<Client['fetchTutorial']>(),
}));
const read = vi.hoisted(() => vi.fn<typeof import('../../../client/workflowsClient.js')['getWorkflowDefinitionRaw']>());
vi.mock('../tutorialsClient.js', () => client);
vi.mock('../../../client/workflowsClient.js', () => ({ getWorkflowDefinitionRaw: read }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess({ enabled: true }) }));
const { TutorialsPage } = await import('../TutorialsPage.js');
const ID = 'walkthrough.campaign-studio.first-brief';
const edited = { workflowId: ID, metadata: { name: 'Our edited sample', walkthrough: true }, nodes: [{ nodeId: 'edited', typeId: 'core.noop' }] };
const launch = vi.fn<(id: string) => void>();
const network = vi.fn<typeof fetch>(async () => { throw new Error('unexpected network call from the tutorial page'); });
let off: (() => void) | undefined;
const text = (key: string) => String(i18n.t(`tutorials:${key}`));
const show = () => screen.getByRole('button', { name: text('showMePhase') });
function mount() {
  return render(<MemoryRouter initialEntries={['/tutorials/campaign-studio-first-brief']}>
    <Routes><Route path="/tutorials/:tutorialId" element={<TutorialsPage />} />
      <Route path="/walkthroughs" element={<h1>Guided walkthrough setup destination</h1>} /></Routes>
  </MemoryRouter>);
}
function deferred() {
  let resolve: (value: Record<string, unknown> | null) => void = () => { throw new Error('Deferred reader was not initialized'); };
  const promise = new Promise<Record<string, unknown> | null>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  client.fetchTutorialProgress.mockResolvedValue({ ok: true, persisted: false, rows: [] });
  client.saveTutorialProgress.mockResolvedValue({ ok: true });
  client.fetchTutorials.mockResolvedValue({ ok: true, degraded: false, tutorials: [] });
  client.fetchTutorial.mockResolvedValue({ ok: true, tutorial: null });
  read.mockResolvedValue(null);
  vi.stubGlobal('fetch', network);
  off = onWalkthroughLaunchRequest(launch);
});
afterEach(() => { off?.(); cleanup(); vi.unstubAllGlobals(); });

it('missing current sample offers explicit setup and never dispatches a player launch', async () => {
  mount(); fireEvent.click(show());
  expect(await screen.findByText(text('sampleUnavailable'))).toBeTruthy();
  expect(read).toHaveBeenCalledExactlyOnceWith(ID);
  expect(launch).not.toHaveBeenCalled();
  const link = screen.getByRole('link', { name: text('sampleSetup') });
  expect(link.getAttribute('href')).toBe('/walkthroughs');
  fireEvent.click(link);
  expect(await screen.findByRole('heading', { name: 'Guided walkthrough setup destination' })).toBeTruthy();
  expect(launch).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

it('an available tenant-edited sample launches the exact current ID once without rewriting its definition', async () => {
  read.mockResolvedValue(edited); mount(); fireEvent.click(show());
  await waitFor(() => expect(launch).toHaveBeenCalledExactlyOnceWith(ID));
  expect(read).toHaveBeenCalledExactlyOnceWith(ID);
  expect(screen.queryByText(text('sampleUnavailable'))).toBeNull();
  expect(network).not.toHaveBeenCalled(); // no seed or definition write left the page
});

it('a refused or failed read offers retry rather than claiming the sample is absent', async () => {
  read.mockRejectedValue(new Error('catalog 403')); mount(); fireEvent.click(show());
  expect(await screen.findByText(text('sampleCheckFailed'))).toBeTruthy();
  expect(screen.queryByText(text('sampleUnavailable'))).toBeNull();
  expect(screen.queryByRole('link', { name: text('sampleSetup') })).toBeNull();
  expect(launch).not.toHaveBeenCalled();
  read.mockResolvedValue(edited);
  fireEvent.click(screen.getByRole('button', { name: String(i18n.t('common:retry')) }));
  await waitFor(() => expect(launch).toHaveBeenCalledExactlyOnceWith(ID));
});

it('auth changes invalidate a pending available result before it can launch, including same-act settlement', async () => {
  const pending = deferred(); read.mockReturnValue(pending.promise); mount(); fireEvent.click(show());
  await act(async () => { fireAuthChanged(); pending.resolve(edited); await pending.promise; });
  expect(launch).not.toHaveBeenCalled();
  expect(screen.queryByText(text('sampleUnavailable'))).toBeNull();
  read.mockResolvedValue(edited); fireEvent.click(show());
  await waitFor(() => expect(launch).toHaveBeenCalledExactlyOnceWith(ID));
});

it('an A-to-B-to-A auth change cannot revive an old missing result', async () => {
  const pending = deferred(); read.mockReturnValue(pending.promise); mount(); fireEvent.click(show());
  await act(async () => { fireAuthChanged(); fireAuthChanged(); pending.resolve(null); await pending.promise; });
  expect(launch).not.toHaveBeenCalled();
  expect(screen.queryByText(text('sampleUnavailable'))).toBeNull();
  read.mockResolvedValue(edited); fireEvent.click(show());
  await waitFor(() => expect(launch).toHaveBeenCalledExactlyOnceWith(ID));
});

it('does not dispatch when the tutorial unmounts before its catalog result', async () => {
  const pending = deferred(); read.mockReturnValue(pending.promise); const page = mount(); fireEvent.click(show());
  page.unmount();
  await act(async () => { pending.resolve(edited); await pending.promise; });
  expect(launch).not.toHaveBeenCalled();
});

it('coalesces repeated clicks while checking rather than dispatching duplicate launches', async () => {
  const pending = deferred(); read.mockReturnValue(pending.promise); mount(); const button = show();
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(read).toHaveBeenCalledExactlyOnceWith(ID);
  await act(async () => { pending.resolve(edited); await pending.promise; });
  expect(launch).toHaveBeenCalledExactlyOnceWith(ID);
});
