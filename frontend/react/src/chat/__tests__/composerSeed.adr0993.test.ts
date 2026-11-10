/**
 * ADR 0993 D1 (`/architect` H5) — a command's inserted text reaches the composer
 * the command was typed in. The live lane (`seedLiveComposer`) gives text to the
 * FIRST mounted sink, which in the multi-tab deck is tab 1's composer, not the
 * one in front of the user.
 *
 * Each sink records what it received, so a case asserts exactly which composer
 * got the text and which got nothing.
 *
 * Sabotage (witnessed, wave 78): ignore the marked composer in
 * `insertIntoSubmittingComposer` → cases 1 and 2 red; never clear the mark in
 * `forgetSubmittingComposer` → case 3 red; `runCoreSubmit` passing no `insert`
 * to the command → case 2 red.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { forgetSubmittingComposer, insertIntoSubmittingComposer, markSubmittingComposer, subscribeLiveComposer } from '../composerSeed.js';
import { runCoreSubmit, type CoreSubmitContext } from '../lib/chatSubmit.js';
import { clearCommands, registerCommand } from '../registry/CommandRegistry.js';

/** A composer sink that records every text it is handed. */
function recordingSink(): { sink: (t: string) => boolean; got: string[] } {
  const got: string[] = [];
  return { sink: (t: string) => { got.push(t); return true; }, got };
}

// Module state (`submitting`, the live-sink set) must not leak between cases,
// even when a case fails before its own cleanup line.
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  clearCommands();
});
function live(sink: (t: string) => boolean): void { cleanups.push(subscribeLiveComposer(sink)); }
function mark(sink: (t: string) => boolean): void {
  markSubmittingComposer(sink);
  cleanups.push(() => forgetSubmittingComposer(sink));
}

describe('insertIntoSubmittingComposer', () => {
  it('goes to the composer that submitted, not the first mounted one', () => {
    const tab1 = recordingSink();
    const tab3 = recordingSink();
    live(tab1.sink);
    live(tab3.sink);
    mark(tab3.sink);
    insertIntoSubmittingComposer('from the library');
    expect(tab3.got).toEqual(['from the library']);
    expect(tab1.got).toEqual([]);
  });

  it('the core submit hands commands that insert into the submitting composer', async () => {
    registerCommand({ name: '/ins', description: 'x', handler: (_a, ctx) => { ctx.insert?.('inserted'); return true; } });
    const mine = recordingSink();
    mark(mine.sink);
    const ctx: CoreSubmitContext = {
      config: { provider: 'anthropic', model: 'm', credentialRef: 'k' },
      send: async () => {}, reset: () => {}, cancel: async () => {}, emitSystem: () => {},
      runWorkflowMention: async () => {}, activeAgents: { activateAgent: () => '', currentAgentId: '' }, agentEntries: [],
    };
    await runCoreSubmit('/ins', undefined, ctx);
    expect(mine.got).toEqual(['inserted']);
  });

  it('an unmounted composer stops receiving inserts', () => {
    const gone = recordingSink();
    const liveOne = recordingSink();
    live(liveOne.sink);
    markSubmittingComposer(gone.sink);
    forgetSubmittingComposer(gone.sink);
    insertIntoSubmittingComposer('text');
    expect(gone.got).toEqual([]);
    expect(liveOne.got).toEqual(['text']);
  });
});
