/**
 * ADR 0773 G-06a — "your hands are narrated too" (design principle 04).
 *
 * Between turns, the person's own canvas edits are summarised into ONE quiet
 * line in the Pair panel ("You connected Enrich → Score lead · renamed Score").
 * It is a display for the person, not a message stream to the model: the
 * Architect reads the effect of these edits through `read-canvas` (the flushed
 * draft), so nothing is sent per keystroke.
 *
 * Excluded by construction:
 *  - a KEPT suggestion (applied while `isNarrationPaused()`): that edit is the
 *    AI's and already has its receipt;
 *  - position-only moves (a drag is layout, not a change — ADR 0770 D4 strips
 *    position from both revision hashes for the same reason).
 */

import i18n from '../../i18n/index.js';
import { useBuilderStore } from '../store/builderStore.js';
import type { BuilderEdge, BuilderNode } from '../schema/workflow.js';
import { isNarrationPaused, usePairStore } from './pairStore.js';

const DEBOUNCE_MS = 1200;
const MAX_PHRASES = 3;

interface Snap { nodes: readonly BuilderNode[]; edges: readonly BuilderEdge[] }

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Describe what changed between two graphs, ignoring layout. Pure. */
export function describeEdits(before: Snap, after: Snap): string[] {
  const beforeById = new Map(before.nodes.map((n) => [n.id, n]));
  const afterById = new Map(after.nodes.map((n) => [n.id, n]));
  const nameOf = (id: string): string => afterById.get(id)?.name ?? beforeById.get(id)?.name ?? id;
  const out: string[] = [];
  for (const n of after.nodes) {
    const was = beforeById.get(n.id);
    if (!was) { out.push(i18n.t('builder:pairNarrAdded', { name: n.name })); continue; }
    if (was.name !== n.name) out.push(i18n.t('builder:pairNarrRenamed', { from: was.name, to: n.name }));
    if (!sameJson(was.config, n.config) || !sameJson(was.inputs ?? {}, n.inputs ?? {})) out.push(i18n.t('builder:pairNarrConfigured', { name: n.name }));
  }
  for (const n of before.nodes) if (!afterById.has(n.id)) out.push(i18n.t('builder:pairNarrRemoved', { name: n.name }));
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));
  for (const e of after.edges) {
    const was = beforeEdges.get(e.id);
    if (!was) out.push(i18n.t('builder:pairNarrConnected', { from: nameOf(e.source), to: nameOf(e.target) }));
    else if (!sameJson(was.condition, e.condition)) out.push(i18n.t('builder:pairNarrCondition', { from: nameOf(e.source), to: nameOf(e.target) }));
  }
  for (const e of before.edges) if (!afterEdges.has(e.id)) out.push(i18n.t('builder:pairNarrDisconnected', { from: nameOf(e.source), to: nameOf(e.target) }));
  return out;
}

/** Compose the phrases into one line ("You connected A → B · renamed C · +2 more"). */
export function narrationLine(phrases: readonly string[]): string | null {
  if (phrases.length === 0) return null;
  const shown = phrases.slice(0, MAX_PHRASES).join(' · ');
  const more = phrases.length - MAX_PHRASES;
  return i18n.t('builder:pairNarrLine', { changes: more > 0 ? `${shown} · ${i18n.t('builder:pairNarrMore', { count: more })}` : shown });
}

/** Start narrating builder edits into the pair store. Returns a stop function. */
export function startNarration(): () => void {
  let baseline: Snap = { nodes: useBuilderStore.getState().nodes, edges: useBuilderStore.getState().edges };
  let baselineWorkflow = useBuilderStore.getState().workflowId;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    timer = undefined;
    const s = useBuilderStore.getState();
    const now: Snap = { nodes: s.nodes, edges: s.edges };
    const line = narrationLine(describeEdits(baseline, now));
    baseline = now;
    if (line) usePairStore.getState().pushNarration(line);
  };

  const unsub = useBuilderStore.subscribe((state, prev) => {
    if (state.nodes === prev.nodes && state.edges === prev.edges && state.workflowId === prev.workflowId) return;
    // A workflow switch or a load is not an edit.
    if (state.workflowId !== baselineWorkflow) {
      baselineWorkflow = state.workflowId;
      baseline = { nodes: state.nodes, edges: state.edges };
      if (timer) { clearTimeout(timer); timer = undefined; }
      return;
    }
    // A kept suggestion is the AI's edit — move the baseline past it silently.
    if (isNarrationPaused()) {
      // Settle any pending MANUAL edits against the state just BEFORE the keep,
      // so the AI's change is never narrated as the person's.
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        const line = narrationLine(describeEdits(baseline, { nodes: prev.nodes, edges: prev.edges }));
        if (line) usePairStore.getState().pushNarration(line);
      }
      baseline = { nodes: state.nodes, edges: state.edges };
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  });

  return () => {
    unsub();
    if (timer) clearTimeout(timer);
  };
}
