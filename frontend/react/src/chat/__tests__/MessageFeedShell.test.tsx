/**
 * CS-FE-5 (conversation-stack audit 2026-07-09) — first direct component
 * coverage for the MessageFeed shell, plus the CS-FE-1 memo-stability pin:
 * the channel-mode `channelActions` prop must be REFERENTIALLY STABLE across
 * re-renders (a fresh per-row object defeated MessageBubble's memo for the
 * whole feed on every streaming delta).
 *
 * What breaks it: dropping the `channelActionsPair` useMemo (a fresh object per
 * render) reds the CS-FE-1 case; renaming the log's role or dropping its
 * accessible name / `aria-relevant="additions"` (A11Y-6) reds the role cases;
 * dropping the `hasOlderMessages && onLoadEarlier` region reds the load-earlier case.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ComponentProps } from 'react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

// A pass-through spy on the bubble MessageFeed actually imports: it records the
// `channelActions` prop each time the feed renders a bubble, then renders the
// real (memo'd) bubble. The wrapper is NOT memo'd, so every parent render is seen.
const seenActions = vi.hoisted(() => [] as unknown[]);
vi.mock('../MessageBubble.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../MessageBubble.js')>();
  const Real = m.MessageBubble;
  function SpyBubble(p: ComponentProps<typeof Real>): JSX.Element {
    seenActions.push(p.channelActions);
    return <Real {...p} />;
  }
  return { ...m, MessageBubble: SpyBubble };
});

import { MessageFeed } from '../MessageFeed.js';
import type { ChatMessage } from '../types.js';

/** The four props every MessageFeed requires; these cases do not exercise them. */
const FEED = { tenantId: 't-test', onResolveInterrupt: async () => {}, onOpenWorkflowProgress: () => {}, focusedWorkflowMessageId: null };

const msg = (id: string, role: ChatMessage['role'], content: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role, content, createdAt: '2026-07-09T00:00:00.000Z', ...over,
});

beforeEach(() => {
  cleanup();
  seenActions.length = 0;
  // jsdom has no scrollIntoView; the feed's stick-to-bottom effect calls it.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('MessageFeed shell (CS-FE-5)', () => {
  it('renders user + assistant turns in the log with the a11y roles', () => {
    render(<MessageFeed {...FEED} messages={[msg('u1', 'user', 'hello feed'), msg('a1', 'assistant', 'hi there')]} />);
    const log = screen.getByRole('log', { name: 'conversationLog' });
    // A11Y-6 — the log announces ADDITIONS only, never every streamed token mutation.
    expect(log.getAttribute('aria-relevant')).toBe('additions');
    expect(within(log).getByText('hello feed')).toBeTruthy();
    expect(within(log).getByText('hi there')).toBeTruthy();
  });

  // Twin of case 1 for the log role (`feed-log-role` reds both); kept because the
  // EMPTY feed is its own input: the named log must exist before any turn does.
  it('renders an empty feed without crashing (designed empty state upstream)', () => {
    render(<MessageFeed {...FEED} messages={[]} />);
    const log = screen.getByRole('log', { name: 'conversationLog' });
    expect(within(log).queryByRole('button')).toBeNull();
    expect(seenActions).toHaveLength(0); // no bubble rendered for no message
  });

  // Twin: branchAvailability.test.tsx "says nothing about branching when branching
  // was never offered" asserts the same control (`ba-region-gone` reds both).
  it('shows the load-earlier affordance when older messages exist', () => {
    const onLoadEarlier = vi.fn();
    render(<MessageFeed {...FEED} messages={[msg('u1', 'user', 'x')]} hasOlderMessages onLoadEarlier={onLoadEarlier} />);
    const button = screen.getByRole('button', { name: 'loadEarlierMessages' });
    button.click();
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });
});

describe('CS-FE-1 — channel-mode channelActions memo stability', () => {
  it('the channelActions object identity is stable across re-renders (memo-compatible)', () => {
    const messageActions = {
      onToggleReaction: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
    };
    const directory = new Map([['user:alice', { displayName: 'Alice', kind: 'user' as const }]]);
    const messages = [msg('m1', 'user', 'channel msg', { authorSubject: 'user:alice' })];
    const { rerender } = render(
      <MessageFeed {...FEED} messages={messages} authorDirectory={directory} viewerSubjectRef="user:bob" messageActions={messageActions} />,
    );
    rerender(
      <MessageFeed {...FEED} messages={messages} authorDirectory={directory} viewerSubjectRef="user:bob" messageActions={messageActions} />,
    );
    expect(screen.getByText('channel msg')).toBeTruthy();
    // Positive control: the channel branch ran and handed the bubble an actions object.
    expect(seenActions.length).toBeGreaterThanOrEqual(2);
    expect(seenActions[0]).toBeDefined();
    // The claim: the SAME object on the re-render, so the memo'd bubble can skip.
    expect(seenActions.at(-1)).toBe(seenActions[0]);
    expect(messageActions.onToggleReaction).not.toHaveBeenCalled();
  });
});
