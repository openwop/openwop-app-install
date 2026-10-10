/**
 * ADR 0829 P4 — handing a card on with a note.
 *
 *   - picking a person opens the dialog and sends NOTHING (always on since
 *     2026-10-07); "assign with note" sends the draft, "assign without note"
 *     sends none, cancel sends nothing at all (the draft is never sent unconfirmed);
 *   - an empty intent cannot be sent with a note;
 *   - the card shows a stored note behind a disclosure; a malformed one renders nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeFeatureAccess } from '../../featureToggles/__testing__/makeFeatureAccess.js';

const h = vi.hoisted(() => ({
  assignCard: vi.fn(async () => ({ card: { id: 'c1' } })),
  enabled: true,
}));
vi.mock('../kanbanClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), assignCard: h.assignCard }));
vi.mock('../../orgs/orgMembers.js', () => ({
  loadOrgMembers: vi.fn(async () => [{ memberId: 'm1', subject: 'user-bob', displayName: 'Bob' }]),
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: h.enabled }),
}));

import { AssigneeControl } from '../AssigneeControl.js';
import { toHandoffDraft } from '../HandoffDialog.js';
import { CardHandoffNote } from '../CardHandoffNote.js';

beforeEach(() => { h.assignCard.mockClear(); });
afterEach(cleanup);

async function pickBob(): Promise<void> {
  render(<AssigneeControl cardId="c1" assigneeId={undefined} cardTitle="Launch brief" />);
  fireEvent.click(screen.getByRole('button'));
  const select = await screen.findByRole('combobox');
  await screen.findByRole('option', { name: 'Bob' });
  fireEvent.change(select, { target: { value: 'user-bob' } });
}

describe('AssigneeControl + HandoffDialog', () => {
  it('ON: picking a person opens the dialog prefilled from the card and sends nothing', async () => {
    h.enabled = true;
    await pickBob();
    const intent = await screen.findByLabelText(/What this is for/);
    expect((intent as HTMLTextAreaElement).value).toBe('Launch brief');
    expect(h.assignCard).not.toHaveBeenCalled();
  });

  it('ON: "Assign with note" sends the draft', async () => {
    h.enabled = true;
    await pickBob();
    fireEvent.change(await screen.findByLabelText(/Still open/), { target: { value: 'Is the date fixed?\n\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign with note' }));
    await waitFor(() => expect(h.assignCard).toHaveBeenCalledTimes(1));
    expect(h.assignCard).toHaveBeenCalledWith('c1', { assigneeId: 'user-bob', notifyAssignee: true, handoff: { intent: 'Launch brief', openQuestions: ['Is the date fixed?'] } });
  });

  it('ON: a picked confidence and its reason ride the draft', async () => {
    h.enabled = true;
    await pickBob();
    fireEvent.change(await screen.findByLabelText(/How sure are you/), { target: { value: 'low' } });
    fireEvent.change(await screen.findByLabelText(/^Why/), { target: { value: 'no data yet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign with note' }));
    await waitFor(() => expect(h.assignCard).toHaveBeenCalledTimes(1));
    expect(h.assignCard).toHaveBeenCalledWith('c1', { assigneeId: 'user-bob', notifyAssignee: true, handoff: { intent: 'Launch brief', confidence: { value: 0.3, basis: 'no data yet' } } });
  });

  it('ON: "Assign without note" sends no note; cancel sends nothing', async () => {
    h.enabled = true;
    await pickBob();
    fireEvent.click(await screen.findByRole('button', { name: 'Assign without note' }));
    await waitFor(() => expect(h.assignCard).toHaveBeenCalledWith('c1', { assigneeId: 'user-bob', notifyAssignee: true }));
    cleanup(); h.assignCard.mockClear();
    await pickBob();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(h.assignCard).not.toHaveBeenCalled();
  });

  it('ON: an empty intent disables "Assign with note"', async () => {
    h.enabled = true;
    await pickBob();
    fireEvent.change(await screen.findByLabelText(/What this is for/), { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: 'Assign with note' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('toHandoffDraft', () => {
  it('splits lines, trims, and omits empty lists', () => {
    expect(toHandoffDraft({ intent: ' Ship it ', decisions: 'EU first\n\n', openQuestions: '', tried: ' A \nB' }))
      .toEqual({ intent: 'Ship it', decisions: [{ summary: 'EU first' }], tried: [{ approach: 'A' }, { approach: 'B' }] });
  });
  it('maps a picked confidence level to its value, with an optional reason; unset sends none', () => {
    const base = { intent: 'Ship it', decisions: '', openQuestions: '', tried: '' };
    expect(toHandoffDraft({ ...base, confidence: 'medium', confidenceBasis: ' copy not reviewed ' }).confidence).toEqual({ value: 0.6, basis: 'copy not reviewed' });
    expect(toHandoffDraft({ ...base, confidence: 'high', confidenceBasis: '  ' }).confidence).toEqual({ value: 0.9 });
    expect(toHandoffDraft({ ...base, confidence: '', confidenceBasis: 'ignored' })).not.toHaveProperty('confidence');
    expect(toHandoffDraft(base)).not.toHaveProperty('confidence');
  });
});

describe('CardHandoffNote', () => {
  it('shows a stored note behind a disclosure', () => {
    render(<CardHandoffNote handoff={{ v: 1, intent: 'Finish the brief', decisions: [], openQuestions: ['When?'], tried: [], producedBy: 'human' }} />);
    const btn = screen.getByRole('button', { name: /Handoff note/ });
    expect(screen.queryByText('Finish the brief')).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByText('Finish the brief')).toBeTruthy();
    expect(screen.getByText('When?')).toBeTruthy();
  });
  it("a person's confidence reads as the word they picked, not a percentage", () => {
    render(<CardHandoffNote handoff={{ v: 1, intent: 'Finish the brief', decisions: [], openQuestions: [], tried: [], confidence: { value: 0.3, basis: 'no data yet' }, producedBy: 'human' }} />);
    fireEvent.click(screen.getByRole('button', { name: /Handoff note/ }));
    expect(screen.getByText(/Confidence: low/)).toBeTruthy();
    expect(screen.getByText(/no data yet/)).toBeTruthy();
    expect(screen.queryByText(/30%/)).toBeNull();
  });
  it('renders nothing for a malformed note', () => {
    const { container } = render(<CardHandoffNote handoff={{ decisions: [] }} />);
    expect(container.innerHTML).toBe('');
  });
});
