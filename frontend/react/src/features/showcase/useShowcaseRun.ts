import { useCallback, useEffect, useState } from 'react';
import type { RunEventDoc, RunSnapshot } from '@openwop/openwop';
import { getRun, pollEvents } from '../../client/runsClient.js';
import { subscribeToRun } from '../../client/streamsClient.js';
import { getWorkflowDefinitionRaw } from '../../client/workflowsClient.js';
import { listOpenInterrupts, type OpenInterrupt } from '../../client/interruptsClient.js';
import { isShowcaseDefinition, mergeEvents, terminal } from './model.js';

export function useShowcaseRun(runId: string | null) {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [definition, setDefinition] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<RunEventDoc[]>([]);
  const [interrupts, setInterrupts] = useState<readonly OpenInterrupt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce(n => n + 1), []);
  useEffect(() => {
    setSnapshot(null); setDefinition(null); setEvents([]); setInterrupts([]); setError(null); setConnected(false);
    if (!runId) return;
    let active = true, busy = false, finished = false, validated = false;
    let cachedDefinition: Record<string, unknown> | null = null;
    let subscription: { close(): void } | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    async function hydrate() {
      if (busy || !active) return;
      busy = true;
      try {
        const [snap, log, gates] = await Promise.all([getRun(runId!), pollEvents(runId!, -1), listOpenInterrupts(runId!)]);
        const def = cachedDefinition ?? await getWorkflowDefinitionRaw(snap.workflowId);
        if (!def || !isShowcaseDefinition(def)) throw new Error('This run is not a launch showcase. Open it in Runs to inspect its workflow.');
        if (!active) return;
        cachedDefinition = def; validated = true;
        setSnapshot(snap); setDefinition(def); setInterrupts(gates);
        setEvents(prev => mergeEvents(prev, log.events, runId!));
        setError(null);
        finished = terminal(snap.status);
        if (finished) { subscription?.close(); setConnected(false); if (interval) clearInterval(interval); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : String(e)); }
      finally { busy = false; }
    }
    // Hydrate and validate before subscribing: no unrelated run is projected here.
    void hydrate().then(() => {
      if (!active || finished || !validated) return;
      subscription = subscribeToRun(runId, {
        idleTimeoutMs: 5 * 60_000, absoluteTimeoutMs: 30 * 60_000,
        onEvent: e => {
          if (!active) return;
          setConnected(true);
          setEvents(prev => mergeEvents(prev, [e], runId));
          if (e.type.startsWith('run.') || e.type === 'node.suspended' || e.type.includes('interrupt')) void hydrate();
        },
        onError: () => { if (active) setConnected(false); },
        onClose: () => { if (active) setConnected(false); },
        onTimeout: () => { if (active) setConnected(false); },
      });
      // Serialized recovery reads, never a simulated step clock. Also catches
      // a missed terminal/approval event; SSE remains the low-latency channel.
      interval = setInterval(() => { void hydrate(); }, 5000);
    });
    return () => { active = false; subscription?.close(); if (interval) clearInterval(interval); };
  }, [runId, nonce]);
  return { snapshot, definition, events, interrupts, error, connected, refresh };
}
