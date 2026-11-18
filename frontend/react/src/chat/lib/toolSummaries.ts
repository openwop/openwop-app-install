/**
 * ADR 1040 D7 F3 — the per-call display summaries of one chat turn, keyed by
 * call id, asked for only when `enabled` (an OPEN receipt on a settled turn).
 * The client is loaded on demand (it must not ride the feed's entry chunk). A
 * failed read is simply no summaries: the receipt stays as it was.
 */
import { useEffect, useState } from 'react';

const EMPTY: ReadonlyMap<string, string> = new Map();
/** Per turn, for the session: a reopened receipt does not ask again. */
const cache = new Map<string, ReadonlyMap<string, string>>();
const CACHE_MAX = 200;

export function useToolSummaries(
  turnRef: { conversationRunId: string; turnMessageId: string } | undefined,
  enabled: boolean,
): ReadonlyMap<string, string> {
  const runId = turnRef?.conversationRunId;
  const messageId = turnRef?.turnMessageId;
  const key = runId && messageId ? `${runId}\u0000${messageId}` : '';
  const [state, setState] = useState<{ key: string; byCall: ReadonlyMap<string, string> }>({ key: '', byCall: EMPTY });
  useEffect(() => {
    if (!enabled || !key || !runId || !messageId) return undefined;
    const hit = cache.get(key);
    if (hit) { setState({ key, byCall: hit }); return undefined; }
    let live = true;
    void import('../artifacts/artifactClient.js')
      .then((m) => m.listChatTurnToolSummaries(runId, messageId))
      .then(
        (rows) => {
          const byCall: ReadonlyMap<string, string> = new Map(rows.map((r) => [r.callId, r.summary]));
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
          cache.set(key, byCall);
          if (live) setState({ key, byCall });
        },
        () => { /* no summaries; the receipt is unchanged (and a later open may retry) */ },
      );
    return () => { live = false; };
  }, [key, runId, messageId, enabled]);
  // Never another turn's rows: a map read under a different key shows nothing.
  return state.key === key ? state.byCall : EMPTY;
}
