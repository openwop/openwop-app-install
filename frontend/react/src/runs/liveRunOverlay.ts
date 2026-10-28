/**
 * ADR 0960 D3 — the live run overlay as a hook, outside the builder.
 *
 * Reads the run's event log once (REST), then follows the live stream (SSE),
 * de-duplicated by sequence, and folds every event into the given builder store
 * through its own `applyRunEvent` — the SAME reducer the builder's overlay uses,
 * so a run view and the builder paint a node identically. Returns the ordered
 * events (for `RunHandoffMap` / `RunStepInspector`) and the read state; a failed
 * read is said, never shown as an empty run.
 */
import { useEffect, useState } from 'react';
import type { StoreApi } from 'zustand';
import type { RunEventDoc } from '@openwop/openwop';
import { pollEvents } from '../client/runsClient.js';
import { subscribeToRun } from '../client/streamsClient.js';
import type { BuilderState } from '../builder/store/builderStore.js';

export type LiveRunRead = 'loading' | 'ready' | 'failed';

export function useLiveRunOverlay(store: StoreApi<BuilderState> | null, runId: string, backendIdToBuilder: Record<string, string> | null): { events: RunEventDoc[]; read: LiveRunRead } {
  const [events, setEvents] = useState<RunEventDoc[]>([]);
  const [read, setRead] = useState<LiveRunRead>('loading');
  // A stream the host or a proxy closed (idle/absolute timeout) is re-opened, and
  // the log re-read (de-duplicated), so a long gate wait never freezes the view.
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!store || !backendIdToBuilder) return undefined;
    let cancelled = false;
    const seen = new Set<number>();
    let initializing = true;
    const buffered = new Map<number, RunEventDoc>();
    // The overlay keys events by the run id it was started with; the log and
    // the stream may spell it bound or bare, so every event is applied under it.
    const apply = (ev: RunEventDoc): void => {
      if (seen.has(ev.sequence)) return;
      seen.add(ev.sequence);
      store.getState().applyRunEvent({ ...ev, runId });
      setEvents((prev) => [...prev, ev].sort((a, b) => a.sequence - b.sequence));
    };
    store.getState().startOverlay(runId, backendIdToBuilder);
    setEvents([]);
    setRead('loading');
    void (async () => {
      try {
        const polled = await pollEvents(runId, 0);
        if (cancelled) return;
        // A live completion can arrive before the older initial poll. Paint the
        // merged history in sequence order so that older reads cannot rewind it.
        for (const ev of polled.events) buffered.set(ev.sequence, ev);
        for (const ev of [...buffered.values()].sort((a, b) => a.sequence - b.sequence)) apply(ev);
        buffered.clear();
        initializing = false;
        setRead('ready');
      } catch {
        if (!cancelled) {
          for (const ev of [...buffered.values()].sort((a, b) => a.sequence - b.sequence)) apply(ev);
          buffered.clear(); initializing = false; setRead('failed');
        }
      }
    })();
    const sub = subscribeToRun(runId, {
      // A campaign run waits on review gates for long stretches.
      idleTimeoutMs: 10 * 60_000,
      absoluteTimeoutMs: 60 * 60_000,
      onEvent: (ev) => {
        if (cancelled) return;
        if (initializing) buffered.set(ev.sequence, ev);
        else apply(ev);
      },
      onTimeout: () => { if (!cancelled) setEpoch((e) => e + 1); },
    });
    return () => { cancelled = true; sub.close(); };
  }, [store, runId, backendIdToBuilder, epoch]);

  return { events, read };
}
