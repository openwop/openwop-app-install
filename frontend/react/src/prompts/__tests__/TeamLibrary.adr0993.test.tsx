/**
 * ADR 0993 D8 — the Team library tab. Before it, no screen could publish, edit,
 * set the visibility of or delete an org library entry (`createPrompt` had no
 * callers), so the chat's `/p-` picker read a collection only the API could fill.
 *
 * Breaks if: an edit stops sending the revision it opened (D3), a stale edit is
 * applied or shown as a generic failure instead of reloading, a write stops
 * telling the chat commands to re-read, a dead entry is offered for use, or
 * "Use in chat" sends instead of staging a draft at `/chat`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PromptEntry } from '../../client/promptLibraryClient.js';

const m = vi.hoisted(() => ({
  listTeamPrompts: vi.fn<(orgId: string) => Promise<PromptEntry[]>>(),
  publishTeamPrompt: vi.fn(),
  editTeamPrompt: vi.fn(),
  deleteTeamPrompt: vi.fn(),
  renderTeamPrompt: vi.fn<(orgId: string, entryId: string) => Promise<string>>(),
  invalidatePromptCommands: vi.fn(),
  stageComposerDraft: vi.fn(),
}));
vi.mock('../teamLibraryClient.js', async (orig) => ({ ...(await orig<typeof import('../teamLibraryClient.js')>()), ...{
  listTeamPrompts: m.listTeamPrompts, publishTeamPrompt: m.publishTeamPrompt, editTeamPrompt: m.editTeamPrompt,
  deleteTeamPrompt: m.deleteTeamPrompt, renderTeamPrompt: m.renderTeamPrompt,
} }));
vi.mock('../../client/promptLibraryClient.js', () => ({ listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]) }));
vi.mock('../../chat/promptCommands.js', () => ({ invalidatePromptCommands: m.invalidatePromptCommands }));
vi.mock('../../chat/composerSeed.js', () => ({ stageComposerDraft: m.stageComposerDraft }));

import { TeamLibrary } from '../TeamLibrary.js';
import { TeamLibraryError } from '../teamLibraryClient.js';

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

beforeEach(() => { for (const f of Object.values(m)) f.mockReset(); });
afterEach(cleanup);

describe('Team library', () => {
  it('an edit sends the revision it opened; a stale one keeps the form and offers the reload', async () => {
    m.listTeamPrompts.mockResolvedValue([entry({})]);
    m.editTeamPrompt.mockRejectedValueOnce(new TeamLibraryError('conflict', 409, 'changed'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Weekly digest' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit team prompt' });
    fireEvent.change(within(dialog).getByLabelText(/Prompt text/), { target: { value: 'Summarize the month.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(m.editTeamPrompt).toHaveBeenCalledTimes(1));
    expect(m.editTeamPrompt).toHaveBeenCalledWith('org-1', 'e1', expect.objectContaining({ expectedRevision: 3, text: 'Summarize the month.' }));
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
    m.publishTeamPrompt.mockResolvedValue(entry({}));
    mount({ name: 'Tone editor', template: { kind: 'system', text: 'Edit for tone.' } });
    const dialog = await screen.findByRole('dialog', { name: 'Publish to the Team library' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(m.publishTeamPrompt).toHaveBeenCalledWith('org-1', expect.objectContaining({
      name: 'Tone editor', visibility: 'org', template: { kind: 'system', text: 'Edit for tone.' },
    })));
    await waitFor(() => expect(m.invalidatePromptCommands).toHaveBeenCalled());
  });

  it('a dead entry is flagged and cannot be used; a live one stages a draft at /chat', async () => {
    m.listTeamPrompts.mockResolvedValue([withoutBody(entry({ entryId: 'dead', name: 'Gone', available: false })), entry({})]);
    m.renderTeamPrompt.mockResolvedValue('Summarize the week.');
    mount();
    await screen.findByText('Template missing');
    const [deadUse, liveUse] = screen.getAllByRole('button', { name: 'Use in chat' });
    expect((deadUse as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(liveUse!);
    await screen.findByText('chat page');
    expect(m.stageComposerDraft).toHaveBeenCalledWith('Summarize the week.');
  });
});
