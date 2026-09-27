/**
 * PROJ-UX-2 — the charter editor no longer discards a draft silently.
 *
 * The always-visible tab bar sits directly above the editor, so any of 10 tab
 * clicks — or Cancel — used to destroy up to an 8000-char brief + objectives +
 * milestones with no prompt (the FORM-UX-2 family). This proves BOTH exits are
 * intercepted, and the negative controls: a CLEAN editor cancels and switches
 * tabs without nagging (a guard that always fires trains users to click through
 * it), and a declined confirm keeps the draft on screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const getProject = vi.fn();
const confirmMock = vi.fn();

vi.mock('../projectsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getProject: (id: string) => getProject(id),
  listProjectMembers: vi.fn(async () => ({ members: [], visibility: 'org' })),
}));
vi.mock('../../../client/accessClient.js', () => ({
  listMembers: vi.fn(async () => []),
  getEffectiveAccess: vi.fn(async () => ({ scopes: ['workspace:write'] })),
}));
vi.mock('../../../agents/rosterClient.js', () => ({ listRoster: vi.fn(async () => []) }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: unknown) => confirmMock(o) }));

import { ProjectDetailPage } from '../ProjectDetailPage.js';

const PROJECT = {
  id: 'p1', tenantId: 't', orgId: 'org-1', name: 'Atlas', workflows: [], boardId: 'b1', canWrite: true,
} as never;

const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  getProject.mockReset();
  confirmMock.mockReset();
  getProject.mockResolvedValue(PROJECT);
});
afterEach(cleanup);

/** Render the detail page, open the charter editor, optionally dirty it. */
async function openEditor(opts: { dirty: boolean }): Promise<void> {
  render(<MemoryRouter initialEntries={['/projects/p1']}><ProjectDetailPage /></MemoryRouter>);
  await settle();
  await waitFor(() => expect(screen.getByRole('button', { name: /add a charter/i })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /add a charter/i }));
  await settle();
  if (opts.dirty) {
    fireEvent.change(screen.getByLabelText(/goal/i), { target: { value: 'Ship the launch plan' } });
    await settle();
  }
}

describe('PROJ-UX-2 — tab-click interception', () => {
  it('a DIRTY editor intercepts a tab click; declining keeps the draft on screen', async () => {
    confirmMock.mockResolvedValue(false); // the user chooses to stay
    await openEditor({ dirty: true });

    fireEvent.click(screen.getByRole('tab', { name: /members/i }));
    await settle();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    // The draft SURVIVED — the goal field is still mounted with its text.
    expect((screen.getByLabelText(/goal/i) as HTMLInputElement).value).toBe('Ship the launch plan');
  });

  it('confirming the discard switches the tab and unmounts the editor', async () => {
    confirmMock.mockResolvedValue(true);
    await openEditor({ dirty: true });

    fireEvent.click(screen.getByRole('tab', { name: /members/i }));
    await settle();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText(/goal/i)).toBeNull(); // editor gone
    expect(screen.getByRole('tab', { name: /members/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('a CLEAN editor switches tabs with no prompt (negative control)', async () => {
    await openEditor({ dirty: false });

    fireEvent.click(screen.getByRole('tab', { name: /members/i }));
    await settle();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: /members/i }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('PROJ-UX-2 — Cancel interception', () => {
  it('a DIRTY editor asks before Cancel; declining keeps the editor', async () => {
    confirmMock.mockResolvedValue(false);
    await openEditor({ dirty: true });

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await settle();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText(/goal/i) as HTMLInputElement).value).toBe('Ship the launch plan');
  });

  it('a CLEAN editor cancels with no prompt (negative control)', async () => {
    await openEditor({ dirty: false });

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await settle();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/goal/i)).toBeNull(); // back to the read view
  });

  it('an edit typed and then REVERTED reads clean again (value-compare, not a touched flag)', async () => {
    await openEditor({ dirty: true });
    fireEvent.change(screen.getByLabelText(/goal/i), { target: { value: '' } }); // revert to initial
    await settle();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await settle();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/goal/i)).toBeNull();
  });
});
