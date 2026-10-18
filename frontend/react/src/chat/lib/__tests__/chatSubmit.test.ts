/**
 * runCoreSubmit — the ONE submit precedence chain every chat surface shares
 * (ADR 0140 G1): built-in `/command` → `/workflow` (optionally `@agent /workflow`,
 * ADR 0764) → caller interceptors (`@@` convene/board) → `@agent` → send.
 * Breaks it: a workflow shadowing `/clear`, an `@@board` read as `@board`, a
 * board summon falling back to a previously selected agent, or (ADR 0768 D1) an
 * attachment turn silently switching agents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { findCommand as FindCommand, CommandRegistration } from '../../registry/CommandRegistry.js';
import type { detectWorkflowSlashMention as DetectSlash, WorkflowMentionEntry } from '../workflowMentions.js';
import type { detectAgentMention as DetectAgent, AgentMentionEntry } from '../agentMentions.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';
import type { ContentPart } from '../../types.js';

// Drive each precedence branch deterministically by mocking the detectors. Every
// argument is forwarded, so a call with the wrong agent list is visible.
const findCommand = vi.fn<typeof FindCommand>();
const detectWorkflowSlashMention = vi.fn<typeof DetectSlash>();
const detectAgentMention = vi.fn<typeof DetectAgent>();
vi.mock('../../registry/CommandRegistry.js', () => ({ findCommand: (...a: Parameters<typeof FindCommand>) => findCommand(...a) }));
vi.mock('../workflowMentions.js', () => ({ detectWorkflowSlashMention: (...a: Parameters<typeof DetectSlash>) => detectWorkflowSlashMention(...a) }));
vi.mock('../agentMentions.js', () => ({ detectAgentMention: (...a: Parameters<typeof DetectAgent>) => detectAgentMention(...a) }));

import { runCoreSubmit, type CoreSubmitContext, type SubmitInterceptor } from '../chatSubmit.js';

const DEFAULT = '__default_assistant__';
const CONFIG: BYOKActiveConfig = { provider: 'anthropic', model: 'm', credentialRef: 'r' };

function wf(id: string): WorkflowMentionEntry {
  return { displayName: id, slug: id, description: '', toolName: `wf_${id}`, workflowId: id };
}
function agentEntry(slug: string, agentId: string): AgentMentionEntry {
  return { displayName: slug, persona: slug, slug, description: '', agentId, packName: 'p', packVersion: '1.0.0', modelClass: 'chat' };
}

function ctx(over: Partial<CoreSubmitContext> = {}): CoreSubmitContext {
  return {
    config: CONFIG,
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

/** The third (options) argument of the single `send` call. */
function sendOpts(c: CoreSubmitContext): unknown {
  const send = vi.mocked(c.send);
  expect(send).toHaveBeenCalledOnce();
  return send.mock.calls[0]![2];
}

beforeEach(() => {
  findCommand.mockReset().mockReturnValue(null);
  detectWorkflowSlashMention.mockReset().mockReturnValue(null);
  detectAgentMention.mockReset().mockReturnValue(null);
});

