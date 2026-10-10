/**
 * DESIGN.md §4.5 rule 17 / ADR 0844 D4 — no link a viewer cannot follow.
 * `/runs/:runId` is admin-tier, so a member's chat run surfaces must not link
 * there: the run id stays as text, and "Open run" actions are absent.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChatMessage, WorkflowRunState } from '../types.js';

let admin = false;
vi.mock('../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => ({ access: {}, resolved: true }),
  isAdminCaller: () => admin,
}));

const { WorkflowCompletionCard } = await import('../WorkflowCompletionCard.js');
const { WorkflowRunBubble } = await import('../WorkflowRunBubble.js');

function runState(over: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    slug: 'wf', workflowName: 'Weekly variance', workflowId: 'wf-1',
    runId: 'run-abc', status: 'completed', totalNodes: 3,
    completedNodeIds: ['a'], nodeOutputs: {}, failedNodeIds: [],
    startedAt: Date.now(),
    ...over,
  } as WorkflowRunState;
}

function runLinks(): HTMLAnchorElement[] {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/runs/"]'));
}

afterEach(() => { cleanup(); admin = false; });

describe('chat run links follow the /runs/:runId admin tier', () => {
  it('completion card: an admin gets "Open run"; a member gets no run link', () => {
    admin = true;
    render(<MemoryRouter><WorkflowCompletionCard run={runState()} /></MemoryRouter>);
    expect(runLinks().map((a) => a.getAttribute('href'))).toContain('/runs/run-abc');
    cleanup();

    admin = false;
    render(<MemoryRouter><WorkflowCompletionCard run={runState()} /></MemoryRouter>);
    expect(runLinks()).toEqual([]);
    // The graph-cache miss copy must not tell a member to open the run.
    const miss = screen.getByTestId('wfcomplete-graph-unavailable').textContent ?? '';
    expect(miss).toMatch(/isn’t cached on this device/);
    expect(miss).not.toMatch(/Open the run/);
  });

  it('run bubble: a member sees the run id as text, not a link', () => {
    const message = { id: 'm1', role: 'assistant', content: '', workflowRun: runState({ status: 'running' }) } as unknown as ChatMessage;

    admin = true;
    render(<MemoryRouter><WorkflowRunBubble message={message} /></MemoryRouter>);
    expect(runLinks().map((a) => a.textContent)).toContain('run run-abc');
    cleanup();

    admin = false;
    render(<MemoryRouter><WorkflowRunBubble message={message} /></MemoryRouter>);
    expect(runLinks()).toEqual([]);
    expect(screen.getByText('run run-abc')).toBeTruthy();
  });
});
