/**
 * UX_UPGRADE-chat CH-G1 — "Branch from here" is withheld while a thread is
 * paginated, for a CORRECTNESS reason: `branchSeq` is derived from the render
 * index and only equals the server seq once the whole conversation is loaded.
 * Forking from the wrong turn would be worse than not offering it.
 *
 * The bug was that the control silently VANISHED. These pin that the guard
 * still holds AND that the absence is now explained.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { MessageFeed } from '../MessageFeed.js';
import type { ChatMessage } from '../types.js';

const msg = (id: string, role: ChatMessage['role'], content: string): ChatMessage =>
  ({ id, role, content, createdAt: '2026-07-09T00:00:00.000Z' } as ChatMessage);

const messages = [msg('u1', 'user', 'First question'), msg('a1', 'assistant', 'First answer')];

/** A bubble deep in the feed calls `useNavigate`, so the tree needs a router. */
const renderFeed = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => {
  cleanup();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('chat — branch availability on a paginated thread (CH-G1)', () => {
  // Scoped to what THIS change owns — the explanation. Whether the per-bubble
  // branch button renders is pre-existing behaviour gated on bubble internals,
  // and asserting it here would be testing someone else's contract by guess.
  it('explains nothing when the WHOLE conversation is loaded', () => {
    renderFeed(<MessageFeed messages={messages} isSending={false} onBranchFrom={vi.fn()} onLoadEarlier={vi.fn()} />);
    // No load-earlier region at all ⇒ no explanation, because there is nothing
    // withheld to explain.
    expect(screen.queryByText('branchNeedsFullThread')).toBeNull();
    expect(screen.queryByText('loadEarlierMessages')).toBeNull();
  });

  it('withholds branching while older messages are unloaded — and SAYS WHY', () => {
    renderFeed(<MessageFeed messages={messages} isSending={false} hasOlderMessages onBranchFrom={vi.fn()} onLoadEarlier={vi.fn()} />);
    // The absence is explained, next to the control that resolves it.
    const region = screen.getByRole('status');
    expect(within(region).getByText('branchNeedsFullThread')).toBeTruthy();
    expect(within(region).getByText('loadEarlierMessages')).toBeTruthy();
  });

  it('says nothing about branching when branching was never offered at all', () => {
    // A surface that doesn't wire `onBranchFrom` (e.g. an embedded panel) must
    // not advertise a capability it does not have.
    renderFeed(<MessageFeed messages={messages} isSending={false} hasOlderMessages onLoadEarlier={vi.fn()} />);
    expect(screen.queryByText('branchNeedsFullThread')).toBeNull();
    expect(screen.getByText('loadEarlierMessages')).toBeTruthy();
  });

  it('does not show the explanation while the earlier page is still loading', () => {
    renderFeed(<MessageFeed messages={messages} isSending={false} hasOlderMessages isLoadingEarlier onBranchFrom={vi.fn()} onLoadEarlier={vi.fn()} />);
    expect(screen.queryByText('branchNeedsFullThread')).toBeNull();
  });
});
