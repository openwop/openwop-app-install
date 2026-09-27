/**
 * conversationTransport — turns→bubbles mapping + flag default + the gate-open
 * wait that guards the first turn against the background-dispatch race.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const openConversation = vi.fn();
const listOpenInterrupts = vi.fn();
const getRun = vi.fn();

vi.mock('../conversationClient.js', async (importActual) => ({
  ...(await importActual<typeof import('../conversationClient.js')>()),
  openConversation: (...a: unknown[]) => openConversation(...a),
}));
vi.mock('../../client/interruptsClient.js', () => ({
  listOpenInterrupts: (...a: unknown[]) => listOpenInterrupts(...a),
}));
vi.mock('../../client/runsClient.js', async (importActual) => ({
  ...(await importActual<typeof import('../../client/runsClient.js')>()),
  getRun: (...a: unknown[]) => getRun(...a),
}));

import { seedRunState, turnsToBubbles, openConversationSession, streamDeltaFromEvent, exchangeSettleSignal, exchangeErrorPayload, toolActivityFromEvent, titledFromEvent, recallUsedFromEvent, contextDegradedFromEvent } from '../conversationTransport.js';
import type { ConversationTurn } from '../conversationClient.js';

const turn = (p: Partial<ConversationTurn> & Pick<ConversationTurn, 'messageId' | 'role' | 'turnIndex' | 'from'>): ConversationTurn => ({
  content: '', ts: 0, ...p,
});

describe('turnsToBubbles', () => {
  it('drops system turns; maps user→user and agent→assistant with wire attribution', () => {
    const bubbles = turnsToBubbles([
      turn({ messageId: 'c:0:system', role: 'system', turnIndex: 0, from: 'system', content: 'opened' }),
      turn({ messageId: 'c:1:user', role: 'user', turnIndex: 1, from: 'user', content: 'hi @devon', to: 'a:devon' }),
      turn({ messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'a:devon', content: 'Hey!', agent: { agentId: 'a:devon' } }),
      turn({ messageId: 'c:3:system', role: 'system', turnIndex: 3, from: 'system', content: 'closed' }),
    ]);
    expect(bubbles).toEqual([
      { id: 'c:1:user', role: 'user', content: 'hi @devon' },
      { id: 'c:2:agent', role: 'assistant', content: 'Hey!', agentPersona: 'a:devon' },
    ]);
  });

  // ADR 0665 D4 — an advisor that produced NOTHING. Without this projection the
  // typed object falls through to `asText` and the feed renders raw JSON; worse, an
  // empty bubble in a council reads as assent, which is the defect being closed.
  it('maps a no_contribution turn to a marked bubble, never raw JSON and never bare empty prose', () => {
    const bubbles = turnsToBubbles([
      turn({
        messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'host:ada',
        content: { kind: 'no_contribution', reason: 'empty_completion', agentId: 'host:ada' },
        agent: { agentId: 'host:ada' },
      }),
    ]);
    expect(bubbles[0]).toEqual({ id: 'c:2:agent', role: 'assistant', content: '', noContribution: true, agentPersona: 'host:ada' });
    expect(String(bubbles[0]?.content), 'not the JSON fallback').not.toContain('no_contribution');
  });

  it('an ordinary EMPTY-STRING agent turn is NOT marked — only the typed shape is', () => {
    // The marker must come from the backend's decision, not from the client guessing
    // at emptiness: a legacy turn (or a turn trimmed elsewhere) is not a refusal to speak.
    const bubbles = turnsToBubbles([turn({ messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'host:ada', content: '', agent: { agentId: 'host:ada' } })]);
    expect(bubbles[0]?.noContribution).toBeUndefined();
  });

  it('omits agentPersona for the default assistant', () => {
    const bubbles = turnsToBubbles([turn({ messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'assistant', content: 'hello' })]);
    expect(bubbles[0]).toEqual({ id: 'c:2:agent', role: 'assistant', content: 'hello' });
  });

  it('passes a multimodal ContentPart[] user turn through VERBATIM (audio player, not a JSON dump)', () => {
    // The "wall of base64" defect: a voice-clip turn stringified into the bubble.
    const parts = [
      { type: 'text', text: 'Testing 1, 2, 3.' },
      { type: 'audio', mimeType: 'audio/webm;codecs=opus', dataBase64: 'GkXfo0==', durationSeconds: 5.6 },
    ];
    const bubbles = turnsToBubbles([turn({ messageId: 'c:1:user', role: 'user', turnIndex: 1, from: 'user', content: parts })]);
    expect(bubbles[0]?.content).toEqual(parts); // the ARRAY, not JSON.stringify(parts)
  });

  it('a MALFORMED array still falls back to the text projection (never a broken renderer)', () => {
    const bubbles = turnsToBubbles([turn({ messageId: 'c:1:user', role: 'user', turnIndex: 1, from: 'user', content: [{ nope: true }] })]);
    expect(typeof bubbles[0]?.content).toBe('string');
  });

  // 2026-07-25 Challenge Factory incident. A run an agent tool ignited mid-turn
  // reaches the client as `{kind:'workflow_run', runId, agentId}`. It used to fall
  // through to the assistant branch, so the feed showed RAW JSON and — because only
  // a workflow_run message carries run state — the Workflow-progress rail read "No
  // workflow runs yet" while the run was genuinely executing.
  it('maps a workflow_run REFERENCE turn to a run-backed bubble, never raw JSON', () => {
    const bubbles = turnsToBubbles([
      turn({
        messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'host:challenge-author',
        content: {
          kind: 'workflow_run', runId: 'run-123', agentId: 'host:challenge-author',
          workflowId: 'openwop-app.kicktodo.challenge-factory', workflowName: 'Challenge Factory',
        },
        agent: { agentId: 'host:challenge-author' },
      }),
    ]);
    expect(bubbles[0]).toEqual({
      id: 'c:2:agent', role: 'workflow_run', content: '',
      runRef: {
        runId: 'run-123', agentId: 'host:challenge-author',
        workflowId: 'openwop-app.kicktodo.challenge-factory', workflowName: 'Challenge Factory',
      },
      agentPersona: 'host:challenge-author',
    });
    expect(JSON.stringify(bubbles[0]?.content)).not.toContain('workflow_run');
  });

  it('a run reference WITHOUT workflow identity still projects (older turns / the ADR 0089 bubble)', () => {
    const bubbles = turnsToBubbles([
      turn({ messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'a:x', content: { kind: 'workflow_run', runId: 'r9' } }),
    ]);
    expect(bubbles[0]?.role).toBe('workflow_run');
    expect(bubbles[0]?.runRef).toEqual({ runId: 'r9' }); // no blank-string keys to render
  });

  it('a workflow_run turn with NO runId degrades to the text projection (nothing to attach to)', () => {
    const bubbles = turnsToBubbles([
      turn({ messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'a:x', content: { kind: 'workflow_run' } }),
    ]);
    expect(bubbles[0]?.role).toBe('assistant');
  });
});

describe('streamDeltaFromEvent — Phase 2 replay-guard', () => {
  it('returns the chunk for a fresh output.chunk (sequence > startSeq)', () => {
    expect(streamDeltaFromEvent({ type: 'output.chunk', sequence: 5, payload: { chunk: 'hi ' } }, 3)).toBe('hi ');
  });
  it('ALSO accepts the two spellings a deploy-skew window can deliver', () => {
    // ADR 0688. Backend and frontend ship separately, so for one window the
    // running backend emits a spelling the loaded SPA was not built for — and
    // what is lost is a live reply's streaming bubble. Both directions:
    // `openwop-app.ai.message-chunk` is what the previous backend emitted,
    // `ai.message.chunk` what the one before that did.
    expect(streamDeltaFromEvent({ type: 'openwop-app.ai.message-chunk', sequence: 5, payload: { chunk: 'a' } }, 3)).toBe('a');
    expect(streamDeltaFromEvent({ type: 'ai.message.chunk', sequence: 5, payload: { chunk: 'b' } }, 3)).toBe('b');
  });
  it('still rejects a type that is NOT a chunk spelling', () => {
    // Non-vacuity: a matcher that accepted everything would pass every leg above.
    expect(streamDeltaFromEvent({ type: 'output.chunked', sequence: 5, payload: { chunk: 'x' } }, 3)).toBeNull();
    expect(streamDeltaFromEvent({ type: 'node.message', sequence: 5, payload: { chunk: 'x' } }, 3)).toBeNull();
  });
  it('ignores a REPLAYED delta from a prior turn (sequence <= startSeq)', () => {
    expect(streamDeltaFromEvent({ type: 'output.chunk', sequence: 3, payload: { chunk: 'old' } }, 3)).toBeNull();
    expect(streamDeltaFromEvent({ type: 'output.chunk', sequence: 1, payload: { chunk: 'older' } }, 3)).toBeNull();
  });
  it('ignores non-chunk events and malformed payloads', () => {
    expect(streamDeltaFromEvent({ type: 'conversation.exchanged', sequence: 9, payload: { turn: {} } }, 0)).toBeNull();
    expect(streamDeltaFromEvent({ type: 'output.chunk', sequence: 9, payload: {} }, 0)).toBeNull();
    expect(streamDeltaFromEvent({ type: 'output.chunk', payload: { chunk: 'no-seq' } }, 0)).toBeNull();
  });
});

describe('exchangeSettleSignal — Phase 3 async settle classification', () => {
  it('returns "agent" for a fresh agent conversation.exchanged turn', () => {
    expect(exchangeSettleSignal({ type: 'conversation.exchanged', sequence: 7, payload: { turn: { role: 'agent' } } }, 3)).toBe('agent');
  });
  it('returns "error" for a fresh openwop-app.ai.message-error', () => {
    expect(exchangeSettleSignal({ type: 'openwop-app.ai.message-error', sequence: 7, payload: { message: 'boom' } }, 3)).toBe('error');
  });
  it('ignores the user-turn echo, deltas, and replayed/older events', () => {
    expect(exchangeSettleSignal({ type: 'conversation.exchanged', sequence: 7, payload: { turn: { role: 'user' } } }, 3)).toBeNull();
    expect(exchangeSettleSignal({ type: 'openwop-app.ai.message-chunk', sequence: 7, payload: { chunk: 'hi' } }, 3)).toBeNull();
    expect(exchangeSettleSignal({ type: 'conversation.exchanged', sequence: 3, payload: { turn: { role: 'agent' } } }, 3)).toBeNull();
    expect(exchangeSettleSignal({ type: 'openwop-app.ai.message-error', payload: {} }, 3)).toBeNull();
  });
  it('extracts the error code + message off the terminal event', () => {
    expect(exchangeErrorPayload({ payload: { code: 'credential_unavailable', message: 'no key' } })).toEqual({ code: 'credential_unavailable', message: 'no key' });
    expect(exchangeErrorPayload({ payload: {} })).toEqual({});
    expect(exchangeErrorPayload({})).toEqual({});
  });
});

describe('recallUsedFromEvent — RCL-UX-1 recall-use marker', () => {
  it('recognizes a live recall_used event and nothing else', () => {
    expect(recallUsedFromEvent({ type: 'openwop-app.conversation.recall-used', sequence: 9 }, 3)).toBe(true);
    // Replay guard: an older event belongs to a prior turn.
    expect(recallUsedFromEvent({ type: 'openwop-app.conversation.recall-used', sequence: 3 }, 3)).toBe(false);
    expect(recallUsedFromEvent({ type: 'openwop-app.conversation.recall-used' }, 3)).toBe(false);
    expect(recallUsedFromEvent({ type: 'openwop-app.ai.message-chunk', sequence: 9 }, 3)).toBe(false);
  });
});

describe('contextDegradedFromEvent — RCL-UX-2/RCL-7 degradation consumption', () => {
  it('extracts the block names from a live context_degraded event', () => {
    expect(contextDegradedFromEvent(
      { type: 'openwop-app.conversation.context-degraded', sequence: 9, payload: { degraded: ['twin_borrowed_recall_partial', 'persona'] } }, 3,
    )).toEqual(['twin_borrowed_recall_partial', 'persona']);
  });
  it('rejects replayed, malformed, and empty ledgers', () => {
    expect(contextDegradedFromEvent({ type: 'openwop-app.conversation.context-degraded', sequence: 3, payload: { degraded: ['persona'] } }, 3)).toBeNull();
    expect(contextDegradedFromEvent({ type: 'openwop-app.conversation.context-degraded', sequence: 9, payload: { degraded: [] } }, 3)).toBeNull();
    expect(contextDegradedFromEvent({ type: 'openwop-app.conversation.context-degraded', sequence: 9, payload: {} }, 3)).toBeNull();
    expect(contextDegradedFromEvent({ type: 'openwop-app.conversation.context-degraded', sequence: 9, payload: { degraded: [42, ''] } }, 3)).toBeNull();
    expect(contextDegradedFromEvent({ type: 'conversation.exchanged', sequence: 9, payload: { degraded: ['persona'] } }, 3)).toBeNull();
  });
});

describe('titledFromEvent — ADR 0151 auto-title', () => {
  it('returns the title for a fresh openwop-app.conversation.titled event', () => {
    expect(titledFromEvent({ type: 'openwop-app.conversation.titled', sequence: 9, payload: { title: 'Refactor Auth' } }, 3)).toBe('Refactor Auth');
  });
  it('ignores other event types, replayed/older events, and empty/malformed titles', () => {
    expect(titledFromEvent({ type: 'openwop-app.ai.message-chunk', sequence: 9, payload: { title: 'x' } }, 3)).toBeNull();
    expect(titledFromEvent({ type: 'openwop-app.conversation.titled', sequence: 3, payload: { title: 'old fold' } }, 3)).toBeNull();
    expect(titledFromEvent({ type: 'openwop-app.conversation.titled', sequence: 9, payload: { title: '' } }, 3)).toBeNull();
    expect(titledFromEvent({ type: 'openwop-app.conversation.titled', sequence: 9, payload: {} }, 3)).toBeNull();
    expect(titledFromEvent({ type: 'openwop-app.conversation.titled', payload: { title: 'no seq' } }, 3)).toBeNull();
  });
});

describe('openConversationSession — waits for the gate before the first turn', () => {
  afterEach(() => { openConversation.mockReset(); listOpenInterrupts.mockReset(); getRun.mockReset(); });

  it('resolves only once the gate interrupt is open (guards the dispatch race)', async () => {
    openConversation.mockResolvedValue({ runId: 'run-1' });
    // First poll: gate not open yet (background dispatch in flight); then it opens.
    listOpenInterrupts
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ interruptId: 'i-gate', nodeId: 'gate', kind: 'conversation' }]);
    getRun.mockResolvedValue({ status: 'running' });

    const { runId, nodeId } = await openConversationSession({});
    expect(runId).toBe('run-1');
    expect(nodeId).toBe('gate');
    expect(listOpenInterrupts.mock.calls.length).toBeGreaterThanOrEqual(2); // it polled, didn't return early
  });

  it('fails fast with a readable error if the run terminates before the gate opens', async () => {
    openConversation.mockResolvedValue({ runId: 'run-2' });
    listOpenInterrupts.mockResolvedValue([]);       // gate never opens
    getRun.mockResolvedValue({ status: 'failed' });  // run died first
    await expect(openConversationSession({})).rejects.toThrow(/could not start \(run failed\)/);
  });
});

describe('toolActivityFromEvent — ADR 0089 Phase 2 tool progress', () => {
  it('maps agent.toolCalled / toolReturned with replay guard', () => {
    expect(toolActivityFromEvent({ type: 'agent.toolCalled', sequence: 5, payload: { callId: 'c1', toolName: 'search', agentId: 'a' } }, 3))
      .toEqual({ kind: 'tool-called', callId: 'c1', toolName: 'search', agentId: 'a' });
    expect(toolActivityFromEvent({ type: 'agent.toolReturned', sequence: 6, payload: { callId: 'c1', toolName: 'search', status: 'ok' } }, 3))
      .toEqual({ kind: 'tool-returned', callId: 'c1', toolName: 'search', status: 'ok' });
    expect(toolActivityFromEvent({ type: 'agent.reasoned', sequence: 4, payload: { agentId: 'a' } }, 3))
      .toEqual({ kind: 'reasoned', agentId: 'a' });
  });
  it('drops replayed (≤ startSeq) and non-tool events', () => {
    expect(toolActivityFromEvent({ type: 'agent.toolCalled', sequence: 3, payload: { callId: 'c1' } }, 3)).toBeNull();
    expect(toolActivityFromEvent({ type: 'openwop-app.ai.message-chunk', sequence: 9, payload: { chunk: 'x' } }, 0)).toBeNull();
    expect(toolActivityFromEvent({ type: 'agent.toolCalled', payload: {} }, 0)).toBeNull();
  });
  it('WFAU-4 / RFC 0064 §E — carries a populated toolReturned.error {code,message} through to the card', () => {
    expect(toolActivityFromEvent({ type: 'agent.toolReturned', sequence: 6, payload: { callId: 'c1', toolName: 'search', status: 'error', error: { code: 'host_capability_disabled', message: "feature 'x' is off" } } }, 3))
      .toEqual({ kind: 'tool-returned', callId: 'c1', toolName: 'search', status: 'error', error: { code: 'host_capability_disabled', message: "feature 'x' is off" } });
  });
  it('WFAU-4 — a gate status (forbidden) carries NO error payload; a malformed error is dropped', () => {
    // Gate case: status only, no error → the card falls back to the status-derived code.
    expect(toolActivityFromEvent({ type: 'agent.toolReturned', sequence: 6, payload: { callId: 'c1', toolName: 'search', status: 'forbidden' } }, 3))
      .toEqual({ kind: 'tool-returned', callId: 'c1', toolName: 'search', status: 'forbidden' });
    // A malformed error (no string code) is not carried — never a broken renderer.
    expect(toolActivityFromEvent({ type: 'agent.toolReturned', sequence: 6, payload: { callId: 'c1', toolName: 'search', status: 'error', error: { message: 'no code' } } }, 3))
      .toEqual({ kind: 'tool-returned', callId: 'c1', toolName: 'search', status: 'error' });
  });
});

/**
 * ADR 0491 gap FE-1 / PROJ-1 — the run-state seeding for a tool-dispatched run.
 *
 * This branch previously lived inside a hook callback reachable only through a
 * full conversation-exchange harness, so it shipped untested: the gap was
 * structural, not an oversight. Extracted as a pure function to close it.
 * A regression here reads as a BLANK-titled bubble frozen at "running" — exactly
 * the symptom the ADR removed.
 */
