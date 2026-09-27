/**
 * ADR 0501 (console) — the coach's desk renders the caseload, composes a
 * proposal over the closed lanes, previews the server's humanized lines, and
 * sends. It never applies anything; the participant decides on their card.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const caseload = [
  { circleId: 'circ:1', circleName: 'March Cohort', enrollmentId: 'enr:1', summary: { currentDay: 4, durationDays: 14, completedActivities: 0, totalRequiredActivities: 4, state: 'active' }, flagged: true, proposals: [] },
  { circleId: 'circ:2', circleName: 'Walkers', enrollmentId: 'enr:2', summary: { currentDay: 2, durationDays: 7, completedActivities: 2, totalRequiredActivities: 2, state: 'active' }, flagged: false, proposals: [
    { id: 'prop:a', state: 'applied', note: 'Try mornings.', hasCommands: true, createdAt: '2026-09-10T08:00:00Z' },
  ] },
];

vi.mock('../../../client/kicktodoCirclesClient.js', () => ({
  getCaseload: vi.fn(async () => caseload),
  dryRunProposal: vi.fn(async (_circleId: string, commands: unknown[]) => ({ lines: commands.map(() => 'Move your sessions to the morning.') })),
  createProposal: vi.fn(async () => ({ id: 'prop:new', state: 'proposed' })),
}));

import { CoachConsolePage } from '../CoachConsolePage.js';
import { dryRunProposal, createProposal } from '../../../client/kicktodoCirclesClient.js';
import { messages as en } from '../i18n/en.js';

afterEach(cleanup);

function mount() {
  return render(<MemoryRouter><CoachConsolePage /></MemoryRouter>);
}

describe('CoachConsolePage', () => {
  it('renders the caseload with the attention flag and each row’s proposal count', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('March Cohort')).toBeTruthy());
    expect(screen.getByText(en.coachFlagged)).toBeTruthy();
    expect(screen.getByText(en.coachOnTrack)).toBeTruthy();
    // Rows are a real table with the caption a screen reader announces.
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('composes a proposal: note required, lanes closed, preview shows the participant’s lines, send posts commands', async () => {
    mount();
    await waitFor(() => screen.getByText('March Cohort'));
    fireEvent.click(screen.getByText('March Cohort'));
    // Send is disabled until a note exists — advice is never empty.
    const send = screen.getByRole('button', { name: en.coachSendCta }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(new RegExp(en.coachNoteLabel)), { target: { value: 'Mornings suit you.' } });
    expect(send.disabled).toBe(false);
    // Add one command (schedule → morning by default) and preview it.
    fireEvent.click(screen.getByRole('button', { name: en.coachAddCommand }));
    fireEvent.click(screen.getByRole('button', { name: en.coachPreviewCta }));
    await waitFor(() => expect(screen.getByText('Move your sessions to the morning.')).toBeTruthy());
    expect(vi.mocked(dryRunProposal)).toHaveBeenCalledWith('circ:1', [{ lane: 'schedule', daypart: 'morning' }]);
    // Send carries the note and the commands; the confirmation says who decides.
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByText(en.coachSent)).toBeTruthy());
    expect(vi.mocked(createProposal)).toHaveBeenCalledWith('circ:1', 'Mornings suit you.', [{ lane: 'schedule', daypart: 'morning' }]);
  });

  it('caps the composer at five commands and names the cap', async () => {
    mount();
    await waitFor(() => screen.getByText('Walkers'));
    fireEvent.click(screen.getByText('Walkers'));
    const add = screen.getByRole('button', { name: en.coachAddCommand }) as HTMLButtonElement;
    for (let i = 0; i < 5; i += 1) fireEvent.click(add);
    expect(add.disabled).toBe(true);
    expect(screen.getByText(en.coachMaxCommands)).toBeTruthy();
    // The existing applied proposal is listed with its state and executability.
    expect(screen.getByText('Try mornings.')).toBeTruthy();
    expect(screen.getByText(en.coachStateApplied)).toBeTruthy();
    expect(screen.getByText(en.coachExecutable)).toBeTruthy();
  });
});
