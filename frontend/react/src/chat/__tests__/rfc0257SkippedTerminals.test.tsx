/**
 * RFC 0257 (ADR 1027 P3) — a run that COMPLETED without reaching any terminal
 * node is shown as its own state in chat, not as a plain success (R1).
 *
 * The marker is read from the `run.completed` payload (`skippedTerminals`),
 * through both paths that finalize a chat run: the live SSE handler and the
 * log reconcile. The completion card then says "no final step ran", names the
 * skipped steps and offers no View button, because there is no output.
 *
 * Each claim has its positive control: a `run.completed` WITHOUT the marker
 * stays a plain "Workflow completed" with its View button. The card finds its
 * View targets in the builder graph saved on this device, so the card cases seed
 * that graph (`check → act`); without it neither branch renders a View button and
 * the "no View button" check could not fail.
 *
 * Double guard, recorded: in the marker case the View button is also absent
 * because a skipped terminal never completed (`useTerminalNodes` surfaces only
 * reached terminals). So dropping the early return alone is caught by the title
 * assertions, not by the View check; the View check is witnessed by the
 * positive control (no View → red).
 *
 * Red when (sabotage-witnessed, ADR 1027 §Witnesses P3): the reader ignores the
 * payload key; either finalize path drops the marker; the card ignores it or
 * shows it on every completion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type React from 'react';
import type { RunEventDoc } from '@openwop/openwop';
import type { ChatMessage, ChatSession, WorkflowRunState } from '../types.js';
import type { SavedWorkflow } from '../../builder/schema/workflow.js';

const api = vi.hoisted(() => ({ pollEvents: vi.fn(), listOpenInterrupts: vi.fn() }));
vi.mock('../../client/runsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, pollEvents: api.pollEvents };
});
vi.mock('../../client/interruptsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listOpenInterrupts: api.listOpenInterrupts };
});

const { readSkippedTerminals, skippedTerminalsFromEvents } = await import('../lib/skippedTerminals.js');
const { makeWorkflowRunHandlers, reconcileWorkflowRunFromLog } = await import('../hooks/workflowRunSubscription.js');
const { WorkflowCompletionCard } = await import('../WorkflowCompletionCard.js');
const { upsertSavedWorkflow, deleteSavedWorkflow } = await import('../../builder/persistence/localStore.js');

function runState(over: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    slug: 'wf', workflowName: 'Apply to job', workflowId: 'wf-1',
    runId: 'r-1', status: 'running', totalNodes: 3,
    completedNodeIds: ['check'], nodeOutputs: {}, failedNodeIds: [],
    currentNodeName: null, nodeNames: { check: 'Check eligibility', act: 'Submit application' },
    startedAt: '2026-11-02T00:00:00.000Z',
    ...over,
  };
}

function ev(type: string, payload: Record<string, unknown>, sequence = 9): RunEventDoc {
  return { runId: 'r-1', eventId: `e${sequence}`, sequence, type, timestamp: '2026-11-02T00:00:01Z', schemaVersion: 1, payload };
}

/** A real state cell behind the context's setters, so the test reads what the
 *  handlers actually committed. */
function harness() {
  const msg: ChatMessage = { id: 'm1', role: 'workflow_run', content: '', workflowRun: runState(), createdAt: '2026-11-02T00:00:00Z' };
  let session: ChatSession = { id: 's1', title: 'Chat', messages: [msg], createdAt: '2026-11-02T00:00:00Z' };
  const setSession = (u: ChatSession | ((s: ChatSession) => ChatSession)) => { session = typeof u === 'function' ? u(session) : u; };
  const ctx = {
    runId: 'r-1', runMsgId: 'm1', sessionId: 's1', sessionTitle: 'Chat',
    setSession: setSession as React.Dispatch<React.SetStateAction<ChatSession>>,
    persistMessage: vi.fn(async () => {}),
    updateWorkflowRun: (id: string, patch: (p: WorkflowRunState) => WorkflowRunState) => {
      setSession((s) => ({ ...s, messages: s.messages.map((m) => (m.id === id && m.workflowRun ? { ...m, workflowRun: patch(m.workflowRun) } : m)) }));
    },
    closeWorkflowSub: vi.fn(),
  };
  return { ctx, run: () => session.messages[0]?.workflowRun };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listOpenInterrupts.mockResolvedValue([]);
});
afterEach(cleanup);

