/**
 * ADR 0958 P3 — files from collaborators, the agency side.
 *
 *   - external collaborators off → renders nothing;
 *   - a failed read is said with a retry, never "nothing waiting";
 *   - a waiting submission shows the sender, the rights and its files as
 *     downloads (never an inline preview), flags files no scanner checked, and
 *     accepts or rejects; reject needs a reason, which is sent;
 *   - the server's refusal is shown verbatim.
 *
 * Sabotage: mapping a failed read to an empty list reds the failed case;
 * rendering a file as an <img> or link to a URL reds the "downloads" assertion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ listClientIntakes: vi.fn(), acceptClientIntake: vi.fn(), rejectClientIntake: vi.fn(), downloadIntakeFile: vi.fn() }));
vi.mock('../intakeClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...h }));

import { ClientIntakeSection } from '../ClientIntakeSection.js';
import { CampaignOpsError } from '../campaignOpsClient.js';

const INTAKE = {
  intakeId: 'intk_1', orgId: 'o1', campaignId: 'c1', grantId: 'cgr_1', collaboratorId: 'ccb_1',
  files: [{ fileId: 'ifl_1', name: 'hero.png', contentType: 'image/png', bytes: 2048, contentHash: 'a'.repeat(64), scan: 'not_configured' }],
  rights: { license: 'licensed-term', termEndsAt: '2027-06-30', credit: 'Dana Studio', modelReleases: true, attestedAt: '2026-10-26T00:00:00Z' },
  status: 'submitted', submittedAt: '2026-10-26T10:00:00Z', accepting: false,
  collaborator: { collaboratorId: 'ccb_1', displayName: 'Dana Studio', kind: 'vendor', status: 'active' },
};

beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });
afterEach(cleanup);

describe('ClientIntakeSection', () => {
  it('renders nothing when external collaborators are off', async () => {
    h.listClientIntakes.mockRejectedValueOnce(new CampaignOpsError('External collaborators is not enabled for this tenant.', 404));
    const { container } = render(<ClientIntakeSection orgId="o1" />);
    await waitFor(() => expect(h.listClientIntakes).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('a failed read is said with a retry, never shown as nothing waiting', async () => {
    h.listClientIntakes.mockRejectedValueOnce(new CampaignOpsError('boom', 500));
    render(<ClientIntakeSection orgId="o1" />);
    expect((await screen.findAllByText(/Couldn’t load the submissions/)).length).toBeGreaterThan(0);
    expect(screen.queryByText('Nothing is waiting for review.')).toBeNull();
    h.listClientIntakes.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing is waiting for review.')).toBeTruthy();
  });

  it('shows the sender, rights and files as downloads; accepts', async () => {
    h.listClientIntakes.mockResolvedValue([INTAKE]);
    h.downloadIntakeFile.mockResolvedValue(undefined);
    render(<ClientIntakeSection orgId="o1" />);
    expect(await screen.findByText('Dana Studio')).toBeTruthy();
    expect(screen.getByText(/Licensed for a term · until .* · releases: yes · credit: Dana Studio/)).toBeTruthy();
    expect(screen.getByText('Not virus-scanned')).toBeTruthy();
    // Unreviewed files are never previewed or linked: only a download button.
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('a[href]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download hero.png to review it' }));
    await waitFor(() => expect(h.downloadIntakeFile).toHaveBeenCalledWith('o1', 'intk_1', INTAKE.files[0]));
    h.acceptClientIntake.mockResolvedValueOnce({ ...INTAKE, status: 'accepted' });
    fireEvent.click(screen.getByRole('button', { name: 'Accept into the media library' }));
    await waitFor(() => expect(h.acceptClientIntake).toHaveBeenCalledWith('o1', 'intk_1'));
    expect(await screen.findByText('Accepted. 1 file(s) added to the media library.')).toBeTruthy();
  });

  it('reject needs a reason and sends it; a server refusal is shown verbatim', async () => {
    h.listClientIntakes.mockResolvedValue([INTAKE]);
    render(<ClientIntakeSection orgId="o1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const confirmBtn = screen.getByRole('button', { name: 'Reject files' }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: /Why/ }), { target: { value: 'Wrong bottle colour' } });
    h.rejectClientIntake.mockRejectedValueOnce(new CampaignOpsError('This submission is being accepted right now.', 409, 'intake_busy'));
    fireEvent.click(screen.getByRole('button', { name: 'Reject files' }));
    await waitFor(() => expect(h.rejectClientIntake).toHaveBeenCalledWith('o1', 'intk_1', 'Wrong bottle colour'));
    expect(await screen.findByText('This submission is being accepted right now.')).toBeTruthy();
  });
});
