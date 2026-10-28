/**
 * ADR 0993 D1 (`/architect` H5) — a command's inserted text reaches the composer
 * the command was typed in. The live lane (`seedLiveComposer`) gives text to the
 * FIRST mounted sink, which in the multi-tab deck is tab 1's composer, not the
 * one in front of the user.
 */
import { describe, it, expect, vi } from 'vitest';
import { forgetSubmittingComposer, insertIntoSubmittingComposer, markSubmittingComposer, subscribeLiveComposer } from '../composerSeed.js';
import { runCoreSubmit, type CoreSubmitContext } from '../lib/chatSubmit.js';
import { clearCommands, registerCommand } from '../registry/CommandRegistry.js';

describe('insertIntoSubmittingComposer', () => {
  it('goes to the composer that submitted, not the first mounted one', () => {
    const tab1 = vi.fn((_t: string) => true);
    const tab3 = vi.fn((_t: string) => true);
    const off1 = subscribeLiveComposer(tab1);
    const off3 = subscribeLiveComposer(tab3);
    markSubmittingComposer(tab3);
    insertIntoSubmittingComposer('from the library');
    expect(tab3).toHaveBeenCalledWith('from the library');
    expect(tab1).not.toHaveBeenCalled();
    off1(); off3();
  });

  it('the core submit hands commands that insert into the submitting composer', async () => {
    clearCommands();
    registerCommand({ name: '/ins', description: 'x', handler: (_a, ctx) => { ctx.insert?.('inserted'); return true; } });
    const mine = vi.fn((_t: string) => true);
    markSubmittingComposer(mine);
    const ctx: CoreSubmitContext = {
      config: { provider: 'anthropic', model: 'm', credentialRef: 'k' },
      send: async () => {}, reset: () => {}, cancel: async () => {}, emitSystem: () => {},
      runWorkflowMention: async () => {}, activeAgents: { activateAgent: () => '', currentAgentId: '' }, agentEntries: [],
    };
    await runCoreSubmit('/ins', undefined, ctx);
    expect(mine).toHaveBeenCalledWith('inserted');
    forgetSubmittingComposer(mine);
    clearCommands();
  });

  it('an unmounted composer stops receiving inserts', () => {
    const gone = vi.fn((_t: string) => true);
    const live = vi.fn((_t: string) => true);
    const off = subscribeLiveComposer(live);
    markSubmittingComposer(gone);
    forgetSubmittingComposer(gone);
    insertIntoSubmittingComposer('text');
    expect(gone).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledWith('text');
    off();
  });
});
