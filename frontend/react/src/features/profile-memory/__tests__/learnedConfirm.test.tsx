/**
 * ADR 0982 D6 (MAE2UX-4) — deleting a LEARNED fact says what else it does: it will not be learned
 * again in the same words. A typed note keeps the generic, subject-neutral confirm.
 *
 * The learned copy lives in this feature's LAZY `profile-memory` namespace (the eager `memory`
 * area catalog would grow the entry chunk), and a lazy namespace read through the wrong `t`
 * renders the raw KEY (row 9's BILLUX lesson). So this asserts the RENDERED English copy through
 * the real i18n stack, and that no key leaks.
 *
 * Witnessed (row 57 sabotage): dropping `confirmBodyFor`, or resolving it through the `memory`
 * namespace, reds case 1.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const confirmSpy = vi.hoisted(() => vi.fn(async (_opts: { title: string; body: string; danger?: boolean }) => false));
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmSpy }));

const notes = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock('../profileMemoryClient.js', () => ({
  listMemoriesWithRecall: vi.fn(async () => ({ notes: notes.list })),
  listMemories: vi.fn(async () => notes.list),
  addMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));
vi.mock('../memoryExtractionClient.js', () => ({ getExtractionGrant: vi.fn(async () => null), setExtractionGrant: vi.fn() }));

import { ProfileMemoryTab } from '../ProfileMemoryTab.js';

const note = (source: 'user' | 'auto-extract') => ({
  id: `n-${source}`, content: `a ${source} note`, contentTrust: source === 'auto-extract' ? 'untrusted' : 'trusted', source, createdAt: '2026-10-26T00:00:00.000Z',
});
const bodyOfLastConfirm = (): string => confirmSpy.mock.calls.at(-1)?.[0].body ?? '';

afterEach(() => { cleanup(); confirmSpy.mockClear(); });

describe('Personal Memory delete confirm', () => {
  it('a learned fact\'s confirm renders the lazy copy: it will not be learned again', async () => {
    notes.list = [note('auto-extract')];
    render(<ProfileMemoryTab />);
    fireEvent.click(await screen.findByRole('button', { name: /remove/i }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(bodyOfLastConfirm()).toBe('Remove this learned fact? It will no longer be recalled, and it will not be learned again in the same words.');
    expect(bodyOfLastConfirm()).not.toMatch(/removeLearnedConfirmBody/);
  });

  it('a typed note keeps the generic confirm, which names no agent', async () => {
    notes.list = [note('user')];
    render(<ProfileMemoryTab />);
    fireEvent.click(await screen.findByRole('button', { name: /remove/i }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(bodyOfLastConfirm()).toBe('Remove this memory? It will no longer be recalled.');
  });
});
