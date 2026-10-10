/**
 * ADR 0834 D6 / D3 — a held chat tool call reaches the user, and says what an approval
 * covers. Born red: before ADR 0834 the only surface was a bare gear icon with no pending
 * indicator, the dialog showed the tool name alone, and approve sent no version.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A STABLE `t` (as react-i18next's is): the dialog's loader depends on it, and a fresh
// function per render would re-fetch forever.
const t = (k: string, o?: { count?: number }): string => (o?.count !== undefined ? `${k}:${o.count}` : k);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const getCapabilityScope = vi.fn();
const resolveToolApproval = vi.fn();
vi.mock('../capabilityScopeClient.js', () => ({
  getCapabilityScope: (...a: unknown[]) => getCapabilityScope(...a),
  setCapabilityScope: vi.fn(),
  resolveToolApproval: (...a: unknown[]) => resolveToolApproval(...a),
  ApprovalConflictError: class extends Error {},
}));

import ConversationToolsControl from '../ConversationToolsControl.js';

const PENDING = { toolName: 'openwop:core.openwop.http.fetch', status: 'pending', requestedAt: '2026-10-06T00:00:00.000Z', requestedInput: '{"url":"https://example.com"}' };

beforeEach(() => { getCapabilityScope.mockReset(); resolveToolApproval.mockReset(); });

describe('conversation tools control (ADR 0834 D6)', () => {
  it('a bare gear when nothing is pending', async () => {
    getCapabilityScope.mockResolvedValue({ scope: { mode: 'agent-default' }, approvals: [], viewer: { mayApprove: true, mayBypass: true } });
    render(<ConversationToolsControl sessionId="s1" refreshKey={0} />);
    await waitFor(() => expect(getCapabilityScope).toHaveBeenCalled());
    expect(screen.getByTestId('conversation-tools-control').className).toBe('composer-modifier');
  });

  it('says when a call is waiting, shows its arguments and the grain, approves the version shown, then offers Continue', async () => {
    getCapabilityScope.mockResolvedValue({ scope: { mode: 'agent-default' }, approvals: [PENDING], viewer: { mayApprove: true, mayBypass: true } });
    resolveToolApproval.mockResolvedValue({ ...PENDING, status: 'approved' });
    const onContinue = vi.fn();
    render(<ConversationToolsControl sessionId="s1" refreshKey={0} onContinue={onContinue} />);
    const control = await screen.findByText('pendingChip:1');
    expect(screen.getByTestId('conversation-tools-control').className).toContain('is-pending');
    fireEvent.click(control);
    expect(await screen.findByText('{"url":"https://example.com"}')).toBeTruthy();
    expect(screen.getByText('grainNote')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'approveAria' }));
    await waitFor(() => expect(resolveToolApproval).toHaveBeenCalledWith('s1', PENDING.toolName, 'approved', PENDING.requestedAt));
    getCapabilityScope.mockResolvedValue({ scope: { mode: 'agent-default' }, approvals: [{ ...PENDING, status: 'approved' }], viewer: { mayApprove: true, mayBypass: true } });
    fireEvent.click(await screen.findByRole('button', { name: 'continue' }));
    expect(onContinue).toHaveBeenCalledWith('continueMessage');
  });

  it('a viewer without authority sees the request but no Approve/Deny, and is reported upward', async () => {
    getCapabilityScope.mockResolvedValue({ scope: { mode: 'agent-default' }, approvals: [PENDING], viewer: { mayApprove: false, mayBypass: false } });
    const onViewer = vi.fn();
    render(<ConversationToolsControl sessionId="s1" refreshKey={0} onViewer={onViewer} />);
    fireEvent.click(await screen.findByText('pendingChip:1'));
    expect(await screen.findByText('notOwnerNote')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'approveAria' })).toBeNull();
    expect(onViewer).toHaveBeenCalledWith({ mayApprove: false, mayBypass: false });
  });

  it('re-reads when the turn settles (refreshKey changes) — FW2-UX-1', async () => {
    getCapabilityScope.mockResolvedValue({ scope: { mode: 'agent-default' }, approvals: [], viewer: { mayApprove: true, mayBypass: true } });
    const { rerender } = render(<ConversationToolsControl sessionId="s1" refreshKey={-1} />);
    await waitFor(() => expect(getCapabilityScope).toHaveBeenCalledTimes(1));
    getCapabilityScope.mockResolvedValue({ scope: { mode: 'agent-default' }, approvals: [PENDING], viewer: { mayApprove: true, mayBypass: true } });
    rerender(<ConversationToolsControl sessionId="s1" refreshKey={2} />);
    expect(await screen.findByText('pendingChip:1')).toBeTruthy();
  });

  it('a viewer who may not edit the scope sees it read-only, with no Save — FW2-UX-2', async () => {
    getCapabilityScope.mockResolvedValue({ scope: { mode: 'agent-default' }, approvals: [], viewer: { mayApprove: false, mayBypass: false, mayEditScope: false } });
    render(<ConversationToolsControl sessionId="s1" refreshKey={0} />);
    await waitFor(() => expect(getCapabilityScope).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('conversation-tools-control'));
    expect(await screen.findByText('scopeReadOnlyNote')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
  });
});
