/**
 * ADR 0845 (feature loop round 2 row 27) — UX surfacing of the gate changes:
 * STR3UX-3 (an Overview save sends only what changed, and a protected edit that
 * reverted names the field LABEL), STR3UX-2 (an import that reverted says so),
 * D4 (a lost compare-and-swap is localized and offers Reload), and the approval
 * decide error mapping (`content_changed`, `separation-of-duties`).
 *
 * Sabotage-witnessed (grade-tests w19, probes w19g5-r5-*): always sending
 * `accountableExecutive`, dropping the summary patch, rendering raw field ids,
 * nulling either auto-revert report, toasting a reverted Overview save, dropping
 * the stale-write branch or Reload's re-read, and removing either error mapping
 * each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type * as Client from '../strategyClient.js';
import type { Strategy } from '../strategyClient.js';

const getStrategy = vi.fn<typeof Client.getStrategy>();
const listStrategies = vi.fn<typeof Client.listStrategies>();
const listProjects = vi.fn<typeof Client.listProjects>();
const updateStrategy = vi.fn<typeof Client.updateStrategy>();
const replaceLinks = vi.fn<typeof Client.replaceLinks>();
const importObjectives = vi.fn<typeof Client.importObjectives>();
const getStrategyDetailContext = vi.fn<typeof Client.getStrategyDetailContext>();
const getStrategyContext = vi.fn<typeof Client.getStrategyContext>();
const toastSuccess = vi.fn<(m: string) => void>();

vi.mock('../strategyClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getStrategy: (...a: Parameters<typeof Client.getStrategy>) => getStrategy(...a),
  listStrategies: (...a: Parameters<typeof Client.listStrategies>) => listStrategies(...a),
  listProjects: () => listProjects(),
  updateStrategy: (...a: Parameters<typeof Client.updateStrategy>) => updateStrategy(...a),
  getStrategyDetailContext: (...a: Parameters<typeof Client.getStrategyDetailContext>) => getStrategyDetailContext(...a),
  getStrategyContext: (...a: Parameters<typeof Client.getStrategyContext>) => getStrategyContext(...a),
  listStrategyCheckIns: vi.fn(async () => []),
  // No case here opens the Timeline tab; kept inert so a stray read cannot fetch.
  getStrategyTimeline: vi.fn(async () => []),
  replaceLinks: (...a: Parameters<typeof Client.replaceLinks>) => replaceLinks(...a),
  importObjectives: (...a: Parameters<typeof Client.importObjectives>) => importObjectives(...a),
}));
// ADR 0661 — a SECOND shape, distinct from "the factory missed an export": this
// live fetch came from a SHARED cross-feature module (`orgs/orgMembers.ts`) that
// the test never considered at all, reached through a component this page renders.
// Nothing here asserts on members.
vi.mock('../../../orgs/orgMembers.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadOrgMembers: vi.fn(async () => []),
}));
const toastInfo = vi.fn();
vi.mock('../../../ui/toast.js', () => ({ toast: { success: (m: string) => toastSuccess(m), info: (m: string) => toastInfo(m), error: vi.fn() } }));
const confirmMock = vi.fn<(o: unknown) => Promise<boolean>>();
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: unknown) => confirmMock(o) }));

import { StrategyDetailPage } from '../StrategyDetailPage.js';
import { StrategyStaleWriteError } from '../strategyClient.js';
import { approvalErrorInfo, ApprovalApiError } from '../../../agents/approvalsClient.js';

const STRATEGY: Strategy = {
  id: 's1', tenantId: 'user:t1', orgId: 'org-1', scope: 'org',
  title: 'Win the mid-market', planningHorizon: 'annual',
  period: { label: '2026' }, status: 'active',
  objectives: [
    { id: 'o1', title: 'Grow pipeline', keyResults: [{ id: 'k1', title: 'MQLs 2x' }] },
    { id: 'o2', title: 'Retain the base', keyResults: [] },
  ],
  initiatives: [], links: [],
  createdBy: 'user:t1', createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

/** A PATCH / import response: the full saved strategy plus the flags under test. */
const saved = (flags: Partial<Strategy> = {}): Strategy => ({ ...structuredClone(STRATEGY), ...flags });

