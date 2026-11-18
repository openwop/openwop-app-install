/**
 * CC-CHAT-6 — a finished run is never waiting, and a self-resuming wait never
 * "needs you".
 *
 * MEASURED on prod 2026-11-16 (run 0a4c0701): a campaign orchestration cancelled
 * while its channel-dispatch step waited on linked runs kept that wait in the
 * saved chat message. After a full reload the composer strip said "NEEDS YOU · 1"
 * with a Review button, and the run card said "Cancelled" beside "Waiting —
 * continues on its own", although the server listed no open interrupt.
 *
 * These pin the read side, so chats saved before the fix render correctly too:
 * the tray skips finished runs and self-resuming kinds (the CC-ORCH-3 rule), and
 * the run bubble shows no waiting line on a finished run. The write side (the
 * terminal handlers clear `activeInterrupts`) is pinned in
 * `hooks/__tests__/useChatSession.integration.test.tsx`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChatMessage, WorkflowRunState } from '../types.js';
import type { OpenInterrupt } from '../../client/interruptsClient.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { count?: unknown }) => (o && o.count !== undefined ? `${k}:${String(o.count)}` : k) }),
}));
vi.mock('../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => ({ access: {}, resolved: true }),
  isAdminCaller: () => false,
}));

import { collectOpenInterrupts } from '../lib/openInterrupts.js';
import { NeedsYouTray } from '../NeedsYouTray.js';
import { WorkflowRunBubble } from '../WorkflowRunBubble.js';

function interrupt(id: string, nodeId: string, kind: string): OpenInterrupt {
  return { interruptId: id, nodeId, kind, data: {}, createdAt: '2026-11-16T19:30:00Z' };
}
function runMessage(id: string, status: WorkflowRunState['status'], interrupts: OpenInterrupt[]): ChatMessage {
  const workflowRun: WorkflowRunState = {
    slug: 'campaign-orchestration', workflowName: 'Campaign orchestration', workflowId: 'wf', runId: `run-${id}`, status,
    totalNodes: 8, completedNodeIds: ['a', 'b'], nodeOutputs: {}, failedNodeIds: [], currentNodeName: null,
    nodeNames: { 'kernel-approve': 'Approve kernel', 'channel-dispatch': 'Channel dispatch' }, startedAt: '2026-11-16T19:29:00Z',
  };
  return { id, role: 'workflow_run', content: '', createdAt: '2026-11-16T19:29:00Z', activeInterrupts: interrupts, workflowRun };
}

afterEach(cleanup);

describe('CC-CHAT-6 — the needs-you projection', () => {
  it('skips a finished run, whatever its saved message still carries', () => {
    for (const status of ['cancelled', 'completed', 'failed'] as const) {
      expect(collectOpenInterrupts([runMessage('m', status, [interrupt('i1', 'kernel-approve', 'approval')])])).toEqual([]);
    }
  });

  it('skips a self-resuming wait on a live run, and keeps a gate a person must answer', () => {
    const out = collectOpenInterrupts([
      runMessage('m', 'running', [interrupt('w', 'channel-dispatch', 'external-event'), interrupt('t', 'channel-dispatch', 'timer'), interrupt('g', 'kernel-approve', 'approval')]),
    ]);
    expect(out.map((e) => e.interruptId)).toEqual(['g']);
  });

  it('the tray renders nothing for the prod case (cancelled run, channel-dispatch wait)', () => {
    const { container } = render(<NeedsYouTray messages={[runMessage('m', 'cancelled', [interrupt('w', 'channel-dispatch', 'external-event')])]} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('CC-CHAT-6 — the run bubble', () => {
  it('a cancelled run shows no waiting line, even with a stale wait saved on it', () => {
    render(<MemoryRouter><WorkflowRunBubble message={runMessage('m', 'cancelled', [interrupt('w', 'channel-dispatch', 'external-event')])} /></MemoryRouter>);
    expect(screen.queryByText('waitingResumesOnItsOwn')).toBeNull();
    expect(screen.queryByText('awaitingYourInput')).toBeNull();
  });

  it('a live run waiting on linked runs still says it continues on its own', () => {
    render(<MemoryRouter><WorkflowRunBubble message={runMessage('m', 'running', [interrupt('w', 'channel-dispatch', 'external-event')])} /></MemoryRouter>);
    expect(screen.getByText('waitingResumesOnItsOwn')).toBeTruthy();
  });
});
