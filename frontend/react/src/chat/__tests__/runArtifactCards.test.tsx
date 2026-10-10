/**
 * ADR 0768 follow-up B3 — a completed run lists its DURABLE outputs as cards
 * that open in the Workbench.
 *
 * Pins: cards only on a surface with a Workbench and only for a completed run;
 * a click opens THAT artifact; the "outputs can't be listed on this device" line
 * is withdrawn once the server has listed them (it would be false), and kept
 * when the read fails (a failure is never read as "none").
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { WorkflowRunState } from '../types.js';

// A plain implementation + call log, not a vi.fn: under Vitest 4 a cleared/reset
// vi.fn whose promise REJECTS fails the test even when the code handles the
// rejection (probed four ways), which would make the failure path untestable.
let impl: (id: string) => Promise<unknown> = async () => [];
const calls: string[] = [];
vi.mock('../artifacts/artifactClient.js', () => ({ listRunArtifacts: (id: string) => { calls.push(id); return impl(id); } }));

import { WorkflowCompletionCard } from '../WorkflowCompletionCard.js';

const run = (over: Partial<WorkflowRunState> = {}): WorkflowRunState => ({
  slug: 'wf', workflowName: 'Launch plan', workflowId: 'wf-not-cached',
  runId: 'run-7', status: 'completed', totalNodes: 2,
  completedNodeIds: ['draft', 'review'], nodeOutputs: {}, failedNodeIds: [],
  startedAt: Date.now(), ...over,
} as WorkflowRunState);

const art = (id: string, title: string) => ({
  artifactId: `run-event:run-7:${id}`, runNodeId: id, title, kind: 'document', format: 'markdown',
  tenantId: 't', orgId: 'o', source: 'run-event', sourceId: id, status: 'final',
  createdBy: { kind: 'run', id: 'run-7' }, createdAt: '2026-09-29T00:00:00Z', provenance: { runId: 'run-7', nodeId: id },
});

beforeEach(() => { calls.length = 0; impl = async () => []; });
afterEach(cleanup);

const view = (r: WorkflowRunState, onOpenArtifact?: (a: { artifactId: string }) => void) =>
  render(<MemoryRouter><WorkflowCompletionCard run={r} {...(onOpenArtifact ? { onOpenArtifact } : {})} /></MemoryRouter>);

describe('run artifact cards (ADR 0768 B3)', () => {
  it('lists the run\'s artifacts and opens the clicked one in the Workbench', async () => {
    impl = async () => ([art('draft', 'Launch plan v3'), art('review', 'Review notes')]);
    const onOpen = vi.fn();
    view(run(), onOpen);
    fireEvent.click(await screen.findByText('Review notes'));
    expect(calls).toEqual(['run-7']);
    expect(onOpen).toHaveBeenCalledWith({ artifactId: 'run-event:run-7:review' });
    expect(screen.getByText('Launch plan v3')).toBeTruthy();
  });

  it('withdraws "can\'t be listed on this device" once the server listed outputs', async () => {
    impl = async () => ([art('draft', 'Launch plan v3')]);
    view(run(), vi.fn());
    await screen.findByText('Launch plan v3');
    expect(screen.queryByTestId('wfcomplete-graph-unavailable')).toBeNull();
  });

  it('a failed read shows no cards and KEEPS the honest line', async () => {
    impl = async () => { throw new Error('500'); };
    view(run(), vi.fn());
    await waitFor(() => expect(calls).toEqual(['run-7']));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('wfcomplete-graph-unavailable')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('asks nothing without a Workbench, or for a run that did not complete', async () => {
    impl = async () => ([]);
    view(run());
    view(run({ status: 'failed', error: { code: 'x', message: 'y' } }), vi.fn());
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
  });
});
