/**
 * ADR 0834 D6 / D3 — a held chat tool call reaches the user, and says what an approval
 * covers. Born red: before ADR 0834 the only surface was a bare gear icon with no pending
 * indicator, the dialog showed the tool name alone, and approve sent no version.
 *
 * FW2-D1 (CHAN-F2): the primary button sends `grain:'call'`; the conversation-wide grant
 * is its own button, never offered for a channel ask or for arguments not all shown.
 * CHAN-F17: approvals already given are listed by grain and revocable by whoever may
 * approve; an expired one says so; an expired channel ask is not counted as waiting
 * and has no decision buttons.
 *
 * Sabotage-witnessed (waves 51 and 109; each reddens the named case): drop the pending
 * style or count ("says when a call is waiting"); approve without `requestedAt`, with
 * the conversation grain, or without Continue (same case); send the primary grain from
 * the conversation button, or offer it for a channel or truncated ask ("FW2-D1");
 * swap the grain labels or revoke with the wrong version ("listed by grain" — the label
 * is read per ROW, so a swap is visible); drop the expired label ("labelled expired");
 * offer Revoke, count an expired ask, or offer its decision buttons ("a viewer without
 * authority sees no Revoke"); offer Approve or the grain note to a viewer without
 * authority, or stop reporting the viewer upward; stop re-reading on `refreshKey`
 * (FW2-UX-1); offer Save / hide the read-only note (FW2-UX-2).
 */
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A STABLE `t` (as react-i18next's is): the dialog's loader depends on it, and a fresh
// function per render would re-fetch forever.
const t = (k: string, o?: { count?: number }): string => (o?.count !== undefined ? `${k}:${o.count}` : k);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

type ScopeClient = typeof import('../capabilityScopeClient.js');
const getCapabilityScope = vi.fn<ScopeClient['getCapabilityScope']>();
const resolveToolApproval = vi.fn<ScopeClient['resolveToolApproval']>();
const revokeToolApproval = vi.fn<ScopeClient['revokeToolApproval']>();
vi.mock('../capabilityScopeClient.js', async (orig) => ({
  ...(await orig<ScopeClient>()), // keeps the real ApprovalConflictError
  getCapabilityScope: (sessionId: string) => getCapabilityScope(sessionId),
  setCapabilityScope: vi.fn<ScopeClient['setCapabilityScope']>(),
  resolveToolApproval: (...a: Parameters<ScopeClient['resolveToolApproval']>) => resolveToolApproval(...a),
  revokeToolApproval: (...a: Parameters<ScopeClient['revokeToolApproval']>) => revokeToolApproval(...a),
}));

import ConversationToolsControl from '../ConversationToolsControl.js';
import type { CapabilityScopeView, ToolApproval } from '../capabilityScopeClient.js';

type Viewer = NonNullable<CapabilityScopeView['viewer']>;
const OWNER: Viewer = { mayApprove: true, mayBypass: true };
const view = (approvals: ToolApproval[], viewer: Viewer = OWNER): CapabilityScopeView => ({ scope: { mode: 'agent-default' }, approvals, viewer });

const PENDING: ToolApproval = { toolName: 'openwop:core.openwop.http.fetch', status: 'pending', requestedAt: '2026-10-06T00:00:00.000Z', requestedInput: '{"url":"https://example.com"}' };

beforeEach(() => { getCapabilityScope.mockReset(); resolveToolApproval.mockReset(); revokeToolApproval.mockReset(); });

describe('conversation tools control (ADR 0834 D6)', () => {
  it('a bare gear when nothing is pending', async () => {
    getCapabilityScope.mockResolvedValue(view([]));
    render(<ConversationToolsControl sessionId="s1" refreshKey={0} />);
    await waitFor(() => expect(getCapabilityScope).toHaveBeenCalled());
    await act(async () => { await getCapabilityScope.mock.results[0]?.value; }); // the view SETTLED, not the initial state
    expect(screen.getByTestId('conversation-tools-control').className).toBe('composer-modifier');
  });

  it('says when a call is waiting, shows its arguments and the grain, approves the version shown, then offers Continue', async () => {
    getCapabilityScope.mockResolvedValue(view([PENDING]));
    resolveToolApproval.mockResolvedValue({ ...PENDING, status: 'approved' });
    const onContinue = vi.fn();
    render(<ConversationToolsControl sessionId="s1" refreshKey={0} onContinue={onContinue} />);
    const control = await screen.findByText('pendingChip:1');
    expect(screen.getByTestId('conversation-tools-control').className).toContain('is-pending');
    fireEvent.click(control);
    expect(await screen.findByText('{"url":"https://example.com"}')).toBeTruthy();
    expect(screen.getByText('grainNote')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'approveAria' }));
    // FW2-D1 — the primary button approves exactly this call, once.
    await waitFor(() => expect(resolveToolApproval).toHaveBeenCalledWith('s1', PENDING.toolName, 'approved', PENDING.requestedAt, 'call'));
    getCapabilityScope.mockResolvedValue(view([{ ...PENDING, status: 'approved' }]));
    fireEvent.click(await screen.findByRole('button', { name: 'continue' }));
    expect(onContinue).toHaveBeenCalledWith('continueMessage');
  });

  it('FW2-D1: the conversation-wide grant is a separate, named choice, offered only for an in-app ask whose arguments were all shown', async () => {
    resolveToolApproval.mockResolvedValue({ ...PENDING, status: 'approved', grain: 'conversation' });
    getCapabilityScope.mockResolvedValue(view([PENDING]));
    const { unmount } = render(<ConversationToolsControl sessionId="s1" refreshKey={0} />);
    fireEvent.click(await screen.findByText('pendingChip:1'));
    fireEvent.click(await screen.findByRole('button', { name: 'allowConversationAria' }));
    await waitFor(() => expect(resolveToolApproval).toHaveBeenCalledWith('s1', PENDING.toolName, 'approved', PENDING.requestedAt, 'conversation'));
    unmount();

    // From a messaging channel: one call at a time, and said so.
    getCapabilityScope.mockResolvedValue(view([{ ...PENDING, lane: 'channel' }]));
    const ch = render(<ConversationToolsControl sessionId="s2" refreshKey={0} />);
    fireEvent.click(await screen.findByText('pendingChip:1'));
    expect(await screen.findByText('grainNoteChannel')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'approveAria' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'allowConversationAria' })).toBeNull();
    ch.unmount();

    // Arguments not all shown: a warning, and no tool-wide grant.
    getCapabilityScope.mockResolvedValue(view([{ ...PENDING, inputTruncated: true }]));
    render(<ConversationToolsControl sessionId="s3" refreshKey={0} />);
    fireEvent.click(await screen.findByText('pendingChip:1'));
    expect(await screen.findByText('inputHidden')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'allowConversationAria' })).toBeNull();
  });

  it('CHAN-F17: approvals already given are listed by grain, and Revoke sends the version shown', async () => {
    const WIDE: ToolApproval = { toolName: 'tool.wide', status: 'approved', grain: 'conversation', requestedAt: PENDING.requestedAt, resolvedAt: '2026-10-06T00:01:00.000Z' };
    const ONCE: ToolApproval = { toolName: 'tool.once', status: 'approved', grain: 'call', requestedAt: PENDING.requestedAt, resolvedAt: '2026-10-06T00:02:00.000Z' };
    getCapabilityScope.mockResolvedValue(view([WIDE, ONCE]));
    revokeToolApproval.mockResolvedValue(undefined);
    render(<ConversationToolsControl sessionId="s1" refreshKey={0} />);
    await waitFor(() => expect(getCapabilityScope).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('conversation-tools-control'));
    expect(await screen.findByText('grantedHeading')).toBeTruthy();
    // Each label on ITS row: two labels anywhere on the page would pass a swap.
    const rowOf = (tool: string): HTMLElement => {
      const li = screen.getByText(tool).closest('li');
      if (!li) throw new Error(`no row for ${tool}`);
      return li;
    };
    expect(within(rowOf('tool.wide')).getByText('grantedConversation')).toBeTruthy();
    expect(within(rowOf('tool.once')).getByText('grantedOnce')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'revokeAria' })).toHaveLength(2);
    fireEvent.click(within(rowOf('tool.wide')).getByRole('button', { name: 'revokeAria' }));
    await waitFor(() => expect(revokeToolApproval).toHaveBeenCalledWith('s1', 'tool.wide', WIDE.resolvedAt));
  });

  it('CHAN-F17: an expired one-call channel approval is labelled expired and can still be revoked', async () => {
    const OLD: ToolApproval = { toolName: 'tool.old', status: 'approved', grain: 'call', lane: 'channel', requestedAt: PENDING.requestedAt, resolvedAt: '2026-10-06T00:01:00.000Z', expiresAt: new Date(Date.now() - 60_000).toISOString() };
    getCapabilityScope.mockResolvedValue(view([OLD]));
    render(<ConversationToolsControl sessionId="s1" refreshKey={0} />);
    await waitFor(() => expect(getCapabilityScope).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('conversation-tools-control'));
    expect(await screen.findByText('grantedExpired')).toBeTruthy();
    expect(screen.queryByText('grantedOnce')).toBeNull();
    expect(screen.getByRole('button', { name: 'revokeAria' })).toBeTruthy();
  });

  it('CHAN-F17: a viewer without authority sees no Revoke; an expired channel ask has no decision buttons and is not counted', async () => {
    const WIDE: ToolApproval = { toolName: 'tool.wide', status: 'approved', grain: 'conversation', requestedAt: PENDING.requestedAt, resolvedAt: '2026-10-06T00:01:00.000Z' };
    getCapabilityScope.mockResolvedValue(view([WIDE], { mayApprove: false, mayBypass: false }));
    const ro = render(<ConversationToolsControl sessionId="s1" refreshKey={0} />);
    await waitFor(() => expect(getCapabilityScope).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('conversation-tools-control'));
    expect(await screen.findByText('grantedHeading')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'revokeAria' })).toBeNull();
    ro.unmount();

    // Expiry is relative to the real clock, so the date-bomb sweep cannot move it.
    const EXPIRED: ToolApproval = { ...PENDING, lane: 'channel', expiresAt: new Date(Date.now() - 60_000).toISOString() };
    getCapabilityScope.mockClear();
    getCapabilityScope.mockResolvedValue(view([EXPIRED]));
    render(<ConversationToolsControl sessionId="s2" refreshKey={0} />);
    await waitFor(() => expect(getCapabilityScope).toHaveBeenCalled());
    await act(async () => { await getCapabilityScope.mock.results[0]?.value; });
    expect(screen.getByTestId('conversation-tools-control').className, 'an expired ask is not waiting on anyone').toBe('composer-modifier');
    fireEvent.click(screen.getByTestId('conversation-tools-control'));
    expect(await screen.findByText('expiredNote')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'approveAria' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'denyAria' })).toBeNull();
  });

  it('a viewer without authority sees the request but no Approve/Deny, and is reported upward', async () => {
    getCapabilityScope.mockResolvedValue(view([PENDING], { mayApprove: false, mayBypass: false }));
    const onViewer = vi.fn();
    render(<ConversationToolsControl sessionId="s1" refreshKey={0} onViewer={onViewer} />);
    fireEvent.click(await screen.findByText('pendingChip:1'));
    expect(await screen.findByText('notOwnerNote')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'approveAria' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'allowConversationAria' })).toBeNull();
    expect(onViewer).toHaveBeenCalledWith({ mayApprove: false, mayBypass: false });
  });

  it('re-reads when the turn settles (refreshKey changes) — FW2-UX-1', async () => {
    getCapabilityScope.mockResolvedValue(view([]));
    const { rerender } = render(<ConversationToolsControl sessionId="s1" refreshKey={-1} />);
    await waitFor(() => expect(getCapabilityScope).toHaveBeenCalledTimes(1));
    getCapabilityScope.mockResolvedValue(view([PENDING]));
    rerender(<ConversationToolsControl sessionId="s1" refreshKey={2} />);
    expect(await screen.findByText('pendingChip:1')).toBeTruthy();
  });

  it('a viewer who may not edit the scope sees it read-only, with no Save — FW2-UX-2', async () => {
    getCapabilityScope.mockResolvedValue(view([], { mayApprove: false, mayBypass: false, mayEditScope: false }));
    render(<ConversationToolsControl sessionId="s1" refreshKey={0} />);
    await waitFor(() => expect(getCapabilityScope).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('conversation-tools-control'));
    expect(await screen.findByText('scopeReadOnlyNote')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
  });
});
