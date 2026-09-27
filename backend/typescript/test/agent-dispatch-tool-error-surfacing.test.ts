/**
 * WFAU-4 / RFC 0064 §E — tool-return failure honesty.
 *
 * The locked §E invariant: an `agent.toolReturned` that represents anything
 * other than a successful result MUST carry a failure discriminator — `error`
 * populated (`_errorObject`) plus `status:'error'` (this host advertises
 * `toolHooks.prePostEvents`). A tool-return with `outcome` absent AND `error`
 * absent AND `status ∈ {absent, ok}` MUST NOT represent a failure. `error` and
 * `outcome` stay mutually exclusive; `durationMs` is present iff the tool
 * actually ran (absent for a capability-precondition gate, like the
 * `forbidden`/`rate_limited` gate statuses).
 *
 * This is the WFAU-4 gap made observable: before the fix, an execution failure
 * emitted `status:'error'` with NO `error` payload — a failure a consumer could
 * not distinguish from an empty success — and a validation failure emitted the
 * wire-invalid `status:'invalid_args'` (not an enum member).
 *
 * Pure-unit: drives `runAgentDispatchLive` with injected mocks (no provider, no
 * boot), modelled on `agent-dispatch-tool-loop.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import {
  runAgentDispatchLive,
  type AgentToolDef,
  type LiveDispatchDeps,
} from '../src/host/agentDispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

const SEARCH_TOOL: AgentToolDef = {
  name: 'search',
  description: 'Search the web',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
};

const resolveSearch: LiveDispatchDeps['resolveTool'] = (n) => (n === 'search' ? SEARCH_TOOL : undefined);
const callAINever: LiveDispatchDeps['callAI'] = async () => {
  throw new Error('callAI must not be used on the tool-loop path');
};

/** A two-round model: round 1 calls `search`, round 2 stops. */
function callAICallsThenStops(input: Record<string, unknown>): LiveDispatchDeps['callAIWithTools'] {
  let round = 0;
  return async (_req: AiToolCallRequest): Promise<AiToolCallResult> => {
    round += 1;
    if (round === 1) return { toolCalls: [{ id: 'c1', name: 'search', input }], finishReason: 'tool-call' };
    return { content: 'done', toolCalls: [], finishReason: 'stop' };
  };
}

function register(): void {
  getAgentRegistry().register({
    agentId: 'tool.agent',
    persona: 'Tooler',
    modelClass: 'research',
    systemPrompt: 'Use tools to answer.',
    packName: 'test',
    packVersion: '0',
    toolAllowlist: ['search'],
    confidence: { defaultThreshold: 0.5 },
  });
}

type ReturnedEvent = { type: string; status?: string; error?: { code?: string; message?: string }; durationMs?: number; outcome?: unknown };

function toolReturned(events: readonly unknown[]): ReturnedEvent | undefined {
  return (events as ReturnedEvent[]).find((e) => e.type === 'agent.toolReturned');
}

afterEach(() => getAgentRegistry()._resetForTest());

