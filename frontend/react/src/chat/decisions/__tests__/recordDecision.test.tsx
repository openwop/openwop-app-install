/**
 * ADR 0853 D2 — "Record as decision" from a message.
 *   - offered only when the conversation's project (a project chat's owner, or a
 *     channel's bound project) has a ledger and the toggle is on;
 *   - the dialog is prefilled from the message (title from its first line) and
 *     sends nothing until Record; the link back names the conversation and message;
 *   - the ledger OWNER gets "Accept it now" (on by default); anyone else's record
 *     carries no `accept`; a failed record is said.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const h = vi.hoisted(() => ({
  enabled: true, me: 'u-owner',
  getChannel: vi.fn(), getTeamLedger: vi.fn(), recordDecision: vi.fn(),
}));
vi.mock('../../../client/channelsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getChannel: h.getChannel }));
vi.mock('../../../features/projects/teamLedgerClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getTeamLedger: h.getTeamLedger, recordDecision: h.recordDecision }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess({ enabled: h.enabled }) }));
vi.mock('../../../auth/backendSession.js', () => ({ useBackendSession: () => ({ user: { userId: h.me } }) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { titleFrom, useRecordDecision } from '../useRecordDecision.js';
import type { ChatMessage } from '../../types.js';

const MSG = { id: 'm1', role: 'user', content: 'Ship EU first\nLegal is ready there, US waits a quarter.' } as unknown as ChatMessage;

function Harness(props: { sessionId: string; projectIdHint: string | null; isChannel: boolean }): JSX.Element {
  const { onRecord, dialog } = useRecordDecision(props);
  return <>{onRecord ? <button type="button" onClick={() => onRecord(MSG)}>open</button> : <span>no-action</span>}{dialog}</>;
}

beforeEach(() => {
  h.enabled = true; h.me = 'u-owner';
  for (const f of [h.getChannel, h.getTeamLedger, h.recordDecision]) f.mockReset();
  h.getTeamLedger.mockResolvedValue({ ledger: { ledgerId: 'l1', ownerSubject: 'u-owner', version: 2 }, state: {} });
  h.recordDecision.mockResolvedValue({ documentId: 'd1', accepted: true });
});
afterEach(cleanup);

describe('Record as decision', () => {
  it('titleFrom takes the first non-empty line, bounded', () => {
    expect(titleFrom('\n  Ship EU first \nmore')).toBe('Ship EU first');
    expect(titleFrom('x'.repeat(100)).length).toBe(80);
  });

  it("the owner records from a project chat: prefilled, accepted, linked back", async () => {
    render(<Harness sessionId="s1" projectIdHint="p1" isChannel={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'open' }));
    expect((screen.getByLabelText('Decision (short title)') as HTMLInputElement).value).toBe('Ship EU first');
    expect((screen.getByLabelText('Accept it into the ledger now') as HTMLInputElement).checked).toBe(true);
    expect(h.recordDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(h.recordDecision).toHaveBeenCalledTimes(1));
    expect(h.recordDecision).toHaveBeenCalledWith('p1', expect.objectContaining({
      title: 'Ship EU first', accept: true,
      source: { kind: 'message', ref: 'm1', link: '/chat?conversation=s1' },
    }));
  });

  it("a non-owner in a bound channel records a proposal (no accept)", async () => {
    h.me = 'u-mate';
    h.getChannel.mockResolvedValue({ channel: { boundProjectId: 'p7' } });
    render(<Harness sessionId="ch1" projectIdHint={null} isChannel />);
    fireEvent.click(await screen.findByRole('button', { name: 'open' }));
    expect(screen.queryByLabelText('Accept it into the ledger now')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(h.recordDecision).toHaveBeenCalled());
    const [projectId, input] = h.recordDecision.mock.calls[0]!;
    expect(projectId).toBe('p7');
    expect(input).not.toHaveProperty('accept');
  });

  it('not offered: no project or no ledger', async () => {
    h.getChannel.mockResolvedValue({ channel: {} });
    render(<Harness sessionId="ch1" projectIdHint={null} isChannel />);
    await waitFor(() => expect(h.getChannel).toHaveBeenCalled());
    expect(screen.getByText('no-action')).toBeTruthy();
    cleanup();
    h.getTeamLedger.mockResolvedValue({ ledger: null, state: null });
    render(<Harness sessionId="s1" projectIdHint="p1" isChannel={false} />);
    await waitFor(() => expect(h.getTeamLedger).toHaveBeenCalled());
    expect(screen.getByText('no-action')).toBeTruthy();
  });

  it('a failed record is said and the dialog stays open', async () => {
    h.recordDecision.mockRejectedValue(new Error('403'));
    render(<Harness sessionId="s1" projectIdHint="p1" isChannel={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect((await screen.findAllByText(/could not be recorded/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Record' })).toBeTruthy();
  });
});
