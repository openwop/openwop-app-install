/**
 * ADR 0099 — integration: the tool-result BUILDER → provider dispatcher → model relay.
 *
 * Compaction is applied by the tool-result BUILDER (a node's `onToolUse` return, or the
 * `agentDispatch` loop), NOT inside the provider dispatcher. The dispatcher relays the
 * builder's returned `content` VERBATIM into the model-facing `tool_result`. This pins that
 * contract end-to-end against a real `dispatchAnthropicWithTools` round-trip (fetch mocked):
 * a compacted `onToolUse` return is exactly what reaches the model, and the dispatcher does
 * NOT re-process it (no double compaction).
 *
 * Why this test exists: a review once mistook the dispatcher's lack of an
 * `applyToolResultTransform` call for "tool outputs are uncompacted on this path." They are
 * not — the builder compacts and the dispatcher forwards. This guards that contract so the
 * misread can't recur silently, and so a future change that makes the dispatcher re-derive
 * or drop the builder's content fails loudly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchAnthropicWithTools, type ToolsDispatchRequest } from '../src/providers/dispatchAnthropicTools.js';
import { registerToolResultTransform, applyToolResultTransform, __resetToolResultTransform } from '../src/host/toolResultTransform.js';
import { compactToolOutput } from '../src/features/tool-output-compaction/compact.js';

function mockFetchSequence(bodies: unknown[]): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as Response);
  });
  return { calls };
}

const TOOL: ToolsDispatchRequest['tools'][number] = {
  name: 'search', description: 'Search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
};

// A verbose, pretty-printed payload with structurally-empty fields — lossless compaction
// (minify + drop `""`/`null`/`[]`/`{}`) strictly shrinks it.
const RAW = JSON.stringify({ rows: [{ id: 1, label: 'a', note: '', tags: [] }], meta: {}, summary: null }, null, 2);

beforeEach(() => {
  // The real kernel, registered exactly as the feature wires it (`feature.ts`).
  registerToolResultTransform((content, ctx) => compactToolOutput(content, ctx.decision!));
});
afterEach(() => {
  __resetToolResultTransform();
  vi.unstubAllGlobals();
});

describe('ADR 0099 — compaction reaches the model via the dispatcher relay', () => {
  it('a compacted onToolUse return is the verbatim tool_result the model receives (no double-compaction)', async () => {
    const { calls } = mockFetchSequence([
      { content: [{ type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'x' } }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 2 } },
      { content: [{ type: 'text', text: 'final answer' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } },
    ]);

    let returnedToModel = '';
    const req: ToolsDispatchRequest = {
      provider: 'anthropic', model: 'claude-x', apiKey: 'k',
      messages: [{ role: 'user', content: 'find x' }],
      tools: [TOOL],
      // The BUILDER compacts here (as a node's onToolUse does with ctx.compaction).
      onToolUse: async () => {
        returnedToModel = applyToolResultTransform(RAW, { decision: { mode: 'lossless' }, toolName: 'search' });
        return { toolUseId: 'tu1', content: returnedToModel };
      },
    };

    const result = await dispatchAnthropicWithTools(req);
    expect(result.completion).toBe('final answer');
    expect(calls).toHaveLength(2); // round 1 (tool_use) → execute → round 2 (final)

    // The tool_result the dispatcher sent to the model on round 2:
    const round2 = JSON.parse(calls[1]!.init.body as string) as {
      messages: Array<{ role: string; content: string | Array<{ type: string; content?: string }> }>;
    };
    const toolResult = round2.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === 'tool_result');

    expect(toolResult?.content).toBe(returnedToModel);     // relayed VERBATIM (= the builder's compacted output)
    expect(returnedToModel.length).toBeLessThan(RAW.length); // compaction actually happened
    expect(toolResult?.content).not.toBe(RAW);             // raw verbose output did NOT reach the model
  });

  it('with no decision the builder returns identity — the model receives the raw content unchanged', async () => {
    const { calls } = mockFetchSequence([
      { content: [{ type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'x' } }], stop_reason: 'tool_use', usage: {} },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: {} },
    ]);
    const req: ToolsDispatchRequest = {
      provider: 'anthropic', model: 'claude-x', apiKey: 'k',
      messages: [{ role: 'user', content: 'q' }], tools: [TOOL],
      onToolUse: async () => ({ toolUseId: 'tu1', content: applyToolResultTransform(RAW, {}) }), // no decision ⇒ identity
    };
    await dispatchAnthropicWithTools(req);
    const round2 = JSON.parse(calls[1]!.init.body as string) as { messages: Array<{ content: string | Array<{ type: string; content?: string }> }> };
    const toolResult = round2.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result');
    expect(toolResult?.content).toBe(RAW); // identity preserved end-to-end
  });
});
