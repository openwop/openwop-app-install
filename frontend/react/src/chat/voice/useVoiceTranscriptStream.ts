/**
 * Live transcript delivery for the OpenAI realtime path (ADR 0141 RT-4). That browser holds
 * audio-only WebRTC and NEVER sees a transcript — the host sideband captures each turn,
 * persists it, and publishes a per-conversation frame. This hook subscribes to that frame
 * while a realtime session is live and reloads the thread from the durable store (the source
 * of truth), mirroring the channel stream (`useChannelMessageStream`, ADR 0154 FU-6).
 *
 * OpenAI-only: Gemini streams transcripts client-side (`realtimeClient` → `onTranscript` →
 * `upsertTranscriptTurn`) and persists them itself, so a store reload would fight its live
 * streaming bubble. We probe the provider and no-op unless it is `openai-realtime`.
 *
 * `voiceClient` is dynamically imported so its SSE + fetch code stays OUT of the eager chat
 * entry chunk (the same reason `LiveVoiceController` is lazy).
 */
import { useEffect, useRef } from 'react';

export function useVoiceTranscriptStream(
  conversationId: string | undefined,
  active: boolean,
  reload: (id: string) => Promise<void>,
): void {
  // GRADE-3 — the cleanup fires on DEP CHANGE too, and `reload(oldId)` from a
  // conversation SWITCH raced the new conversation's load (the slower fetch
  // could flip the whole session back to the old thread). Track the live
  // `active` value via a ref: the final catch-up reload runs ONLY when the
  // voice session actually ENDED (active → false) — never on an id switch or
  // unmount, where reloading the old conversation is wrong or useless.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!active || !conversationId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsub: (() => void) | null = null;
    let didSubscribe = false;
    let probeUnreadable = false;
    void import('./voiceClient.js').then(async ({ getRealtimeCapability, subscribeVoiceTranscripts }) => {
      // A FAILED probe is not an answer. Reading `null` as "not openai-realtime"
      // silently disabled the only transcript path on the one provider that
      // needs it: the user speaks an entire session and no turn ever appears,
      // with nothing shown anywhere. Retry a few times before giving up, and
      // remember that we never got an answer.
      type Probe = { ok: true; provider: string } | { ok: false };
      let probe: Probe = { ok: false };
      for (let attempt = 0; attempt < 3 && !cancelled && !probe.ok; attempt += 1) {
        if (attempt > 0) await new Promise((r) => { timer = setTimeout(r, 400 * attempt); });
        if (cancelled) return;
        probe = await getRealtimeCapability()
          .then((c) => ({ ok: true as const, provider: c.provider }))
          .catch(() => ({ ok: false as const }));
      }
      timer = null;
      if (cancelled) return;
      // Unreadable ⇒ we cannot subscribe, but we CAN still catch up from the
      // durable store when the session ends (below), which is where the host
      // sideband committed the turns anyway.
      probeUnreadable = !probe.ok;
      if (!probe.ok || probe.provider !== 'openai-realtime') return;
      didSubscribe = true;
      unsub = subscribeVoiceTranscripts(conversationId, () => {
        if (timer) return; // coalesce a burst of frames into one reload
        timer = setTimeout(() => { timer = null; void reload(conversationId).catch(() => undefined); }, 200);
      });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      if (unsub) unsub();
      if (timer) clearTimeout(timer);
      // One final reload so a turn the sideband committed as the session ended
      // (its frame racing the unsubscribe) still lands — but only on the
      // active→false transition (see GRADE-3 above).
      // `probeUnreadable` joins it: if we never learned the provider we may have
      // missed an entire OpenAI session, and the durable store is the source of
      // truth. At session END nothing is streaming, so this cannot fight a
      // Gemini live bubble the way a mid-session reload would.
      if ((didSubscribe || probeUnreadable) && !activeRef.current) void reload(conversationId).catch(() => undefined);
    };
  }, [conversationId, active, reload]);
}
