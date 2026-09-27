/**
 * PROF-UX-15(a) — assign/unassign on the Assigned-workflows tab used to be
 * SILENT on success (the card list changed and nothing was said) and its
 * failure Notice was conditionally mounted with no `announce` — inserted
 * already holding its text, so not heard either. Both outcomes now speak
 * through the shell's live regions: success politely (`toast.success`),
 * failure assertively (`Notice announce=`).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { setMyWorkflows } = vi.hoisted(() => ({ setMyWorkflows: vi.fn() }));
vi.mock('../profilesClient.js', async (orig) => ({
  ...(await orig<typeof import('../profilesClient.js')>()),
  setMyWorkflows,
}));
vi.mock('../../../client/runsClient.js', () => ({ createRun: vi.fn() }));

import { ProfileWorkflowsTab } from '../ProfileWorkflowsTab.js';
import { ALL_WORKFLOW_OPTIONS } from '../../../agents/roleTemplates.js';
import { GlobalLiveRegion } from '../../../ui/announce.js';

const polite = (): string => document.querySelector('[data-owp-live="polite"]')?.textContent ?? '';
const assertive = (): string => document.querySelector('[data-owp-live="assertive"]')?.textContent ?? '';

/** Complete against the real shape (the teamDirectoryFailedRead lesson). */
const PROFILE = {
  userId: 'u1', tenantId: 't1', displayName: 'Ada Lovelace',
  skills: [], equipment: [], interests: [], workflows: [] as string[],
  portfolioAssetTokens: [], pinnedAgentIds: [],
  completeness: 40, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

const firstWorkflowId = ALL_WORKFLOW_OPTIONS[0]!.workflowId;

const mount = async (workflows: string[], onSaved = vi.fn()): Promise<ReturnType<typeof vi.fn>> => {
  render(<MemoryRouter><GlobalLiveRegion /><ProfileWorkflowsTab workflows={workflows} onSaved={onSaved} /></MemoryRouter>);
  await act(async () => {});
  return onSaved;
};

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

describe('assign / unassign outcomes are announced (PROF-UX-15a)', () => {
  it('a successful ASSIGN is spoken politely and the saved profile is handed back', async () => {
    setMyWorkflows.mockResolvedValue({ ...PROFILE, workflows: [firstWorkflowId] });
    const onSaved = await mount([]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow to assign' }), { target: { value: firstWorkflowId } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Assign workflow' })); });
    expect(setMyWorkflows).toHaveBeenCalledWith([firstWorkflowId]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(polite()).toContain('Workflow assigned.');
    expect(assertive()).not.toContain('Workflow assigned.');
  });

  it('a successful UNASSIGN is spoken too', async () => {
    setMyWorkflows.mockResolvedValue({ ...PROFILE, workflows: [] });
    await mount([firstWorkflowId]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unassign' })); });
    expect(setMyWorkflows).toHaveBeenCalledWith([]);
    expect(polite()).toContain('Workflow unassigned.');
  });

  it('a FAILED save is shown in the Notice AND spoken assertively (the Notice no longer relies on insertion)', async () => {
    setMyWorkflows.mockRejectedValue(new Error('portfolio write refused'));
    const onSaved = await mount([firstWorkflowId]);
    // The announcer is module-level state, so an earlier test's success string is
    // still IN the polite region: assert it did not CHANGE, not that it is empty.
    const politeBefore = polite();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unassign' })); });
    expect(onSaved).not.toHaveBeenCalled();
    expect(document.querySelector('.alert.error')?.textContent).toContain('portfolio write refused');
    expect(assertive()).toContain('portfolio write refused');
    // Not a success in disguise: nothing new was spoken politely.
    expect(polite()).toBe(politeBefore);
  });
});
