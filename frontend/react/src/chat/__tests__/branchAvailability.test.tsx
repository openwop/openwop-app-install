/**
 * UX_UPGRADE-chat CH-G1 — "Branch from here" is withheld while a thread is
 * paginated, for a CORRECTNESS reason: `branchSeq` is derived from the render
 * index and only equals the server seq once the whole conversation is loaded.
 * Forking from the wrong turn would be worse than not offering it.
 *
 * The bug was that the control silently VANISHED. These pin that the guard
 * still holds AND that the absence is now explained.
 *
 * What breaks it: offering "Branch from here" while `hasOlderMessages` (case 2),
 * a branch seq that is not render-index + 1 (case 1), showing the explanation
 * when nothing is withheld / branching is not offered / the page is loading
 * (cases 1, 3, 4), or losing the `role="status"` region that announces it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { MessageFeed } from '../MessageFeed.js';

/** The four props every MessageFeed requires; these cases do not exercise them. */
const FEED = { tenantId: 't-test', onResolveInterrupt: async () => {}, onOpenWorkflowProgress: () => {}, focusedWorkflowMessageId: null };
import type { ChatMessage } from '../types.js';

const msg = (id: string, role: ChatMessage['role'], content: string): ChatMessage =>
  ({ id, role, content, createdAt: '2026-07-09T00:00:00.000Z' });

const messages = [msg('u1', 'user', 'First question'), msg('a1', 'assistant', 'First answer')];

/** A bubble deep in the feed calls `useNavigate`, so the tree needs a router. */
const renderFeed = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => {
  cleanup();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('chat — branch availability on a paginated thread (CH-G1)', () => {
  // The per-bubble control is MessageBubble's plain `onBranchFrom && branchSeq != null`
  // button ("Branch from here"), so whether the FEED hands it over is asserted
  // directly: present when the whole thread is loaded, absent while paginated.
  it('explains nothing when the WHOLE conversation is loaded', () => {
    const onBranchFrom = vi.fn();
    renderFeed(<MessageFeed {...FEED} messages={messages} onBranchFrom={onBranchFrom} onLoadEarlier={vi.fn()} />);
    // Positive control for case 2: branching IS offered here, on the assistant turn,
    // and its seq is the 1-based render index (the 2nd message ⇒ 2).
    fireEvent.click(screen.getByRole('button', { name: 'branchFromHere' }));
    expect(onBranchFrom).toHaveBeenCalledWith(2);
    // No load-earlier region at all ⇒ no explanation, because there is nothing
    // withheld to explain.
    expect(screen.queryByText('branchNeedsFullThread')).toBeNull();
    expect(screen.queryByText('loadEarlierMessages')).toBeNull();
  });

  it('withholds branching while older messages are unloaded — and SAYS WHY', () => {
    renderFeed(<MessageFeed {...FEED} messages={messages} hasOlderMessages onBranchFrom={vi.fn()} onLoadEarlier={vi.fn()} />);
    // The absence is explained, next to the control that resolves it.
    const region = screen.getByRole('status');
    expect(within(region).getByText('branchNeedsFullThread')).toBeTruthy();
    expect(within(region).getByText('loadEarlierMessages')).toBeTruthy();
    // …and the control itself is withheld (the render index is not the server seq yet).
    expect(screen.getByText('First answer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'branchFromHere' })).toBeNull();
  });

  it('says nothing about branching when branching was never offered at all', () => {
    // A surface that doesn't wire `onBranchFrom` (e.g. an embedded panel) must
    // not advertise a capability it does not have.
    renderFeed(<MessageFeed {...FEED} messages={messages} hasOlderMessages onLoadEarlier={vi.fn()} />);
    expect(screen.queryByText('branchNeedsFullThread')).toBeNull();
    expect(screen.getByText('loadEarlierMessages')).toBeTruthy();
  });

  it('does not show the explanation while the earlier page is still loading', () => {
    renderFeed(<MessageFeed {...FEED} messages={messages} hasOlderMessages isLoadingEarlier onBranchFrom={vi.fn()} onLoadEarlier={vi.fn()} />);
    expect(screen.queryByText('branchNeedsFullThread')).toBeNull();
  });
});
