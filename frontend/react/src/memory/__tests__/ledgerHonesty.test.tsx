/**
 * ADR 0979 D4 — the run-summary ledger says what it is and offers only what the
 * host will do.
 *
 * The page used to call itself a "memory inspector" whose reads "are scoped to
 * your credential", which was true of the tenant and false of the member, and it
 * offered delete to a Viewer the host now refuses. It never said that no agent
 * reads the list. The run panel listed the newest 50 TENANT rows and filtered
 * them here, so an older run showed nothing.
 *
 * Sabotage that turns it red (witnessed): ignore `canDelete`; drop the own-runs
 * sentence; drop the "agents do not read" lede; list the run panel without its
 * run tag; ungate the grid card's delete; ignore a replay fork's recorded tag.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { RunEventDoc } from '@openwop/openwop';

const { listMemory, getCapabilities } = vi.hoisted(() => ({
  listMemory: vi.fn(),
  getCapabilities: vi.fn(),
}));
vi.mock('../../client/runsClient.js', () => ({ listMemory, getCapabilities }));

import { MemoryInspectorPage } from '../MemoryInspectorPage.js';
import { RunMemoryPanel } from '../../runs/RunMemoryPanel.js';

const ROW = { id: 'runsummary:r1', content: 'Run r1 of "wf" completed → {"text":"HI"}', tags: ['run-summary', 'run-id:r1'], createdAt: '2026-10-25T10:00:00.000Z' };

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  getCapabilities.mockResolvedValue({ capabilities: {} });
});

const mountPage = async (): Promise<void> => {
  render(<MemoryInspectorPage />);
  await act(async () => {});
};

describe('ADR 0979 D4 — the run-summary ledger', () => {
  it('says agents do not read it', async () => {
    listMemory.mockResolvedValue({ memoryRef: 'tenant-memory', entries: [ROW], visibility: 'all', canDelete: true });
    await mountPage();
    expect(document.body.textContent).toContain('Agents do not read this list');
    expect(document.body.textContent).not.toContain('scoped to your credential');
  });

  it('a member who sees only their own runs is told so, and gets no delete controls when the host would refuse', async () => {
    listMemory.mockResolvedValue({ memoryRef: 'tenant-memory', entries: [ROW], visibility: 'own-runs', canDelete: false });
    await mountPage();
    expect(document.body.textContent).toContain('You see the runs you started');
    expect(document.body.textContent).toContain('HI');
    expect(screen.queryByRole('button', { name: /Delete memory entry/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('the grid view honours the same answer', async () => {
    localStorage.setItem('openwop:view:memory', 'grid');
    try {
      listMemory.mockResolvedValue({ memoryRef: 'tenant-memory', entries: [ROW], visibility: 'own-runs', canDelete: false });
      await mountPage();
      expect(document.body.textContent).toContain('HI');
      expect(screen.queryByRole('button', { name: /Delete memory entry/ })).toBeNull();
    } finally {
      localStorage.removeItem('openwop:view:memory');
    }
  });

  it('a caller the host lets delete keeps the controls', async () => {
    listMemory.mockResolvedValue({ memoryRef: 'tenant-memory', entries: [ROW], visibility: 'all', canDelete: true });
    await mountPage();
    expect(screen.getByRole('button', { name: 'Delete memory entry runsummary:r1' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('You see the runs you started');
  });

  it('a host that sends neither field keeps today\'s behaviour (deletable)', async () => {
    listMemory.mockResolvedValue({ memoryRef: 'tenant-memory', entries: [ROW] });
    await mountPage();
    expect(screen.getByRole('button', { name: 'Delete memory entry runsummary:r1' })).toBeTruthy();
  });

  it('the run panel asks the host for THIS run\'s rows', async () => {
    listMemory.mockResolvedValue({ memoryRef: 'tenant-memory', entries: [ROW] });
    render(<RunMemoryPanel runId="r1" events={[]} status="completed" />);
    await act(async () => {});
    expect(listMemory).toHaveBeenCalledWith(expect.objectContaining({ tag: 'run-id:r1' }));
    expect(document.body.textContent).toContain('1 entry');
  });

  it('a replay fork shows the entry its log records (the source run\'s), not an empty panel', async () => {
    listMemory.mockResolvedValue({ memoryRef: 'tenant-memory', entries: [ROW] });
    const replayed: RunEventDoc[] = [{
      runId: 'fork1', sequence: 3, type: 'memory.written', timestamp: '2026-10-25T10:00:00Z', eventId: 'e3', schemaVersion: 1,
      payload: { memoryRef: 'tenant-memory', memoryId: 'runsummary:r1', tags: ['run-summary', 'run-id:r1'] },
    }];
    render(<RunMemoryPanel runId="fork1" events={replayed} status="completed" />);
    await act(async () => {});
    expect(listMemory).toHaveBeenCalledWith(expect.objectContaining({ tag: 'run-id:r1' }));
    expect(document.body.textContent).toContain('1 entry');
  });
});
