/**
 * ADR 0960 D3 — one run's graph, live, read-only. NOT a second graph renderer:
 * it is the builder's canvas (`BuilderCanvas`) over an isolated read-only store
 * (`createReadOnlyBuilderStore`), painted by the builder's own overlay reducer
 * through `useLiveRunOverlay`. The user's builder draft is never touched.
 *
 * The caller supplies the definition the run EXECUTED (its pinned revision, from
 * a campaign-scoped read), so the graph matches what ran. Node types the host no
 * longer knows make the graph unrenderable; that is said, with the run page as
 * the way on — never an empty canvas.
 *
 * Lazy-load this module (`lazy(() => import(...))`): it pulls in the canvas.
 * Its copy comes from the caller (`labels`), so its strings ride the caller's
 * lazily loaded namespace rather than the eagerly loaded `runs` one.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RunEventDoc } from '@openwop/openwop';
import { BuilderCanvas } from '../builder/canvas/BuilderCanvas.js';
import { CanvasStoreContext } from '../builder/store/canvasStore.js';
import { createReadOnlyBuilderStore, loadReadOnlyGraph } from '../builder/store/readOnlyBuilderStore.js';
import { fromCanonicalDefinition } from '../builder/schema/deserialize.js';
import { loadDynamicCatalog } from '../builder/palette/catalogRegistry.js';
import { InlineState } from '../ui/InlineState.js';
import { Notice } from '../ui/Notice.js';
import { useLiveRunOverlay } from './liveRunOverlay.js';

type Graph = { kind: 'loading' } | { kind: 'unrenderable'; reason: string } | { kind: 'ready'; idMap: Record<string, string> };

export interface RunGraphLabels { loading: string; unrenderable: string; openRun: string; aria: string; eventsFailed: string }

export function RunGraphView({ runId, workflowId, definition, onEvents, labels }: {
  runId: string;
  labels: RunGraphLabels;
  workflowId: string;
  definition: unknown;
  /** The ordered run events, for the panels beside the graph. */
  onEvents?: (events: RunEventDoc[]) => void;
}): JSX.Element {
  const store = useMemo(() => createReadOnlyBuilderStore(), []);
  const [graph, setGraph] = useState<Graph>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setGraph({ kind: 'loading' });
    void (async () => {
      // Node chrome comes from the host catalog; a type it does not know cannot be drawn.
      await loadDynamicCatalog().catch(() => undefined);
      try {
        const parsed = fromCanonicalDefinition(definition);
        if (cancelled) return;
        loadReadOnlyGraph(store, { workflowId, name: parsed.name, nodes: parsed.nodes, edges: parsed.edges });
        // A loaded definition keeps the host's node ids, so the overlay map is the identity.
        setGraph({ kind: 'ready', idMap: Object.fromEntries(parsed.nodes.map((n) => [n.id, n.id])) });
      } catch (err) {
        if (!cancelled) setGraph({ kind: 'unrenderable', reason: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [store, workflowId, definition]);

  const live = useLiveRunOverlay(graph.kind === 'ready' ? store : null, runId, graph.kind === 'ready' ? graph.idMap : null);
  useEffect(() => { onEvents?.(live.events); }, [live.events, onEvents]);

  if (graph.kind === 'loading') return <InlineState kind="loading" message={labels.loading} />;
  if (graph.kind === 'unrenderable') {
    return (
      <Notice variant="warning" announce={labels.unrenderable}>
        {labels.unrenderable} {graph.reason}{' '}
        <Link className="inline-link" to={`/runs/${encodeURIComponent(runId)}`}>{labels.openRun}</Link>
      </Notice>
    );
  }
  return (
    <div className="run-graph-view" role="region" aria-label={labels.aria}>
      {live.read === 'failed' ? <Notice variant="error" announce={labels.eventsFailed}>{labels.eventsFailed}</Notice> : null}
      <CanvasStoreContext.Provider value={store}>
        <BuilderCanvas />
      </CanvasStoreContext.Provider>
    </div>
  );
}
