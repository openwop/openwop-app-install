/**
 * ADR 0993 D8 — the Team library tab. Before it, no screen could publish, edit,
 * set the visibility of or delete an org library entry (`createPrompt` had no
 * callers), so the chat's `/p-` picker read a collection only the API could fill.
 *
 * Breaks if: an edit stops sending the revision it opened (D3), a stale edit is
 * applied or shown as a generic failure instead of reloading, a write stops
 * telling the chat commands to re-read, a dead entry is offered for use, or
 * "Use in chat" sends instead of staging a draft at `/chat`.
 *
 * The list is a typed module mock; edit, publish and render are stubbed at the
 * FETCH level, so each case asserts the exact route, method and whole body, and
 * the stale edit is the server's 409 `conflict` through the real client.
 *
 * Sabotage (witnessed, wave 78): send revision 1 instead of the opened one, any
 * other visibility, a non-PATCH, or treat `conflict` as a generic failure, or
 * skip the reload → case 1 red; skip `invalidatePromptCommands`, or publish the
 * wrong kind → case 2 red; enable the dead entry's button, or skip staging the
 * rendered text → case 3 red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { config } from '../../client/config.js';
import type { PromptEntry } from '../../client/promptLibraryClient.js';

const m = vi.hoisted(() => ({
  listTeamPrompts: vi.fn<(orgId: string) => Promise<PromptEntry[]>>(),
  invalidatePromptCommands: vi.fn<() => void>(),
  stageComposerDraft: vi.fn<(text: string) => void>(),
}));
vi.mock('../teamLibraryClient.js', async (orig) => ({ ...(await orig<typeof import('../teamLibraryClient.js')>()), listTeamPrompts: m.listTeamPrompts }));
vi.mock('../../client/promptLibraryClient.js', () => ({ listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]) }));
vi.mock('../../chat/promptCommands.js', () => ({ invalidatePromptCommands: m.invalidatePromptCommands }));
vi.mock('../../chat/composerSeed.js', () => ({ stageComposerDraft: m.stageComposerDraft }));

import { TeamLibrary } from '../TeamLibrary.js';

const ENTRIES = `${config.baseUrl}/host/openwop-app/prompts/orgs/org-1/entries`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const requests = (): Array<[string, string | undefined, unknown]> =>
  fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined]);

const entry = (over: Partial<PromptEntry>): PromptEntry => ({
  entryId: 'e1', name: 'Weekly digest', visibility: 'org', revision: 3, available: true, ownedByCaller: true,
  bodyVersion: '1.2.0', body: { kind: 'user', text: 'Summarize the week.', version: '1.2.0' }, ...over,
});

/** A dead entry has no resolved body (the field is absent, not undefined). */
function withoutBody(e: PromptEntry): PromptEntry {
  const { body: _gone, ...rest } = e;
  return rest;
}

function mount(draft: Parameters<typeof TeamLibrary>[0]['draft'] = null) {
  return render(
    <MemoryRouter initialEntries={['/prompts']}>
      <Routes>
        <Route path="/prompts" element={<TeamLibrary draft={draft} onDraftTaken={() => {}} />} />
        <Route path="/chat" element={<div>chat page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Team library', () => {
  it('an edit sends the revision it opened; a stale one keeps the form and offers the reload', async () => {
    m.listTeamPrompts.mockResolvedValue([entry({})]);
    fetchMock.mockResolvedValueOnce(json(409, { error: 'conflict', message: 'changed' }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Weekly digest' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit team prompt' });
    fireEvent.change(within(dialog).getByLabelText(/Prompt text/), { target: { value: 'Summarize the month.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requests()).toEqual([[`${ENTRIES}/e1`, 'PATCH', {
      name: 'Weekly digest', description: '', visibility: 'org', text: 'Summarize the month.', expectedRevision: 3,
    }]]);
    // The form stays, with what was typed, and says why (grade-ux P61UX-4).
    await within(dialog).findByText(/Someone changed this prompt/);
    expect((within(dialog).getByLabelText(/Prompt text/) as HTMLTextAreaElement).value).toBe('Summarize the month.');
    expect(m.invalidatePromptCommands, 'nothing was written').not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload the latest version' }));
    await waitFor(() => expect(m.listTeamPrompts).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('publishing a shared draft posts its text and tells the chat commands to re-read', async () => {
    m.listTeamPrompts.mockResolvedValue([]);
    fetchMock.mockResolvedValueOnce(json(201, { entry: entry({}) }));
    mount({ name: 'Tone editor', template: { kind: 'system', text: 'Edit for tone.' } });
    const dialog = await screen.findByRole('dialog', { name: 'Publish to the Team library' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(m.invalidatePromptCommands).toHaveBeenCalledTimes(1));
    expect(requests()).toEqual([[ENTRIES, 'POST', { name: 'Tone editor', visibility: 'org', template: { kind: 'system', text: 'Edit for tone.' } }]]);
  });

  it('a dead entry is flagged and cannot be used; a live one stages a draft at /chat', async () => {
    m.listTeamPrompts.mockResolvedValue([withoutBody(entry({ entryId: 'dead', name: 'Gone', available: false })), entry({})]);
    fetchMock.mockResolvedValueOnce(json(200, { composed: 'Summarize the week.' }));
    mount();
    await screen.findByText('Template missing');
    const [deadUse, liveUse] = screen.getAllByRole('button', { name: 'Use in chat' });
    expect((deadUse as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(liveUse!);
    await screen.findByText('chat page');
    expect(m.stageComposerDraft).toHaveBeenCalledWith('Summarize the week.');
    expect(requests()).toEqual([[`${ENTRIES}/e1/render`, 'POST', { variables: {} }]]);
  });
});
