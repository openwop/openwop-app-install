/**
 * WF-R2-1 (workforces round 2) — pairwise compare from trace-search results.
 *
 * LangSmith's compare-from-search is the cited leader shape
 * (docs.langchain.com/langsmith/compare-traces); we already own the /compare
 * page (`?a=&b=`), but the workforce forensics surface — the exact place an
 * operator finds two related runs — had no path to it.
 *
 * Behavioral assertions: exactly two selections arm a link whose href carries
 * BOTH run ids; under two shows the hint (no dead button); a third checkbox is
 * disabled rather than silently evicting a selection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ searchWorkforceTrace: vi.fn() }));
vi.mock('../../client/workforcesClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, searchWorkforceTrace: api.searchWorkforceTrace };
});

import { TraceSearchPanel } from '../TraceSearchPanel.js';

const MATCHES = {
  scanned: 3,
  capped: false,
  matches: [
    { runId: 'run-aaaaaaaaaaaaaaaa', status: 'completed', outcome: 'success', batchId: 'b1' },
    { runId: 'run-bbbbbbbbbbbbbbbb', status: 'failed', outcome: 'failure', batchId: 'b1' },
    { runId: 'run-cccccccccccccccc', status: 'completed', outcome: 'success', batchId: 'b2' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.searchWorkforceTrace.mockResolvedValue(MATCHES);
});
afterEach(cleanup);

async function search(): Promise<void> {
  render(<MemoryRouter><TraceSearchPanel workforceId="wf1" /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/trace/i), { target: { value: 'b1' } });
  fireEvent.submit(screen.getByLabelText(/trace/i).closest('form')!);
  await screen.findAllByRole('checkbox');
}

describe('WF-R2-1 — trace-search results feed /compare', () => {
  it('two selections arm a compare link carrying both run ids', async () => {
    await search();
    // Under two: the hint, not a dead control.
    expect(screen.getByText(/Select two runs to compare/i)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Select run run-aaaaaaaaaaaa for comparison'));
    fireEvent.click(screen.getByLabelText('Select run run-bbbbbbbbbbbb for comparison'));
    const link = screen.getByRole('link', { name: 'Compare the two selected runs' });
    expect(link.getAttribute('href')).toBe('/compare?a=run-aaaaaaaaaaaaaaaa&b=run-bbbbbbbbbbbbbbbb');
  });

  it('a third checkbox disables instead of silently evicting a selection', async () => {
    await search();
    fireEvent.click(screen.getByLabelText('Select run run-aaaaaaaaaaaa for comparison'));
    fireEvent.click(screen.getByLabelText('Select run run-bbbbbbbbbbbb for comparison'));
    const third = screen.getByLabelText('Select run run-cccccccccccc for comparison');
    expect((third as HTMLInputElement).disabled).toBe(true);
    // Deselecting one re-enables it (the cap is a state, not a one-way door).
    fireEvent.click(screen.getByLabelText('Select run run-aaaaaaaaaaaa for comparison'));
    expect((third as HTMLInputElement).disabled).toBe(false);
  });
});
