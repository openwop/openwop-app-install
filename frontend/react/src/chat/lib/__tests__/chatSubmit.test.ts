import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drive each precedence branch deterministically by mocking the detectors.
const findCommand = vi.fn();
const detectWorkflowSlashMention = vi.fn();
const detectAgentMention = vi.fn();
vi.mock('../../registry/CommandRegistry.js', () => ({ findCommand: (t: string) => findCommand(t) }));
vi.mock('../workflowMentions.js', () => ({ detectWorkflowSlashMention: (t: string) => detectWorkflowSlashMention(t) }));
vi.mock('../agentMentions.js', () => ({ detectAgentMention: (t: string) => detectAgentMention(t) }));

import { runCoreSubmit, type CoreSubmitContext, type SubmitInterceptor } from '../chatSubmit.js';

const DEFAULT = '__default_assistant__';
function ctx(over: Partial<CoreSubmitContext> = {}): CoreSubmitContext {
  return {
    config: { provider: 'demo', model: 'm', credentialRef: 'r' } as never,
    send: vi.fn(() => Promise.resolve()),
    reset: vi.fn(),
    cancel: vi.fn(() => Promise.resolve()),
    emitSystem: vi.fn(),
    runWorkflowMention: vi.fn(() => Promise.resolve()),
    activeAgents: { activateAgent: vi.fn(() => 'agent-x'), currentAgentId: DEFAULT },
    agentEntries: [],
    ...over,
  };
}

beforeEach(() => {
  findCommand.mockReset().mockReturnValue(null);
  detectWorkflowSlashMention.mockReset().mockReturnValue(null);
  detectAgentMention.mockReset().mockReturnValue(null);
});

describe('runCoreSubmit — precedence', () => {
  it('a consuming /command wins and stops (no send)', async () => {
    const handler = vi.fn(() => Promise.resolve(true)); // consumed
    findCommand.mockReturnValue({ args: 'x', reg: { handler } });
    const c = ctx();
    await runCoreSubmit('/clear', undefined, c);
    expect(handler).toHaveBeenCalledOnce();
    expect(c.send).not.toHaveBeenCalled();
    expect(detectWorkflowSlashMention).not.toHaveBeenCalled();
  });

  it('a /workflow mention dispatches and stops', async () => {
    detectWorkflowSlashMention.mockReturnValue({ entry: { id: 'wf' }, trailing: 'go' });
    const c = ctx();
    await runCoreSubmit('/wf go', undefined, c);
    expect(c.runWorkflowMention).toHaveBeenCalledWith({ id: 'wf' }, 'go');
    expect(c.send).not.toHaveBeenCalled();
  });

  it('an interceptor that returns handled stops before @agent + send', async () => {
    const intercept: SubmitInterceptor = vi.fn(() => Promise.resolve({ kind: 'handled' as const }));
    const c = ctx();
    await runCoreSubmit('@@board', undefined, c, [intercept]);
    expect(intercept).toHaveBeenCalledOnce();
    expect(detectAgentMention).not.toHaveBeenCalled();
    expect(c.send).not.toHaveBeenCalled();
  });

  it('a routing interceptor skips @agent and sends with the routed agent + no fallback', async () => {
    const intercept: SubmitInterceptor = vi.fn(() => Promise.resolve({ kind: 'route' as const, activeAgentId: 'chair', boardSummoned: true }));
    const c = ctx({ activeAgents: { activateAgent: vi.fn(), currentAgentId: 'someone-selected' } });
    await runCoreSubmit('@@board', undefined, c, [intercept]);
    expect(c.activeAgents.activateAgent).not.toHaveBeenCalled(); // @agent skipped
    expect(c.send).toHaveBeenCalledWith('@@board', c.config, expect.objectContaining({ activeAgentId: 'chair' }));
  });

  it('an @agent mention activates, fires onAgentActivated, and sends routed', async () => {
    detectAgentMention.mockReturnValue({ entry: { agentId: 'rev' } });
    const onAgentActivated = vi.fn();
    const c = ctx({ activeAgents: { activateAgent: vi.fn(() => 'rev'), currentAgentId: DEFAULT }, onAgentActivated });
    await runCoreSubmit('@rev hi', undefined, c);
    expect(c.activeAgents.activateAgent).toHaveBeenCalledWith({ agentId: 'rev' });
    expect(onAgentActivated).toHaveBeenCalledWith('rev');
    expect(c.send).toHaveBeenCalledWith('@rev hi', c.config, expect.objectContaining({ activeAgentId: 'rev' }));
  });

  it('plain text sends with the current agent when one is selected, undefined for the default', async () => {
    const selected = ctx({ activeAgents: { activateAgent: vi.fn(), currentAgentId: 'persona-1' } });
    await runCoreSubmit('hello', undefined, selected);
    expect(selected.send).toHaveBeenCalledWith('hello', selected.config, expect.objectContaining({ activeAgentId: 'persona-1' }));

    const def = ctx();
    await runCoreSubmit('hello', undefined, def);
    expect((def.send as ReturnType<typeof vi.fn>).mock.calls[0][2]).not.toHaveProperty('activeAgentId');
  });

  it('attachments short-circuit command/workflow/agent and route straight to send', async () => {
    const c = ctx();
    const attachments = [{ kind: 'image' }] as never;
    await runCoreSubmit('whatever', attachments, c);
    expect(findCommand).not.toHaveBeenCalled();
    expect(detectAgentMention).not.toHaveBeenCalled();
    expect(c.send).toHaveBeenCalledWith('whatever', c.config, expect.objectContaining({ attachments }));
  });

  it('merges baseSendOptions into the send', async () => {
    const c = ctx({ baseSendOptions: () => ({ webSearch: true, tools: ['t'] as never }) });
    await runCoreSubmit('hi', undefined, c);
    expect(c.send).toHaveBeenCalledWith('hi', c.config, expect.objectContaining({ webSearch: true, tools: ['t'] }));
  });
});