const view = async (tab: string): Promise<void> => {
  render(
    <MemoryRouter initialEntries={[`/strategy/s1?tab=${tab}`]}>
      <Routes><Route path="/strategy/:strategyId" element={<StrategyDetailPage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  await waitFor(() => expect(getStrategy).toHaveBeenCalled());
};

beforeEach(() => {
  for (const m of [getStrategy, listStrategies, listProjects, updateStrategy, replaceLinks, importObjectives, getStrategyDetailContext, getStrategyContext, toastSuccess, confirmMock]) m.mockReset();
  confirmMock.mockResolvedValue(true);
  getStrategy.mockImplementation(async () => structuredClone(STRATEGY));
  listStrategies.mockResolvedValue([]);
  listProjects.mockResolvedValue([]);
  updateStrategy.mockResolvedValue(saved());
  replaceLinks.mockResolvedValue(saved());
  importObjectives.mockResolvedValue({ imported: 2, skipped: [], strategy: saved() });
  getStrategyDetailContext.mockResolvedValue(null);
  getStrategyContext.mockResolvedValue([]);
});
afterEach(cleanup);


/**
 * Feature loop round 2 row 27 (ADR 0845) — the backend now gates import/restore,
 * refuses stale writes and self-approval, and closes reviews whose content moved.
 * Each leg pins that the SCREEN says so (the STR2-M5 lesson: a status chip flipping
 * is not a message).
 */
describe('STR3UX-3 — an Overview save sends only what changed', () => {
  it('editing the summary does not send the protected fields (so cannot deactivate)', async () => {
    updateStrategy.mockResolvedValue(saved());
    await view('overview');
    const summary = await screen.findByLabelText(/summary/i);
    fireEvent.change(summary, { target: { value: 'New summary' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateStrategy).toHaveBeenCalled());
    const patch = updateStrategy.mock.calls[0]![1];
    expect(patch).toEqual({ summary: 'New summary' });
  });

  it('a protected Overview edit that reverted says so, with the field LABEL, not its id', async () => {
    updateStrategy.mockResolvedValue(saved({ status: 'draft', autoRevertedToDraft: true, autoRevertedFields: ['accountableExecutive'] }));
    await view('overview');
    const exec = await screen.findByLabelText(/accountable/i);
    fireEvent.change(exec, { target: { value: 'Someone' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const notice = await screen.findByText(/returns it to Draft/i);
    expect(notice.textContent).not.toContain('accountableExecutive');
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('STR3UX-2 — an import that reverted or withdrew says so', () => {
  it('surfaces the auto-revert disclosure from the import response', async () => {
    importObjectives.mockResolvedValue({ imported: 1, skipped: [], strategy: saved(), autoRevertedToDraft: true, autoRevertedFields: ['objectives'] });
    await view('objectives');
    const box = await screen.findByLabelText(/csv/i);
    fireEvent.change(box, { target: { value: 'objective,keyResult,target,unit\nNew,,,' } });
    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    expect(await screen.findByText(/returns it to Draft/i)).toBeTruthy();
  });
});

describe('ADR 0845 D4 — a lost write is localized and offers Reload', () => {
  it('shows the stale-write copy and a Reload action that re-reads', async () => {
    updateStrategy.mockRejectedValueOnce(new StrategyStaleWriteError('This strategy changed since you opened it.'));
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/changed this strategy while you were editing/i)).toBeTruthy();
    const calls = getStrategy.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /reload latest/i }));
    await waitFor(() => expect(getStrategy.mock.calls.length).toBeGreaterThan(calls));
    // Reload discards the lost write's notice once the latest version is read.
    await waitFor(() => expect(screen.queryByText(/changed this strategy while you were editing/i)).toBeNull());
  });
});

describe('ADR 0845 — approval decide failures say what happened', () => {
  it('maps content_changed and separation-of-duties to their own keys (not "already decided")', () => {
    expect(approvalErrorInfo(new ApprovalApiError('x', 'conflict', 409, { reason: 'content_changed' }))?.key).toBe('approvalStrategyChanged');
    expect(approvalErrorInfo(new ApprovalApiError('x', 'forbidden', 403, { reason: 'separation-of-duties' }))?.key).toBe('approvalSelfApproval');
    expect(approvalErrorInfo(new ApprovalApiError('x', 'conflict', 409))?.key).toBe('approvalAlreadyDecided');
  });
});
