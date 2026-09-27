/**
 * ADR 0600 §3 (`ISU-27`) — a terminal workflow FAILURE was announced politely,
 * from a live region that could not announce at all.
 *
 * `CompletionShell` hardcoded `role="status"` for all three tones. Three
 * separate defects rode on it: the failure branch was polite where
 * `ui/Notice.tsx` maps error → `role="alert" aria-live="assertive"`; the region
 * is NESTED inside `MessageFeed`'s `role="log"` (the competing-voices shape
 * MessageFeed's own comment refuses); and its `aria-label` made AT read the
 * label instead of the row, so the error code was unreachable.
 *
 * The false region is gone. Failure speaks through the one mounted region,
 * assertively. Completion and cancellation deliberately do NOT — the ancestor
 * log announces the card's insertion politely, and a second announcement there
 * is the double-announce `ui/announce.tsx`'s boundary exists to prevent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WorkflowCompletionCard } from '../WorkflowCompletionCard.js';
import { announce, currentAnnouncements } from '../../ui/announce.js';
import type { WorkflowRunState } from '../types.js';

function runState(over: Partial<WorkflowRunState>): WorkflowRunState {
  return {
    slug: 'wf', workflowName: 'Weekly variance', workflowId: 'wf-1',
    runId: 'r-1', status: 'completed', totalNodes: 3,
    completedNodeIds: ['a'], nodeOutputs: {}, failedNodeIds: [],
    startedAt: Date.now(),
    ...over,
  } as WorkflowRunState;
}

function view(run: WorkflowRunState): void {
  render(<MemoryRouter><WorkflowCompletionCard run={run} /></MemoryRouter>);
}

beforeEach(() => {
  // The announcer is module-global; an empty message resets both channels.
  announce('', { assertive: true });
  announce('');
});
afterEach(cleanup);

describe('WorkflowCompletionCard — a failure is announced, and announced ASSERTIVELY', () => {
  it('a FAILED run speaks on the assertive channel', () => {
    view(runState({ status: 'failed', error: { code: 'invalid_config', message: 'no sql' } }));
    expect(currentAnnouncements().assertive).toMatch(/failed/i);
  });

  it('a COMPLETED run does NOT announce — the ancestor log owns that (no double-announce)', () => {
    view(runState({ status: 'completed' }));
    expect(currentAnnouncements().assertive).toBe('');
    expect(currentAnnouncements().polite).toBe('');
  });

  it('a CANCELLED run does not announce assertively either', () => {
    view(runState({ status: 'cancelled' }));
    expect(currentAnnouncements().assertive).toBe('');
  });
});

describe('WorkflowCompletionCard — the shell is no longer a nested live region', () => {
  it('the FAILURE shell carries no status/alert role (it is a labelled group)', () => {
    view(runState({ status: 'failed', error: { code: 'invalid_config', message: 'no sql' } }));
    const shell = document.querySelector('.wfcomplete-shell');
    expect(shell).not.toBeNull();
    expect(shell?.getAttribute('role')).toBe('group');
    // The nesting is the point: `role="status"` here sits inside MessageFeed's
    // `role="log" aria-live="polite"`, which is two regions for one message.
    expect(shell?.getAttribute('aria-live')).toBeNull();
    // …and it is still NAMED, which is what the original `aria-label` was for.
    expect(shell?.getAttribute('aria-label')).toMatch(/failed/i);
  });

  it('the COMPLETED shell is the same shape (the role is not tone-dependent theatre)', () => {
    view(runState({ status: 'completed' }));
    expect(document.querySelector('.wfcomplete-shell')?.getAttribute('role')).toBe('group');
  });

  it('a still-running card renders nothing at all', () => {
    view(runState({ status: 'running' }));
    expect(document.querySelector('.wfcomplete-shell')).toBeNull();
    expect(screen.queryByRole('group')).toBeNull();
  });
});
