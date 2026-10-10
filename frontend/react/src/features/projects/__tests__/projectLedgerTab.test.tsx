/**
 * ADR 0831 P4 — the project Ledger tab.
 *
 *   - no ledger: writers get "Start the ledger"; readers do not;
 *   - only the OWNER sees Accept / Reject (a non-owner is told the owner decides);
 *   - a stale accept (409) asks first and then accepts with `rebased`; declining sends nothing more;
 *   - propose sends ONLY the lists that changed, and needs a reason;
 *   - "changed since you last looked" lists accepted changes after your last-seen version;
 *   - a failed load says so (never renders as "no ledger").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({
  me: 'user-owner',
  confirmAnswer: true,
  getTeamLedger: vi.fn(),
  listLedgerDeltas: vi.fn(),
  createTeamLedger: vi.fn(async () => ({})),
  proposeLedgerChange: vi.fn(async () => ({})),
  acceptLedgerChange: vi.fn(async () => undefined),
  rejectLedgerChange: vi.fn(async () => undefined),
  markSeen: vi.fn(async (_p: string, v: number) => v),
}));
vi.mock('../teamLedgerClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getTeamLedger: h.getTeamLedger, listLedgerDeltas: h.listLedgerDeltas, createTeamLedger: h.createTeamLedger,
  proposeLedgerChange: h.proposeLedgerChange, acceptLedgerChange: h.acceptLedgerChange, rejectLedgerChange: h.rejectLedgerChange,
  markSeen: h.markSeen,
  listDecisionSuggestions: vi.fn(async () => []),
}));
vi.mock('../../../auth/backendSession.js', () => ({ useBackendSession: () => ({ user: { userId: h.me } }) }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => h.confirmAnswer) }));
vi.mock('../../../orgs/orgMembers.js', () => ({
  loadOrgMembers: vi.fn(async () => [{ memberId: 'm1', subject: 'user-mate', displayName: 'Mara Mate' }, { memberId: 'm2', subject: 'user-owner', displayName: 'Olu Owner' }]),
}));

import { ProjectLedgerTab } from '../ProjectLedgerTab.js';
import type { Project } from '../projectsClient.js';

const project = { id: 'p1', tenantId: 't', orgId: 'o', name: 'Launch', workflows: [], boardId: 'b' } as Project;
const STATE = { goal: 'Ship the launch', objectives: ['EU live'], openQuestions: ['Date?'], inScope: ['EU'], outOfScope: ['APAC'], decisionDocumentIds: [] };
const LEDGER = { ledgerId: 'tl1', ownerSubject: 'user-owner', version: 3, updatedAt: '' };
const proposed = (over: Record<string, unknown> = {}) => ({ deltaId: 'd1', status: 'proposed', patch: { inScope: ['EU', 'UK'] }, why: 'UK added Monday', author: { kind: 'user', id: 'user-mate' }, baseVersion: 3, createdAt: '', ...over });

beforeEach(() => {
  for (const f of [h.getTeamLedger, h.listLedgerDeltas, h.createTeamLedger, h.proposeLedgerChange, h.acceptLedgerChange, h.rejectLedgerChange, h.markSeen]) f.mockReset();
  h.markSeen.mockImplementation(async (_p: string, v: number) => v);
  h.me = 'user-owner'; h.confirmAnswer = true;
  h.getTeamLedger.mockResolvedValue({ ledger: LEDGER, state: STATE });
  h.listLedgerDeltas.mockResolvedValue([]);
  try { window.localStorage.clear(); } catch { /* jsdom */ }
});
afterEach(cleanup);

