/**
 * ADR 0773 D5/D6 — the Inspector's pairing affordances. Each self-gates on the
 * `builder-pair` toggle, so the core Inspector renders them unconditionally and
 * stays identical when pairing is off.
 *
 *  - `SuggestionDiffCard`: the pending ops that touch the selected node/edge,
 *    as tracked changes (the preimage struck through beside the proposed value)
 *    with keep/drop — review happens where the change lands.
 *  - `FillWithAi`: a per-field inline ask scoped to `{node, field}`.
 *  - `EdgeAsk`: point-and-ask on an edge ("insert a step here", "only when …").
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { WandIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useBuilderStore } from '../store/builderStore.js';
import { conditionLabel, isValueOp, liveOpStatuses, readConfigPath, type EditOp, type Preimage } from './suggestionModel.js';
import { listWorkflowRevisions } from '../../workflows/workflowsClient.js';
import { catalogEntry, useCatalog } from '../palette/catalogRegistry.js';
import { isPortCompatible } from '../canvas/portCompatibility.js';
import { confirm } from '../../ui/confirm.js';
import { usePairStore } from './pairStore.js';
import { QuickAsk } from './QuickAsk.js';
import { opSummary } from './opSummary.js';

export const BUILDER_PAIR_TOGGLE = 'builder-pair';

const show = (v: unknown): string => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

function proposedOf(op: EditOp): string {
  switch (op.kind) {
    case 'setConfig': return show(op.value);
    case 'renameNode': return op.name;
    case 'setCondition': return op.condition ? conditionLabel(op.condition) : '—';
    case 'removeNode': case 'removeEdge': return '';
    default: return '';
  }
}

function previousOf(pre: Preimage | undefined): string {
  if (!pre || !pre.present) return '—';
  if (pre.value && typeof pre.value === 'object' && 'path' in (pre.value as object) && 'op' in (pre.value as object)) {
    return conditionLabel(pre.value as Parameters<typeof conditionLabel>[0]);
  }
  return show(pre.value);
}

function touches(op: EditOp, target: { nodeId?: string; edgeId?: string }): boolean {
  if (target.nodeId) return 'nodeId' in op && op.nodeId === target.nodeId;
  if (target.edgeId) return 'edgeId' in op && op.edgeId === target.edgeId;
  return false;
}

export function SuggestionDiffCard(target: { nodeId?: string; edgeId?: string }): JSX.Element | null {
  const { t } = useTranslation('builder');
  const { enabled } = useFeatureAccess(BUILDER_PAIR_TOGGLE);
  const suggestion = usePairStore((s) => s.suggestion);
  const opState = usePairStore((s) => s.opState);
  const focusedOp = usePairStore((s) => s.focusedOp);
  const nodes = useBuilderStore((s) => s.nodes);
  const edges = useBuilderStore((s) => s.edges);
  const workflowId = useBuilderStore((s) => s.workflowId);
  const statuses = useMemo(
    () => (suggestion ? liveOpStatuses(suggestion, { nodes, edges }, opState) : []),
    [suggestion, nodes, edges, opState],
  );
  const anyStale = statuses.includes('stale');
  // G-03g — WHO changed it: the head revision's recorded author, by display
  // name. Unknown ⇒ "someone" — never a guess.
  const [changedBy, setChangedBy] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !anyStale || !workflowId) { setChangedBy(null); return; }
    let live = true;
    void listWorkflowRevisions(workflowId)
      .then((rows) => { if (live) setChangedBy(rows.find((r) => r.isHead)?.createdByName ?? null); })
      .catch(() => { if (live) setChangedBy(null); });
    return () => { live = false; };
  }, [enabled, anyStale, workflowId]);
  const [edits, setEdits] = useState<Record<number, string>>({});
  if (!enabled || !suggestion || suggestion.workflowId !== workflowId) return null;
  const rows = suggestion.ops
    .map((o, i) => ({ o, i, st: statuses[i] }))
    .filter((r) => (r.st === 'pending' || r.st === 'stale') && touches(r.o.op, target));
  if (rows.length === 0) return null;
  const store = usePairStore.getState;

  return (
    <section className="pair-diff" aria-label={t('pairDiffAria')}>
      {rows.map(({ o, i, st }) => {
        const pre = o.preimages[0];
        const liveValue = o.op.kind === 'setConfig'
          ? show(readConfigPath(nodes.find((n) => n.id === (o.op as { nodeId: string }).nodeId)?.config, o.op.path).value)
          : null;
        return (
          <div key={i} className={`pair-diff__row${focusedOp === i ? ' is-focused' : ''}${st === 'stale' ? ' is-stale' : ''}`}>
            <div className="pair-diff__head">
              <span className="pair-op__num" aria-hidden>{i + 1}</span>
              <span className="u-fs-12">{opSummary(o, { ops: suggestion.ops, nodes })}</span>
            </div>
            {o.op.kind === 'removeNode' || o.op.kind === 'removeEdge' ? (
              <p className="pair-diff__remove u-fs-12">{t('pairDiffRemoves')}</p>
            ) : (
              <p className="pair-diff__values">
                <del className="pair-diff__old">{st === 'stale' && liveValue !== null ? liveValue : previousOf(pre)}</del>
                <ins className="pair-diff__new">{proposedOf(o.op)}</ins>
              </p>
            )}
            {o.why ? <p className="pair-diff__why u-fs-12">{o.why}</p> : null}
            {/* G-03e — edit the proposed value, then keep the edited one. */}
            {(o.op.kind === 'setConfig' || o.op.kind === 'renameNode') && st === 'pending' ? (
              <label className="pair-diff__edit u-fs-12">
                <span>{t('pairEditValue')}</span>
                <input
                  className="pair-diff__edit-input"
                  value={edits[i] ?? proposedOf(o.op)}
                  onChange={(e) => setEdits({ ...edits, [i]: e.target.value })}
                />
              </label>
            ) : null}
            {st === 'stale' ? (
              <p className="pair-diff__stale u-fs-12">
                {changedBy ? t('pairDiffStaleBy', { name: changedBy }) : t('pairDiffStale')}
              </p>
            ) : null}
            <div className="pair-diff__actions">
              <Button size="sm" variant="quiet" onClick={() => store().drop([i])}>{st === 'stale' ? t('pairKeepTheirs') : t('pairDrop')}</Button>
              {st === 'pending' ? (
                edits[i] !== undefined && edits[i] !== proposedOf(o.op) ? (
                  <Button size="sm" variant="accent" onClick={() => { store().keepEdited(i, parseEdited(edits[i]!, o.op)); setEdits((prev) => { const next = { ...prev }; delete next[i]; return next; }); }}>{t('pairKeepEdited')}</Button>
                ) : (
                  <Button size="sm" variant="accent" onClick={() => store().keep([i])}>{t('pairKeep')}</Button>
                )
              ) : (
                <>
                  <Button size="sm" variant="secondary" onClick={() => store().ask(t('pairRedoPrompt', { n: i + 1, summary: opSummary(o, { ops: suggestion.ops, nodes }) }))}>{t('pairAskRedo')}</Button>
                  {isValueOp(o.op) ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => {
                        void confirm({ title: t('pairUseAiConfirmTitle'), body: t('pairUseAiConfirmBody', { summary: opSummary(o, { ops: suggestion.ops, nodes }) }), confirmLabel: t('pairUseAi') })
                          .then((ok) => { if (ok) store().forceKeep(i); });
                      }}
                    >
                      {t('pairUseAi')}
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function FillWithAi({ nodeName, fieldLabel }: { nodeName: string; fieldLabel: string }): JSX.Element | null {
  const { t } = useTranslation('builder');
  const { enabled } = useFeatureAccess(BUILDER_PAIR_TOGGLE);
  if (!enabled) return null;
  return (
    <Button
      size="sm"
      variant="link"
      className="pair-fill"
      aria-label={t('pairFillAria', { field: fieldLabel })}
      onClick={() => usePairStore.getState().ask(t('pairFillPrompt', { field: fieldLabel, name: nodeName }))}
    >
      <WandIcon size={12} aria-hidden /> {t('pairFill')}
    </Button>
  );
}

export function EdgeAsk({ fromName, toName }: { fromName: string; toName: string }): JSX.Element | null {
  const { t } = useTranslation('builder');
  const { enabled } = useFeatureAccess(BUILDER_PAIR_TOGGLE);
  if (!enabled) return null;
  return (
    <div className="pair-edge-ask">
      <div className="builder-inspector-section-label">{t('pairEdgeAskLabel')}</div>
      <QuickAsk inline framing={t('pairEdgeFraming', { from: fromName, to: toName })} />
      <p className="muted u-fs-12 u-m-0">{t('pairEdgeAskHint')}</p>
    </div>
  );
}

/** ADR 0773 D6 — the palette's "from your words" row: a search that matches no
 *  node offers to describe the step to the Architect instead. */
export function PaletteDescribe({ query }: { query: string }): JSX.Element | null {
  const { t } = useTranslation('builder');
  const { enabled } = useFeatureAccess(BUILDER_PAIR_TOGGLE);
  if (!enabled || !query.trim()) return null;
  return (
    <Button
      size="sm"
      variant="accent"
      className="pair-palette-describe"
      onClick={() => usePairStore.getState().ask(t('pairPaletteDescribePrompt', { query: query.trim() }))}
    >
      <WandIcon size={12} aria-hidden /> {t('pairPaletteDescribe')}
    </Button>
  );
}

/** An edited value back to the op's type: JSON when it parses (numbers, booleans,
 *  objects), else the raw string. A rename is always a string. */
function parseEdited(text: string, op: EditOp): unknown {
  if (op.kind === 'renameNode') return text;
  try { return JSON.parse(text); } catch { return text; }
}

/** ADR 0773 G-01f — "Suggested here": steps whose input fits the selected
 *  node's output, by the same port rule the drop picker uses. Deterministic —
 *  no model call. Clicking adds the step already connected (one undo step). */
export function PaletteSuggestions(): JSX.Element | null {
  const { t } = useTranslation('builder');
  const { enabled } = useFeatureAccess(BUILDER_PAIR_TOGGLE);
  const catalog = useCatalog();
  const selectedId = useBuilderStore((s) => (s.selectedNodeIds.length === 1 ? s.selectedNodeIds[0] : s.selectedNodeId));
  const node = useBuilderStore((s) => s.nodes.find((n) => n.id === selectedId));
  if (!enabled || !node) return null;
  const out = catalogEntry(node.kind)?.outputs[0];
  if (!out) return null;
  const fits = catalog.filter((e) => !e.clientOnly && e.inputs.some((p) => isPortCompatible(out.type, p.type)));
  if (fits.length === 0) return null;
  const shown = fits.slice(0, 4);
  const add = (kind: string): void => {
    const entry = catalogEntry(kind);
    const inPort = entry?.inputs.find((p) => isPortCompatible(out.type, p.type))?.name;
    if (!entry || !inPort) return;
    useBuilderStore.getState().addConnectedNode(kind, { x: node.position.x, y: node.position.y + 140 }, { source: node.id, sourcePort: out.name, targetPort: inPort });
  };
  return (
    <section className="pair-palette-suggest" aria-label={t('pairSuggestedHere', { name: node.name })}>
      <p className="builder-palette-subgroup-name u-m-0">{t('pairSuggestedHere', { name: node.name })}</p>
      {shown.map((e) => (
        <Button key={e.kind} size="sm" variant="quiet" className="pair-palette-suggest__item" onClick={() => add(e.kind)}>
          <span className="pair-chip__dot" style={{ background: e.accent }} aria-hidden /> {e.label}
        </Button>
      ))}
      {fits.length > shown.length ? <p className="muted u-fs-12 u-m-0">{t('pairSuggestedMore', { count: fits.length - shown.length })}</p> : null}
    </section>
  );
}
