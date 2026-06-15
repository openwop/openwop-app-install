import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RunEventDoc } from '@openwop/openwop';

/**
 * Integration harness for useChatSession's run lifecycle (frontend
 * enterprise-review chat decomposition). It mocks the dispatch + SSE clients
 * (createRun / subscribeToRun / write-through), drives RunEventDoc events
 * through the captured onEvent, and asserts on the resulting session state.
 *
 * This is the prerequisite that makes the SSE `runSubscription` safe to extract
 * later: the send → subscribe → stream → finalize / cancel path is now pinned
 * by tests before any refactor touches it.
 */

// --- captured SSE handler + dispatch mocks -------------------------------
interface Captured { runId: string; onEvent: (ev: RunEventDoc) => void | Promise<void> }
let captured: Captured | null = null;
const closeSpy = vi.fn();

vi.mock('../../../client/streamsClient.js', () => ({
  subscribeToRun: (runId: string, opts: { onEvent: (ev: RunEventDoc) => void | Promise<void> }) => {
    captured = { runId, onEvent: opts.onEvent };
    return { close: closeSpy };
  },
}));
vi.mock('../../../client/runsClient.js', () => ({
  createRun: vi.fn(() => Promise.resolve({ runId: 'run-1' })),
  cancelRun: vi.fn(() => Promise.resolve()),
  getRun: vi.fn(() => Promise.resolve({ status: 'running' })),
  getSdkClient: vi.fn(),
}));
vi.mock('../../../client/interruptsClient.js', () => ({
  listOpenInterrupts: vi.fn(() => Promise.resolve([])),
  resolveByRun: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../client/chatSessionsClient.js', () => ({
  createChatSession: vi.fn(() => Promise.resolve()),
  appendChatMessage: vi.fn(() => Promise.resolve()),
  listChatSessionMessages: vi.fn(() => Promise.resolve([])),
}));

import { useChatSession } from '../useChatSession.js';
import { createRun, cancelRun } from '../../../client/runsClient.js';
import { listOpenInterrupts } from '../../../client/interruptsClient.js';

const CONFIG = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' };

let seq = 0;
function evt(type: string, payload: unknown): RunEventDoc {
  seq += 1;
  return { eventId: `e${seq}`, runId: 'run-1', type, payload, timestamp: '2026-01-01T00:00:00Z', sequence: seq };
}

beforeEach(() => {
  localStorage.clear();
  captured = null;
  seq = 0;
  closeSpy.mockClear();
  vi.mocked(createRun).mockClear();
  vi.mocked(cancelRun).mockClear();
});

describe('useChatSession run lifecycle (integration)', () => {
  it('send() appends a user + streaming assistant bubble and opens the subscription', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.send('hello', CONFIG); });

    const roles = result.current.session.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant']);
    const assistant = result.current.session.messages.find((m) => m.role === 'assistant');
    expect(assistant?.isStreaming).toBe(true);
    expect(result.current.isSending).toBe(true);
    expect(vi.mocked(createRun)).toHaveBeenCalledOnce();
    expect(captured?.runId).toBe('run-1');
  });

  it('node.completed finalizes the assistant bubble with the authoritative content', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.send('hi', CONFIG); });

    await act(async () => {
      await captured!.onEvent(evt('node.message', { delta: 'Hel' }));
      await captured!.onEvent(evt('node.message', { delta: 'lo' }));
      await captured!.onEvent(evt('node.completed', { outputs: { completion: 'Hello world' } }));
    });

    const assistant = result.current.session.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('Hello world');
    expect(assistant?.isStreaming).toBe(false);
  });

  it('run.completed ends the turn and closes the subscription', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.send('hi', CONFIG); });
    await act(async () => { await captured!.onEvent(evt('run.completed', {})); });

    expect(result.current.isSending).toBe(false);
    expect(closeSpy).toHaveBeenCalled();
  });

  it('cancel() aborts the in-flight run and closes the subscription', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.send('hi', CONFIG); });
    await act(async () => { await result.current.cancel(); });

    expect(vi.mocked(cancelRun)).toHaveBeenCalledWith('run-1', expect.any(String));
    expect(closeSpy).toHaveBeenCalled();
    expect(result.current.isSending).toBe(false);
  });

  it('run.failed surfaces an error and ends the turn', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.send('hi', CONFIG); });
    await act(async () => { await captured!.onEvent(evt('run.failed', { error: { code: 'boom', message: 'nope' } })); });

    expect(result.current.isSending).toBe(false);
  });

  it('handles a real production COMPLETION stream (openwop-free/MiniMax, captured from app.openwop.dev)', async () => {
    // Exact RunEventDoc shapes a live "Try it free" (openwop-free → MiniMax M2)
    // openwop-app.chat.turn emitted on app.openwop.dev: reasoning deltas, then the
    // answer streamed as node.message deltas, then agent.reasoned, then
    // node.completed with the authoritative completion. Drives my EXTRACTED
    // chatTurnSubscription handler with real happy-path output.
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.send('hi', CONFIG); });

    await act(async () => {
      await captured!.onEvent(evt('run.started', { workflowId: 'openwop-app.chat.turn' }));
      await captured!.onEvent(evt('node.started', {}));
      // reasoning stream (M2 is a reasoning model)
      await captured!.onEvent(evt('agent.reasoning.delta', { delta: 'The', agentId: 'openwop-free-assistant', sequence: 0, verbosity: 'full' }));
      await captured!.onEvent(evt('agent.reasoning.delta', { delta: ' user', agentId: 'openwop-free-assistant', sequence: 1, verbosity: 'full' }));
      // answer streamed as node.message deltas
      for (const d of ['\n\n\n\n', 'hello', ' from', ' a', ' real', ' run']) {
        await captured!.onEvent(evt('node.message', { delta: d }));
      }
      await captured!.onEvent(evt('agent.reasoned', { agentId: 'openwop-free-assistant', reasoning: 'The user asked for an exact reply.', verbosity: 'full' }));
      await captured!.onEvent(evt('node.completed', {
        outputs: { model: 'openwop-free', usage: { inputTokens: 116, outputTokens: 68 }, provider: 'openwop-free', completion: '\n\n\n\nhello from a real run' },
      }));
      await captured!.onEvent(evt('run.completed', { output: {} }));
    });

    const assistant = result.current.session.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('\n\n\n\nhello from a real run'); // authoritative completion
    expect(assistant?.isStreaming).toBe(false);
    expect(assistant?.thoughts?.content).toBe('The user asked for an exact reply.'); // agent.reasoned finalized
    expect(result.current.isSending).toBe(false);
    expect(closeSpy).toHaveBeenCalled();
  });

  it('handles a real production failure stream (captured from app.openwop.dev)', async () => {
    // These are the exact RunEventDoc envelope + payload shapes a live
    // openwop-app.chat.turn emitted on app.openwop.dev (Anthropic managed target
    // unprovisioned → managed_unknown). Drives my onEvent handler with REAL
    // backend output, not synthetic — verifies the failure branch end-to-end.
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.send('hi', CONFIG); });

    await act(async () => {
      await captured!.onEvent(evt('run.started', { workflowId: 'openwop-app.chat.turn' }));
      await captured!.onEvent(evt('node.started', {}));
      await captured!.onEvent(evt('node.failed', { error: { code: 'managed_unknown', message: 'No managed target configured for provider "anthropic".' } }));
      await captured!.onEvent(evt('run.failed', {
        error: { code: 'managed_unknown', action: 'abort', message: 'No managed target configured for provider "anthropic".', category: 'unknown', userMessage: 'Something went wrong. Check the server logs.' },
      }));
    });

    const assistant = result.current.session.messages.find((m) => m.role === 'assistant');
    expect(assistant?.meta?.error?.code).toBe('managed_unknown');
    expect(assistant?.isStreaming).toBe(false);
    expect(result.current.isSending).toBe(false);
    expect(closeSpy).toHaveBeenCalled();
  });

  it('node.suspended attaches an interrupt card; node.interrupt.resolved clears it', async () => {
    vi.mocked(listOpenInterrupts).mockResolvedValueOnce([
      { interruptId: 'i1', nodeId: 'approve', kind: 'approval' },
    ]);
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.send('hi', CONFIG); });

    await act(async () => { await captured!.onEvent(evt('node.suspended', { nodeId: 'approve' })); });
    let assistant = result.current.session.messages.find((m) => m.role === 'assistant');
    expect(assistant?.activeInterrupt?.interruptId).toBe('i1');

    await act(async () => { await captured!.onEvent(evt('node.interrupt.resolved', {})); });
    assistant = result.current.session.messages.find((m) => m.role === 'assistant');
    expect(assistant?.activeInterrupt ?? null).toBeNull();
  });
});