describe('runCoreSubmit — precedence', () => {
  it('a consuming /command wins and stops (no send)', async () => {
    const handler = vi.fn(() => Promise.resolve(true)); // consumed
    const reg: CommandRegistration = { name: '/clear', description: 'clear', handler };
    findCommand.mockReturnValue({ args: 'x', reg });
    const c = ctx();
    await runCoreSubmit('/clear', undefined, c);
    expect(handler).toHaveBeenCalledOnce();
    expect(c.send).not.toHaveBeenCalled();
    expect(detectWorkflowSlashMention).not.toHaveBeenCalled();
  });

  it('a /workflow mention dispatches and stops', async () => {
    detectWorkflowSlashMention.mockReturnValue({ entry: wf('wf'), trailing: 'go', agentSlug: null });
    const c = ctx();
    await runCoreSubmit('/wf go', undefined, c);
    expect(c.runWorkflowMention).toHaveBeenCalledWith(wf('wf'), 'go');
    expect(c.send).not.toHaveBeenCalled();
  });

  it('ADR 0764 — `@agent /workflow` activates the agent AND runs the workflow (never a plain send)', async () => {
    detectWorkflowSlashMention.mockReturnValue({ entry: wf('wf'), trailing: 'go', agentSlug: 'devon' });
    const devon = agentEntry('devon', 'agent-devon');
    const onAgentActivated = vi.fn();
    const c = ctx({ agentEntries: [devon], onAgentActivated });
    await runCoreSubmit('@devon /wf go', undefined, c);
    expect(c.activeAgents.activateAgent).toHaveBeenCalledWith(devon);
    expect(onAgentActivated).toHaveBeenCalledWith('agent-devon');
    expect(c.runWorkflowMention).toHaveBeenCalledWith(wf('wf'), 'go');
    expect(c.send).not.toHaveBeenCalled();
  });

  it('ADR 0764 — an unknown `@slug` prefix still runs the picked workflow', async () => {
    detectWorkflowSlashMention.mockReturnValue({ entry: wf('wf'), trailing: null, agentSlug: 'nobody' });
    const c = ctx();
    await runCoreSubmit('@nobody /wf', undefined, c);
    expect(c.activeAgents.activateAgent).not.toHaveBeenCalled();
    expect(c.runWorkflowMention).toHaveBeenCalledWith(wf('wf'), undefined);
  });

  it('an interceptor that returns handled stops before @agent + send', async () => {
    const intercept = vi.fn<SubmitInterceptor>(() => Promise.resolve({ kind: 'handled' as const }));
    const c = ctx();
    await runCoreSubmit('@@board', undefined, c, [intercept]);
    expect(intercept).toHaveBeenCalledOnce();
    expect(detectAgentMention).not.toHaveBeenCalled();
    expect(c.send).not.toHaveBeenCalled();
  });

  it('a routing interceptor skips @agent and sends with the routed agent', async () => {
    const intercept = vi.fn<SubmitInterceptor>(() => Promise.resolve({ kind: 'route' as const, activeAgentId: 'chair', boardSummoned: true }));
    const c = ctx({ activeAgents: { activateAgent: vi.fn(() => 'x'), currentAgentId: 'someone-selected' } });
    await runCoreSubmit('@@board', undefined, c, [intercept]);
    expect(c.activeAgents.activateAgent).not.toHaveBeenCalled(); // @agent skipped
    expect(c.send).toHaveBeenCalledWith('@@board', c.config, { attachments: undefined, activeAgentId: 'chair' });
  });

  it('a board summon with no routed agent never falls back to the previously selected agent', async () => {
    const intercept = vi.fn<SubmitInterceptor>(() => Promise.resolve({ kind: 'route' as const, boardSummoned: true }));
    const c = ctx({ activeAgents: { activateAgent: vi.fn(() => 'x'), currentAgentId: 'someone-selected' } });
    await runCoreSubmit('@@board what now', undefined, c, [intercept]);
    expect(sendOpts(c)).not.toHaveProperty('activeAgentId');
  });

  it('an @agent mention activates, fires onAgentActivated, and sends routed', async () => {
    const rev = agentEntry('rev', 'rev');
    detectAgentMention.mockReturnValue({ entry: rev, trailing: 'hi' });
    const onAgentActivated = vi.fn();
    const entries = [rev];
    const c = ctx({ activeAgents: { activateAgent: vi.fn(() => 'rev'), currentAgentId: DEFAULT }, onAgentActivated, agentEntries: entries });
    await runCoreSubmit('@rev hi', undefined, c);
    // The detector resolves against THIS surface's agent list.
    expect(detectAgentMention).toHaveBeenCalledWith('@rev hi', entries);
    expect(c.activeAgents.activateAgent).toHaveBeenCalledWith(rev);
    expect(onAgentActivated).toHaveBeenCalledWith('rev');
    expect(c.send).toHaveBeenCalledWith('@rev hi', c.config, expect.objectContaining({ activeAgentId: 'rev' }));
  });

  it('ADR 0768 D1 premise — with attachments an @agent mention does NOT switch agents (AgentHandoffHint says so)', async () => {
    detectAgentMention.mockReturnValue({ entry: agentEntry('rev', 'rev'), trailing: 'check this' });
    const c = ctx({ activeAgents: { activateAgent: vi.fn(() => 'rev'), currentAgentId: DEFAULT } });
    const pdf: ContentPart[] = [{ type: 'file', mimeType: 'application/pdf', name: 'a.pdf' }];
    await runCoreSubmit('@rev check this', pdf, c);
    expect(c.activeAgents.activateAgent).not.toHaveBeenCalled();
  });

  it('plain text sends with the current agent when one is selected, undefined for the default', async () => {
    const selected = ctx({ activeAgents: { activateAgent: vi.fn(() => 'x'), currentAgentId: 'persona-1' } });
    await runCoreSubmit('hello', undefined, selected);
    expect(selected.send).toHaveBeenCalledWith('hello', selected.config, expect.objectContaining({ activeAgentId: 'persona-1' }));

    const def = ctx();
    await runCoreSubmit('hello', undefined, def);
    expect(sendOpts(def)).not.toHaveProperty('activeAgentId');
  });

  it('attachments short-circuit command/workflow/agent and route straight to send', async () => {
    const c = ctx();
    const attachments: ContentPart[] = [{ type: 'image', mimeType: 'image/png', url: 'https://x.test/a.png' }];
    await runCoreSubmit('whatever', attachments, c);
    expect(findCommand).not.toHaveBeenCalled();
    expect(detectWorkflowSlashMention).not.toHaveBeenCalled();
    expect(detectAgentMention).not.toHaveBeenCalled();
    expect(c.send).toHaveBeenCalledWith('whatever', c.config, expect.objectContaining({ attachments }));
  });

  it('merges baseSendOptions into the send', async () => {
    const tools = [{ workflowId: 'wf.t', name: 't', description: 'd' }];
    const c = ctx({ baseSendOptions: () => ({ webSearch: true, tools }) });
    await runCoreSubmit('hi', undefined, c);
    expect(c.send).toHaveBeenCalledWith('hi', c.config, expect.objectContaining({ webSearch: true, tools }));
  });
});