describe('seedRunState', () => {
  const AT = '2026-07-25T12:00:00.000Z';

  it('prefers the workflow NAME the dispatching tool supplied', () => {
    const s = seedRunState({ runId: 'r1', workflowId: 'wf.x', workflowName: 'Challenge Factory' }, 'Workflow run', AT);
    expect(s.workflowName).toBe('Challenge Factory');
    expect(s.workflowId).toBe('wf.x');
    expect(s.runId).toBe('r1');
    expect(s.status).toBe('running');
  });

  it('falls back to the workflow ID when no name was supplied', () => {
    const s = seedRunState({ runId: 'r1', workflowId: 'wf.x' }, 'Workflow run', AT);
    expect(s.workflowName).toBe('wf.x');
  });

  it('falls back to the translated generic label when neither is supplied', () => {
    // Older turns (and the ADR 0089 deep-investigation bubble) carry neither.
    const s = seedRunState({ runId: 'r1' }, 'Workflow run', AT);
    expect(s.workflowName).toBe('Workflow run');
    expect(s.workflowId).toBe('');
  });

  it('NEVER yields a blank title — the header renders this string directly', () => {
    for (const ref of [
      { runId: 'r1' },
      { runId: 'r1', workflowName: '' },
      { runId: 'r1', workflowId: '' },
      { runId: 'r1', workflowName: '', workflowId: '' },
    ]) {
      expect(seedRunState(ref, 'Workflow run', AT).workflowName).not.toBe('');
    }
  });

  it('FEAT-1 — a client translation WINS over the backend English default', () => {
    // The backend has no locale in a tool scope, so it supplies a display default;
    // a pt-BR user should see the translated header, not the verbatim English name.
    const s = seedRunState({ runId: 'r1', workflowId: 'wf.x', workflowName: 'Plan revision' }, 'Workflow run', AT, 'Revisão do plano');
    expect(s.workflowName).toBe('Revisão do plano');
  });

  it('FEAT-1 — an EMPTY translation falls back to the backend name (no blank header)', () => {
    // i18n returns '' for a missing key via defaultValue, so empty must not win.
    const s = seedRunState({ runId: 'r1', workflowId: 'wf.x', workflowName: 'Plan revision' }, 'Workflow run', AT, '');
    expect(s.workflowName).toBe('Plan revision');
  });

  it('seeds an UNKNOWN node total and no slug (both are designed states, not gaps)', () => {
    const s = seedRunState({ runId: 'r1' }, 'Workflow run', AT);
    // 0 ⇒ the rail renders an indeterminate pulse, not a misleading 0%.
    expect(s.totalNodes).toBe(0);
    // No `/slug` mention exists behind a tool-dispatched run, so the footer omits it.
    expect(s.slug).toBe('');
    expect(s.completedNodeIds).toEqual([]);
    expect(s.startedAt).toBe(AT);
  });
});