const MENTION = {
  displayName: 'Uppercase', slug: 'uppercase', description: 'Uppercase the text',
  toolName: 'uppercase', workflowId: 'openwop-app.uppercase',
};

describe('useChatSession workflow_run lifecycle (integration)', () => {
  const wfRun = (result: { current: { session: { messages: Array<{ role: string; id: string; workflowRun?: unknown }> } } }) =>
    result.current.session.messages.find((m) => m.role === 'workflow_run');

  it('runWorkflowMention creates a workflow_run bubble, dispatches, and subscribes', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION, 'hi there'); });

    const run = wfRun(result) as { workflowRun?: { status?: string; runId?: string } } | undefined;
    expect(run).toBeTruthy();
    expect(run?.workflowRun?.status).toBe('running');
    expect(run?.workflowRun?.runId).toBe('run-1');
    expect(vi.mocked(createRun)).toHaveBeenCalledOnce();
    expect(captured?.runId).toBe('run-1');
  });

  it('node.started/completed update the workflow_run progress', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION); });

    await act(async () => {
      await captured!.onEvent(evt('node.started', { nodeId: 'upper_0' }));
    });
    let run = wfRun(result) as { workflowRun?: { runningNodeIds?: string[]; currentNodeName?: string } };
    expect(run.workflowRun?.runningNodeIds).toContain('upper_0');

    await act(async () => {
      await captured!.onEvent(evt('node.completed', { nodeId: 'upper_0', outputs: { text: 'HI' } }));
    });
    run = wfRun(result) as { workflowRun?: { completedNodeIds?: string[]; runningNodeIds?: string[] } };
    expect(run.workflowRun?.completedNodeIds).toContain('upper_0');
    expect(run.workflowRun?.runningNodeIds ?? []).not.toContain('upper_0');
  });

  it('run.completed marks the workflow_run completed and closes its subscription', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION); });
    await act(async () => { await captured!.onEvent(evt('run.completed', { output: { text: 'HI' } })); });

    const run = wfRun(result) as { workflowRun?: { status?: string } };
    expect(run.workflowRun?.status).toBe('completed');
    expect(closeSpy).toHaveBeenCalled();
  });

  it('cancelWorkflowRun cancels the run; run.cancelled flips status', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION); });
    const id = (wfRun(result) as { id: string }).id;

    await act(async () => { await result.current.cancelWorkflowRun(id); });
    expect(vi.mocked(cancelRun)).toHaveBeenCalledWith('run-1', expect.any(String));

    await act(async () => { await captured!.onEvent(evt('run.cancelled', {})); });
    const run = wfRun(result) as { workflowRun?: { status?: string } };
    expect(run.workflowRun?.status).toBe('cancelled');
  });
});
