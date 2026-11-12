/**
 * ADR 0522: a creative brief opens at its own URL (`/creative-briefs/:briefId?org=`), and the
 * client org in that URL is validated against the caller's orgs before any read. This runs
 * the real page and router with controlled client calls. No provider, database, image or
 * reel execution.
 *
 * Invariants, and the sabotages that turn them red (wave 94, w94g2-cb-*):
 *  - An explicit `?org=` is restored before the detail fetch. An unknown org is never fetched
 *    and never falls back to the first org (house). Reds when orgId ignores `?org=` or falls back.
 *  - Every list, new and back link carries `?org=` (briefHref, open). A failed legacy target
 *    (no `?org=`) is kept, so choosing its org or Retry recovers it. Returning to the list
 *    clears the failure.
 *  - Dirty editor text survives auth revalidation and a failed refresh. The editor stays hidden
 *    until the scope is revalidated (`hidden={!editorReady}`), and `selected` is kept on refetch
 *    and on failure.
 *  - A failed list read is never shown as "No creative briefs yet".
 *  - Late results never paint another scope. A late detail read has THREE guards (`cancelled`,
 *    `detailSeq`, `ownsScope`), so the witness breaks all three. A creation that completes after
 *    leaving the page is refused by two `ownsScope` checks. Both depend on the unmount cleanup
 *    bumping the sequences, which is where the break-both witness aims. StrictMode's cleanup must
 *    re-sync `authEpoch`, or the page never becomes ready.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { fireAuthChanged } from '../../../client/config.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { CreativeBrief, Org, createBrief, getBrief, listBriefs, listOrgs, updateBrief } from '../creativeBriefsClient.js';
const api = vi.hoisted(() => ({
  orgs: vi.fn<typeof listOrgs>(), list: vi.fn<typeof listBriefs>(), get: vi.fn<typeof getBrief>(),
  create: vi.fn<typeof createBrief>(), update: vi.fn<typeof updateBrief>(),
}));
vi.mock('../creativeBriefsClient.js', async orig => ({
  ...await orig<Record<string, unknown>>(), listOrgs: api.orgs, listBriefs: api.list, getBrief: api.get, createBrief: api.create, updateBrief: api.update,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: (id: string) => makeFeatureAccess({ enabled: id === 'creative-briefs', loading: false }),
}));
vi.mock('../RendersSection.js', () => ({ RendersSection: () => null }));
// ADR 1039 D8 — the brief page asks the agent catalog whether to offer "Ask the Creative Director".
vi.mock('../../../chat/lib/agentMentions.js', () => ({ useAgentMentions: () => ({ entries: [], isLoading: false, error: null }) }));
vi.mock('../../media/mediaClient.js', async orig => ({ ...await orig<Record<string, unknown>>(), listAssets: vi.fn(async () => []) }));
import { CreativeBriefsPage } from '../CreativeBriefsPage.js';
const ORGS: Org[] = [{ orgId: 'house', name: 'QA house' }, { orgId: 'kick', name: 'QA KickTodo' }];
const BRIEF: CreativeBrief = { briefId: 'cbrief:saved', orgId: 'kick', title: 'Saved KickTodo creative', assetType: 'still', sceneDescription: 'A small next step', composition: 'One clear subject', cameraAngle: 'Eye level', lighting: 'Natural', messagingIntent: 'Make room', directions: [{ label: 'One step', rationale: 'Fit a real week' }], moodBoard: [], status: 'draft', version: 2, updatedAt: '2026-11-06T04:57:00Z' };
const HOUSE = { ...BRIEF, briefId: 'cbrief:house', orgId: 'house', title: 'House creative' };
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function Location() {
  const location = useLocation();
  return <><output aria-label="Current location">{location.pathname}{location.search}</output>
    <Link to="/creative-briefs/cbrief%3Ahouse?org=house">Other brief</Link><Link to="/away">Leave page</Link></>;
}
function mount(url = '/creative-briefs/cbrief%3Asaved?org=kick', strict = false) {
  const content = <MemoryRouter initialEntries={[url]}><Location /><Routes>
    <Route path="/creative-briefs" element={<CreativeBriefsPage />} />
    <Route path="/creative-briefs/:briefId" element={<CreativeBriefsPage />} />
    <Route path="/away" element={<p>Away</p>} />
  </Routes></MemoryRouter>;
  return render(strict ? <StrictMode>{content}</StrictMode> : content);
}
const location = () => screen.getByLabelText('Current location').textContent ?? '';
beforeEach(() => {
  api.orgs.mockReset().mockResolvedValue(ORGS);
  api.list.mockReset().mockImplementation(async (org: string) => org === 'kick' ? [BRIEF] : []);
  api.get.mockReset().mockImplementation(async (org: string, id: string) => {
    if (org === 'kick' && id === BRIEF.briefId) return BRIEF;
    if (org === 'house' && id === HOUSE.briefId) return HOUSE;
    throw new Error('Creative brief not found.');
  });
  api.create.mockReset().mockResolvedValue(BRIEF);
  api.update.mockReset().mockResolvedValue(BRIEF);
});
afterEach(cleanup);

it('restores the explicit client before fetching an encoded detail and retains authored v2 fields', async () => {
  mount(); await screen.findByDisplayValue(BRIEF.title);
  expect(screen.getByDisplayValue('One step')).toBeTruthy();
  expect(screen.getByText('v2')).toBeTruthy();
  expect(screen.getByDisplayValue(BRIEF.sceneDescription)).toBeTruthy();
  expect(api.get).toHaveBeenCalledWith('kick', 'cbrief:saved');
  expect(api.get.mock.calls.some(([org]) => org === 'house')).toBe(false);
  const picker = screen.getByRole('combobox', { name: 'Organization' });
  if (!(picker instanceof HTMLSelectElement)) throw new Error('Organization picker must be a select');
  expect(picker.value).toBe('kick');
});
it('keeps a failed legacy target and recovers by choosing its authorized organization', async () => {
  mount('/creative-briefs/cbrief%3Asaved');
  await screen.findByText('Creative brief not found.');
  expect(location()).toBe('/creative-briefs/cbrief%3Asaved');
  fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), { target: { value: 'kick' } });
  await screen.findByDisplayValue(BRIEF.title);
  expect(location()).toBe('/creative-briefs/cbrief%3Asaved?org=kick');
  expect(screen.queryByText('Creative brief not found.')).toBeNull();
});
it('never fetches an unknown explicit org or silently falls back to house', async () => {
  mount('/creative-briefs/cbrief%3Asaved?org=foreign');
  await screen.findByRole('option', { name: 'Choose an organization' });
  expect(api.get).not.toHaveBeenCalled(); expect(api.list).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), { target: { value: 'kick' } });
  await screen.findByDisplayValue(BRIEF.title);
});
it('retries a transient detail failure on the same URL without dropping its target', async () => {
  api.get.mockRejectedValueOnce(new Error('Temporary detail failure'));
  mount(); await screen.findByText('Temporary detail failure');
  const original = location(); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByDisplayValue(BRIEF.title); expect(location()).toBe(original);
});
it('uses scoped list/new/back links so new tabs and reloads carry the client', async () => {
  mount('/creative-briefs?org=kick');
  const card = await screen.findByRole('link', { name: /Saved KickTodo creative/ });
  expect(card.getAttribute('href')).toBe('/creative-briefs/cbrief%3Asaved?org=kick');
  fireEvent.click(screen.getByRole('button', { name: /New brief/i }));
  await screen.findByDisplayValue(BRIEF.title); expect(location()).toBe('/creative-briefs/cbrief%3Asaved?org=kick');
  fireEvent.click(screen.getByRole('button', { name: 'All briefs' }));
  await screen.findByRole('link', { name: /Saved KickTodo creative/ });
  expect(location()).toBe('/creative-briefs?org=kick');
});
it('preserves dirty editor text through auth revalidation and a failed refresh until retry succeeds', async () => {
  mount(); await screen.findByDisplayValue(BRIEF.title);
  fireEvent.change(screen.getByDisplayValue(BRIEF.sceneDescription), { target: { value: 'Unsaved scene edit' } });
  const orgs = deferred<Org[]>(); api.orgs.mockReturnValueOnce(orgs.promise);
  api.get.mockRejectedValueOnce(new Error('Refresh unavailable'));
  act(() => fireAuthChanged());
  expect(screen.getByDisplayValue('Unsaved scene edit').closest('fieldset')?.hidden).toBe(true);
  await act(async () => orgs.resolve(ORGS));
  await screen.findByText('Refresh unavailable');
  expect(screen.getByDisplayValue('Unsaved scene edit').closest('fieldset')?.hidden).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByDisplayValue('Unsaved scene edit').closest('fieldset')?.hidden).toBe(false));
  expect(screen.getByDisplayValue('Unsaved scene edit')).toBeTruthy();
});
it.each(['success', 'error'] as const)('ignores late previous-detail %s after navigation to another scoped record', async outcome => {
  const old = deferred<CreativeBrief>(); api.get.mockImplementationOnce(() => old.promise);
  mount(); await waitFor(() => expect(api.get).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('link', { name: 'Other brief' }));
  await screen.findByDisplayValue(HOUSE.title);
  await act(async () => { if (outcome === 'success') old.resolve(BRIEF); else old.reject(new Error('Obsolete detail error')); });
  expect(screen.getByDisplayValue(HOUSE.title)).toBeTruthy();
  expect(screen.queryByText('Obsolete detail error')).toBeNull();
  expect(location()).toBe('/creative-briefs/cbrief%3Ahouse?org=house');
});
it('does not claim an empty collection when the scoped list request failed', async () => {
  api.list.mockRejectedValueOnce(new Error('List unavailable'));
  mount('/creative-briefs?org=kick'); await screen.findByText('List unavailable');
  expect(screen.queryByText('No creative briefs yet')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('link', { name: /Saved KickTodo creative/ });
});
it('does not navigate back when creation completes after leaving the page', async () => {
  const created = deferred<CreativeBrief>(); api.create.mockReturnValueOnce(created.promise);
  api.list.mockResolvedValue([HOUSE]);
  mount('/creative-briefs?org=house');
  await screen.findByRole('link', { name: /House creative/ });
  fireEvent.click(screen.getByRole('button', { name: /New brief/i }));
  await waitFor(() => expect(api.create).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('link', { name: 'Leave page' }));
  await act(async () => created.resolve(HOUSE));
  expect(screen.getByText('Away')).toBeTruthy(); expect(location()).toBe('/away');
});

it('recovers StrictMode cleanup and commits a dirty save refresh in the current scope', async () => {
  mount(undefined, true);
  const scene = await screen.findByDisplayValue(BRIEF.sceneDescription);
  fireEvent.change(scene, { target: { value: 'StrictMode saved scene' } });
  const saved = { ...BRIEF, sceneDescription: 'StrictMode saved scene', version: 3 };
  api.get.mockResolvedValue(saved);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('v3');
  expect(api.update).toHaveBeenCalledWith('kick', BRIEF.briefId, expect.objectContaining({ sceneDescription: saved.sceneDescription }));
  expect(screen.getByDisplayValue(saved.sceneDescription)).toBeTruthy();
});

it('clears failed detail recovery when explicitly returning to the collection', async () => {
  mount('/creative-briefs/cbrief%3Asaved');
  await screen.findByText('Creative brief not found.');
  fireEvent.click(screen.getByRole('button', { name: 'All briefs' }));
  await waitFor(() => expect(location()).toBe('/creative-briefs?org=house'));
  expect(screen.queryByText('Creative brief not found.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});
