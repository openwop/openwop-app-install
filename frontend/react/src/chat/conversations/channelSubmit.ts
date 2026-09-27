/**
 * submitChannelPost (ADR 0192 D5) — the ONE channel-post submit shared by
 * ChatSidebar and TabSession (they previously carried near-identical copies;
 * the FE architect gate flagged the duplication before D5 would have tripled it).
 *
 * Attachments ride the serialized ChatMessage envelope the 1:1 surface already
 * stores (`parsePersistedMessages` dual-parses it); plain text stays plain so
 * legacy channel history keeps one shape per message kind. The backend caps
 * posts at 256 KB — mirrored here so an oversized attachment fails with a
 * typed toast instead of a round-trip.
 */
import type { ContentPart } from '../types.js';
import { toast } from '../../ui/toast.js';
import i18n from '../../i18n/index.js';

/** Mirrors the backend `MAX_POST_BYTES` (channelService, ADR 0192 D5). */
const MAX_POST_BYTES = 256 * 1024;

export interface ChannelSubmitDeps {
  /** Reload the open conversation's messages after the post lands. */
  loadSessionFromBackend: (sessionId: string) => Promise<void>;
  /** Optional read-marker + rail refresh hooks (surface-specific). */
  markRead?: (sessionId: string) => void;
  refreshConversations?: () => void;
  /** The composer's draft-persistence key. On a FAILED post the text is
   *  written back here (best-effort) so it isn't lost — the composer already
   *  cleared before the request settled. */
  draftKey?: string;
}

/** Post into a channel. Returns true when the post was sent. */
export async function submitChannelPost(
  sessionId: string,
  text: string,
  attachments: readonly ContentPart[] | undefined,
  deps: ChannelSubmitDeps,
): Promise<boolean> {
  const body = text.trim();
  if (!body && !attachments?.length) return false;

  // Attachment posts serialize the SAME ChatMessage envelope the 1:1 chat
  // stores; text-only posts stay plain text (mention parsing reads both).
  const content = attachments?.length
    ? JSON.stringify({
        role: 'user',
        content: [...attachments, ...(body ? [{ type: 'text', text: body } satisfies ContentPart] : [])],
        createdAt: new Date().toISOString(),
      })
    : body;

  if (new TextEncoder().encode(content).byteLength > MAX_POST_BYTES) {
    toast.error(i18n.t('chat:channelPostTooLarge'));
    return false;
  }

  try {
    const { postChannelMessage } = await import('../../client/channelsClient.js');
    await postChannelMessage(sessionId, content);
    await deps.loadSessionFromBackend(sessionId);
    deps.markRead?.(sessionId);
    deps.refreshConversations?.();
    return true;
  } catch {
    // A failed post (403/429/network) must surface — the composer has already
    // cleared, so ALSO write the text back into the draft store (best-effort;
    // the composer restores it on its next mount).
    if (deps.draftKey && body) {
      try { localStorage.setItem(deps.draftKey, body); } catch { /* quota/disabled */ }
    }
    toast.error(i18n.t('chat:channelPostError'));
    return false;
  }
}