describe('WFAU-4 — agent.toolReturned failure honesty (RFC 0064 §E)', () => {
  it('a tool that THROWS emits status:error + error{code,message} + durationMs (it ran); outcome absent', async () => {
    register();
    const executeTool: LiveDispatchDeps['executeTool'] = async () => {
      throw new Error('downstream 500');
    };
    const res = await runAgentDispatchLive(
      { agentId: 'tool.agent', task: 't', availableTools: ['search'] },
      { callAI: callAINever, callAIWithTools: callAICallsThenStops({ query: 'x' }), executeTool, resolveTool: resolveSearch },
    );
    const ret = toolReturned(res.events);
    expect(ret?.status).toBe('error');
    expect(ret?.error?.code).toBe('tool_execution_failed');
    expect(ret?.error?.message).toContain('downstream 500');
    // The tool actually ran → duration recorded.
    expect(typeof ret?.durationMs).toBe('number');
    // error ⊥ outcome — this host never sets `outcome` on a tool-return.
    expect(ret?.outcome).toBeUndefined();
    // NOTE: a THROWING executeTool exercises the dispatcher's OWN defensive catch.
    // The production provider (createAgentToolProvider) does NOT throw — it catches
    // internally and RETURNS `{ content, isError, errorCode }`; those (real-shape)
    // cases are the capability tests below. See agent-tool-provider.test.ts for the
    // provider-level witness that a thrown code survives as `errorCode`.
  });

  it('a tool that RETURNS isError emits status:error + error{code:tool_execution_failed} + durationMs', async () => {
    register();
    const executeTool: LiveDispatchDeps['executeTool'] = async () => ({ content: 'the tool said no', isError: true });
    const res = await runAgentDispatchLive(
      { agentId: 'tool.agent', task: 't', availableTools: ['search'] },
      { callAI: callAINever, callAIWithTools: callAICallsThenStops({ query: 'x' }), executeTool, resolveTool: resolveSearch },
    );
    const ret = toolReturned(res.events);
    expect(ret?.status).toBe('error');
    expect(ret?.error?.code).toBe('tool_execution_failed');
    expect(ret?.error?.message).toContain('the tool said no');
    expect(typeof ret?.durationMs).toBe('number');
    expect(ret?.outcome).toBeUndefined();
  });

  it('a CAPABILITY-DISABLED tool (host_capability_disabled) — REAL provider shape: returned {isError,errorCode} — emits that error.code, durationMs ABSENT (never ran)', async () => {
    register();
    // The production provider (createAgentToolProvider) catches the featureSurfaces
    // gate throw and RETURNS this shape — code carried on `errorCode`, NOT thrown.
    // (Using a throwing mock here would hide that the real provider never throws —
    // the exact defect the adversarial review caught.)
    const executeTool: LiveDispatchDeps['executeTool'] = async () => ({
      content: "tool_failed: feature 'x' is not enabled for this tenant",
      isError: true,
      errorCode: 'host_capability_disabled',
    });
    const res = await runAgentDispatchLive(
      { agentId: 'tool.agent', task: 't', availableTools: ['search'] },
      { callAI: callAINever, callAIWithTools: callAICallsThenStops({ query: 'x' }), executeTool, resolveTool: resolveSearch },
    );
    const ret = toolReturned(res.events);
    expect(ret?.status).toBe('error');
    expect(ret?.error?.code).toBe('host_capability_disabled');
    // A capability-precondition gate never ran → no durationMs (like forbidden/rate_limited).
    expect(ret?.durationMs).toBeUndefined();
    expect(ret?.outcome).toBeUndefined();
  });

  it('host_capability_missing CONTENT-DERIVED (a node stringified {code} into content, no errorCode) — code parsed, durationMs ABSENT', async () => {
    register();
    // The node-run tool returns a structured failure as JSON content (no errorCode).
    const executeTool: LiveDispatchDeps['executeTool'] = async () => ({
      content: JSON.stringify({ code: 'host_capability_missing', message: 'host does not expose ctx.webResearch' }),
      isError: true,
    });
    const res = await runAgentDispatchLive(
      { agentId: 'tool.agent', task: 't', availableTools: ['search'] },
      { callAI: callAINever, callAIWithTools: callAICallsThenStops({ query: 'x' }), executeTool, resolveTool: resolveSearch },
    );
    const ret = toolReturned(res.events);
    expect(ret?.status).toBe('error');
    expect(ret?.error?.code).toBe('host_capability_missing');
    expect(ret?.durationMs).toBeUndefined();
  });

  it('a CONTENT-DERIVED non-capability code (validation_error) — code parsed, durationMs PRESENT (the tool ran and returned)', async () => {
    register();
    const executeTool: LiveDispatchDeps['executeTool'] = async () => ({
      content: JSON.stringify({ error: 'validation_error', message: '`names` is required' }),
      isError: true,
    });
    const res = await runAgentDispatchLive(
      { agentId: 'tool.agent', task: 't', availableTools: ['search'] },
      { callAI: callAINever, callAIWithTools: callAICallsThenStops({ query: 'x' }), executeTool, resolveTool: resolveSearch },
    );
    const ret = toolReturned(res.events);
    expect(ret?.status).toBe('error');
    expect(ret?.error?.code).toBe('validation_error');
    // It RAN and returned a structured error → duration recorded.
    expect(typeof ret?.durationMs).toBe('number');
  });

  it('SR-1: a secret-shaped substring in the error message is redacted in the recorded event', async () => {
    register();
    const executeTool: LiveDispatchDeps['executeTool'] = async () => {
      throw new Error('upstream rejected key sk-livesecret0123456789 for this call');
    };
    const res = await runAgentDispatchLive(
      { agentId: 'tool.agent', task: 't', availableTools: ['search'] },
      { callAI: callAINever, callAIWithTools: callAICallsThenStops({ query: 'x' }), executeTool, resolveTool: resolveSearch },
    );
    const ret = toolReturned(res.events);
    expect(ret?.error?.message).toContain('[REDACTED:secret-shaped]');
    expect(ret?.error?.message).not.toContain('sk-livesecret0123456789');
  });

  it('a validation failure emits status:error + error.code:invalid_args, durationMs ABSENT (never ran)', async () => {
    register();
    const executeTool: LiveDispatchDeps['executeTool'] = async () => ({ content: 'unreached' });
    const res = await runAgentDispatchLive(
      // `query` must be a string; supply the wrong shape so pre-exec validation fails.
      { agentId: 'tool.agent', task: 't', availableTools: ['search'] },
      { callAI: callAINever, callAIWithTools: callAICallsThenStops({ query: 42 }), executeTool, resolveTool: resolveSearch },
    );
    const ret = toolReturned(res.events);
    expect(ret?.status).toBe('error');
    expect(ret?.error?.code).toBe('invalid_args');
    expect(ret?.durationMs).toBeUndefined();
    // No paired toolCalled for a rejected-before-exec call.
    expect((res.events as { type: string }[]).some((e) => e.type === 'agent.toolCalled')).toBe(false);
  });

  it('error ⊥ outcome across a failing run — no toolReturned carries BOTH', async () => {
    register();
    const executeTool: LiveDispatchDeps['executeTool'] = async () => {
      throw new Error('boom');
    };
    const res = await runAgentDispatchLive(
      { agentId: 'tool.agent', task: 't', availableTools: ['search'] },
      { callAI: callAINever, callAIWithTools: callAICallsThenStops({ query: 'x' }), executeTool, resolveTool: resolveSearch },
    );
    const returns = (res.events as ReturnedEvent[]).filter((e) => e.type === 'agent.toolReturned');
    expect(returns.length).toBeGreaterThan(0);
    for (const r of returns) {
      const hasError = r.error !== undefined;
      const hasOutcome = r.outcome !== undefined;
      expect(hasError && hasOutcome).toBe(false);
    }
  });
});
