/**
 * MEM-UX-3 / MEM-UX-1 (ADR 0587 §1, §7) — provenance and scope honesty.
 *
 * MEM-UX-3. The "External · unverified" chip existed in this component all along
 * and was UNREACHABLE BY CONSTRUCTION: `addSubjectNote` hardcoded
 * `contentTrust:'trusted'` and it was the only writer of the note store, so
 * `listSubjectNotes` could never return `'untrusted'`. A model's guess about you
 * rendered byte-identical to a fact you typed, and the only marker —
 * `[auto-extracted] ` — lived in the stored CONTENT, so it could not be
 * translated and no fence could read it. These cases pin the chip as LIVE.
 *
 * MEM-UX-1. The list is the curated-note store; the recall port reads the whole
 * scope, into which every completed turn writes a summary. The tab called itself
 * "{{persona}}'s long-term memory". `recallOnlyCount` discloses the gap.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

const { list, add, remove } = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), remove: vi.fn() }));

import { MemoryBrowser } from '../MemoryBrowser.js';

const AUTO = {
  id: 'n1',
  content: 'The user banks with Acme',
  contentTrust: 'untrusted' as const,
  source: 'auto-extract' as const,
  createdAt: '2026-08-01T10:00:00.000Z',
};
const TYPED = {
  id: 'n2',
  content: 'I prefer concise briefings',
  contentTrust: 'trusted' as const,
  source: 'user' as const,
  createdAt: '2026-08-02T10:00:00.000Z',
};

const mount = async (props: Record<string, unknown> = {}): Promise<void> => {
  render(<MemoryBrowser list={list} add={add} remove={remove} {...props} />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([AUTO, TYPED]);
});

describe('MEM-UX-3 — a model-inferred belief is visibly distinguishable from a fact you typed', () => {
  it('renders the auto-learned chip AND the previously-dead untrusted chip', async () => {
    await mount();
    expect(screen.getByText('Auto-learned')).toBeTruthy();
    // Dead code before ADR 0587 — nothing could produce an untrusted note.
    expect(screen.getByText('External · unverified')).toBeTruthy();
  });

  it('ANTI-ROT: a user-typed note carries NEITHER chip — this is not "label everything"', async () => {
    list.mockResolvedValue([TYPED]);
    await mount();
    expect(screen.queryByText('Auto-learned')).toBeNull();
    expect(screen.queryByText('External · unverified')).toBeNull();
  });

  it('the marker is COPY, not content: no `[auto-extracted]` prefix is rendered', async () => {
    await mount();
    // The prefix was untranslatable precisely because it lived in stored content.
    expect(screen.queryByText(/\[auto-extracted\]/)).toBeNull();
    expect(screen.getByText('The user banks with Acme')).toBeTruthy();
  });

  it('renders `createdAt`, which was fetched and dropped on the floor', async () => {
    await mount();
    expect(screen.getAllByText(/^Learned /).length).toBe(2);
  });
});

describe('MEM-UX-1 — the list does not imply it is everything the subject remembers', () => {
  it('discloses rows the subject recalls that this list does not show', async () => {
    await mount({ recallOnlyCount: 3 });
    expect(screen.getByText(/3 more things were remembered from conversations/)).toBeTruthy();
  });

  it('says NOTHING when the count is unknown — silence, never an implied zero', async () => {
    await mount(); // no recallOnlyCount prop
    expect(screen.queryByText(/remembered from conversations/)).toBeNull();
  });

  it('says nothing when there genuinely are none', async () => {
    await mount({ recallOnlyCount: 0 });
    expect(screen.queryByText(/remembered from conversations/)).toBeNull();
  });
});
