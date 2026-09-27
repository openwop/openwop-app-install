/**
 * Campaign funnel board (ADR 0360 / §7.12 CV-9) — the `graph` trait over the
 * campaign doc's FUNNEL collection. Stored `x`/`y` per stage (host-additive,
 * validator-clamped 0–4000); the chain EDGES DERIVE FROM ARRAY ORDER — no
 * connector storage (a funnel is a sequence; reordering stays the element
 * list). `connect` rejects and `deleteEdge` no-ops by design (derived edges
 * have no identity). Node ids encode the positional index (`funnel-<i>`) and
 * `elementForNode` bridges board selection to the ONE elements selection, so
 * the existing property panel edits the stage.
 */
import { useTranslation } from 'react-i18next';
import type { GraphTraitDef, GraphNodeView, GraphEdgeView } from '../../canvas/types.js';
import type { CampaignDoc } from './definition.js';

const NODE_W = 220;
const NODE_H = 120;
const GRID = 20;
const POS_MAX = 4000; // mirrors the backend validator clamp (ADR 0360)

const clampPos = (v: number): number => Math.max(0, Math.min(POS_MAX, Math.round(v / GRID) * GRID));

const funnelOf = (doc: CampaignDoc): Record<string, unknown>[] => (Array.isArray(doc.funnel) ? doc.funnel : []);

const NODE_ID = /^funnel-(\d+)$/;
const idxOf = (id: string): number | null => {
  const m = NODE_ID.exec(id);
  return m ? Number(m[1]) : null;
};

/** Stage card body — localized stage title + description snippet + KPI count. */
function CampaignStageNode({ node }: { node: GraphNodeView }): JSX.Element {
  const { t } = useTranslation('campaign-studio');
  const data = (node.data ?? {}) as Record<string, unknown>;
  const stage = typeof data.stage === 'string' ? data.stage : '';
  const desc = typeof data.description === 'string' ? data.description : '';
  const kpis = Array.isArray(data.kpis) ? data.kpis.length : 0;
  return (
    <div className="campaign-stage-node">
      <div className="campaign-stage-node__title">{stage ? t(`stage_${stage}`) : node.label}</div>
      {desc ? <div className="campaign-stage-node__desc">{desc.length > 90 ? `${desc.slice(0, 90)}…` : desc}</div> : null}
      {kpis > 0 ? <div className="campaign-stage-node__kpis">{t('boardKpiCount', { count: kpis })}</div> : null}
    </div>
  );
}

export const campaignGraph: GraphTraitDef<CampaignDoc> = {
  // The board is the campaign's primary surface (the CV-9 intent).
  defaultView: 'graph',
  nodeSize: { w: NODE_W, h: NODE_H },
  gridSnap: GRID,

  nodes: (doc): GraphNodeView[] => funnelOf(doc).map((s, i) => ({
    id: `funnel-${i}`,
    label: typeof s.stage === 'string' ? s.stage : `#${i + 1}`,
    ...(typeof s.x === 'number' ? { x: s.x } : {}),
    ...(typeof s.y === 'number' ? { y: s.y } : {}),
    data: s,
  })),

  // The chain derives from array order — stage i flows into stage i+1.
  edges: (doc): GraphEdgeView[] => funnelOf(doc).slice(1).map((_, i) => ({
    id: `chain-${i}`,
    from: `funnel-${i}`,
    to: `funnel-${i + 1}`,
  })),

  moveNode: (doc, id, x, y) => {
    const i = idxOf(id);
    const s = i === null ? undefined : funnelOf(doc)[i];
    if (s) { s.x = clampPos(x); s.y = clampPos(y); }
  },

  // Free edges are not the model (ADR 0360): the sequence IS the chain —
  // connect/deleteEdge are OMITTED (grade pass: the surface then renders NO
  // connect affordances; an always-failing gesture was dishonest chrome).

  renderNode: (node) => <CampaignStageNode node={node} />,

  // Board selection drives the ONE elements selection (panel + list in sync).
  elementForNode: (id) => {
    const i = idxOf(id);
    return i === null ? null : { col: 'funnel', idx: i };
  },
};
