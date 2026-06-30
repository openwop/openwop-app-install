/**
 * Per-tool read/write permission gate (ADR 0101 Phase 4 / ADR 0102).
 *
 * Covers the pure evaluator (`evaluateToolPermission`) and its wiring into the
 * shared live tool loop (`runChatToolLoop`) behind the env flag: a tool off an
 * opted-in agent's allowlist is refused before it executes when the gate is on,
 * and unaffected when it's off.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { evaluateToolPermission } from '../src/host/agentToolPermissions.js';
import { runChatToolLoop, type CompiledTool } from '../src/host/agentDispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

function tool(name: string): CompiledTool {
  return {
    def: { name, description: `${name} tool`, inputSchema: { type: 'object' } },
    validate: () => ({ ok: true }),
  };
}

describe('evaluateToolPermission (pure, ADR 0102)', () => {
  it('is ungated with no permissions / no positive allowlist', () => {
    expect(evaluateToolPermission('crm.field.update', null)).toEqual({ allowed: true, reason: 'ungated' });
    expect(evaluateToolPermission('crm.field.update', {})).toEqual({ allowed: true, reason: 'ungated' });
    // `never` only, empty allowlist: a non-never tool is still ungated (opt-in).
    expect(evaluateToolPermission('crm.read', { never: ['email.send'] })).toEqual({ allowed: true, reason: 'ungated' });
  });

  it('hard-denies a `never` match (exact + namespace prefix), short-circuiting', () => {
    expect(evaluateToolPermission('email.send', { never: ['email.send'], write: ['email.send'] })).toEqual({ allowed: false, reason: 'never' });
    // namespace token covers the dotted child
    expect(evaluateToolPermission('payment.release.batch', { never: ['payment'] })).toEqual({ allowed: false, reason: 'never' });
  });

  it('fail-closes an off-allowlist tool once a positive allowlist is declared', () => {
    const perms = { read: ['crm.read'], write: ['kanban.card.write'] };
    expect(evaluateToolPermission('crm.read', perms)).toEqual({ allowed: true, reason: 'allowlisted' });
    expect(evaluateToolPermission('kanban.card.write', perms)).toEqual({ allowed: true, reason: 'allowlisted' });
    expect(evaluateToolPermission('crm.field.delete', perms)).toEqual({ allowed: false, reason: 'not-allowlisted' });
  });

  it('matches a namespace token as a dotted prefix, not across a non-dot boundary', () => {
    expect(evaluateToolPermission('crm.field.update', { write: ['crm'] })).toEqual({ allowed: true, reason: 'allowlisted' });
    // `crm` must NOT match `crmx.foo` (no dot boundary)
    expect(evaluateToolPermission('crmx.foo', { write: ['crm'] })).toEqual({ allowed: false, reason: 'not-allowlisted' });
  });
});

describe('runChatToolLoop — per-tool permission gate wiring (ADR 0102)', () => {
  const FLAG = 'OPENWOP_AGENT_TOOL_PERMISSIONS_ENABLED';
  afterEach(() => { delete process.env[FLAG]; });

  // A model that calls an off-allowlist tool once, then answers.
  function mockProvider(toolName: string): (req: AiToolCallRequest) => Promise<AiToolCallResult> {
    let round = 0;
    return async () => {
      round += 1;
      if (round === 1) return { toolCalls: [{ id: 'c1', name: toolName, input: {} }], finishReason: 'tool-call' };
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    };
  }

  const perms = { read: ['crm.read'], write: ['kanban.card.write'], never: [] };

  it('blocks an off-allowlist tool (forbidden, not executed) when the flag is ON', async () => {
    process.env[FLAG] = 'true';
    const executed: string[] = [];
    const res = await runChatToolLoop(
      {
        provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp',
        messages: [{ role: 'user', content: 'go' }], tools: [tool('crm.field.delete')],
        agentId: 'a', persona: 'P', toolPermissions: perms,
      },
      { callAIWithTools: mockProvider('crm.field.delete'), executeTool: async (c) => { executed.push(c.name); return { content: 'x' }; } },
    );
    expect(executed).toEqual([]); // the tool never ran
    const forbidden = res.events.find((e) => e.type === 'agent.toolReturned' && (e as { status?: string }).status === 'forbidden');
    expect(forbidden).toBeTruthy();
  });

  it('lets the same call through when the flag is OFF (unchanged behavior)', async () => {
    const executed: string[] = [];
    const res = await runChatToolLoop(
      {
        provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp',
        messages: [{ role: 'user', content: 'go' }], tools: [tool('crm.field.delete')],
        agentId: 'a', persona: 'P', toolPermissions: perms,
      },
      { callAIWithTools: mockProvider('crm.field.delete'), executeTool: async (c) => { executed.push(c.name); return { content: 'x' }; } },
    );
    expect(executed).toEqual(['crm.field.delete']); // ran — gate is off
    expect(res.events.some((e) => e.type === 'agent.toolReturned' && (e as { status?: string }).status === 'ok')).toBe(true);
  });

  it('lets an allowlisted tool through even when the flag is ON', async () => {
    process.env[FLAG] = 'true';
    const executed: string[] = [];
    await runChatToolLoop(
      {
        provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp',
        messages: [{ role: 'user', content: 'go' }], tools: [tool('crm.read')],
        agentId: 'a', persona: 'P', toolPermissions: perms,
      },
      { callAIWithTools: mockProvider('crm.read'), executeTool: async (c) => { executed.push(c.name); return { content: 'x' }; } },
    );
    expect(executed).toEqual(['crm.read']);
  });
});

// ADR 0104 OQ#4 — the override (which tools are OFFERED at dispatch, modeled by the
// `tools` array) and the ADR 0102 permission gate (ENTITLEMENT) are orthogonal:
// a call must pass BOTH to execute. These pin that composition.
describe('runChatToolLoop — ADR 0104 offering × ADR 0102 entitlement compose orthogonally (ATOOL-3)', () => {
  const FLAG = 'OPENWOP_AGENT_TOOL_PERMISSIONS_ENABLED';
  afterEach(() => { delete process.env[FLAG]; });

  function callsThen(toolName: string): (req: AiToolCallRequest) => Promise<AiToolCallResult> {
    let round = 0;
    return async () => {
      round += 1;
      if (round === 1) return { toolCalls: [{ id: 'c1', name: toolName, input: {} }], finishReason: 'tool-call' };
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    };
  }

  it('offered-but-not-entitled → blocked by the entitlement gate', async () => {
    process.env[FLAG] = 'true';
    const executed: string[] = [];
    // The override OFFERS crm.field.delete (present in `tools`), but permissions
    // do NOT entitle it → the permission gate is the binding constraint.
    const res = await runChatToolLoop(
      {
        provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp',
        messages: [{ role: 'user', content: 'go' }], tools: [tool('crm.field.delete')],
        agentId: 'a', persona: 'P', toolPermissions: { read: ['crm.read'], write: [], never: [] },
      },
      { callAIWithTools: callsThen('crm.field.delete'), executeTool: async (c) => { executed.push(c.name); return { content: 'x' }; } },
    );
    expect(executed).toEqual([]);
    expect(res.events.some((e) => e.type === 'agent.toolReturned' && (e as { status?: string }).status === 'forbidden')).toBe(true);
  });

  it('entitled-but-not-offered → refused by the offering layer (§A14)', async () => {
    process.env[FLAG] = 'true';
    const executed: string[] = [];
    // Permissions ENTITLE crm.field.delete, but the override does NOT offer it
    // (absent from `tools`) → refused at the manifest layer; offering is binding.
    const res = await runChatToolLoop(
      {
        provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp',
        messages: [{ role: 'user', content: 'go' }], tools: [tool('crm.read')],
        agentId: 'a', persona: 'P', toolPermissions: { read: ['crm.read', 'crm.field.delete'], write: [], never: [] },
      },
      { callAIWithTools: callsThen('crm.field.delete'), executeTool: async (c) => { executed.push(c.name); return { content: 'x' }; } },
    );
    expect(executed).toEqual([]);
    expect(res.events.some((e) => e.type === 'agent.toolReturned' && (e as { status?: string }).status === 'forbidden')).toBe(true);
  });
});
