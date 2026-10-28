/**
 * One-shot composer seed (ADR 0334 5b).
 *
 * Lets another surface open the ONE chat with a pre-filled composer draft WITHOUT
 * a bespoke chat panel and WITHOUT threading a `?draft=` param through both chat
 * shells (ChatSidebar + TabChatDeck). A caller stages a draft then navigates to
 * the agent deep-link (`/?agent=…`); the next `ChatInput` to mount (or the one
 * that swaps in on the conversation switch) consumes it exactly once — the same
 * "activation survives the async mount" idea as the command palette's openSignal.
 *
 * One-shot by design: staging is immediately followed by navigation, so the
 * target composer is the next to read it; a stale stage is harmless (the user
 * sees an editable draft they can clear) and can never be applied twice.
 *
 * Leaf module — no React, no imports back into the composer — so both the chat
 * and any feature surface can depend on it without a cycle.
 */
let pending: string | null = null;

/** Stage a draft for the next composer mount/switch to consume. */
export function stageComposerDraft(text: string): void {
  pending = text || null;
}

/** Consume the staged draft (returns it once, then clears it). */
export function takeStagedComposerDraft(): string | null {
  const t = pending;
  pending = null;
  return t;
}

/**
 * Live lane (ADR 0565) — seed a composer that is ALREADY mounted on this
 * surface. The selection-rewrite affordance lives inside the chat feed, so
 * there is no navigation and no future mount to consume a stage; the draft
 * must reach the composer that is on screen right now. A mounted `ChatInput`
 * registers a sink; `seedLiveComposer` hands the text to the first sink that
 * accepts it, and falls back to the one-shot stage when none is mounted
 * (e.g. a feed-only embed) so the draft is never dropped.
 */
type LiveComposerSink = (text: string) => boolean;
const liveSinks = new Set<LiveComposerSink>();

/** Register a mounted composer as a live-seed target. Returns unsubscribe. */
export function subscribeLiveComposer(sink: LiveComposerSink): () => void {
  liveSinks.add(sink);
  return () => { liveSinks.delete(sink); };
}

/** Seed the currently-mounted composer, or stage one-shot if none is live. */
export function seedLiveComposer(text: string): void {
  if (!text) return;
  for (const sink of [...liveSinks]) {
    if (sink(text)) return;
  }
  stageComposerDraft(text);
}

/**
 * ADR 0993 D1 — the composer a slash command was typed in. `seedLiveComposer`
 * hands text to the FIRST mounted sink, which in the multi-tab deck is tab 1's
 * (every tab stays mounted). A command that inserts text must reach the composer
 * it came from, so `ChatInput` marks itself just before it submits, and a command
 * inserts through this. Falls back to the live lane when nothing is marked.
 */
let submitting: LiveComposerSink | null = null;

/** Called by a composer immediately before it hands a submission off. */
export function markSubmittingComposer(sink: LiveComposerSink): void {
  submitting = sink;
}

/** Called by a composer as it unmounts: a closed tab's composer must not keep
 *  swallowing inserts (code-review P61CR-12). */
export function forgetSubmittingComposer(sink: LiveComposerSink): void {
  if (submitting === sink) submitting = null;
}

/** Insert into the composer that submitted the current command. */
export function insertIntoSubmittingComposer(text: string): void {
  if (!text) return;
  if (submitting?.(text)) return;
  seedLiveComposer(text);
}
