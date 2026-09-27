/**
 * Chat walkthrough action pack (ADR 0378 P4, surface 1) — the semantic
 * actions/checkpoints the CHAT-01 P0 walkthrough drives. Registered lazily
 * from ChatTab (the campaign-brief idiom) so nothing lands in the entry chunk.
 *
 * Targets resolve via `data-walkthrough` anchors in ChatInput; the response
 * checkpoint reads the feed's existing STABLE `data-role` attribute on
 * `.msgbubble-box` (behavior-bearing, not styling) — the last bubble must be
 * an assistant one, which holds for fresh AND already-used conversations
 * because the user's just-sent message is last until the reply lands.
 */
import { registerWalkthroughAction, registerWalkthroughCheckpoint } from '../walkthroughs/actionRegistry.js';

export const CHAT_WALKTHROUGH_ACTION_IDS = ['chat.composer.send-message'] as const;
export const CHAT_WALKTHROUGH_CHECKPOINT_IDS = ['chat.response-received'] as const;

/** The reply can stream for a while — poll patiently before calling it failed. */
const RESPONSE_POLL_MS = 500;
const RESPONSE_POLL_TRIES = 90; // ≈45s

export function registerChatWalkthroughActions(): void {
  registerWalkthroughAction('chat.composer.send-message', {
    route: '/',
    resolve: () => document.querySelector<HTMLElement>('[data-walkthrough="chat.composer"]'),
    verb: 'focus',
    // HITL: the user types their own message; pressing Send completes the
    // step (a click listener on the send anchor — no synthetic sends, no cost
    // the user didn't choose).
    hitlComplete: (_el, done) => {
      const send = document.querySelector<HTMLElement>('[data-walkthrough="chat.send"]');
      if (!send) return null; // could not attach — the chrome falls back to "I did it"
      const onClick = () => done({ sent: true });
      send.addEventListener('click', onClick, { once: true });
      return () => send.removeEventListener('click', onClick);
    },
  });

  registerWalkthroughCheckpoint('chat.response-received', {
    evaluate: async () => {
      for (let i = 0; i < RESPONSE_POLL_TRIES; i++) {
        const bubbles = document.querySelectorAll('.msgbubble-box[data-role]');
        const last = bubbles[bubbles.length - 1];
        if (last?.getAttribute('data-role') === 'assistant') return null; // pass
        await new Promise((res) => setTimeout(res, RESPONSE_POLL_MS));
      }
      return 'no assistant response arrived';
    },
  });
}
