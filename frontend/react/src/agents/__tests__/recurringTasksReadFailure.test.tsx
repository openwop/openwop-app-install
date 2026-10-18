/**
 * RTP-EMPTY-1 (ADR 0779 D7) — a failed read of the recurring tasks is NOT shown as
 * an empty list.
 *
 * On a rejected `listLoops` the panel set its list to [] and rendered "No recurring
 * tasks configured." beside the error: a failed read presented as "you have none".
 * Found by /grade-tests wave 48. Break it by dropping `!readFailed` from the empty
 * line in RecurringTasksPanel, or the `setError` in its catch → case 1 red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type AssistantClient = typeof import('../../features/assistant/assistantClient.js');
const listLoops = vi.fn<AssistantClient['listLoops']>();
vi.mock('../../features/assistant/assistantClient.js', async (orig) => ({
  ...(await orig<AssistantClient>()),
  listLoops: () => listLoops(),
  setLoopEnabled: vi.fn<AssistantClient['setLoopEnabled']>(),
}));

const { RecurringTasksPanel } = await import('../RecurringTasksPanel.js');

afterEach(() => { cleanup(); listLoops.mockReset(); });

describe('RTP-EMPTY-1 — a failed read is not an empty list', () => {
  it('a rejected read shows the error and NOT "No recurring tasks configured."', async () => {
    listLoops.mockRejectedValue(new Error('loops read failed'));
    render(<MemoryRouter><RecurringTasksPanel /></MemoryRouter>);
    expect(await screen.findByText('loops read failed')).toBeTruthy();
    expect(screen.queryByText('No recurring tasks configured.')).toBeNull();
  });

  it('a successful empty read still says there are none (positive control)', async () => {
    listLoops.mockResolvedValue([]);
    render(<MemoryRouter><RecurringTasksPanel /></MemoryRouter>);
    expect(await screen.findByText('No recurring tasks configured.')).toBeTruthy();
    expect(screen.queryByText('loops read failed')).toBeNull();
  });
});