describe('readSkippedTerminals — the marker off a run.completed payload', () => {
  it('reads the seated key, and the vendor-carried spelling of an older v2 schema', () => {
    expect(readSkippedTerminals({ outputs: {}, skippedTerminals: ['act'] })).toEqual(['act']);
    expect(readSkippedTerminals({ outputs: {}, 'vendor.openwop-app': { skippedTerminals: ['zeta', 'alpha'] } })).toEqual(['zeta', 'alpha']);
  });

  it('absent, empty or malformed → undefined (a terminal completed; plain success)', () => {
    expect(readSkippedTerminals({ outputs: { x: 1 } })).toBeUndefined();
    expect(readSkippedTerminals({ skippedTerminals: [] })).toBeUndefined();
    expect(readSkippedTerminals({ skippedTerminals: 'act' })).toBeUndefined();
    expect(readSkippedTerminals(null)).toBeUndefined();
  });

  it('from an event list: the run.completed event, not some other payload carrying the key', () => {
    expect(skippedTerminalsFromEvents([
      ev('node.completed', { skippedTerminals: ['decoy'] }, 1),
      ev('run.completed', { outputs: {}, skippedTerminals: ['act'] }, 2),
    ])).toEqual(['act']);
    expect(skippedTerminalsFromEvents([ev('node.completed', { skippedTerminals: ['decoy'] }, 1)])).toBeUndefined();
  });
});

describe('chat finalize paths carry the marker into the run state', () => {
  it('live SSE run.completed with the marker → status completed + skippedTerminals', async () => {
    const h = harness();
    api.pollEvents.mockResolvedValue({ events: [] });
    await makeWorkflowRunHandlers(h.ctx).onEvent?.(ev('run.completed', { outputs: {}, skippedTerminals: ['act'] }));
    expect(h.run()?.status).toBe('completed');
    expect(h.run()?.skippedTerminals).toEqual(['act']);
  });

  it('positive control: live run.completed WITHOUT the marker sets none', async () => {
    const h = harness();
    api.pollEvents.mockResolvedValue({ events: [] });
    await makeWorkflowRunHandlers(h.ctx).onEvent?.(ev('run.completed', { outputs: { act: { ok: true } } }));
    expect(h.run()?.status).toBe('completed');
    expect(h.run()?.skippedTerminals).toBeUndefined();
  });

  it('log reconcile (the stream missed run.completed) → the marker from the logged payload', async () => {
    const h = harness();
    api.pollEvents.mockResolvedValue({ events: [
      ev('node.completed', { outputs: { ok: false } }, 3),
      ev('run.completed', { outputs: {}, skippedTerminals: ['act'] }, 4),
    ] });
    const r = await reconcileWorkflowRunFromLog(h.ctx);
    expect(r.terminal).toBe('completed');
    expect(h.run()?.skippedTerminals).toEqual(['act']);
  });
});

describe('WorkflowCompletionCard — "no final step ran" is its own state', () => {
  const view = (run: WorkflowRunState) =>
    render(<MemoryRouter><WorkflowCompletionCard run={run} onPreviewArtifact={() => {}} /></MemoryRouter>);
  /** The graph the Builder saved on this device: `check → act`, `act` terminal. */
  const GRAPH: SavedWorkflow = {
    id: 'wf-1', name: 'Apply to job', version: '1',
    nodes: [
      { id: 'check', kind: 'noop', name: 'Check eligibility', position: { x: 0, y: 0 }, config: {} },
      { id: 'act', kind: 'noop', name: 'Submit application', position: { x: 200, y: 0 }, config: {} },
    ],
    edges: [{ id: 'e1', source: 'check', sourcePort: 'out', target: 'act', targetPort: 'in' }],
    createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
  };
  beforeEach(() => { upsertSavedWorkflow(GRAPH); });
  afterEach(() => { deleteSavedWorkflow('wf-1'); });

  it('with the marker: the distinct title, the skipped steps by name, and no View button', () => {
    view(runState({ status: 'completed', skippedTerminals: ['act'] }));
    expect(screen.getByText('Completed: no final step ran')).toBeTruthy();
    expect(screen.queryByText('Workflow completed')).toBeNull();
    expect(screen.getByTestId('wfcomplete-no-final-step').textContent).toContain('Submit application');
    expect(screen.queryByRole('button', { name: /view/i })).toBeNull();
  });

  it('a skipped terminal with no known name is named by its id', () => {
    view(runState({ status: 'completed', skippedTerminals: ['on-fail'], nodeNames: {} }));
    expect(screen.getByTestId('wfcomplete-no-final-step').textContent).toContain('on-fail');
  });

  it('positive control: a completed run WITHOUT the marker stays a plain success', () => {
    view(runState({ status: 'completed', completedNodeIds: ['check', 'act'], nodeOutputs: { act: { ok: true } } }));
    expect(screen.getByText('Workflow completed')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^View output/ })).toBeTruthy();
    expect(screen.queryByText('Completed: no final step ran')).toBeNull();
    expect(screen.queryByTestId('wfcomplete-no-final-step')).toBeNull();
  });
});
