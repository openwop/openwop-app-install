/**
 * ADR 0035 / RFC 0100 — durable / async A2A Tasks.
 *
 * Exercises the durable leg the RFC adds over the synchronous round-trip:
 *  - message/send PERSISTS an A2ATaskState (taskId == runId).
 *  - tasks/get returns the persisted Task with the correctly projected state
 *    (after a "disconnect" — no connection held).
 *  - the state advances as the run progresses (submitted/working → terminal /
 *    input-required).
 *  - tasks/resubscribe re-attaches the update stream without re-executing.
 *  - a push fires on the terminal/blocking transitions; an SSRF push URL is
 *    refused.
 *  - back-compat: with durableTasks off, tasks/get is still not-found.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { handleA2aRequest, type A2aJsonRpcRequest } from '../src/host/a2aServer.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  __resetA2aTaskStore,
  getA2aTask,
  setA2aPushSink,
  projectRunStatusToTaskState,
  assertPushUrlAllowed,
  A2aPushUrlDeniedError,
} from '../src/host/a2aTaskStore.js';

const CARD = { name: 'Sample Host', url: 'https://example.com/a2a', skills: [] };

function send(method: string, params?: Record<string, unknown>): A2aJsonRpcRequest {
  return { jsonrpc: '2.0', id: 1, method, params };
}

/** A normal, completing peer agent (high confidence ⇒ dispatch `completed`). */
function registerCompletingAgent(id = 'peer.agent'): void {
  getAgentRegistry().register({
    agentId: id,
    persona: 'Peer',
    modelClass: 'general',
    systemPrompt: 'Respond.',
    packName: 'test',
    packVersion: '0',
    toolAllowlist: [],
    confidence: { defaultThreshold: 0.5 },
  });
}

/** An agent whose default confidence (0.9) is BELOW its threshold (0.99) ⇒
 *  dispatch `escalated` ⇒ a durable `input-required` (HITL-style block). */
function registerEscalatingAgent(id = 'peer.escalate'): void {
  getAgentRegistry().register({
    agentId: id,
    persona: 'Escalator',
    modelClass: 'general',
    systemPrompt: 'Respond.',
    packName: 'test',
    packVersion: '0',
    toolAllowlist: [],
    confidence: { defaultThreshold: 0.99 },
  });
}

