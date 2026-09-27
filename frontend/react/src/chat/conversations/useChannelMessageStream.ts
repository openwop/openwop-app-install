/**
 * ADR 0154 FU-6 — subscribe to a channel's live message stream while it is the
 * active conversation; on each frame, reload the thread (debounced to coalesce a
 * burst). The durable store is the source of truth, so a reload is always correct
 * (no dedup). `channelsClient` is dynamically imported so its SSE code stays out
 * of the eager chat entry chunk. Shared by ChatSidebar + the deck's TabSession so
 * both surfaces deliver channel messages live (the three-surfaces parity rule).
 */
import { useEffect } from 'react';
import { toast } from '../../ui/toast.js';
import i18n from '../../i18n/index.js';

export function useChannelMessageStream(
  channelId: string,
  enabled: boolean,
  reload: (id: string, targetMessageIds?: readonly string[]) => Promise<void>,
): void {
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsub: (() => void) | null = null;
    // GC-CHAT-2 — the coalescing window collects every frame's target row, so
    // one refresh can cursor-walk to lifecycle changes on OLDER messages.
    let pendingTargets = new Set<string>();
    void import('../../client/channelsClient.js').then(({ subscribeChannelMessages }) => {
      if (cancelled) return;
      unsub = subscribeChannelMessages(channelId, (messageId) => {
        if (messageId) pendingTargets.add(messageId);
        if (timer) return; // coalesce a burst into one reload
        timer = setTimeout(() => {
          timer = null;
          const targets = [...pendingTargets];
          pendingTargets = new Set();
          void reload(channelId, targets.length ? targets : undefined).catch(() => undefined);
        }, 200);
      }, (status) => {
        // CHV-UX-6 — a 403 mid-session means membership was revoked: say so
        // (once) instead of letting the feed silently stop updating. 404/405
        // (channel gone / feature off) stay quiet — nothing was "lost" mid-read.
        if (status === 403 && !cancelled) toast.info(i18n.t('chat:channelAccessLost'));
      });
    });
    return () => {
      cancelled = true;
      if (unsub) unsub();
      if (timer) clearTimeout(timer);
    };
  }, [channelId, enabled, reload]);
}
