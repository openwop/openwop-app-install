/**
 * ADR 0154 FU-6 — subscribe to a channel's live message stream while it is the
 * active conversation; on each frame, reload the thread (debounced to coalesce a
 * burst). The durable store is the source of truth, so a reload is always correct
 * (no dedup). `channelsClient` is dynamically imported so its SSE code stays out
 * of the eager chat entry chunk. Shared by ChatSidebar + the deck's TabSession so
 * both surfaces deliver channel messages live (the three-surfaces parity rule).
 */
import { useEffect } from 'react';

export function useChannelMessageStream(
  channelId: string,
  enabled: boolean,
  reload: (id: string) => Promise<void>,
): void {
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsub: (() => void) | null = null;
    void import('../../client/channelsClient.js').then(({ subscribeChannelMessages }) => {
      if (cancelled) return;
      unsub = subscribeChannelMessages(channelId, () => {
        if (timer) return; // coalesce a burst into one reload
        timer = setTimeout(() => { timer = null; void reload(channelId).catch(() => undefined); }, 200);
      });
    });
    return () => {
      cancelled = true;
      if (unsub) unsub();
      if (timer) clearTimeout(timer);
    };
  }, [channelId, enabled, reload]);
}
