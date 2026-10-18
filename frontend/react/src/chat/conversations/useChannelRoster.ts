/**
 * useChannelRoster (ADR 0192 D2/D8) — the ONE fetch of a channel's resolved
 * detail (roster + viewer identity + descriptor) shared by rail Zone 1, the
 * channel header facepile, the composer's channel-scoped mention entries, the
 * empty state, and the feed's author directory. Fetched once per
 * (channelId, enabled) flip; `refresh` re-reads after membership mutations
 * (manage dialog `onChanged`, join/leave).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChannelDetail, ChannelRosterEntry } from '../../client/channelsClient.js';
import type { AgentMentionEntry } from '../lib/agentMentions.js';

export interface ChannelRosterState {
  detail: ChannelDetail | null;
  roster: readonly ChannelRosterEntry[];
  viewerIsOwner: boolean;
  /** ADR 0879 — server-computed manage / post authority (see `ChannelDetail`). */
  viewerCanManage: boolean;
  viewerCanPost: boolean;
  /** CH2UX-1 — WHY the viewer cannot post (null when they can, or before the
   *  detail resolves). Each reason has its own copy: an announcement channel and
   *  a read-only workspace role are different problems with different fixes. */
  readOnlyReason: ChannelReadOnlyReason | null;
  /** CH2UX-2 — `workspace:write`, inferred from the server's flags: `true` when
   *  the viewer may post or manage, `false` when an open, non-announcement
   *  channel still refuses their post (the only cause left is the role), and
   *  `null` when the flags cannot tell (a non-manager in an announcement
   *  channel). `null` claims nothing — the affordances stay and the server
   *  remains the authority. */
  viewerCanWrite: boolean | null;
  viewerSubjectRef: string | null;
  /** The fetch failed (non-member / transient) — the surface renders in the
   *  pre-0192 mode and may offer a retry. */
  failed: boolean;
  /** Composer entries for the channel-scoped `@` autocomplete (agents only). */
  mentionEntries: readonly AgentMentionEntry[];
  /** `subjectRef → display` for feed attribution (all kinds). */
  authorDirectory: ReadonlyMap<string, { displayName: string; kind: 'user' | 'agent' | 'other' }>;
  refresh: () => Promise<void>;
}

const EMPTY: readonly ChannelRosterEntry[] = [];

export type ChannelReadOnlyReason = 'archived' | 'managers' | 'role';

/** The composer copy per reason (chat namespace keys). */
export const CHANNEL_READ_ONLY_COPY = {
  archived: 'channelArchivedComposer',
  managers: 'channelReadOnlyComposer',
  role: 'channelReadOnlyRole',
} as const satisfies Record<ChannelReadOnlyReason, string>;

/** Derive the read-only reason + write authority from the server's flags. Pure. */
export function channelWriteState(detail: ChannelDetail | null): { readOnlyReason: ChannelReadOnlyReason | null; viewerCanWrite: boolean | null } {
  if (detail === null) return { readOnlyReason: null, viewerCanWrite: null };
  // `viewerCanWrite` is the server's ROLE answer when it sends one (CH2UX-9); the
  // inference below is only for an older server that does not.
  const role = typeof detail.viewerCanWrite === 'boolean' ? detail.viewerCanWrite : null;
  if (detail.viewerCanPost !== false) return { readOnlyReason: null, viewerCanWrite: true };
  if (role === false) return { readOnlyReason: 'role', viewerCanWrite: false };
  if (detail.channel?.archived) return { readOnlyReason: 'archived', viewerCanWrite: role ?? (detail.viewerCanManage === true ? true : null) };
  if (detail.channel?.postingPolicy === 'managers') return { readOnlyReason: 'managers', viewerCanWrite: role ?? (detail.viewerCanManage === true ? true : null) };
  return { readOnlyReason: 'role', viewerCanWrite: false };
}

export function useChannelRoster(channelId: string | null, enabled: boolean): ChannelRosterState {
  const { t } = useTranslation('chat');
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [failed, setFailed] = useState(false);
  // Staleness guard (code-review finding 1): a fast channel switch must never
  // commit channel A's roster onto channel B — a stale roster would feed the
  // WRONG mention slugs to the composer (the silent-mention failure this ADR
  // exists to kill). Monotonic request id; only the latest fetch commits.
  const requestSeq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    if (!enabled || !channelId) { setDetail(null); setFailed(false); return; }
    try {
      // Dynamic import — channelsClient (and its SSE machinery) stays out of
      // the eager chat entry chunk (the ADR 0154 lazy-chrome posture; the
      // bundle-budget gate enforces it).
      const { getChannel } = await import('../../client/channelsClient.js');
      const d = await getChannel(channelId);
      if (seq !== requestSeq.current) return; // superseded — drop
      setDetail(d);
      setFailed(false);
    } catch {
      if (seq !== requestSeq.current) return;
      // Non-member / transient — the surface stays in pre-0192 rendering mode
      // (detail === null gates channel-mode props) and may offer a retry.
      setFailed(true);
    }
  }, [channelId, enabled]);

  useEffect(() => {
    setDetail(null);
    setFailed(false);
    if (enabled && channelId) void refresh();
  }, [channelId, enabled, refresh]);

  const roster = detail?.roster ?? EMPTY;

  const mentionEntries = useMemo<readonly AgentMentionEntry[]>(
    () => roster
      .filter((r) => r.kind === 'agent')
      .map((r) => ({
        displayName: r.displayName,
        persona: r.displayName,
        // The server-persisted mention slug is what dispatch matches (ADR 0192
        // D1); legacy agent members without one fall back to the raw agent id,
        // which dispatch also matches.
        slug: r.mentionSlug ?? r.subjectRef.slice('agent:'.length),
        agentId: r.subjectRef.slice('agent:'.length),
        description: t('channelAgentMemberDescription'),
        packName: '',
        packVersion: '',
        modelClass: '',
      })),
    [roster, t],
  );

  const authorDirectory = useMemo(() => {
    const map = new Map<string, { displayName: string; kind: 'user' | 'agent' | 'other' }>();
    for (const r of roster) map.set(r.subjectRef, { displayName: r.displayName, kind: r.kind });
    return map;
  }, [roster]);

  return {
    detail,
    roster,
    viewerIsOwner: detail?.viewerIsOwner === true,
    viewerCanManage: detail?.viewerCanManage === true,
    // Unknown until the detail resolves: the composer stays usable rather than
    // flashing read-only; the server refuses a post it would not accept anyway.
    viewerCanPost: detail === null ? true : detail.viewerCanPost !== false,
    ...channelWriteState(detail),
    viewerSubjectRef: detail?.viewerSubjectRef ?? null,
    failed,
    mentionEntries,
    authorDirectory,
    refresh,
  };
}