describe('ProjectLedgerTab', () => {
  it('no ledger: a writer can start one; a reader cannot', async () => {
    h.getTeamLedger.mockResolvedValue({ ledger: null, state: null });
    render(<ProjectLedgerTab project={project} canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start the ledger' }));
    await waitFor(() => expect(h.createTeamLedger).toHaveBeenCalledWith('p1'));
    cleanup();
    render(<ProjectLedgerTab project={project} canWrite={false} />);
    await screen.findByText('No team ledger yet');
    expect(screen.queryByRole('button', { name: 'Start the ledger' })).toBeNull();
  });

  it('a failed load says so, never "no ledger"', async () => {
    h.getTeamLedger.mockRejectedValue(new Error('boom'));
    render(<ProjectLedgerTab project={project} canWrite />);
    expect((await screen.findAllByText(/could not be loaded/)).length).toBeGreaterThan(0);
    expect(screen.queryByText('No team ledger yet')).toBeNull();
  });

  it('shows the state; only the owner sees Accept / Reject', async () => {
    h.listLedgerDeltas.mockResolvedValue([proposed()]);
    render(<ProjectLedgerTab project={project} canWrite />);
    const now = await screen.findByRole('region', { name: 'What this project is for' });
    expect(within(now).getByText('Ship the launch')).toBeTruthy();
    expect(within(now).getByText('APAC')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    cleanup();
    h.me = 'user-mate';
    render(<ProjectLedgerTab project={project} canWrite />);
    await screen.findByText('UK added Monday');
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.getByText('The ledger owner accepts or rejects proposed changes.')).toBeTruthy();
  });

  it('a stale accept asks first, then accepts with rebased; declining sends nothing more', async () => {
    h.listLedgerDeltas.mockResolvedValue([proposed({ baseVersion: 2 })]);
    h.acceptLedgerChange.mockImplementationOnce(async () => { throw Object.assign(new Error('409'), { status: 409 }); });
    render(<ProjectLedgerTab project={project} canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(h.acceptLedgerChange).toHaveBeenCalledTimes(2));
    expect(h.acceptLedgerChange).toHaveBeenLastCalledWith('p1', 'd1', true);

    cleanup(); h.acceptLedgerChange.mockReset(); h.confirmAnswer = false;
    h.acceptLedgerChange.mockImplementationOnce(async () => { throw Object.assign(new Error('409'), { status: 409 }); });
    render(<ProjectLedgerTab project={project} canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(h.acceptLedgerChange).toHaveBeenCalledTimes(1));
  });

  it('propose sends only the changed lists and needs a reason', async () => {
    render(<ProjectLedgerTab project={project} canWrite />);
    const submit = await screen.findByRole('button', { name: 'Propose' });
    expect((submit as HTMLButtonElement).disabled).toBe(true); // nothing changed
    fireEvent.change(screen.getByLabelText('Out of scope'), { target: { value: 'APAC\nLATAM' } });
    expect((submit as HTMLButtonElement).disabled).toBe(true); // no reason yet
    fireEvent.change(screen.getByLabelText('Why (required)'), { target: { value: 'Not this quarter' } });
    fireEvent.click(submit);
    await waitFor(() => expect(h.proposeLedgerChange).toHaveBeenCalledWith('p1', { outOfScope: ['APAC', 'LATAM'] }, 'Not this quarter', 3));
  });

  it('ADR 0856 — the tool policy is shown when set, and proposed whole when either list changes', async () => {
    h.getTeamLedger.mockResolvedValue({ ledger: LEDGER, state: { ...STATE, toolPolicy: { forbidden: ['openwop:email.send'], requireApproval: [] } } });
    render(<ProjectLedgerTab project={project} canWrite />);
    const now = await screen.findByRole('region', { name: 'What this project is for' });
    expect(within(now).getByText('openwop:email.send')).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Tools that need a person's approval here"), { target: { value: 'openwop:web.search' } });
    fireEvent.change(screen.getByLabelText('Why (required)'), { target: { value: 'Ask before searching' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    await waitFor(() => expect(h.proposeLedgerChange).toHaveBeenCalledWith('p1', { toolPolicy: { forbidden: ['openwop:email.send'], requireApproval: ['openwop:web.search'] } }, 'Ask before searching', 3));
  });

  it('grade-ux row 25 B3 — a FAILED proposal keeps the reason the person typed; a landed one clears it', async () => {
    h.proposeLedgerChange.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    render(<ProjectLedgerTab project={project} canWrite />);
    const submit = await screen.findByRole('button', { name: 'Propose' });
    fireEvent.change(screen.getByLabelText('Out of scope'), { target: { value: 'APAC\nLATAM' } });
    const why = screen.getByLabelText('Why (required)') as HTMLInputElement;
    fireEvent.change(why, { target: { value: 'Not this quarter' } });
    fireEvent.click(submit);
    await waitFor(() => expect(h.proposeLedgerChange).toHaveBeenCalledTimes(1));
    await screen.findAllByText(/did not go through/);
    expect(why.value, 'the reason survives the failure').toBe('Not this quarter');
    fireEvent.click(submit);
    await waitFor(() => expect(h.proposeLedgerChange).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(why.value, 'and clears once it lands').toBe(''));
  });

  it('grade-ux row 25 B4 — a failed people-directory read is SAID, not shown as names', async () => {
    const { loadOrgMembers } = await import('../../../orgs/orgMembers.js');
    (loadOrgMembers as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('503'));
    render(<ProjectLedgerTab project={project} canWrite />);
    await screen.findByText(/people directory could not be loaded/);
  });

  it('lists what changed since your SERVER-side last-seen version; "Mark as seen" posts the current one', async () => {
    h.getTeamLedger.mockResolvedValue({ ledger: LEDGER, state: STATE, seenVersion: 2 });
    h.listLedgerDeltas.mockResolvedValue([
      { deltaId: 'a2', status: 'accepted', patch: {}, why: 'Old change', author: { kind: 'user', id: 'x' }, baseVersion: 1, resultVersion: 2, createdAt: '' },
      { deltaId: 'a3', status: 'accepted', patch: {}, why: 'Scope cut agreed', author: { kind: 'user', id: 'x' }, baseVersion: 2, resultVersion: 3, createdAt: '' },
    ]);
    render(<ProjectLedgerTab project={project} canWrite />);
    expect(await screen.findByText(/Changed since you last looked/)).toBeTruthy();
    expect(screen.getByText(/Scope cut agreed/)).toBeTruthy();
    expect(screen.queryByText(/Old change/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Mark as seen' })[0]!);
    await waitFor(() => expect(h.markSeen).toHaveBeenCalledWith('p1', 3));
  });

  it('a pre-server, per-browser last-seen is carried up once and removed', async () => {
    window.localStorage.setItem('team-ledger:seen:p1', '2');
    h.getTeamLedger.mockResolvedValue({ ledger: LEDGER, state: STATE, seenVersion: null });
    h.listLedgerDeltas.mockResolvedValue([
      { deltaId: 'a3', status: 'accepted', patch: {}, why: 'Scope cut agreed', author: { kind: 'user', id: 'x' }, baseVersion: 2, resultVersion: 3, createdAt: '' },
    ]);
    render(<ProjectLedgerTab project={project} canWrite />);
    expect(await screen.findByText(/Changed since you last looked/)).toBeTruthy();
    expect(h.markSeen).toHaveBeenCalledWith('p1', 2);
    expect(window.localStorage.getItem('team-ledger:seen:p1')).toBeNull();
  });

  it('decision-first: the owner sees the waiting queue BEFORE the inventory; others see it after', async () => {
    h.listLedgerDeltas.mockResolvedValue([proposed()]);
    render(<ProjectLedgerTab project={project} canWrite />);
    const queue = await screen.findByRole('region', { name: /Proposed changes/ });
    const now = screen.getByRole('region', { name: 'What this project is for' });
    expect(queue.compareDocumentPosition(now) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    h.me = 'user-mate';
    render(<ProjectLedgerTab project={project} canWrite />);
    const q2 = await screen.findByRole('region', { name: /Proposed changes/ });
    const n2 = screen.getByRole('region', { name: 'What this project is for' });
    expect(n2.compareDocumentPosition(q2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows people by name and fields by their labels, never raw ids or keys', async () => {
    h.me = 'user-mate';
    h.listLedgerDeltas.mockResolvedValue([proposed({ patch: { inScope: ['EU'], outOfScope: ['APAC'] } })]);
    render(<ProjectLedgerTab project={project} canWrite />);
    expect(await screen.findByText(/Proposed by Mara Mate/)).toBeTruthy();
    expect(screen.getByText(/In scope, Out of scope/)).toBeTruthy();
    expect(screen.getByText('Owner: Olu Owner')).toBeTruthy();
    expect(screen.queryByText(/inScope/)).toBeNull();
  });
});
