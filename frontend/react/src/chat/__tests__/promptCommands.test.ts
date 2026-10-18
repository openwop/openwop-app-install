/**
 * ADR 0116 Phase 3c — prompt-library `/`-commands. Breaks it: a slug that is not
 * command-safe, a command that sends the raw name instead of the rendered prompt,
 * a refetch on every composer mount, or an org switch that keeps the old org's
 * commands (the once-guard is per ORG, not once ever).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { PromptEntry } from '../../client/promptLibraryClient.js';

const { listPrompts, renderPrompt } = vi.hoisted(() => ({
  listPrompts: vi.fn<(orgId: string) => Promise<PromptEntry[]>>(),
  renderPrompt: vi.fn<(orgId: string, entryId: string, variables: Record<string, unknown>) => Promise<string>>(),
}));
vi.mock('../../client/promptLibraryClient.js', () => ({ listPrompts, renderPrompt }));

import { promptSlug, registerPromptCommands, resetPromptCommandsForTest } from '../promptCommands.js';
import { findCommand, clearCommands, type CommandContext } from '../registry/CommandRegistry.js';

beforeEach(() => { clearCommands(); resetPromptCommandsForTest(); listPrompts.mockReset(); renderPrompt.mockReset(); });

describe('promptSlug', () => {
  it('kebab-cases + trims a display name', () => {
    expect(promptSlug('Weekly Digest!')).toBe('weekly-digest');
    expect(promptSlug('   ')).toBe('prompt'); // fallback
  });
});

describe('registerPromptCommands', () => {
  it('registers a /p-<slug> command per entry; invoking it renders + sends', async () => {
    listPrompts.mockResolvedValue([{ entryId: 'e1', name: 'Weekly Digest', promptRef: 'p:1' }]);
    renderPrompt.mockResolvedValue('Summarize this week.');
    await registerPromptCommands('org-1');

    const cmd = findCommand('/p-weekly-digest');
    expect(cmd).not.toBeNull();

    const send = vi.fn(async (_text: string): Promise<void> => undefined);
    const ctx: CommandContext = { send, reset: () => {}, cancel: async () => {}, config: { provider: 'anthropic', model: 'm', credentialRef: 'k' }, emitSystem: () => {} };
    const consumed = await cmd!.reg.handler('', ctx);
    expect(consumed).toBe(true);
    expect(renderPrompt).toHaveBeenCalledWith('org-1', 'e1', {});
    expect(send).toHaveBeenCalledWith('Summarize this week.');
  });

  it('is idempotent per org (no refetch), and a different org fetches its own', async () => {
    listPrompts.mockResolvedValue([]);
    await registerPromptCommands('org-1');
    await registerPromptCommands('org-1');
    expect(listPrompts).toHaveBeenCalledTimes(1);
    await registerPromptCommands('org-2');
    expect(listPrompts).toHaveBeenCalledTimes(2);
    expect(listPrompts).toHaveBeenLastCalledWith('org-2');
  });
});
