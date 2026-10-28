/**
 * ADR 0993 D1 — a library prompt is INSERTED for review, never sent unseen.
 *
 * Born red on main (`a52087693`): the `/p-<slug>` handler called `ctx.send` with
 * text the invoking user had never seen. The text is authored by any org writer,
 * so one member's prompt was sent as another member's turn, with their tools and
 * their key. Also red there: two entries with one slug collapsed into one command
 * (the registry overwrote the first), and switching org left the previous org's
 * commands registered (the header of `promptCommands.test.ts` claimed a test
 * caught that; none did).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { PromptEntry } from '../../client/promptLibraryClient.js';

const { listPrompts, renderPrompt, seedLiveComposer } = vi.hoisted(() => ({
  listPrompts: vi.fn<(orgId: string) => Promise<PromptEntry[]>>(),
  renderPrompt: vi.fn<(orgId: string, entryId: string, variables: Record<string, unknown>) => Promise<string>>(),
  seedLiveComposer: vi.fn<(text: string) => void>(),
}));
vi.mock('../../client/promptLibraryClient.js', () => ({ listPrompts, renderPrompt }));
vi.mock('../composerSeed.js', () => ({ seedLiveComposer }));

import { registerPromptCommands, resetPromptCommandsForTest } from '../promptCommands.js';
import { findCommand, clearCommands, listCommands, type CommandContext } from '../registry/CommandRegistry.js';

const entry = (entryId: string, name: string, extra: Partial<PromptEntry> = {}): PromptEntry => ({ entryId, name, promptRef: `t-${entryId}`, ...extra });

function ctx(send = vi.fn(async (_t: string): Promise<void> => undefined)): CommandContext {
  return { send, reset: () => {}, cancel: async () => {}, config: { provider: 'anthropic', model: 'm', credentialRef: 'k' }, emitSystem: () => {} };
}

beforeEach(() => {
  clearCommands(); resetPromptCommandsForTest();
  listPrompts.mockReset(); renderPrompt.mockReset(); seedLiveComposer.mockReset();
});

describe('ADR 0993 D1 — insert for review', () => {
  it('puts the rendered prompt in the composer and sends nothing', async () => {
    listPrompts.mockResolvedValue([entry('e1', 'Weekly Digest')]);
    renderPrompt.mockResolvedValue('Summarize this week.');
    await registerPromptCommands(['org-1']);
    const send = vi.fn(async (_t: string): Promise<void> => undefined);
    const consumed = await findCommand('/p-weekly-digest')!.reg.handler('', ctx(send));
    expect(consumed).toBe(true);
    expect(seedLiveComposer).toHaveBeenCalledWith('Summarize this week.');
    expect(send, 'a co-member authored this text; the user must see it before it is sent').not.toHaveBeenCalled();
  });

  it('a stale read never registers over a newer one (generation token)', async () => {
    let releaseSlow: (v: PromptEntry[]) => void = () => {};
    listPrompts.mockImplementation((orgId) => (orgId === 'slow'
      ? new Promise<PromptEntry[]>((r) => { releaseSlow = r; })
      : Promise.resolve([entry('e2', 'Fresh')])));
    const slow = registerPromptCommands(['slow']);
    await registerPromptCommands(['fast']);
    releaseSlow([entry('e1', 'Stale')]);
    await slow;
    expect(findCommand('/p-stale')).toBeNull();
    expect(findCommand('/p-fresh')).not.toBeNull();
  });

  it('two entries with one slug register as two commands', async () => {
    listPrompts.mockResolvedValue([entry('e1', 'Digest'), entry('e2', 'digest!')]);
    renderPrompt.mockImplementation(async (_o, id) => `text ${id}`);
    await registerPromptCommands(['org-1']);
    const names = listCommands().map((c) => c.name).filter((n) => n.startsWith('/p-'));
    expect(names.sort()).toEqual(['/p-digest', '/p-digest-2']);
    await findCommand('/p-digest-2')!.reg.handler('', ctx());
    expect(seedLiveComposer).toHaveBeenCalledWith('text e2');
  });

  it('an org switch removes the previous org\'s commands', async () => {
    listPrompts.mockImplementation(async (orgId) => (orgId === 'org-1' ? [entry('e1', 'Only In One')] : [entry('e2', 'Only In Two')]));
    await registerPromptCommands(['org-1']);
    expect(findCommand('/p-only-in-one')).not.toBeNull();
    await registerPromptCommands(['org-2']);
    expect(findCommand('/p-only-in-one'), 'org-1 is no longer the active workspace').toBeNull();
    expect(findCommand('/p-only-in-two')).not.toBeNull();
  });

  it('an entry whose template is gone is not offered', async () => {
    listPrompts.mockResolvedValue([entry('e1', 'Gone', { available: false }), entry('e2', 'Here')]);
    await registerPromptCommands(['org-1']);
    expect(findCommand('/p-gone')).toBeNull();
    expect(findCommand('/p-here')).not.toBeNull();
  });

  it('a render that fails puts the command back and says why; it never sends', async () => {
    listPrompts.mockResolvedValue([entry('e1', 'Weekly Digest')]);
    renderPrompt.mockRejectedValue(new Error('not_found: gone'));
    await registerPromptCommands(['org-1']);
    const send = vi.fn(async (_t: string): Promise<void> => undefined);
    const insert = vi.fn<(t: string) => void>();
    const emitSystem = vi.fn<(t: string) => void>();
    const consumed = await findCommand('/p-weekly-digest')!.reg.handler('', { ...ctx(send), insert, emitSystem });
    expect(consumed, 'consumed: falling through would SEND "/p-weekly-digest"').toBe(true);
    expect(insert).toHaveBeenCalledWith('/p-weekly-digest');
    expect(emitSystem.mock.calls[0]?.[0]).toMatch(/\/p-weekly-digest/);
    expect(send).not.toHaveBeenCalled();
  });
});
