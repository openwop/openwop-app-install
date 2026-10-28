/**
 * ADR 0958 P2 — the collaborator's pages.
 *   - "Shared with me" lists grants with client and expiry; a failed read is
 *     said, never shown as an empty list; an empty list has its own state.
 *   - A grant the server no longer serves shows "no longer have access".
 *   - Accept shows who the invite is for, posts the token, and lands on the home;
 *     an email mismatch says how to fix it; a dead invite says so.
 *   - ADR 0958 P3: a campaign grant with `upload` shows "Send files"; sending
 *     needs files, the release answer and the attestation, posts the rights, and
 *     lists the outcome with the agency's reason; a view-only grant has no form.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({ listShared: vi.fn(), getGrant: vi.fn(), acceptInvite: vi.fn(), readInvite: vi.fn(), listIntakes: vi.fn(), sendIntake: vi.fn(), withdrawIntake: vi.fn() }));
vi.mock('../collabClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...h }));

import { CollabAcceptPage, CollabGrantPage, CollabHomePage } from '../CollabPages.js';
import { CollabError } from '../collabClient.js';

function at(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/collab" element={<CollabHomePage />} />
        <Route path="/collab/accept/:token" element={<CollabAcceptPage />} />
        <Route path="/collab/:grantId" element={<CollabGrantPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });
afterEach(cleanup);

describe('Shared with me', () => {
  it('lists grants with the client and a link to each', async () => {
    h.listShared.mockResolvedValue([{ grantId: 'cgr_1', resourceKind: 'creative-brief', title: 'Hero bottle shot', clientName: 'Northwind', actions: ['view'], expiresAt: '2026-11-19T00:00:00Z' }]);
    at('/collab');
    expect(await screen.findByText('Hero bottle shot')).toBeTruthy();
    expect(screen.getByText('For Northwind')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Hero bottle shot/ }).getAttribute('href')).toBe('/collab/cgr_1');
  });

  it('a failed read is said, not shown as empty; an empty list has its own state', async () => {
    h.listShared.mockRejectedValueOnce(new CollabError('boom', 500));
    at('/collab');
    expect(await screen.findByText('Couldn’t load this')).toBeTruthy();
    expect(screen.queryByText('Nothing shared with you yet')).toBeNull();
    h.listShared.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing shared with you yet')).toBeTruthy();
  });
});

describe('a granted item', () => {
  it('renders a campaign and says when access ended', async () => {
    h.getGrant.mockResolvedValueOnce({ grant: { grantId: 'cgr_2', resourceKind: 'campaign', actions: ['view'], expiresAt: '2026-11-19T00:00:00Z' }, title: 'Spring roast', clientName: 'Northwind', resource: { kind: 'campaign', objective: 'Sell 500 bags', channels: ['email'], status: 'draft' } });
    at('/collab/cgr_2');
    expect(await screen.findByText('Sell 500 bags')).toBeTruthy();
    cleanup();
    h.getGrant.mockRejectedValueOnce(new CollabError('Not found.', 404));
    at('/collab/cgr_3');
    expect(await screen.findByText('You no longer have access')).toBeTruthy();
  });
});

describe('accepting an invite', () => {
  it('shows who it is for, accepts and lands on Shared with me', async () => {
    h.readInvite.mockResolvedValue({ collaboratorKind: 'freelancer', displayName: 'Dana Designer', clientName: 'Northwind' });
    h.acceptInvite.mockResolvedValue(undefined);
    h.listShared.mockResolvedValue([]);
    at('/collab/accept/tok123');
    expect(await screen.findByText('Northwind invited you as Dana Designer.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(h.acceptInvite).toHaveBeenCalledWith('tok123'));
    expect(await screen.findByText('Shared with me')).toBeTruthy();
  });

  it('an email mismatch says how to fix it; a dead invite says so', async () => {
    h.readInvite.mockResolvedValue({ collaboratorKind: 'vendor', displayName: 'Pixel' });
    h.acceptInvite.mockRejectedValueOnce(new CollabError('x', 403, 'invite_email_mismatch'));
    at('/collab/accept/tok');
    fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect((await screen.findAllByText(/sent to a different email address/)).length).toBeGreaterThan(0);
    cleanup();
    h.readInvite.mockRejectedValueOnce(Object.assign(new Error('gone'), { kind: 'gone' }));
    at('/collab/accept/dead');
    expect(await screen.findByText('This invitation is no longer valid')).toBeTruthy();
  });
});

describe('sending files (ADR 0958 P3)', () => {
  const grant = (actions: string[]) => ({ grant: { grantId: 'cgr_u', resourceKind: 'campaign', actions, expiresAt: '2026-11-19T00:00:00Z' }, title: 'Spring roast', clientName: 'Northwind', resource: { kind: 'campaign', objective: 'Sell', channels: [], status: 'draft' } });

  it('a view-only grant has no upload form', async () => {
    h.getGrant.mockResolvedValueOnce(grant(['view']));
    at('/collab/cgr_u');
    expect(await screen.findByText('Sell')).toBeTruthy();
    expect(screen.queryByText('Send files')).toBeNull();
    expect(h.listIntakes).not.toHaveBeenCalled();
  });

  it('refuses until the form is complete, then sends the rights and lists the outcome', async () => {
    h.getGrant.mockResolvedValueOnce(grant(['view', 'upload']));
    h.listIntakes.mockResolvedValueOnce([{ intakeId: 'i1', status: 'rejected', submittedAt: '2026-10-20T00:00:00Z', reason: 'Wrong colour', files: [{ fileId: 'f', name: 'old.png', contentType: 'image/png', bytes: 10 }], rights: { license: 'stock', modelReleases: true } }]);
    at('/collab/cgr_u');
    expect(await screen.findByText('Agency’s reason: Wrong colour')).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send files' });
    fireEvent.click(send);
    expect(await screen.findByText('Choose at least one file.')).toBeTruthy();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'hero.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText(/^Files/), { target: { files: [file] } });
    fireEvent.click(send);
    expect(await screen.findByText('Answer the question about releases.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/signed releases/), { target: { value: 'yes' } });
    fireEvent.click(send);
    expect(await screen.findByText('Confirm that you have the right to supply these files.')).toBeTruthy();
    expect(h.sendIntake).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/I have the right to supply/));
    h.sendIntake.mockResolvedValueOnce({ intakeId: 'i2' });
    h.listIntakes.mockResolvedValueOnce([]);
    fireEvent.click(send);
    await waitFor(() => expect(h.sendIntake).toHaveBeenCalledTimes(1));
    const [gid, files, rights] = h.sendIntake.mock.calls[0]!;
    expect(gid).toBe('cgr_u');
    expect((files as File[]).map((f) => f.name)).toEqual(['hero.png']);
    expect(rights).toEqual({ license: 'work-for-hire', modelReleases: true, attest: true });
    expect(await screen.findByText('Sent. The agency will review the files.')).toBeTruthy();
  });

  it('a send refused because access ended says so', async () => {
    h.getGrant.mockResolvedValueOnce(grant(['upload']));
    h.listIntakes.mockResolvedValueOnce([]);
    at('/collab/cgr_u');
    await screen.findByText('Nothing sent yet.');
    fireEvent.change(screen.getByLabelText(/^Files/), { target: { files: [new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })] } });
    fireEvent.change(screen.getByLabelText(/signed releases/), { target: { value: 'no' } });
    fireEvent.click(screen.getByLabelText(/I have the right to supply/));
    h.sendIntake.mockRejectedValueOnce(new CollabError('Not found.', 404));
    fireEvent.click(screen.getByRole('button', { name: 'Send files' }));
    expect(await screen.findByText(/no longer send files here/)).toBeTruthy();
  });
});
