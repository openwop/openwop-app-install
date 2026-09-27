/**
 * WS-DISC — creating a workspace is reachable from Organizations & access.
 *
 * A **workspace** is the tenant (ADR 0015); an **organization** is a grouping
 * inside it. This page only ever managed organizations, but its title and lede
 * read as the entry point for both, and the real create affordance was the last
 * `<option>` inside a `<select>` labelled "Switch workspace". Users concluded the
 * app could not create a workspace — the reachability half of the same defect
 * class ADR 0508 was the working half of.
 *
 * These assert the two things that make it a fix rather than decoration: the
 * action is PRESENT here, and a FAILED create SAYS SO (a silent failure would be
 * the failed-read-as-empty family in its write-path form — the user could not tell
 * "refused" from "nothing happened").
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const createAndEnterWorkspace = vi.fn();
vi.mock('../../client/workspaceClient.js', () => ({
  createAndEnterWorkspace: (name: string) => createAndEnterWorkspace(name),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { WorkspaceCreateSection } from '../WorkspaceCreateSection.js';

beforeEach(() => { cleanup(); createAndEnterWorkspace.mockReset(); });

describe('WS-DISC — workspace creation is reachable from the orgs page', () => {
  it('creates through the SHARED create-and-enter unit, not a local re-implementation', async () => {
    createAndEnterWorkspace.mockResolvedValue({ workspaceId: 'ws:new', name: 'Acme' });
    const onCreated = vi.fn();
    render(<WorkspaceCreateSection onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('newWorkspaceAriaLabel'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'createWorkspace' }));

    // The single unit — creating without entering would leave the user staring at
    // their OLD workspace wondering whether it worked.
    await waitFor(() => expect(createAndEnterWorkspace).toHaveBeenCalledWith('Acme'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('a FAILED create says so — it does not fail silently', async () => {
    createAndEnterWorkspace.mockRejectedValue(new Error('Workspace limit reached.'));
    const onCreated = vi.fn();
    render(<WorkspaceCreateSection onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('newWorkspaceAriaLabel'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'createWorkspace' }));

    // The server's reason, surfaced. Not a generic shrug, and NOT silence.
    await waitFor(() => expect(screen.getByText('Workspace limit reached.')).toBeTruthy());
    // And the refresh must NOT run — reloading on failure would hide the message
    // the user needs to read.
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('guards a whitespace-only name IN THE HANDLER, not just via the disabled button', async () => {
    // Sabotage-verified: clicking the button proves nothing here, because the button
    // is `disabled` when the name is blank, so the click never lands and the
    // handler's own guard is never exercised — the first version of this test stayed
    // GREEN with the guard deleted. Submit the FORM directly (Enter in the field
    // does exactly this in a real browser) so the guard is what is under test.
    const { container } = render(<WorkspaceCreateSection onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('newWorkspaceAriaLabel'), { target: { value: '   ' } });
    const form = container.querySelector('form');
    expect(form, 'the create form must exist').toBeTruthy();
    fireEvent.submit(form!);
    expect(createAndEnterWorkspace).not.toHaveBeenCalled();
  });

  it('the submit button is ALSO disabled while the name is blank', () => {
    // The affordance half, asserted separately so neither claim rides on the other.
    render(<WorkspaceCreateSection onCreated={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'createWorkspace' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
