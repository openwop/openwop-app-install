/**
 * ADR 0834 D6 / FW2-UX-1 — the pending tool-approval read happens when a turn SETTLES.
 *
 * Born red: the first cut keyed the re-read on `messages.length`. A send adds the user
 * row and a "thinking" placeholder (the read fires mid-turn, before the hold is recorded)
 * and the completion SWAPS those two for the server's turns — same count, no second read,
 * so a held call stayed invisible until the next message. This drives the hook through
 * exactly that sequence (count 0 → sending at 2 → settled at 2) and asserts the control is
 * asked to re-read after `isSending` goes false.
 *
 * Sabotage witness (w43): keying `refreshKey` on `messageCount` alone (the
 * born-red shape) turns it red.
 */
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../ModelSwitcher.js', () => ({ ModelSwitcher: () => null }));
const keys: number[] = [];
vi.mock('../../conversationTools/ConversationToolsControl.js', () => ({
  default: ({ refreshKey }: { refreshKey: number }) => { keys.push(refreshKey); return null; },
}));

import { useComposerModifiers } from '../hooks/useComposerModifiers.js';

function Harness({ messageCount, isSending }: { messageCount: number; isSending: boolean }): JSX.Element {
  const { composerModifiers } = useComposerModifiers({ sessionId: 's1', supportsWebSearch: false, supportsTools: false, messageCount, isSending });
  return <div>{composerModifiers}</div>;
}

describe('pending approvals re-read on turn settle (FW2-UX-1)', () => {
  it('the key changes when isSending goes false even though the count did not', async () => {
    const { rerender } = render(<Harness messageCount={0} isSending={false} />);
    await vi.waitFor(() => expect(keys.length).toBeGreaterThan(0));
    rerender(<Harness messageCount={2} isSending />);            // send: user row + placeholder
    await vi.waitFor(() => expect(keys.at(-1)).toBe(-1));
    rerender(<Harness messageCount={2} isSending={false} />);    // completion: 1:1 swap, same count
    // Settled: the key moved off the in-flight -1 to the count — a re-read.
    await vi.waitFor(() => expect(keys.at(-1)).toBe(2));
  });
});
