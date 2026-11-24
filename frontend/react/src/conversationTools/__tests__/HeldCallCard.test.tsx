/**
 * ADR 1156 — the held-call card in the conversation.
 *
 * Pins:
 *  - one press: Approve sends the version shown with `grain:'call'`, then the Continue
 *    message through the surface's submit, with nothing else to press;
 *  - Decline denies that one call (`grain:'call'`) and sends nothing;
 *  - the tool's own lines are shown, grouped, with the raw arguments behind a toggle;
 *    without lines the arguments are shown directly;
 *  - the card is matched to its turn by `askId` (another turn's ask is not this card);
 *  - outcomes are said in words in a live region: ran, refused with the tool's reason,
 *    superseded, declined, approved-and-running;
 *  - a viewer who may not approve sees no buttons;
 *  - a 409 says the request changed and sends nothing;
 *  - a feature's own card replaces the default and its `approve` goes through the same
 *    decision.
 *
 * Sabotage notes: dropping the `onContinue` call, sending no `requestedAt`, or sending the
 * conversation grain reds the one-press case; matching by tool name only reds the askId
 * case; dropping the live region's text reds the outcome cases.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const t = (k: string, o?: Record<string, unknown>): string => (o?.reason !== undefined ? `${k}:${String(o.reason)}` : k);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

type ScopeClient = typeof import('../capabilityScopeClient.js');
const getCapabilityScope = vi.fn<ScopeClient['getCapabilityScope']>();
const resolveToolApproval = vi.fn<ScopeClient['resolveToolApproval']>();
vi.mock('../capabilityScopeClient.js', async (orig) => ({
  ...(await orig<ScopeClient>()),
  getCapabilityScope: (sessionId: string) => getCapabilityScope(sessionId),
  resolveToolApproval: (...a: Parameters<ScopeClient['resolveToolApproval']>) => resolveToolApproval(...a),
}));

import HeldCallCard, { type HeldCall } from '../HeldCallCard.js';
import { ApprovalConflictError, type CapabilityScopeView, type ToolApproval } from '../capabilityScopeClient.js';

const TOOL = 'openwop:casavoga.boards.edit';
const HELD: HeldCall = { askId: 'turn-1', toolName: TOOL, requestedAt: '2026-11-23T00:00:00.000Z' };
const ROW: ToolApproval = {
  toolName: TOOL, status: 'pending', requestedAt: '2026-11-23T00:00:00.000Z', askId: 'turn-1',
  requestedInput: '{"ops":[{"op":"move"}]}',
  requestedLines: [{ group: 'Kitchen', text: 'Move the oak table to the window' }, { group: 'Kitchen', text: 'Keep the lamp' }, { text: 'Rename the board' }],
};
const view = (approvals: ToolApproval[], mayApprove = true): CapabilityScopeView => ({ scope: { mode: 'agent-default' }, approvals, viewer: { mayApprove, mayBypass: mayApprove } });

beforeEach(() => { getCapabilityScope.mockReset(); resolveToolApproval.mockReset(); });

describe('held-call card (ADR 1156)', () => {
  it('one press on Approve approves this exact call and continues', async () => {
    getCapabilityScope.mockResolvedValue(view([ROW]));
    resolveToolApproval.mockResolvedValue({ ...ROW, status: 'approved', grain: 'call' });
    const onContinue = vi.fn();
    render(<HeldCallCard sessionId="s1" held={HELD} refreshKey={0} onContinue={onContinue} />);
    fireEvent.click(await screen.findByRole('button', { name: 'cardApproveAria' }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith('continueMessage'));
    expect(resolveToolApproval).toHaveBeenCalledWith('s1', TOOL, 'approved', ROW.requestedAt, 'call');
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('Decline denies that one call and sends nothing', async () => {
    getCapabilityScope.mockResolvedValue(view([ROW]));
    resolveToolApproval.mockResolvedValue({ ...ROW, status: 'denied', grain: 'call' });
    const onContinue = vi.fn();
    render(<HeldCallCard sessionId="s1" held={HELD} refreshKey={0} onContinue={onContinue} />);
    fireEvent.click(await screen.findByRole('button', { name: 'cardDeclineAria' }));
    await waitFor(() => expect(resolveToolApproval).toHaveBeenCalledWith('s1', TOOL, 'denied', ROW.requestedAt, 'call'));
    getCapabilityScope.mockResolvedValue(view([{ ...ROW, status: 'denied', grain: 'call' }]));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('cardDeclined'));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('shows the tool\'s lines grouped, with the arguments behind a toggle', async () => {
    getCapabilityScope.mockResolvedValue(view([ROW]));
    render(<HeldCallCard sessionId="s1" held={HELD} refreshKey={0} onContinue={vi.fn()} />);
    expect(await screen.findByText('Move the oak table to the window')).toBeTruthy();
    expect(screen.getByText('Kitchen')).toBeTruthy();
    expect(screen.getByText('Rename the board')).toBeTruthy();
    expect(screen.queryByText(ROW.requestedInput!)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cardShowDetails' }));
    expect(screen.getByText(ROW.requestedInput!)).toBeTruthy();
  });

  it('without lines, shows the arguments directly', async () => {
    const { requestedLines: _l, ...plain } = ROW;
    getCapabilityScope.mockResolvedValue(view([plain]));
    render(<HeldCallCard sessionId="s1" held={HELD} refreshKey={0} onContinue={vi.fn()} />);
    expect(await screen.findByText(ROW.requestedInput!)).toBeTruthy();
  });

  it('is matched to its own turn: a newer ask from another turn is not this card', async () => {
    getCapabilityScope.mockResolvedValue(view([{ ...ROW, askId: 'turn-2', requestedAt: '2026-11-23T00:01:00.000Z' }]));
    render(<HeldCallCard sessionId="s1" held={HELD} refreshKey={0} onContinue={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('cardGone'));
    expect(screen.queryByRole('button', { name: 'cardApproveAria' })).toBeNull();
  });

  it.each([
    [{ outcome: 'ran' as const }, 'cardRan'],
    [{ outcome: 'refused' as const, reason: 'The board changed.' }, 'cardRefused:The board changed.'],
    [{ outcome: 'refused' as const }, 'cardRefusedNoReason'],
    [{ outcome: 'superseded' as const }, 'cardSuperseded'],
  ])('says the outcome %o in words', async (outcome, text) => {
    getCapabilityScope.mockResolvedValue(view([]));
    render(<HeldCallCard sessionId="s1" held={{ ...HELD, ...outcome }} refreshKey={0} onContinue={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(text));
    expect(screen.queryByRole('button', { name: 'cardApproveAria' })).toBeNull();
  });

  it('an approved, not yet run call says it is being carried out', async () => {
    getCapabilityScope.mockResolvedValue(view([{ ...ROW, status: 'approved', grain: 'call' }]));
    render(<HeldCallCard sessionId="s1" held={HELD} refreshKey={0} onContinue={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('cardApproved'));
  });

  it('a viewer who may not approve sees no buttons', async () => {
    getCapabilityScope.mockResolvedValue(view([ROW], false));
    render(<HeldCallCard sessionId="s1" held={HELD} refreshKey={0} onContinue={vi.fn()} />);
    expect(await screen.findByText('notOwnerNote')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cardApproveAria' })).toBeNull();
  });

  it('a request that changed (409) says so and sends nothing', async () => {
    getCapabilityScope.mockResolvedValue(view([ROW]));
    resolveToolApproval.mockRejectedValue(new ApprovalConflictError('approval_conflict'));
    const onContinue = vi.fn();
    render(<HeldCallCard sessionId="s1" held={HELD} refreshKey={0} onContinue={onContinue} />);
    fireEvent.click(await screen.findByRole('button', { name: 'cardApproveAria' }));
    expect(await screen.findByText('approvalChanged')).toBeTruthy();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('a feature\'s own card replaces the default, and its approve is the same decision', async () => {
    getCapabilityScope.mockResolvedValue(view([ROW]));
    resolveToolApproval.mockResolvedValue({ ...ROW, status: 'approved', grain: 'call' });
    const onContinue = vi.fn();
    render(
      <HeldCallCard
        sessionId="s1" held={HELD} refreshKey={0} onContinue={onContinue}
        renderCustom={(payload, onAction) => (
          <button type="button" onClick={() => { void onAction('approve'); }}>{`custom ${payload.state} ${payload.lines?.length ?? 0}`}</button>
        )}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'custom waiting 3' }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith('continueMessage'));
    expect(screen.queryByTestId('held-call-card')).toBeNull();
  });
});