beforeAll(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

beforeEach(async () => {
  await __resetA2aTaskStore();
  setA2aPushSink(null);
});

afterEach(() => {
  getAgentRegistry()._resetForTest();
  setA2aPushSink(null);
});

const DURABLE = { agentCard: CARD, durableTasks: true } as const;

describe('ADR 0035 / RFC 0100 — durable A2A Tasks', () => {
  it('message/send persists an A2ATaskState (taskId == runId)', async () => {
    registerCompletingAgent();
    await handleA2aRequest(
      send('message/send', { agentId: 'peer.agent', message: { parts: [{ kind: 'text', text: 'hi' }] }, contextId: 'ctx_abc' }),
      DURABLE,
    );
    const rec = await getA2aTask('a2a:peer.agent');
    expect(rec).not.toBeNull();
    expect(rec?.taskId).toBe('a2a:peer.agent');
    expect(rec?.runId).toBe(rec?.taskId); // 1:1 binding (a2a-integration.md §2)
    expect(rec?.contextId).toBe('ctx_abc');
    expect(typeof rec?.updatedAt).toBe('string');
  });

  it('tasks/get returns the persisted Task with the projected state after disconnect', async () => {
    registerCompletingAgent();
    // "Send + disconnect": we discard the message/send response and query later.
    await handleA2aRequest(send('message/send', { agentId: 'peer.agent', message: { parts: [{ text: 'go' }] } }), DURABLE);

    const res = await handleA2aRequest(send('tasks/get', { id: 'a2a:peer.agent' }), DURABLE);
    const task = res.result as { kind: string; id: string; status: { state: string } };
    expect(task.kind).toBe('task');
    expect(task.id).toBe('a2a:peer.agent');
    expect(task.status.state).toBe('completed'); // the live projected state, not absent
  });

  it('projects an escalation to a durable input-required with interrupt metadata', async () => {
    registerEscalatingAgent();
    await handleA2aRequest(send('message/send', { agentId: 'peer.escalate', message: { parts: [{ text: 'help' }] } }), DURABLE);

    const rec = await getA2aTask('a2a:peer.escalate');
    expect(rec?.state).toBe('input-required');
    expect(rec?.interruptKind).toBe('clarification');

    const res = await handleA2aRequest(send('tasks/get', { id: 'a2a:peer.escalate' }), DURABLE);
    const task = res.result as { status: { state: string }; metadata?: { openwop?: { interrupt?: { kind?: string } } } };
    expect(task.status.state).toBe('input-required');
    expect(task.metadata?.openwop?.interrupt?.kind).toBe('clarification');
  });

  it('advances the state as the run progresses (input-required → completed on resume)', async () => {
    // Open the task escalated (input-required), then "resume" by re-sending into
    // the SAME taskId against a now-completing agent — the durable state advances.
    registerEscalatingAgent('peer.x');
    await handleA2aRequest(send('message/send', { agentId: 'peer.x', message: { parts: [{ text: 'a' }] } }), DURABLE);
    expect((await getA2aTask('a2a:peer.x'))?.state).toBe('input-required');

    getAgentRegistry()._resetForTest();
    registerCompletingAgent('peer.x'); // same id, now clears its threshold
    await handleA2aRequest(
      send('message/send', { agentId: 'peer.x', message: { parts: [{ text: 'approve' }] }, id: 'a2a:peer.x' }),
      DURABLE,
    );
    expect((await getA2aTask('a2a:peer.x'))?.state).toBe('completed');
  });

  it('tasks/resubscribe re-attaches the stream (read-only) without re-executing', async () => {
    registerCompletingAgent();
    await handleA2aRequest(send('message/send', { agentId: 'peer.agent', message: { parts: [{ text: 'go' }] } }), DURABLE);
    const before = await getA2aTask('a2a:peer.agent');

    const res = await handleA2aRequest(send('tasks/resubscribe', { id: 'a2a:peer.agent' }), DURABLE);
    const evt = res.result as { kind: string; taskId: string; status: { state: string }; final: boolean };
    expect(evt.kind).toBe('status-update');
    expect(evt.taskId).toBe('a2a:peer.agent');
    expect(evt.status.state).toBe('completed');
    expect(evt.final).toBe(true); // terminal ⇒ final

    // Read-only: the backing runId is unchanged and no re-execution occurred.
    const after = await getA2aTask('a2a:peer.agent');
    expect(after?.runId).toBe(before?.runId);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it('tasks/resubscribe + tasks/get are not-found for an unknown task', async () => {
    expect((await handleA2aRequest(send('tasks/get', { id: 'a2a:nope' }), DURABLE)).error?.code).toBe(-32001);
    expect((await handleA2aRequest(send('tasks/resubscribe', { id: 'a2a:nope' }), DURABLE)).error?.code).toBe(-32001);
  });

  it('registers a push-config and fires a push on the terminal transition', async () => {
    registerCompletingAgent();
    const pushed: Array<{ url: string; state: string }> = [];
    setA2aPushSink((cfg, evt) => {
      pushed.push({ url: cfg.url, state: (evt.status as { state: string }).state });
    });

    await handleA2aRequest(send('message/send', { agentId: 'peer.agent', message: { parts: [{ text: 'go' }] } }), DURABLE);
    const set = await handleA2aRequest(
      send('tasks/pushNotificationConfig/set', {
        id: 'a2a:peer.agent',
        pushNotificationConfig: { url: 'https://hooks.example.com/push' },
      }),
      DURABLE,
    );
    expect(set.error).toBeUndefined();
    // Drive a transition (re-send → completed) so the registered push fires.
    await handleA2aRequest(send('message/send', { agentId: 'peer.agent', message: { parts: [{ text: 'again' }] }, id: 'a2a:peer.agent' }), DURABLE);
    expect(pushed.some((p) => p.url === 'https://hooks.example.com/push' && p.state === 'completed')).toBe(true);
  });

  it('refuses an SSRF push URL (RFC 0093 egress guard)', async () => {
    registerCompletingAgent();
    await handleA2aRequest(send('message/send', { agentId: 'peer.agent', message: { parts: [{ text: 'go' }] } }), DURABLE);
    const res = await handleA2aRequest(
      send('tasks/pushNotificationConfig/set', {
        id: 'a2a:peer.agent',
        pushNotificationConfig: { url: 'http://10.0.0.5/push' },
      }),
      DURABLE,
    );
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain('private');
    // The push config was NOT persisted.
    expect((await getA2aTask('a2a:peer.agent'))?.pushConfig).toBeUndefined();
  });

  it('back-compat: with durableTasks off, tasks/get is not-found and nothing persists', async () => {
    registerCompletingAgent();
    const res = await handleA2aRequest(send('message/send', { agentId: 'peer.agent', message: { parts: [{ text: 'go' }] } }), { agentCard: CARD });
    expect((res.result as { status: { state: string } }).status.state).toBe('completed');
    expect((await getA2aTask('a2a:peer.agent'))).toBeNull(); // no durable record
    expect((await handleA2aRequest(send('tasks/get', { id: 'a2a:peer.agent' }), { agentCard: CARD })).error?.code).toBe(-32001);
  });
});

describe('ADR 0035 / RFC 0100 — projection + SSRF unit checks', () => {
  it('projects run.status → TaskState per the a2a-integration.md FINAL table', () => {
    expect(projectRunStatusToTaskState('pending').state).toBe('submitted');
    expect(projectRunStatusToTaskState('running').state).toBe('working');
    expect(projectRunStatusToTaskState('paused').state).toBe('working'); // drift #1
    expect(projectRunStatusToTaskState('waiting-approval')).toEqual({ state: 'input-required', interruptKind: 'approval' });
    expect(projectRunStatusToTaskState('waiting-input')).toEqual({ state: 'input-required', interruptKind: 'clarification' });
    expect(projectRunStatusToTaskState('completed').state).toBe('completed');
    expect(projectRunStatusToTaskState('failed').state).toBe('failed');
    expect(projectRunStatusToTaskState('cancelled').state).toBe('canceled'); // spelling drift
  });

  it('assertPushUrlAllowed accepts public https and rejects private/loopback/non-http', () => {
    expect(() => assertPushUrlAllowed('https://hooks.example.com/x')).not.toThrow();
    expect(() => assertPushUrlAllowed('http://127.0.0.1/x')).toThrow(A2aPushUrlDeniedError);
    expect(() => assertPushUrlAllowed('http://10.0.0.5/x')).toThrow(A2aPushUrlDeniedError);
    expect(() => assertPushUrlAllowed('http://localhost/x')).toThrow(A2aPushUrlDeniedError);
    expect(() => assertPushUrlAllowed('http://169.254.169.254/latest')).toThrow(A2aPushUrlDeniedError);
    expect(() => assertPushUrlAllowed('file:///etc/passwd')).toThrow(A2aPushUrlDeniedError);
    expect(() => assertPushUrlAllowed('not a url')).toThrow(A2aPushUrlDeniedError);
  });
});
