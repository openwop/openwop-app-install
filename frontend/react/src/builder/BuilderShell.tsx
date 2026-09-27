/**
 * Builder content + business logic over the shared shell chrome.
 *
 * ADR 0361 Phase 1: the three-region layout, rails, shortcut registry,
 * ⌘K projection, live region, and zoom-handle slot moved to the ONE
 * chassis composition (`canvas/CanvasSurfaceShell`). This file keeps what
 * is genuinely the builder's: the toolbar verbs (run/validate/export/
 * import/publish/AI), pre-flight, the run-overlay SSE fold, and the rail
 * CONTENT (NodePalette / Inspector).
 *
 * Auto-saves to localStorage on every store mutation; no explicit Save
 * button — matches the chat session pattern (useChatSession.ts:87-113).
 * The workflow list lives at /builder (WorkflowsDashboard).
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { NodePalette } from './palette/NodePalette.js';
import { BuilderCanvas } from './canvas/BuilderCanvas.js';
import { Inspector } from './inspector/Inspector.js';
import { useBuilderStore } from './store/builderStore.js';
import { newWorkflowId } from './persistence/localStore.js';
import { registerWorkflow } from './persistence/registerClient.js';
import { serializeWithIdMap, SerializeError } from './schema/serialize.js';
import { fromCanonicalDefinition, looksCanonical } from './schema/deserialize.js';
import { buildChainPackManifest } from './schema/chainPackManifest.js';
import { createRun, listMyRuns } from '../client/runsClient.js';
import { classifyHttpError } from '../client/classifyHttpError.js';
import { promoteWorkflow, listWorkflowSummaries } from '../workflows/workflowsClient.js';
import { saveWorkflow } from './persistence/backendStore.js';
import { toast } from '../ui/toast.js';
import { useLiveRegion } from '../ui/announce.js';
import { subscribeToRun } from '../client/streamsClient.js';
import type { SavedWorkflow } from './schema/workflow.js';
import { CheckIcon } from '../ui/icons/index.js';
import { ErrorBoundary } from '../ui/ErrorBoundary.js';
import {
  useHostLimits,
  collectPreflightIssues,
  collectConnectionRefs,
  collectLimitIssues,
  formatAdvertisedLimits,
  isMissingResourceError,
  directionalTarget,
  nextRangeSelection,
  floodSelection,
  canvasOrNowhereFocused,
  useLatchedValue,
  drawerEscapeHandler,
  type PreflightIssue,
  type LimitIssue,
} from './builderShellHelpers.js';
import { listConnections, listProviders } from '../features/connections/connectionsClient.js';
import { BuilderToolbar } from './BuilderToolbar.js';
import { CreateWithAiPanel } from './CreateWithAiPanel.js';
import { PublishHelpBanner } from './PublishHelpBanner.js';
import { PreflightBanner, type UnboundConnection } from './PreflightBanner.js';
import { RunOverlayBanner } from './RunOverlayBanner.js';
import { Notice } from '../ui/Notice.js';
import { CANVAS_NODE_BUDGET } from './perfBudget.js';
import { SyncFailureBanner } from './SyncFailureBanner.js';
import { ProposalBanner } from './ProposalBanner.js';
import { HistoryDrawer } from './HistoryDrawer.js';
import { EvalsDrawer } from './EvalsDrawer.js';
import { loadWorkflow as loadBackendWorkflowForRestore } from './persistence/backendStore.js';
import { RemovedReferencedNodesNotice } from './RemovedReferencedNodesNotice.js';
import { definitionMetadataFor } from './persistence/definitionMetadata.js';
import { DebugSessionBanner } from './DebugSessionBanner.js';
import { loadDebugSessionFromServer, prefillDebugSessionFromRun } from './debugSession.js';
import { fetchFleetStats, fetchWorkflowEstimate, type WorkflowCostEstimate } from '../workflows/fleetInsightsClient.js';
import { formatCurrency } from '../i18n/format.js';
import { RunDrawer } from './RunDrawer.js';
import type { ShortcutDef } from '../canvas/shortcuts.js';
import { CanvasSurfaceShell, type SurfaceShellConfig, type SurfaceShellCtx } from '../canvas/CanvasSurfaceShell.js';
import { copySelection, pasteClipboard, duplicateSelection, hasClipboard } from './nodeClipboard.js';
import { probeWorkflowCollabAvailable, useWorkflowCollabSession, type WorkflowCollabState } from './collab/workflowCollabSession.js';
import { useWorkflowCollabPresence } from './collab/useWorkflowCollabPresence.js';
import { collabGuestSuffix, presenceSelfName } from '../canvas/useCollabPresence.js';
import { useAuth } from '../auth/useAuth.js';

interface Props {
  onNewWorkflow(): void;
}

export function BuilderShell({ onNewWorkflow }: Props) {
  const { t } = useTranslation('builder');
  const nav = useNavigate();
  const workflowId = useBuilderStore((s) => s.workflowId);
  const name = useBuilderStore((s) => s.name);
  const undo = useBuilderStore((s) => s.undo);
  const redo = useBuilderStore((s) => s.redo);
  const canUndo = useBuilderStore((s) => s.past.length > 0);
  const canRedo = useBuilderStore((s) => s.future.length > 0);
  const overlay = useBuilderStore((s) => s.overlay);
  const lifecycle = useBuilderStore((s) => s.lifecycle);
  // ADR 0369 §5 + OQ5 — Save (promote) unlocks after a green review run of
  // THIS session (the backend independently enforces the completed-run gate,
  // so a stale unlock can only produce an honest 409 toast).
  const [greenRun, setGreenRun] = useState(false);
  useEffect(() => {
    if (overlay?.runStatus === 'completed') setGreenRun(true);
  }, [overlay?.runStatus]);
  useEffect(() => { setGreenRun(false); }, [workflowId]);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ADR 0483 (B5) — the large-canvas advisory: past the 200-node perf budget,
  // say so honestly ONCE per workflow per session (dismissible; muted — an
  // advisory, not a fault). The budget itself is ratcheted by
  // canvasPerfBudget.test.tsx; this is the user-facing half.
  const nodeCount = useBuilderStore((s) => s.nodes.length);
  // Review F2 — SESSION-scoped dismissal (the ADR's contract): component
  // state alone re-showed the advisory on every builder visit.
  const [largeCanvasDismissed, setLargeCanvasDismissed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem('owp:builder:largeCanvasDismissed') ?? '[]') as string[]); }
    catch { return new Set(); }
  });
  const dismissLargeCanvas = (id: string): void => {
    setLargeCanvasDismissed((cur) => {
      const next = new Set(cur).add(id);
      try { sessionStorage.setItem('owp:builder:largeCanvasDismissed', JSON.stringify([...next])); } catch { /* private mode */ }
      return next;
    });
  };
  const showLargeCanvasNote = nodeCount > CANVAS_NODE_BUDGET && !largeCanvasDismissed.has(workflowId);
  // ADR 0474 correction (grade-ux #1) — published-behind-head state: once a
  // workflow is promoted, later edits leave production running the published
  // pin with (previously) NO in-app cure but rollback. The toolbar now offers
  // "Publish changes" whenever the backend list marks this workflow behind
  // its published revision. Re-checked after every confirmed autosave (the
  // head only moves when a save lands) and after each publish.
  const syncState = useBuilderStore((s) => s.syncState);
  const [publishPending, setPublishPending] = useState(false);
  useEffect(() => {
    if (!workflowId) return;
    let alive = true;
    void listWorkflowSummaries().then((rows) => {
      if (!alive) return;
      const row = rows.find((w) => w.workflowId === workflowId);
      setPublishPending(Boolean(row?.publishedRevision) && row?.publishedBehindHead === true);
    }).catch(() => { /* fail-soft: the button simply doesn't show */ });
    return () => { alive = false; };
  }, [workflowId, syncState]);
  // ADR 0481 — builder multiplayer. The "Go live" affordance shows only when
  // the ticket probe answers (a uniform 404 hides it silently — toggles off or
  // an ineligible workflow); the session itself is the room client + store
  // adapter (autosave suspension, per-user undo, presence).
  const [collabAvailable, setCollabAvailable] = useState(false);
  useEffect(() => {
    setCollabAvailable(false);
    if (!workflowId) return;
    let alive = true;
    void probeWorkflowCollabAvailable(workflowId).then((ok) => { if (alive) setCollabAvailable(ok); });
    return () => { alive = false; };
  }, [workflowId]);
  const [collabWanted, setCollabWanted] = useState(false);
  useEffect(() => { setCollabWanted(false); }, [workflowId]); // navigation ends the session
  const collab = useWorkflowCollabSession({ workflowId, enabled: collabWanted && collabAvailable });
  const liveCollab = collab.active && collab.status === 'live' ? collab : null;
  const collabRef = useRef<WorkflowCollabState>(collab);
  collabRef.current = collab;
  // §7.5 / CV-2 — the builder's TYPE verbs, merged into the shared shell's
  // registry (ADR 0361 Phase 1: the registry/keydown/⌘K/overlay owner is
  // canvas/CanvasSurfaceShell; only the verbs live here).
  const { t: tc } = useTranslation('canvas');
  const st = () => useBuilderStore.getState();
  // ⌘Z routes to the per-user Y.UndoManager while a room is live (ADR 0481 §5
  // — the solo snapshot stacks are cleared on join/leave); solo path unchanged.
  const liveSession = () => {
    const c = collabRef.current;
    return c.active && c.status === 'live' ? c : null;
  };
  const typeShortcuts = useCallback(({ announce }: SurfaceShellCtx): ShortcutDef[] => [
    // ⌘Z/⇧⌘Z — the surface owns undo (the zustand snapshot stack; the binding's
    // per-user undo while live).
    { combo: 'mod+z', labelKey: 'undo', group: 'general', enabled: () => liveSession()?.canUndo ?? st().past.length > 0, run: () => { const c = liveSession(); if (c) c.undo(); else st().undo(); announce(tc('annUndid')); } },
    { combo: 'mod+shift+z', labelKey: 'redo', group: 'general', enabled: () => liveSession()?.canRedo ?? st().future.length > 0, run: () => { const c = liveSession(); if (c) c.redo(); else st().redo(); announce(tc('annRedid')); } },
    { combo: 'mod+y', labelKey: 'redo', group: 'general', enabled: () => liveSession()?.canRedo ?? st().future.length > 0, run: () => { const c = liveSession(); if (c) c.redo(); else st().redo(); announce(tc('annRedid')); } },
    { combo: 'mod+c', labelKey: 'shortcutCopyNodes', group: 'type', enabled: () => st().selectedNodeIds.length > 0 && (window.getSelection()?.isCollapsed ?? true), run: () => { const n = copySelection(); if (n) announce(t('annCopiedNodes', { count: n })); } },
    { combo: 'mod+v', labelKey: 'shortcutPasteNodes', group: 'type', enabled: () => hasClipboard(), run: () => { const n = pasteClipboard(); if (n) announce(t('annPastedNodes', { count: n })); } },
    { combo: 'mod+d', labelKey: 'shortcutDuplicateNodes', group: 'type', enabled: () => st().selectedNodeIds.length > 0, run: () => { const n = duplicateSelection(); if (n) announce(t('annDuplicatedNodes', { count: n })); } },
    // UX_UPGRADE-workflows-builder P2 — '/' focuses the palette search (the
    // n8n Tab-to-search parity; Tab itself must keep moving focus, WCAG 2.1.1).
    // Disabled while the palette rail is collapsed — its input isn't rendered.
    { combo: '/', labelKey: 'shortcutFindNode', group: 'type', enabled: () => document.querySelector('.builder-palette-search-input') != null, run: () => { st().requestPaletteSearchFocus(); announce(t('annFindNodeFocused')); } },
    // P3 — Alt+Arrow directional node navigation (bare arrows stay xyflow's
    // nudge). Left/right walk edges; up/down are spatial (helper is pure +
    // unit-tested). Selection AND DOM focus move so the ring follows.
    // Gated on canvas-or-nowhere focus: the registry keydown owner is
    // window-level, and Alt+←/→ is browser back/forward on Windows/Linux —
    // shadowing that while focus sits in a rail or the toolbar would eat a
    // navigation habit the user aimed at the BROWSER, not the graph.
    ...(['left', 'right', 'up', 'down'] as const).map((dir): ShortcutDef => ({
      combo: `alt+arrow${dir}`,
      labelKey: dir === 'left' ? 'shortcutNodeNavUpstream' : dir === 'right' ? 'shortcutNodeNavDownstream' : dir === 'up' ? 'shortcutNodeNavUp' : 'shortcutNodeNavDown',
      group: 'type',
      enabled: () => st().nodes.length > 0 && canvasOrNowhereFocused(),
      run: () => {
        const s = st();
        const target = directionalTarget(s.nodes, s.edges, s.selectedNodeId ?? s.selectedNodeIds[0] ?? null, dir);
        // `dispatchShortcut` already called preventDefault() by the time we get
        // here, so a bare `return` spends the user's keystroke on silence — the
        // key looks broken, and a screen-reader user gets nothing at all. Say
        // that the edge of the graph is why nothing moved.
        if (!target) { announce(t('annNodeNavNone', { context: dir })); return; }
        s.selectNode(target);
        document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(target)}"]`)?.focus();
        const node = s.nodes.find((n) => n.id === target);
        announce(t('annNodeNavSelected', { name: node?.name || node?.kind || target }));
      },
    })),
    // Round 2 — ⌘A selects all nodes (n8n parity; docs.n8n.io/build/keyboard-
    // shortcuts). Canvas-or-nowhere gated so text select-all survives in rails.
    { combo: 'mod+a', labelKey: 'shortcutSelectAllNodes', group: 'type', enabled: () => st().nodes.length > 0 && canvasOrNowhereFocused(), run: () => { const s = st(); s.setSelection(s.nodes.map((n) => n.id)); announce(t('annAllNodesSelected', { count: s.nodes.length })); } },
    // BLDKB-1 (round 2) — Alt+Shift+Arrow EXTENDS the selection by the
    // directional target (the n8n range-select parity, on our Alt layer so
    // bare arrows keep xyflow's nudge). Anchor = last-added node, so repeated
    // presses walk outward. Add-only v1: reversing does not shrink (Esc or a
    // canvas click clears) — recorded in the tracker.
    ...(['left', 'right', 'up', 'down'] as const).map((dir): ShortcutDef => ({
      combo: `alt+shift+arrow${dir}`,
      labelKey: 'shortcutNodeExtendSelection',
      group: 'type',
      enabled: () => st().nodes.length > 0 && canvasOrNowhereFocused(),
      run: () => {
        const s = st();
        const anchor = s.selectedNodeIds[s.selectedNodeIds.length - 1] ?? s.selectedNodeId ?? null;
        const target = directionalTarget(s.nodes, s.edges, anchor, dir);
        if (!target) { announce(t('annNodeNavNone', { context: dir })); return; }
        const next = nextRangeSelection(s.selectedNodeIds.length ? s.selectedNodeIds : anchor ? [anchor] : [], target);
        s.setSelection(next);
        document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(target)}"]`)?.focus();
        const node = s.nodes.find((n) => n.id === target);
        announce(t('annNodeRangeSelected', { name: node?.name || node?.kind || target, count: next.length }));
      },
    })),
    // R3 flood-select — mod on top of the range layer: Alt+Shift+⌘/Ctrl+→
    // selects everything DOWNSTREAM of the selection (← = upstream), the n8n
    // flood semantics recorded as the round-3 candidate. Announced as one
    // counted message (a flood of N is deliberately not N announcements).
    ...([['right', 'downstream'], ['left', 'upstream']] as const).map(([arrow, dir]): ShortcutDef => ({
      combo: `mod+alt+shift+arrow${arrow}`,
      labelKey: dir === 'downstream' ? 'shortcutNodeFloodDownstream' : 'shortcutNodeFloodUpstream',
      group: 'type',
      enabled: () => (st().selectedNodeIds.length > 0 || st().selectedNodeId != null) && canvasOrNowhereFocused(),
      run: () => {
        const s = st();
        const anchors = s.selectedNodeIds.length ? s.selectedNodeIds : (s.selectedNodeId ? [s.selectedNodeId] : []);
        const next = floodSelection(anchors, s.edges, anchors, dir);
        if (next.length === anchors.length) { announce(t('annNodeFloodNone')); return; }
        s.setSelection(next);
        announce(t('annNodeFloodSelected', { count: next.length }));
      },
    })),
  ], [t, tc]);
  // ADR 0481 D5 — presence: identity + node selection over awareness; peers
  // mirror into the store for the canvas node markers; join/leave coalesced
  // into the polite live region below (the useCollabPresence precedent).
  const { user: authUser } = useAuth();
  const guestIdRef = useRef('');
  if (!guestIdRef.current) guestIdRef.current = collabGuestSuffix();
  const selectedNodeIds = useBuilderStore((s) => s.selectedNodeIds);
  // ANN-UX-2: a bare `useState` here was silent on a repeat — reconnect flapping
  // announced "Live session reconnecting" once and then never again.
  const [collabAnnounce, setCollabAnnounce] = useLiveRegion();
  const presence = useWorkflowCollabPresence({
    awareness: collab.active ? collab.awareness : null,
    // RTCC-4 — never broadcast the user email into workflow-collab presence
    // (relayed to every room peer, and via SLC-1 to a same-tenant non-member).
    // Same non-PII resolver as the canvas presence site.
    selfName: presenceSelfName(authUser, tc('guestN', { id: guestIdRef.current })),
    selectedNodeIds,
    onPeersChanged: ({ joined, left }) => {
      // ONE composed message: a join and a leave in the same coalesce window
      // must both land (two setState calls = last write wins).
      const parts: string[] = [];
      if (joined.length === 1) parts.push(tc('annPeerJoined', { name: joined[0] }));
      else if (joined.length > 1) parts.push(tc('annPeersJoined', { n: joined.length }));
      if (left.length === 1) parts.push(tc('annPeerLeft', { name: left[0] }));
      else if (left.length > 1) parts.push(tc('annPeersLeft', { n: left.length }));
      // Ambient peer churn, not a user verb — collapse repeats so a flapping
      // connection cannot back up the polite queue (same call as CanvasEditorPage).
      if (parts.length > 0) setCollabAnnounce(parts.join(' — '), { collapseRepeats: true });
    },
  });
  const collabPeerCount = presence.peers.length;
  useEffect(() => {
    useBuilderStore.getState().setCollabPeers(liveCollab ? presence.peers : null);
  }, [liveCollab, presence.peers]);
  // ux-M4 — show 'connecting' the INSTANT Go live is clicked: the session
  // hook's first active setState lands only after the dynamic imports + the
  // ticket mint resolve, which reads as a dead button on a slow link.
  const collabChipStatus: 'off' | 'connecting' | 'live' | 'reconnecting' | 'failed' =
    !collab.active
      ? (collabWanted && collabAvailable ? 'connecting' : 'off')
      : collab.status === 'live'
        ? (collab.connected ? 'live' : 'reconnecting')
        : collab.status;
  // ux-M5 — announce connection-state TRANSITIONS once each through the
  // shared sr-only live region below (the chip itself is NOT a live region:
  // a role="status" chip re-announced on every unrelated re-render).
  const prevCollabStatusRef = useRef(collabChipStatus);
  useEffect(() => {
    if (prevCollabStatusRef.current === collabChipStatus) return;
    prevCollabStatusRef.current = collabChipStatus;
    if (collabChipStatus === 'live') setCollabAnnounce(t('collabAnnLive'));
    else if (collabChipStatus === 'reconnecting') setCollabAnnounce(t('collabAnnReconnecting'));
    else if (collabChipStatus === 'failed') setCollabAnnounce(t('collabAnnFailed'));
    // `setCollabAnnounce` is listed because it is now a `useCallback` from
    // `useLiveRegion`, not a `useState` setter that eslint auto-treats as
    // stable. It IS stable (empty deps), so this cannot re-run the effect.
  }, [collabChipStatus, t, setCollabAnnounce]);
  // The Publish-to-registry helper. Non-null when the user has clicked
  // "Publish to registry…" — stores the proposed pack slug + manifest
  // size + GitHub registry URL so the inline checklist can render
  // without re-deriving on every render.
  const [publishHelp, setPublishHelp] = useState<{ slug: string; size: number; manifestJson: string } | null>(null);
  // Pre-flight issues found on the last Run click. When non-null the
  // user must confirm ("Run anyway") or cancel before the run fires.
  // `caps` are per-node missing host surfaces; `limits` are graph-shape
  // breaches of advertised engine ceilings. A "Run anyway" applies to
  // both — limit breaches will still fail at runtime, but the user may
  // want to capture the error trace.
  const [preflight, setPreflight] = useState<
    | { caps: PreflightIssue[]; limits: LimitIssue[]; conns: UnboundConnection[] }
    | null
  >(null);
  // Success summary from the last Validate click; null when none/cleared.
  const [validateOk, setValidateOk] = useState<string | null>(null);
  // "Create with AI" drawer (ADR 0072/0073) — slides down from the header.
  // `aiOpen` drives the slide; `aiHasOpened` keeps the embedded chat mounted
  // after the first open (so reopen resumes and the slide-up can animate).
  const [aiOpen, setAiOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [evalsOpen, setEvalsOpen] = useState(false);
  // ADR 0476 — pre-run cost hint (fail-soft; absent until data exists) + the
  // canvas failure-heatmap toggle (counts live in the store for BaseNode).
  const [estimate, setEstimate] = useState<WorkflowCostEstimate | null>(null);
  // UX-BLD-2 — "the estimate read FAILED" is not the same fact as "this workflow
  // has no estimate yet", but both used to collapse into an absent chip: the
  // `.catch(() => {})` here plus `runEstimate` returning null below. Someone
  // about to fire an expensive AI workflow got identical silence either way.
  // Fail-soft (ADR 0476) means the chip is optional, NOT that a failure may
  // masquerade as "free".
  const [estimateFailed, setEstimateFailed] = useState(false);
  const failureHeat = useBuilderStore((s) => s.failureHeat);
  const failureHeatMode = useBuilderStore((s) => s.failureHeatMode);
  useEffect(() => {
    if (!workflowId) return;
    let live = true;
    setEstimate(null); // review L2 — never show the PREVIOUS workflow's chip
    setEstimateFailed(false);
    void fetchWorkflowEstimate(workflowId)
      .then((e) => { if (live) setEstimate(e); })
      .catch(() => { if (live) setEstimateFailed(true); });
    return () => { live = false; };
  }, [workflowId]);
  const runEstimate = useMemo(() => {
    // The read failed — say so rather than rendering the same nothing that
    // "no estimate yet" renders (UX-BLD-2).
    if (estimateFailed) {
      return { label: t('runEstimateUnavailableChip'), title: t('runEstimateUnavailableTitle'), unavailable: true };
    }
    const usd = estimate?.historical?.medianUsd ?? estimate?.static?.floorUsd;
    if (usd === undefined || usd <= 0) return null;
    return {
      label: t('runEstimateChip', { usd: formatCurrency(usd, 'USD', { maximumFractionDigits: usd < 0.01 ? 4 : 2 }) }),
      title: estimate?.historical
        ? t('runEstimateHistoricalTitle', { samples: estimate.historical.samples, count: estimate.historical.samples })
        : t('runEstimateStaticTitle', { count: estimate?.static?.aiNodes ?? 0 }),
    };
  }, [estimate, estimateFailed, t]);
  async function onToggleHeatmap(): Promise<void> {
    const st = useBuilderStore.getState();
    // ADR 0482 — the two modes share ONE slice: toggling failures while cost
    // heat is lit replaces it (never two number vocabularies at once).
    if (st.failureHeat && st.failureHeatMode === 'failures') { st.setFailureHeat(null); return; }
    try {
      const fleet = await fetchFleetStats();
      const row = fleet.workflows.find((w) => w.workflowId === workflowId);
      const heat: Record<string, number> = {};
      // Backend node ids are the builder ids (ADR 0440 preserves them);
      // unknown ids (renamed/removed nodes) paint nothing — and when NOTHING
      // intersects the current canvas, say so instead of a toggle that
      // visibly does nothing (ux-review M5).
      // Review M4 — the FULL per-node counts, not the dashboard chip's top 3.
      for (const f of row?.nodeFailures ?? row?.topFailures ?? []) heat[f.nodeId] = f.count;
      st.setFailureHeat(heat);
      const canvasIds = new Set(st.nodes.map((n) => n.id));
      const painted = Object.keys(heat).filter((id) => canvasIds.has(id));
      if (painted.length === 0) toast.info(t('heatmapNoFailures'));
    } catch {
      toast.error(t('heatmapLoadFailed'));
    }
  }
  // ADR 0482 §6 — the COST heatmap mode: paints the MOST RECENT terminal
  // run's costByNode stamp (honest v1 scope — the toolbar chip discloses
  // "latest run"; fleet stats rows carry no per-node cost to aggregate).
  async function onToggleCostHeatmap(): Promise<void> {
    const st = useBuilderStore.getState();
    if (st.failureHeat && st.failureHeatMode === 'cost') { st.setFailureHeat(null); return; }
    try {
      // ux-2 — the M2 server-side workflow filter: 'latest run' is truly THIS
      // workflow's latest, not whatever survived the tenant's global page.
      const runs = await listMyRuns({ workflowId, limit: 25 });
      const latest = runs
        .filter((r) => ['completed', 'failed', 'cancelled'].includes(r.status)
          && r.costByNode && Object.keys(r.costByNode).length > 0)
        .sort((a, b) => (b.completedAt ?? b.startedAt ?? '').localeCompare(a.completedAt ?? a.startedAt ?? ''))[0];
      if (!latest?.costByNode) {
        toast.info(t('costHeatmapNoData'));
        return;
      }
      // ux-13 — when nothing intersects the canvas, do NOT enter the mode:
      // a lit toggle painting zero badges reads as a broken feature.
      const canvasIds = new Set(st.nodes.map((n) => n.id));
      const painted = Object.keys(latest.costByNode).filter((id) => canvasIds.has(id));
      if (painted.length === 0) {
        toast.info(t('costHeatmapNoOverlap'));
        return;
      }
      st.setFailureHeat({ ...latest.costByNode }, 'cost');
    } catch {
      toast.error(t('heatmapLoadFailed'));
    }
  }
  // ADR 0475 — outcome notice for the ?debugRun prefill (unmatched node ids
  // from an older-revision run are reported, never silently dropped).
  const [debugNotice, setDebugNotice] = useState<string | null>(null);
  const [aiHasOpened, setAiHasOpened] = useState(false);
  const hostLimits = useHostLimits();

  // ADR 0137 — an accepted Ambient Work Graph suggestion arrives in router state.
  // Synthesize an authoring prompt from the recurring pattern + auto-open the AI drawer,
  // so "Make a workflow" actually hands the work to the Workflow Architect.
  const location = useLocation();
  const seed = (location.state as { workGraphSeed?: { name?: string; toolSequence?: string[]; sampleGoal?: string } } | null)?.workGraphSeed;
  const seedPrompt = useMemo(() => {
    if (!seed?.toolSequence?.length) return undefined;
    const steps = seed.toolSequence.join(' → ');
    const goal = seed.sampleGoal ?? seed.name;
    return t('aiSeedPrompt', { steps, goal: goal ?? steps, defaultValue: `Create a workflow that performs these steps in order: ${steps}.${goal ? ` Goal: ${goal}.` : ''}` });
  }, [seed, t]);
  // ADR 0596 (`WFAU-3`) — LATCH the synthesized prompt, because the effect below
  // clears the router state it is derived from. See `useLatchedValue`'s docblock
  // for the batching mechanism this defeats; the short version is that the panel
  // used to mount with `seedPrompt === undefined` on both ADR 0137 hand-offs.
  const latchedSeedPrompt = useLatchedValue(seedPrompt);
  // ADR 0596 (`WFAU-5`) — drawer focus management.
  const aiDrawerRef = useRef<HTMLDivElement | null>(null);
  const aiTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Focus moves INTO the drawer when it opens — the house pattern
  // (`HistoryDrawer.tsx:44`, `EvalsDrawer.tsx:120`). Without it the drawer was
  // reachable only by tabbing the whole toolbar again.
  useEffect(() => { if (aiOpen) aiDrawerRef.current?.focus(); }, [aiOpen]);
  const closeAiDrawer = useCallback(() => {
    setAiOpen(false);
    // Restore focus to the control that opened it. Deferred a frame: the drawer
    // is still the active subtree at this point in the commit.
    requestAnimationFrame(() => aiTriggerRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!seedPrompt) return;
    setAiHasOpened(true); setAiOpen(true);
    // Clear the history state so a refresh/back doesn't re-trigger the seeded turn.
    nav('.', { replace: true, state: {} });
  }, [seedPrompt, nav]);

  // ADR 0475 — failed-run→editor deep link (?debugRun=<runId>): prefill pins
  // from the run's real outputs, load the session, then strip the param so a
  // refresh doesn't re-prefill over the author's edited pins. Independently,
  // an existing server-side debug session is re-loaded on plain opens so pins
  // are never invisible (the banner is the honesty surface).
  const debugRunParam = new URLSearchParams(location.search).get('debugRun');
  // Review H1 — the zustand store is module-global and keeps the LAST-opened
  // workflow's id across route mounts while BuilderTab loads the routed one
  // asynchronously. Acting on the stale id would prefill pins against the
  // wrong workflow (a 400) and then strip the param, losing the deep link.
  // Gate on store id === routed id, which also guarantees `loadFromSaved`
  // (which resets debugSession) has already run for THIS workflow.
  const { workflowId: routedWorkflowId } = useParams<{ workflowId?: string }>();
  useEffect(() => {
    if (!workflowId) return;
    if (routedWorkflowId && routedWorkflowId !== workflowId) return; // store not yet loaded for this route
    if (debugRunParam) {
      void (async () => {
        try {
          const res = await prefillDebugSessionFromRun(workflowId, debugRunParam);
          if (res.unmatched && res.unmatched.length > 0) {
            setDebugNotice(t('debugPrefillUnmatched', { nodes: res.unmatched.join(', ') }));
          }
        } catch (err) {
          // ux-review H6 — a deleted workflow (or run) 404s here; say THAT
          // instead of implying pins are pinnable on a canvas that may be blank.
          setDebugNotice(isMissingResourceError(err) ? t('debugPrefillGone') : t('debugPrefillFailed'));
        }
        nav('.', { replace: true, state: {} });
      })();
      return;
    }
    // Plain open: surface any pins persisted from a prior session.
    // UX-BLD-1 — fail-soft is right ONLY for the "nothing to ask" case: an
    // unsaved local-only draft has no server workflow, which 404s and is
    // legitimately silent. A REAL failure (5xx/offline) must not be, because
    // swallowing it leaves `debugSession` null and `DebugSessionBanner`
    // unrendered — i.e. the author is told they have no pins while the server
    // still holds them. That is precisely the failure mode ADR 0475's banner
    // exists to prevent ("the author must always be able to SEE that pins
    // exist"). Same 404-vs-real split the ?debugRun path already makes above.
    void loadDebugSessionFromServer(workflowId).catch((err: unknown) => {
      if (isMissingResourceError(err)) return; // no server-side workflow yet — nothing to report
      setDebugNotice(t('debugPinsLoadFailed'));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run per workflow/param change, not per t/nav identity
  }, [workflowId, routedWorkflowId, debugRunParam]);

  // Grade-ux #5 — ?heatmap=1 (the dashboard hotspot chip's deep link): light
  // the failure heatmap on arrival, then strip the param (same discipline as
  // ?debugRun — a refresh must not re-toggle).
  const heatmapParam = new URLSearchParams(location.search).get('heatmap');
  useEffect(() => {
    if (!workflowId || heatmapParam !== '1') return;
    if (routedWorkflowId && routedWorkflowId !== workflowId) return;
    if (useBuilderStore.getState().failureHeat === null) void onToggleHeatmap();
    nav('.', { replace: true, state: {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run per workflow/param change, not per handler identity
  }, [workflowId, routedWorkflowId, heatmapParam]);

  // Subscribe to the overlaid run's SSE stream and fold each event into
  // the store so the canvas paints node status live. Re-subscribes when
  // a new run starts (overlay.runId changes); tears down on unmount.
  const overlayRunId = overlay?.runId ?? null;
  useEffect(() => {
    if (!overlayRunId) return;
    const sub = subscribeToRun(overlayRunId, {
      modes: ['updates'],
      // Relax the default 30s/120s timeouts — a watched run can be long
      // and idle between nodes; the idle timer still resets per event.
      idleTimeoutMs: 5 * 60_000,
      absoluteTimeoutMs: 30 * 60_000,
      onEvent: (ev) => useBuilderStore.getState().applyRunEvent(ev),
    });
    return () => sub.close();
  }, [overlayRunId]);

  // Grade-ux #4 — in-builder debug entry for a failed overlay run: the same
  // prefill the ?debugRun deep link performs, without leaving the canvas.
  async function onDebugFromOverlayRun(runId: string): Promise<void> {
    try {
      const res = await prefillDebugSessionFromRun(workflowId, runId);
      if (res.unmatched && res.unmatched.length > 0) {
        setDebugNotice(t('debugPrefillUnmatched', { nodes: res.unmatched.join(', ') }));
      } else {
        setDebugNotice(t('debugPrefillDone', { count: res.pinned.length }));
      }
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      setDebugNotice(/_404$/.test(code) ? t('debugPrefillGone') : t('debugPrefillFailed'));
    }
  }

  async function onPublishChanges(): Promise<void> {
    try {
      await promoteWorkflow(workflowId); // non-transient promote = re-publish head
      setPublishPending(false);
      toast.success(t('publishChangesDone', { name }));
    } catch (err) {
      if (err instanceof Error && err.message === 'workflow_untested') {
        toast.error(t('saveDraftLockedTitle'));
      } else if (err instanceof Error && err.message === 'evals_failing') {
        toast.error(t('saveDraftEvalsFailing'));
        setEvalsOpen(true);
      } else {
        toast.error(t('publishChangesFailed'));
      }
    }
  }

  async function onSaveDraft(): Promise<void> {
    try {
      await promoteWorkflow(workflowId);
      useBuilderStore.getState().clearTransient();
      setPublishPending(false); // promote published this head
      toast.success(t('draftPromoted', { name }));
    } catch (err) {
      // The backend gate is authoritative: an untested draft refuses.
      if (err instanceof Error && err.message === 'workflow_untested') {
        toast.error(t('saveDraftLockedTitle'));
      } else if (err instanceof Error && err.message === 'evals_failing') {
        // ADR 0477 §4 — required eval set(s) not green for THIS draft.
        toast.error(t('saveDraftEvalsFailing'));
        setEvalsOpen(true); // the next action is one click away
      } else {
        toast.error(t('draftPromoteFailed'));
      }
    }
  }

  // Dry-run validation: the same gates Run applies — graph serialization
  // (empty graph / cycles / orphan edges via SerializeError), default-inputs
  // JSON parse, and the host-capability pre-flight — but with no network
  // work. Surfaces "build → run → cryptic failure" problems at author time.
  function onValidate() {
    setError(null);
    setPreflight(null);
    setValidateOk(null);
    const snap = useBuilderStore.getState().snapshot();
    try {
      serializeWithIdMap(snap);
    } catch (err) {
      if (err instanceof SerializeError) {
        setError(err.message);
        if (err.nodeId) useBuilderStore.getState().selectNode(err.nodeId);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const raw = snap.defaultInputs?.trim();
    if (raw) {
      try {
        JSON.parse(raw);
      } catch {
        setError(t('defaultInputsInvalidJson'));
        return;
      }
    }
    const caps = collectPreflightIssues(snap.nodes);
    const limits = collectLimitIssues(snap.nodes, hostLimits);
    if (caps.length > 0 || limits.length > 0) {
      setPreflight({ caps, limits, conns: [] });
      return;
    }
    const nN = snap.nodes.length;
    const eN = snap.edges.length;
    setValidateOk(
      t('validSummary', {
        nodes: t('validNode', { count: nN }),
        edges: t('validEdge', { count: eN }),
        limits: formatAdvertisedLimits(hostLimits),
      }),
    );
  }

  async function onRun(force = false) {
    setError(null);
    setValidateOk(null);
    const snap0 = useBuilderStore.getState().snapshot();
    // Pre-flight host-capability + engine-limit check before doing any
    // network work. The two are surfaced together so the user sees the
    // full set of author-time problems in one banner.
    if (!force) {
      const caps = collectPreflightIssues(snap0.nodes);
      const limits = collectLimitIssues(snap0.nodes, hostLimits);
      // Day-1 UX P9 — named-but-unbound connections become a connect prompt
      // at the Run gate instead of silent {ok:false} no-ops mid-run. Honors
      // ADR 0033's fail-closed posture: the run itself is unchanged; this is
      // the author-time invitation. Connections unreachable ⇒ don't block.
      let conns: UnboundConnection[] = [];
      const refs = collectConnectionRefs(snap0.nodes);
      if (refs.length > 0) {
        try {
          const [rows, provs] = await Promise.all([listConnections(), listProviders()]);
          const active = new Set(rows.filter((r) => r.status === 'active').map((r) => r.provider));
          const byId = new Map(provs.map((pr) => [pr.id, pr]));
          conns = refs
            .filter((r) => !active.has(r.providerId))
            .map((r) => ({
              ...r,
              label: byId.get(r.providerId)?.label ?? r.providerId,
              connectable: byId.get(r.providerId)?.oauthConfigured === true,
            }));
        } catch { /* connections unreadable — never block the run on the check */ }
      }
      if (caps.length > 0 || limits.length > 0 || conns.length > 0) {
        setPreflight({ caps, limits, conns });
        return;
      }
    }
    setPreflight(null);
    setRunning(true);
    try {
      const snap = useBuilderStore.getState().snapshot();
      const { definition: def, backendIdToBuilder } = serializeWithIdMap(snap);
      let inputs: Record<string, unknown> = {};
      const raw = snap.defaultInputs?.trim();
      if (raw) {
        try {
          inputs = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          throw new Error(t('defaultInputsInvalidJson'));
        }
      }
      // ADR 0440 P1 — carry the definition metadata; the route replaces the
      // definition wholesale, so registering without it erases it.
      // ADR 0481 (code-H4) — while a collab room is live, the room is the
      // head's ONLY writer: this register would 409 `workflow_room_live` and
      // kill the run. Skip it — the run executes the current server head
      // (the session's periodic derive) — and say so honestly.
      if (useBuilderStore.getState().collabLive) {
        toast.info(t('collabRunSessionState'));
      } else {
        await registerWorkflow({ ...def, metadata: definitionMetadataFor(snap) });
      }
      // Omit body.tenantId so the BE infers from the authenticated
      // session/bearer (req.tenantId): `anon:<sid>` for cookie-anon
      // callers, `user:<hash>` for Firebase-signed-in callers. A
      // hardcoded 'demo' here is rejected by principalAuthorizer
      // for any non-bearer-with-demo-allowlist principal — that's
      // the "principal cannot operate under tenant demo" error.
      // ADR 0474 P1b — the builder's Run is a DRAFT run: it executes the head
      // just registered above, not the published revision (the host-local
      // metadata convention; production launches resolve published).
      const res = await createRun({ workflowId: def.workflowId, inputs, metadata: { launch: 'draft' } });
      // Stay on the canvas and paint the run live, rather than navigating
      // straight to the text event log. The banner offers a jump to the
      // full run detail for the timeline / reasoning / inspector views.
      useBuilderStore.getState().startOverlay(res.runId, backendIdToBuilder);
    } catch (err) {
      if (err instanceof SerializeError) {
        setError(err.message);
        if (err.nodeId) useBuilderStore.getState().selectNode(err.nodeId);
      } else {
        // ADR 0482 (ux-1) — a budget-exhausted 429 gets the honest localized
        // budget sentence instead of the raw SDK message.
        const c = classifyHttpError(err);
        setError(c.kind === 'budget-exhausted'
          ? t('common:errorBudgetExhausted')
          : err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRunning(false);
    }
  }

  // Export the built graph as portable JSON (the SavedWorkflow shape —
  // open execution schema, RFC 0037 §1). Re-importable here or shareable.
  function onExport() {
    const snap = useBuilderStore.getState().snapshot();
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safe = (snap.name || 'workflow').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    a.download = `${safe}.openwop-workflow.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Export the built graph as an RFC 0013 workflow-chain-pack manifest
  // (the authoring half of "publish as a chain pack" — the user submits
  // it via the PR-based registry flow; the app never signs/pushes). Runs
  // the same graph validation as Run, so cycles/orphans surface here too.
  function onExportChainPack() {
    setError(null);
    try {
      const snap = useBuilderStore.getState().snapshot();
      const manifest = buildChainPackManifest(snap);
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safe = (snap.name || 'workflow').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
      a.download = `${safe}.workflow-chain-pack.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      if (err instanceof SerializeError) {
        setError(err.message);
        if (err.nodeId) useBuilderStore.getState().selectNode(err.nodeId);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Publish-to-registry helper. Registry submission is a PR-based flow
  // per `PUBLISHING.md` + `spec/v1/registry-operations.md` — there's no
  // in-app push for trust + provenance reasons (Ed25519 signing happens
  // at PR-merge time by the registry maintainers, not in the browser).
  // This action materializes the manifest + opens a checklist with the
  // canonical GitHub registry directory URL so the operator can finish
  // the submission with one click into the registry.
  function onPublishToRegistry() {
    setError(null);
    try {
      const snap = useBuilderStore.getState().snapshot();
      const manifest = buildChainPackManifest(snap);
      const manifestJson = JSON.stringify(manifest, null, 2);
      // Strip `community.local.` prefix from the manifest name to get
      // the final slug; the registry directory uses the bare slug as
      // the per-pack directory name (see existing entries under
      // `registry/packs/<slug>/`).
      const slug = manifest.name.replace(/^community\.local\./, '');
      setPublishHelp({ slug, size: manifestJson.length, manifestJson });
    } catch (err) {
      if (err instanceof SerializeError) {
        setError(err.message);
        if (err.nodeId) useBuilderStore.getState().selectNode(err.nodeId);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Import portable JSON. Mints a fresh workflow id so importing never
  // clobbers the workflow currently open, then navigates into it.
  async function onImportFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const raw: unknown = JSON.parse(text);
      const id = newWorkflowId();
      const now = new Date().toISOString();
      let imported: SavedWorkflow;
      if (looksCanonical(raw)) {
        // Canonical WorkflowDefinition (an `examples/*` pipeline, a
        // chain-pack composition, or this builder's own chain-pack
        // export) — convert typeIds back to builder kinds.
        const { name, nodes, edges, defaultInputs, inputSchema, variables, configurableSchema } =
          fromCanonicalDefinition(raw);
        imported = {
          id,
          name: t('workflowNameSuffixImported', { name }),
          version: '1.0.0',
          nodes,
          edges,
          defaultInputs,
          // ADR 0523 — carry the def-level half. Node `inputs` already rode
          // through here (deserialize reads them), so omitting these produced
          // exactly the asymmetry the ADR forbids: preserved `{type:'variable'}`
          // refs with their declarations deleted, which resolve to `undefined`
          // and OVERWRITE the edge value. Reachable in one gesture — Export,
          // then Import.
          ...(inputSchema ? { inputSchema } : {}),
          ...(variables !== undefined ? { variables } : {}),
          ...(configurableSchema !== undefined ? { configurableSchema } : {}),
          createdAt: now,
          updatedAt: now,
        };
      } else {
        // Builder SavedWorkflow shape (this builder's "Export" output).
        const parsed = raw as Partial<SavedWorkflow>;
        if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
          throw new Error(t('errNotOpenwopExport'));
        }
        imported = {
          id,
          name: parsed.name ? t('workflowNameSuffixImported', { name: parsed.name }) : t('importedWorkflow'),
          version: parsed.version ?? '1.0.0',
          nodes: parsed.nodes,
          edges: parsed.edges,
          defaultInputs: parsed.defaultInputs ?? '{}',
          // Export writes the whole SavedWorkflow including these, so dropping
          // them here made Export → Import a lossy round trip of its own.
          ...(parsed.inputSchema ? { inputSchema: parsed.inputSchema } : {}),
          ...(parsed.variables !== undefined ? { variables: parsed.variables } : {}),
          ...(parsed.configurableSchema !== undefined ? { configurableSchema: parsed.configurableSchema } : {}),
          createdAt: now,
          updatedAt: now,
        };
      }
      useBuilderStore.getState().loadFromSaved(imported);
      useBuilderStore.getState().persist();
      nav(`/builder/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ADR 0361 Phase 1 — content-only config for the shared shell chrome:
  // rails/registry/⌘K/live-region/zoom-slot are canvas/CanvasSurfaceShell's.
  // `storageKey` stays 'workflow-builder' so saved rail layouts + the ⌘K
  // source id survive the restructuring (the architect-gate parity pin).
  const shellConfig: SurfaceShellConfig = {
    storageKey: 'workflow-builder',
    shellClassName: 'builder-shell',
    colsClassName: 'builder-body cv-editor__cols',
    bar: () => (
      <>
        <BuilderToolbar
          name={name}
          workflowId={workflowId}
          canUndo={liveCollab ? liveCollab.canUndo : canUndo}
          canRedo={liveCollab ? liveCollab.canRedo : canRedo}
          running={running}
          undo={liveCollab ? liveCollab.undo : undo}
          redo={liveCollab ? liveCollab.redo : redo}
          onExport={onExport}
          onExportChainPack={onExportChainPack}
          onPublishToRegistry={onPublishToRegistry}
          onImportFile={onImportFile}
          onNewWorkflow={onNewWorkflow}
          onValidate={onValidate}
          onRun={() => onRun()}
          draft={lifecycle?.transient ? { canSave: greenRun } : null}
          onSaveDraft={() => { void onSaveDraft(); }}
          publish={!lifecycle?.transient && publishPending ? { canPublish: true } : null}
          onPublishChanges={() => { void onPublishChanges(); }}
          onOpenHistory={() => setHistoryOpen((v) => !v)}
          onOpenEvals={() => setEvalsOpen((v) => !v)}
          runEstimate={runEstimate}
          heatmapOn={failureHeat !== null && failureHeatMode === 'failures'}
          onToggleHeatmap={() => { void onToggleHeatmap(); }}
          costHeatmapOn={failureHeat !== null && failureHeatMode === 'cost'}
          onToggleCostHeatmap={() => { void onToggleCostHeatmap(); }}
          aiOpen={aiOpen}
          aiTriggerRef={aiTriggerRef}
          onCreateWithAi={() => { setAiHasOpened(true); setAiOpen((v) => !v); }}
          collab={collabAvailable ? {
            status: collabChipStatus,
            peerCount: collabPeerCount,
            peerNames: presence.peers.map((p) => p.name).join(', '),
          } : null}
          onToggleCollab={() => setCollabWanted((v) => !v)}
        />
        {/* ADR 0481 D5 — polite live region for the coalesced join/leave
            announcements (peer selections are never announced). */}
        {/* `aria-atomic` is load-bearing with `useLiveRegion`: its repeat
            mechanism is a trailing invisible marker on a ' — '-joined string,
            and without atomic some AT reads only the CHANGED portion — i.e.
            just the marker. Matches GlobalLiveRegion. */}
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{collabAnnounce}</div>
        {/* ADR 0596 (`WFAU-5`) — the focus/Escape pattern BOTH sibling builder
            drawers already implement (`HistoryDrawer`, `EvalsDrawer`): focus in
            on open, Escape to close, focus restored to the trigger. Close lives
            INSIDE the collapsing region, so without restoration activating it
            stranded focus on <body> when `visibility:hidden` landed 220 ms later.
            `inert` when closed rather than `aria-hidden` alone: `aria-hidden`
            flips synchronously while `visibility` lags the transition, so during
            the close animation visible, focusable content sat inside an
            aria-hidden subtree (WCAG 4.1.2). `inert` removes it from BOTH the
            a11y tree and the tab order for exactly that window. */}
        <div
          className="builder-ai-drawer"
          id="builder-ai-drawer"
          data-open={aiOpen ? 'true' : 'false'}
          aria-hidden={!aiOpen}
          {...(aiOpen ? {} : { inert: '' })}
          tabIndex={-1}
          ref={aiDrawerRef}
          onKeyDown={drawerEscapeHandler(closeAiDrawer)}
        >
          <div className="builder-ai-drawer-inner">
            {aiHasOpened && <CreateWithAiPanel onClose={closeAiDrawer} open={aiOpen} {...(latchedSeedPrompt ? { seedPrompt: latchedSeedPrompt } : {})} />}
          </div>
        </div>
        {error && <div role="alert" className="alert error builder-toolbar-error">{error}</div>}
        {validateOk && (
          <div className="alert success builder-toolbar-error" role="status">
            <CheckIcon size={14} /> {validateOk}
          </div>
        )}
        {/* ADR 0434 — renders only when the backend REFUSED an autosave. FIRST in
            the banner stack deliberately: "your work is not saved to your account"
            outranks publish hints, preflight warnings, and run status. */}
        <SyncFailureBanner />
        {showLargeCanvasNote ? (
          <Notice variant="info">
            <span className="u-flex u-items-center u-gap-2 u-wrap">
              {t('largeCanvasNote', { count: nodeCount, budget: CANVAS_NODE_BUDGET })}
              <Button
                variant="quiet" size="sm"
                onClick={() => dismissLargeCanvas(workflowId)}
              >
                {t('largeCanvasDismiss')}
              </Button>
            </span>
          </Notice>
        ) : null}
        {workflowId && evalsOpen ? (
          <EvalsDrawer workflowId={workflowId} open onClose={() => setEvalsOpen(false)} />
        ) : null}
        {workflowId ? (
          <HistoryDrawer
            workflowId={workflowId}
            open={historyOpen}
            onClose={() => setHistoryOpen(false)}
            onRestored={() => {
              // Reload the restored head into the canvas (the BuilderTab load path).
              void loadBackendWorkflowForRestore(workflowId).then((restored) => {
                if (restored) useBuilderStore.getState().loadFromSaved(restored);
              });
            }}
          />
        ) : null}
        {/* ADR 0475 — pins visible whenever they exist (the honesty surface). */}
        <DebugSessionBanner />
        {debugNotice && (
          <div className="alert warning builder-toolbar-error" role="status">
            {debugNotice}
            <Button variant="quiet" onClick={() => setDebugNotice(null)}>{t('dismiss')}</Button>
          </div>
        )}
        {/* ADR 0473 Phase 3 — a pending agent proposal referencing THIS draft:
            attribution + decide verbs; Approve & run persists the canvas first
            (approve-what-you-see) through saveWorkflow — the ONE draft writer
            (local cache + the ADR 0434 refused-save taxonomy; review F6), so
            the banner never becomes a third registration path. Preflight
            (capability/connection warnings) deliberately matches the chat
            card, not the Run button — the server-side gates are identical
            either way (review F5, documented parity). */}
        {workflowId ? (
          <ProposalBanner
            workflowId={workflowId}
            persistDraft={async () => {
              await saveWorkflow(useBuilderStore.getState().snapshot());
            }}
          />
        ) : null}
        <RemovedReferencedNodesNotice />
        {publishHelp && (
          <PublishHelpBanner publishHelp={publishHelp} onClose={() => setPublishHelp(null)} />
        )}
        {preflight && (
          <PreflightBanner
            preflight={preflight}
            onCancel={() => setPreflight(null)}
            onRunAnyway={() => onRun(true)}
          />
        )}
        {overlay && <RunOverlayBanner onDebugFromRun={(runId) => { void onDebugFromOverlayRun(runId); }} />}
      </>
    ),
    railL: {
      content: <NodePalette />,
      className: 'builder-rail',
      label: t('paletteRail'),
      expandLabel: t('expandPalette'),
      collapseLabel: t('collapsePalette'),
      resizeLabel: t('resizePalette'),
      announceCollapsed: t('annPaletteCollapsed'),
      announceExpanded: t('annPaletteExpanded'),
      defaultW: 260,
    },
    railR: {
      content: <Inspector />,
      className: 'builder-rail builder-rail--inspector',
      label: t('inspectorRail'),
      expandLabel: t('expandInspector'),
      collapseLabel: t('collapseInspector'),
      resizeLabel: t('resizeInspector'),
      announceCollapsed: t('annInspectorCollapsed'),
      announceExpanded: t('annInspectorExpanded'),
      defaultW: 320,
    },
    center: (
      // BLD-6: corrupt node data (e.g. a NaN position from a bad import or
      // localStorage row) makes xyflow throw — without a boundary that
      // white-screens the whole builder. Contain the crash to the canvas.
      <ErrorBoundary label="builder canvas">
        <BuilderCanvas />
      </ErrorBoundary>
    ),
    // §7.2.5 / CV-17 — the run/inspect drawer (payloads live here).
    tail: <RunDrawer />,
    typeShortcuts,
    typeT: t,
    commandsGroupLabel: t('commandsGroup'),
  };

  return <CanvasSurfaceShell config={shellConfig} />;
}
