/**
 * ADR 0784 P3 — the receipt's read/write lookup, cached per tool name for the
 * session. A name the server does not know is cached as `null` (asked once,
 * never re-asked). A failed read caches NOTHING: the receipt keeps its neutral
 * "N tools" and the next render may ask again — a failure is never recorded as
 * "unknown tool", and never as a read.
 */
import { useEffect, useState } from 'react';
import { getToolEffects } from '../../client/chatSessionsClient.js';

export type ToolEffect = 'read' | 'write';
const cache = new Map<string, ToolEffect | null>();
const listeners = new Set<() => void>();
const inFlight = new Set<string>();

function ask(names: readonly string[]): void {
  const missing = [...new Set(names)].filter((n) => !cache.has(n) && !inFlight.has(n));
  if (missing.length === 0) return;
  for (const n of missing) inFlight.add(n);
  getToolEffects(missing).then(
    (effects) => {
      for (const n of missing) cache.set(n, effects[n] ?? null);
      for (const l of [...listeners]) l();
    },
    () => { /* nothing cached: neutral copy stays, a later render may retry */ },
  ).finally(() => { for (const n of missing) inFlight.delete(n); });
}

/** The known effects for these tool names (absent until answered). */
export function useToolEffects(names: readonly string[]): ReadonlyMap<string, ToolEffect> {
  const key = [...new Set(names)].sort().join(',');
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    if (key) ask(key.split(','));
    return () => { listeners.delete(l); };
  }, [key]);
  const out = new Map<string, ToolEffect>();
  for (const n of names) { const e = cache.get(n); if (e) out.set(n, e); }
  return out;
}

/** Test seam: forget everything cached. */
export function _resetToolEffectsCache(): void { cache.clear(); inFlight.clear(); }
