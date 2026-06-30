/**
 * ADR 0116 Phase 3c — prompt-library `/`-commands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { listPrompts, renderPrompt } = vi.hoisted(() => ({ listPrompts: vi.fn(), renderPrompt: vi.fn() }));
vi.mock('../../client/promptLibraryClient.js', () => ({ listPrompts, renderPrompt }));

import { promptSlug, registerPromptCommands, resetPromptCommandsForTest } from '../promptCommands.js';
import { findCommand, clearCommands } from '../registry/CommandRegistry.js';

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

    const send = vi.fn().mockResolvedValue(undefined);
    const consumed = await cmd!.reg.handler('', { send, reset: () => {}, cancel: async () => {}, config: {} as never, emitSystem: () => {} });
    expect(consumed).toBe(true);
    expect(renderPrompt).toHaveBeenCalledWith('org-1', 'e1', {});
    expect(send).toHaveBeenCalledWith('Summarize this week.');
  });

  it('is idempotent per org (no refetch)', async () => {
    listPrompts.mockResolvedValue([]);
    await registerPromptCommands('org-1');
    await registerPromptCommands('org-1');
    expect(listPrompts).toHaveBeenCalledTimes(1);
  });
});
