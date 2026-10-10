/**
 * ADR 0773 D1–D3 — the Pair tab: the ONE chat (`chat/EmbeddedChatPanel`, lazy —
 * the builder must lazy-import it, CLAUDE.md) scoped to the Workflow Architect,
 * plus what only the builder knows: what the Architect can see (the ADR 0768 P4
 * "can see" slot), the selection chips, and the active suggestion's review card.
 *
 * `beforeSend` is the honesty hinge (D3): it flushes autosave and publishes the
 * pairing context, and a failure BLOCKS the turn — the strip never claims the
 * Architect sees a canvas it could not read.
 */

import { lazy, Suspense, useCallback, useMemo, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../ui/icons/index.js';
import { Button } from '../../ui/Button.js';
import { useBuilderStore } from '../store/builderStore.js';
import { catalogEntry } from '../palette/catalogRegistry.js';
import { WorkflowAuthorWelcome } from '../WorkflowAuthorWelcome.js';
import { SuggestionReview } from './SuggestionReview.js';
import { usePairStore, RUN_STEP_CITE_MIME } from './pairStore.js';
import type { EmbedToolActivity } from '../../chat/EmbeddedChatPanel.js';

const EmbeddedChatPanel = lazy(() =>
  import('../../chat/EmbeddedChatPanel.js').then((m) => ({ default: m.EmbeddedChatPanel })),
);

/** The agent the Pair tab scopes the chat to (ADR 0072 pack). */
export const WORKFLOW_ARCHITECT_AGENT_ID = 'vendor.openwop-app.workflow-author.agents.workflow-architect';

/** The palette's native drag payload (NodePalette sets it). */
const PALETTE_DRAG_TYPE = 'application/openwop-node-kind';
/** G-02d — a canvas node's cite handle (BaseNode `NODE_CITE_MIME`). */
const NODE_CITE_TYPE = 'application/openwop-node-id';

export function PairPanel(): JSX.Element {
  const { t } = useTranslation('builder');
  const prompt = usePairStore((s) => s.prompt);
  const phase = usePairStore((s) => s.phase);
  const cited = usePairStore((s) => s.cited);
  const lastRunId = usePairStore((s) => s.lastRunId);
  const roomCount = usePairStore((s) => s.roomSuggestions.length);
  const lastError = usePairStore((s) => s.lastError);
  const narration = usePairStore((s) => s.narration);
  const stopSignal = usePairStore((s) => s.stopSignal);
  const followUps = usePairStore((s) => s.suggestion?.followUps);
  const diagnoseNodeId = usePairStore((s) => s.diagnoseNodeId);
  // G-04b — the failed run's host-recorded facts for the node Diagnose is about
  // (from the run overlay the builder already holds — never from the model).
  const failedDetail = useBuilderStore((s) => (diagnoseNodeId && s.overlay ? s.overlay.nodeDetail[diagnoseNodeId] : undefined));
  const failedName = useBuilderStore((s) => (diagnoseNodeId ? s.nodes.find((n) => n.id === diagnoseNodeId)?.name : undefined));
  // Stable slices only; derive in memos (a fresh array from a zustand v5
  // selector re-renders forever — the Inspector's recorded lesson).
  const allNodes = useBuilderStore((s) => s.nodes);
  const selectedNodeIds = useBuilderStore((s) => s.selectedNodeIds);
  const selectedNodeId = useBuilderStore((s) => s.selectedNodeId);
  const selected = useMemo(() => {
    const ids = new Set([...selectedNodeIds, ...(selectedNodeId ? [selectedNodeId] : [])]);
    return allNodes.filter((n) => ids.has(n.id));
  }, [allNodes, selectedNodeIds, selectedNodeId]);
  const citedNodes = useMemo(() => allNodes.filter((n) => cited.includes(n.id)), [allNodes, cited]);
  const edgeSelected = useBuilderStore((s) => s.selectedEdgeId !== null);
  const workflowName = useBuilderStore((s) => s.name);
  const collabLive = useBuilderStore((s) => s.collabLive);

  // ADR 0768 P5's feature-supplied "can see" slot — ONE owner of that strip.
  const canSee = [t('pairCanSee', { name: workflowName }), collabLive ? t('pairCanSeeLive') : null, lastRunId ? t('pairCanSeeRun') : null]
    .filter(Boolean).join(' · ');

  const beforeSend = useCallback(async (conversationId: string, conversationRunId?: string) => {
    const r = await usePairStore.getState().beforeSend(conversationId, conversationRunId);
    if (r.ok) return r;
    const key = r.reason === 'sync-failed' ? 'pairBlockedSync' : r.reason === 'not-found' ? 'pairBlockedNotFound' : r.reason === 'no-workflow' ? 'pairBlockedNoWorkflow' : 'pairBlockedContext';
    return { ok: false as const, reason: t(key) };
  }, [t]);
  const onConversationId = useCallback((id: string) => usePairStore.getState().setConversationId(id), []);
  const onToolActivity = useCallback((a: EmbedToolActivity) => usePairStore.getState().onToolActivity(a), []);
  const onTurnSettled = useCallback(() => usePairStore.getState().onTurnSettled(), []);

  // Drag-to-cite from the palette: "add one of these". (Canvas nodes are cited
  // with the `+ node` picker — xyflow drags are pointer gestures, not DnD.)
  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (e.dataTransfer.types.includes(PALETTE_DRAG_TYPE) || e.dataTransfer.types.includes(NODE_CITE_TYPE) || e.dataTransfer.types.includes(RUN_STEP_CITE_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    // P11 — a run step from the run drawer: cite its node AND attach its run.
    const runStep = e.dataTransfer.getData(RUN_STEP_CITE_MIME);
    if (runStep) {
      e.preventDefault();
      try {
        const v = JSON.parse(runStep) as { nodeId?: unknown; runId?: unknown };
        if (typeof v.nodeId === 'string' && typeof v.runId === 'string') usePairStore.getState().citeRunStep(v.nodeId, v.runId);
      } catch { /* not ours — ignore */ }
      return;
    }
    const cited = e.dataTransfer.getData(NODE_CITE_TYPE);
    if (cited) { e.preventDefault(); usePairStore.getState().cite(cited); return; }
    const kind = e.dataTransfer.getData(PALETTE_DRAG_TYPE);
    if (!kind) return;
    e.preventDefault();
    usePairStore.getState().ask(t('pairAskAddKind', { label: catalogEntry(kind)?.label ?? kind }));
  };

  const chips = [...selected, ...citedNodes.filter((c) => !selected.some((x) => x.id === c.id))];

  return (
    <div className="pair-panel" onDragOver={onDragOver} onDrop={onDrop}>
      <SuggestionReview />
      {roomCount > 0 ? <p className="pair-room-note muted u-fs-12">{t('pairRoomShared', { count: roomCount })}</p> : null}
      {lastError ? <p className="pair-error u-fs-12" role="status">{t('pairLoadFailed')}</p> : null}

      <div className="pair-context" role="group" aria-label={t('pairContextAria')}>
        {chips.length === 0 && !edgeSelected ? (
          <span className="muted u-fs-12">{t('pairContextNone')}</span>
        ) : null}
        {chips.map((c) => (
          <span key={c.id} className="pair-chip">
            <span className="pair-chip__dot" style={{ background: catalogEntry(c.kind)?.accent ?? 'var(--ink-3)' }} aria-hidden />
            {c.name}
            {cited.includes(c.id) ? (
              <Button variant="quiet" size="sm" className="pair-chip__x" aria-label={t('pairUncite', { name: c.name })} onClick={() => usePairStore.getState().uncite(c.id)}>
                <XIcon size={12} aria-hidden />
              </Button>
            ) : null}
          </span>
        ))}
        {edgeSelected ? <span className="pair-chip">{t('pairChipEdge')}</span> : null}
        {lastRunId ? <span className="pair-chip pair-chip--run">{t('pairChipRun')}</span> : null}
        <label className="sr-only" htmlFor="pair-cite-picker">{t('pairCitePicker')}</label>
        <select
          id="pair-cite-picker"
          className="pair-cite-picker"
          value=""
          onChange={(e) => { if (e.target.value) usePairStore.getState().cite(e.target.value); }}
        >
          <option value="">{t('pairCiteNode')}</option>
          {allNodes.filter((n) => !chips.some((c) => c.id === n.id)).map((n) => (
            <option key={n.id} value={n.id}>{n.name}</option>
          ))}
        </select>
        {chips.length > 0 ? <span className="muted u-fs-12">{t('pairContextFollows')}</span> : null}
      </div>

      {lastRunId && failedName ? (
        <section className="pair-digest" aria-label={t('pairDigestAria')}>
          <strong className="u-fs-12">{t('pairDigestTitle', { name: failedName })}</strong>
          {failedDetail ? <code className="pair-digest__detail">{digestText(failedDetail)}</code> : null}
        </section>
      ) : null}

      {narration.length > 0 ? (
        <ul className="pair-narration" aria-label={t('pairNarrationAria')}>
          {narration.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}

      {followUps && followUps.length > 0 && phase !== 'thinking' && phase !== 'drafting' ? (
        <div className="pair-followups" role="group" aria-label={t('pairFollowUpsAria')}>
          {followUps.map((f) => (
            <Button key={f} size="sm" variant="secondary" onClick={() => usePairStore.getState().ask(f)}>{f}</Button>
          ))}
        </div>
      ) : null}

      {phase === 'thinking' || phase === 'reading' || phase === 'drafting' ? (
        <p className="pair-phase u-fs-12" aria-hidden>{t(`pairPhase_${phase}`)}</p>
      ) : null}

      <div className="pair-chat">
        <Suspense fallback={<div className="muted u-fs-13 u-p-3">{t('aiAuthoring')}</div>}>
          <EmbeddedChatPanel
            agentId={WORKFLOW_ARCHITECT_AGENT_ID}
            beforeSend={beforeSend}
            onConversationId={onConversationId}
            onToolActivity={onToolActivity}
            onTurnSettled={onTurnSettled}
            prompt={prompt}
            stopSignal={stopSignal}
            contextLabel={canSee}
            renderEmptyState={(onPick) => <WorkflowAuthorWelcome onPick={onPick} />}
          />
        </Suspense>
      </div>
    </div>
  );
}

/** The failed step's recorded error, as the host logged it (G-04b). */
function digestText(d: unknown): string {
  const r = d as { error?: { code?: string; message?: string } | string; status?: string } | undefined;
  if (!r) return '';
  if (typeof r.error === 'string') return r.error.slice(0, 200);
  const code = r.error?.code ?? r.status ?? '';
  const msg = r.error?.message ?? '';
  return `${code}${code && msg ? ' — ' : ''}${msg}`.slice(0, 200);
}
