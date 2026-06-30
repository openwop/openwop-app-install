/**
 * ADR 0099 §residuals — runAgentDispatchLive honors `req.compaction` at the
 * manifest-dispatch tool-result boundary (the runless /agents/:id/dispatch path).
 *
 * This closes the /code-review MEDIUM: the route's RESOLUTION (toggle →
 * req.compaction) is unit-tested in tool-output-compaction-residuals.test.ts;
 * here we prove the dispatch LOOP actually compacts the tool result before it
 * re-enters the model context on the next round. Drives runAgentDispatchLive
 * with injected mocks (no real provider) — the same pattern as
 * agent-dispatch-tool-loop.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { runAgentDispatchLive, type AgentToolDef, type LiveDispatchDeps } from '../src/host/agentDispatch.js';
import type { AiToolCallRequest, AiToolCallResult, CompactionDecision } from '../src/executor/types.js';
import {
  registerToolResultTransform,
  __resetToolResultTransform,
} from '../src/host/toolResultTransform.js';
import { compactToolOutput } from '../src/features/tool-output-compaction/compact.js';
import { fenceUntrustedBlock } from '../src/host/untrustedContent.js';

/** The tool result re-enters the loop fenced as untrusted (RFC 0021), so the
 *  byte-exact "raw" baseline is the FENCED raw content — compaction happens
 *  inside the fence. */
const fencedRaw = (inner: string) => `Result of list: ${fenceUntrustedBlock(inner, 'tool list')}`;

const LIST_TOOL: AgentToolDef = {
  name: 'list',
  description: 'List records',
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
};
const resolveList: LiveDispatchDeps['resolveTool'] = (n) => (n === 'list' ? LIST_TOOL : undefined);
const callAINever: LiveDispatchDeps['callAI'] = async () => {
  throw new Error('callAI must not be used on the tool-loop path');
};

/** A verbose, empty-field-heavy tool result — compacts well, losslessly. */
const VERBOSE = JSON.stringify({ items: [{ id: 1, tags: [], note: null }, { id: 2, tags: [], note: '' }] }, null, 2);

function register(): void {
  getAgentRegistry().register({
    agentId: 'comp.agent',
    persona: 'Lister',
    modelClass: 'research',
    systemPrompt: 'Use tools.',
    packName: 'test',
    packVersion: '0',
    toolAllowlist: ['list'],
    confidence: { defaultThreshold: 0.5 },
  });
}

/** Run a 2-round tool loop; return the tool-result message the 2nd round saw. */
async function runAndCaptureToolResult(compaction: CompactionDecision | undefined): Promise<string> {
  register();
  let round = 0;
  let secondRoundMessages: AiToolCallRequest['messages'] = [];
  const callAIWithTools = async (req: AiToolCallRequest): Promise<AiToolCallResult> => {
    round += 1;
    if (round === 1) return { toolCalls: [{ id: 'c1', name: 'list', input: {} }], finishReason: 'tool-call' };
    secondRoundMessages = req.messages;
    return { content: 'done', toolCalls: [], finishReason: 'stop' };
  };
  const executeTool: LiveDispatchDeps['executeTool'] = async () => ({ content: VERBOSE });
  await runAgentDispatchLive(
    { agentId: 'comp.agent', task: 't', availableTools: ['list'], ...(compaction ? { compaction } : {}) },
    { callAI: callAINever, callAIWithTools, executeTool, resolveTool: resolveList },
  );
  const toolMsg = secondRoundMessages.find((m) => typeof m.content === 'string' && m.content.startsWith('Result of list:'));
  return typeof toolMsg?.content === 'string' ? toolMsg.content : '';
}

beforeEach(() => {
  registerToolResultTransform((content, ctx) => (ctx.decision ? compactToolOutput(content, ctx.decision) : content));
});
afterEach(() => {
  getAgentRegistry()._resetForTest();
  __resetToolResultTransform();
});

describe('runAgentDispatchLive — req.compaction at the tool-result boundary', () => {
  it('compacts the tool result when req.compaction is lossless', async () => {
    const msg = await runAndCaptureToolResult({ mode: 'lossless' });
    expect(msg).toContain('Result of list:');
    expect(msg).toContain('BEGIN UNTRUSTED CONTENT'); // fenced as untrusted (RFC 0021)
    expect(msg).not.toContain('"tags"'); // empty field dropped
    expect(msg.length).toBeLessThan(fencedRaw(VERBOSE).length); // compaction shrinks inside the fence
  });

  it('leaves the tool result raw when no compaction decision is supplied', async () => {
    const msg = await runAndCaptureToolResult(undefined);
    expect(msg).toBe(fencedRaw(VERBOSE));
    expect(msg).toContain('"tags"');
  });

  it('honors a per-tool exemption (byte-exact) even with a live decision', async () => {
    const msg = await runAndCaptureToolResult({ mode: 'lossless', exemptTools: ['list'] });
    expect(msg).toBe(fencedRaw(VERBOSE));
  });

  it('mode "off" leaves the tool result raw', async () => {
    const msg = await runAndCaptureToolResult({ mode: 'off' });
    expect(msg).toBe(fencedRaw(VERBOSE));
  });
});
