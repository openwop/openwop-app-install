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
 *
 * Sabotage that turns it red: swap a/b in the href; arm the link at one selection;
 * drop the hint; never disable (or disable at one) a further checkbox.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import type { TraceMatch, TraceSearchResult } from '../../client/workforcesClient.js';

const api = vi.hoisted(() => ({ searchWorkforceTrace: vi.fn<typeof import('../../client/workforcesClient.js').searchWorkforceTrace>() }));
vi.mock('../../client/workforcesClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../client/workforcesClient.js')>()),
  searchWorkforceTrace: api.searchWorkforceTrace,
}));

import { TraceSearchPanel } from '../TraceSearchPanel.js';

const match = (runId: string, status: string, outcome: string, batchId: string): TraceMatch => ({
  runId, status, outcome, batchId, correlationId: null, startedAt: '2026-09-01T10:00:00.000Z',
});
const MATCHES: TraceSearchResult = {
  query: 'b1',
  scanned: 3,
  capped: false,
  matches: [
    match('run-aaaaaaaaaaaaaaaa', 'completed', 'success', 'b1'),
    match('run-bbbbbbbbbbbbbbbb', 'failed', 'failure', 'b1'),
    match('run-cccccccccccccccc', 'completed', 'success', 'b2'),
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
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
    // ONE selection: still the hint, still no link (no half-armed compare).
    expect(screen.queryByRole('link', { name: 'Compare the two selected runs' })).toBeNull();
    expect(screen.getByText(/Select two runs to compare/i)).toBeTruthy();
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
