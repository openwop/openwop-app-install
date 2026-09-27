/**
 * useRunAnnotations — §C3. Fetches RFC 0056 annotations for a set of runs,
 * gated on `capabilities.feedback`, and exposes review classification so the
 * runs index can surface a "flagged for review" queue. Returns an empty map
 * (feedbackOn=false) against a host that doesn't advertise feedback, so every
 * caller degrades to a no-op there.
 *
 * Shared by RunsIndexPage's flagged filter and its §C2 quality rollup, so the
 * per-run `GET /v1/runs/{id}/annotations` fan-out happens exactly once.
 */
import { useEffect, useState } from 'react';
import { getFeedbackCapability, listAnnotations, type Annotation } from '../client/feedbackClient.js';
import i18n from '../i18n/index.js';

export interface RunReview {
  flagged: boolean; // ≥1 flag signal
  lowRated: boolean; // ≥1 rating ≤ 2
  corrected: boolean; // ≥1 correction
}

/** Classify a run's annotations for the review queue. */
export function reviewOf(anns: readonly Annotation[]): RunReview {
  let flagged = false;
  let lowRated = false;
  let corrected = false;
  for (const a of anns) {
    if (a.signal.kind === 'flag') flagged = true;
    else if (a.signal.kind === 'rating' && typeof a.signal.rating === 'number' && a.signal.rating <= 2) lowRated = true;
    else if (a.signal.kind === 'correction') corrected = true;
  }
  return { flagged, lowRated, corrected };
}

/** True when a run carries any "this went wrong" signal worth triaging. */
export function needsReview(r: RunReview): boolean {
  return r.flagged || r.lowRated || r.corrected;
}

/** Human-readable reason(s) a run is in the review queue (for a tooltip). */
export function reviewReason(r: RunReview): string {
  const parts: string[] = [];
  if (r.flagged) parts.push(i18n.t('runs:reviewReasonFlagged'));
  if (r.lowRated) parts.push(i18n.t('runs:reviewReasonLowRated'));
  if (r.corrected) parts.push(i18n.t('runs:reviewReasonCorrected'));
  return parts.join(' · ');
}

interface RunAnnotations {
  byRun: Map<string, readonly Annotation[]>;
  feedbackOn: boolean;
  /** RUN-R2-1 — true when ≥1 per-run annotation read FAILED this pass. The
   *  flagged count is then a floor, not a fact; the index says so instead of
   *  rendering a confident "flagged (0)". */
  degraded: boolean;
}

// Per-run annotation cache (GAP-ANALYSIS E3). The Runs index fans out one
// `GET /v1/runs/{id}/annotations` per visible run; without a cache, navigating
// away and back re-fires the whole fan-out against the per-IP read budget.
// Short TTL keeps the flagged queue fresh while collapsing repeat loads.
const ANN_TTL_MS = 60_000;
const annCache = new Map<string, { value: readonly Annotation[]; at: number }>();
// RUN-R2-1 — a FAILED read is never cached: the old client fabricated `[]` on
// any failure and this cache then served that lie for a full TTL. Only a real
// answer may enter the cache; a rejection propagates to the caller.
async function listAnnotationsCached(runId: string): Promise<readonly Annotation[]> {
  const hit = annCache.get(runId);
  if (hit && Date.now() - hit.at < ANN_TTL_MS) return hit.value;
  const value = await listAnnotations(runId);
  annCache.set(runId, { value, at: Date.now() });
  return value;
}

/** Fetch annotations for `runIds`, capability-gated. The dedup key is the
 *  joined id list so the effect re-runs only when the set actually changes. */
export function useRunAnnotations(runIds: readonly string[]): RunAnnotations {
  const [byRun, setByRun] = useState<Map<string, readonly Annotation[]>>(new Map());
  const [feedbackOn, setFeedbackOn] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const key = runIds.join(',');

  useEffect(() => {
    const ids = key ? key.split(',') : [];
    let cancelled = false;
    void (async () => {
      const cap = await getFeedbackCapability();
      if (cancelled) return;
      if (!cap || ids.length === 0) {
        setFeedbackOn(false);
        setByRun(new Map());
        setDegraded(false);
        return;
      }
      setFeedbackOn(true);
      // RUN-R2-1 — allSettled, not all: one failed read must neither sink the
      // whole fan-out nor masquerade as "no annotations". Fulfilled runs keep
      // their real answer; any rejection marks the pass degraded so the index
      // reports the flagged count as a floor, not a fact.
      const lists = await Promise.allSettled(ids.map((id) => listAnnotationsCached(id)));
      if (cancelled) return;
      const next = new Map<string, readonly Annotation[]>();
      let anyFailed = false;
      ids.forEach((id, i) => {
        const r = lists[i]!;
        if (r.status === 'fulfilled') next.set(id, r.value);
        else anyFailed = true;
      });
      setByRun(next);
      setDegraded(anyFailed);
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { byRun, feedbackOn, degraded };
}
