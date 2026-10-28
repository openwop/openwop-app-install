/**
 * Single xyflow custom node component used for every BuilderNodeKind.
 * Reads the catalog entry off `data.kind` to render the badge,
 * accent stripe, port labels, and handle positions.
 *
 * During a live-run overlay, `data.runStatus` paints a status badge +
 * glow so the canvas doubles as an execution view.
 */

import { CATEGORY_LABEL_KEYS } from '../../palette/categoryLabels.js';
import { Button } from '../../../ui/Button.js';
import { memo, useEffect, useState, type ReactNode } from 'react';
import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { catalogEntry } from '../../palette/catalogRegistry.js';
import { formatUsd } from '../../../i18n/format.js';
import type { NodeRunStatus } from '../../store/builderStore.js';
import { useCanvasStore, useCanvasStoreApi } from '../../store/canvasStore.js';
import { CircleIcon, CheckIcon, XIcon, PauseIcon, AlertIcon, LinkIcon, PinIcon, MessageCircleIcon } from '../../../ui/icons/index.js';
import { usePairStore } from '../../pair/pairStore.js';
import { QuickAsk } from '../../pair/QuickAsk.js';
import { runFromNode } from '../../debugSession.js';
import { toast } from '../../../ui/toast.js';
import { GripVerticalIcon, WandIcon } from '../../../ui/icons/index.js';

/** ADR 0773 G-02d — the native drag payload a node's cite handle carries. */
export const NODE_CITE_MIME = 'application/openwop-node-id';

/** §7.4 / CV-5 — the keyboard-connect affordance state BuilderCanvas feeds
 *  each node (the GraphSurface arm→target pattern, typed-port validated). */
export interface NodeConnectState {
  /** A source is armed somewhere on the canvas. */
  armed: boolean;
  /** This node IS the armed source. */
  isSource: boolean;
  /** Armed + this node has a type-compatible input for the source. */
  canTarget: boolean;
  onArm: () => void;
  onTarget: () => void;
}

interface NodeData extends Record<string, unknown> {
  kind: string;
  name: string;
  /** Live run status painted by the execution overlay; undefined when idle. */
  runStatus?: NodeRunStatus;
  /** ADR 0475 — this node's output is pinned in the debug session. */
  pinned?: boolean;
  /** ADR 0476 — failed-run count for the failure heatmap (undefined = off). */
  failureCount?: number;
  /** ADR 0482 §6 — this node's USD from the latest terminal run's costByNode
   *  stamp, painted by the cost-heatmap mode (undefined = off/none). */
  costUsd?: number;
  /** ADR 0481 D5 — live-session peers with this node selected (quiet dots
   *  beside the pin corner; `color` is a design-token var() reference;
   *  `clientId` is the stable render key — names can collide, ux-H3). */
  peers?: { clientId: number; name: string; color: string }[];
  /** §7.4 / CV-5 keyboard-connect (absent for client-only nodes). */
  connect?: NodeConnectState;
  /** ADR 0773 — numbered pending suggestion ops that touch this node. */
  suggestMarks?: number[];
  /** ADR 0773 — a pending suggestion removes this node. */
  suggestRemove?: boolean;
  /** ADR 0773 D6 — near-selection pair actions (present only on the ONE
   *  selected node while pairing is on). `runId` = its failed run → Diagnose. */
  pairActions?: { runId?: string | undefined };
  /** ADR 0773 G-02d — pairing is on, so the node offers a cite handle. */
  pairCitable?: boolean;
}

/** ADR 0773 D6 — Ask / Explain / Diagnose, docked above the selected node
 *  (the §7.1.2 near-selection toolbar, the only chrome that floats on the sheet). */
function PairNodeToolbar({ nodeId, name, runId }: { nodeId: string; name: string; runId?: string | undefined }): JSX.Element {
  const { t } = useTranslation('builder');
  const [asking, setAsking] = useState(false);
  const ask = usePairStore((s) => s.ask);
  // P11 — ⌘. with this node selected opens the prompt here, at the node.
  const inlineAskFor = usePairStore((s) => s.inlineAskFor);
  useEffect(() => {
    if (inlineAskFor !== nodeId) return;
    setAsking(true);
    usePairStore.getState().requestInlineAsk(null);
  }, [inlineAskFor, nodeId]);
  const run = (mode: 'from-here' | 'only'): void => {
    void runFromNode(nodeId, mode).catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
  };
  return (
    <NodeToolbar isVisible position={Position.Top} className="pair-node-toolbar">
      {asking ? (
        <QuickAsk autoFocus inline onDone={() => setAsking(false)} />
      ) : (
        <div role="group" aria-label={t('pairNodeToolbarAria', { name })} className="pair-node-toolbar__row">
          <Button size="sm" variant="accent" onClick={() => setAsking(true)}>
            <MessageCircleIcon size={12} aria-hidden /> {t('pairAsk')}
          </Button>
          <Button size="sm" variant="quiet" onClick={() => ask(t('pairExplainPrompt', { name }), { inline: true })}>{t('pairExplain')}</Button>
          {runId ? (
            <>
              <Button size="sm" variant="quiet" onClick={() => ask(t('pairDiagnosePrompt', { name }), { runId, nodeId })}>{t('pairDiagnose')}</Button>
              {/* G-04c — the existing debug-lane handlers, not a second run path. */}
              <Button size="sm" variant="quiet" onClick={() => run('only')}>{t('pairRetryStep')}</Button>
              <Button size="sm" variant="quiet" onClick={() => usePairStore.getState().requestDebug(runId)}>{t('pairDebugSession')}</Button>
            </>
          ) : (
            // G-01b — "Run from here", the Inspector's NodeDebugSection handler.
            <Button size="sm" variant="quiet" onClick={() => run('from-here')}>{t('debugRunFromHere')}</Button>
          )}
        </div>
      )}
    </NodeToolbar>
  );
}

// Status → accent color + glyph for the live-execution overlay badge.
// `labelKey` resolves to translated copy in the `builder` namespace.
const RUN_STATUS_META: Record<NodeRunStatus, { color: string; labelKey: string; glyph: ReactNode }> = {
  running: { color: 'var(--color-warning-text)', labelKey: 'runStatusRunning', glyph: <CircleIcon size={12} filled /> },
  completed: { color: 'var(--color-success-text)', labelKey: 'runStatusCompleted', glyph: <CheckIcon size={12} /> },
  failed: { color: 'var(--color-danger-text)', labelKey: 'runStatusFailed', glyph: <XIcon size={12} /> },
  suspended: { color: 'var(--color-ai-text)', labelKey: 'runStatusSuspended', glyph: <PauseIcon size={12} /> },
};

function BaseNodeImpl({ id, data, selected }: NodeProps) {
  const { t } = useTranslation('builder');
  const d = data as NodeData;
  const entry = catalogEntry(d.kind);
  if (!entry) {
    return <div className="builder-node builder-node-unknown">{t('unknownNodePrefix', { kind: d.kind })}</div>;
  }
  // NPV2-U-9 — see the handle render below.
  const handlesInRows = entry.inputs.length > 1 || entry.outputs.length > 1;
  // Client-only nodes (sticky notes, future annotations) get a distinct
  // render: no ports, no run status (they never execute), no missing-
  // capability warnings (preflight skips them), and the prominent
  // content is the config string set on the node itself. The Inspector
  // still drives the configField so authors edit content via the same
  // textarea pattern as any other node.
  if (entry.clientOnly) {
    return <ClientOnlyNode nodeId={id} selected={Boolean(selected)} accent={entry.accent} badge={entry.badge} />;
  }
  const runMeta = d.runStatus ? RUN_STATUS_META[d.runStatus] : null;
  const runMetaLabel = runMeta ? t(runMeta.labelKey) : '';
  // Author-time capability gap: the connected host doesn't advertise a
  // surface this node kind needs (catalog `missingHostSurfaces`, server-
  // computed). Surface it on the canvas — not just the inspector — so the
  // unrunnable node is visible at a glance. A live run takes visual
  // priority, so suppress the warning while a run status is painted.
  const missingSurfaces = entry.missingHostSurfaces ?? [];
  const showCapWarning = missingSurfaces.length > 0 && !d.runStatus;
  return (
    <div
      className={`builder-node${selected ? ' builder-node-selected' : ''}${
        d.runStatus ? ` builder-node-run-${d.runStatus}` : ''
      }${showCapWarning ? ' builder-node-warn' : ''}${d.suggestRemove ? ' builder-node--suggest-remove' : ''}${
        d.suggestMarks && d.suggestMarks.length > 0 ? ' builder-node--suggested' : ''}`}
      style={{
        borderLeftColor: entry.accent,
        ...(runMeta
          ? { boxShadow: `0 0 0 2px ${runMeta.color}`, transition: 'box-shadow 150ms ease' }
          : {}),
      }}
    >
      {showCapWarning && (
        <span
          role="img"
          className="builder-node-warn-badge"
          title={t('hostCantRunNodeTitle', { caps: missingSurfaces.join(', ') })}
          aria-label={t('hostCapabilityMissingNeedsAria', { caps: missingSurfaces.join(', ') })}
        >
          <AlertIcon size={14} />
        </span>
      )}
      {typeof d.failureCount === 'number' && d.failureCount > 0 && (
        <span
          className="builder-node-heat-badge"
          role="img"
          title={t('heatBadgeTitle', { count: d.failureCount })}
          aria-label={t('heatBadgeAria', { count: d.failureCount })}
        >
          {d.failureCount}
        </span>
      )}
      {/* ADR 0482 §6 — the cost-heatmap badge (mutually exclusive with the
          failure badge by construction: the store carries ONE mode). */}
      {typeof d.costUsd === 'number' && d.costUsd > 0 && (
        <span
          className="builder-node-heat-badge builder-node-heat-badge--cost"
          role="img"
          title={t('costBadgeTitle', { usd: formatUsd(d.costUsd) })}
          aria-label={t('costBadgeAria', { usd: formatUsd(d.costUsd) })}
        >
          {formatUsd(d.costUsd)}
        </span>
      )}
      {d.pinned && (
        <span
          className="builder-node-pin-badge"
          role="img"
          title={t('debugPinnedBadgeTitle')}
          aria-label={t('debugPinnedBadgeAria')}
        >
          <PinIcon size={12} />
        </span>
      )}
      {d.pairActions ? <PairNodeToolbar nodeId={id} name={d.name} runId={d.pairActions.runId} /> : null}
      {/* G-04d — a suggested fix on a FAILED node is flagged right beside it. */}
      {d.runStatus === 'failed' && d.suggestMarks && d.suggestMarks.length > 0 ? (
        <span className="builder-node-fix-chip">
          <WandIcon size={11} aria-hidden /> {t('pairFixReady', { count: d.suggestMarks.length })}
        </span>
      ) : null}
      {/* G-02d — a cite handle: native DnD (the node itself drags with xyflow's
          pointer gesture; `nodrag` keeps them apart). Drop it on the Pair panel. */}
      {d.pairCitable ? (
        <Button
          variant="quiet"
          size="sm"
          className="builder-node-cite nodrag"
          draggable
          aria-label={t('pairCiteHandleAria', { name: d.name })}
          title={t('pairCiteHandleTitle')}
          onDragStart={(e) => { e.dataTransfer.setData(NODE_CITE_MIME, id); e.dataTransfer.effectAllowed = 'copy'; }}
          onClick={() => usePairStore.getState().cite(id)}
        >
          <GripVerticalIcon size={12} aria-hidden />
        </Button>
      ) : null}
      {d.suggestMarks && d.suggestMarks.length > 0 ? (
        <span
          className="builder-node-suggest-badge"
          role="img"
          aria-label={t('pairNodeMarksAria', { list: d.suggestMarks.map((m) => m + 1).join(', ') })}
        >
          {d.suggestMarks.map((m) => m + 1).join('·')}
        </span>
      ) : null}
      {/* ADR 0481 D5 — live-session peer markers: quiet identity dots beside
          the pin corner (deliberately NOT a fifth corner badge). */}
      {d.peers && d.peers.length > 0 && (
        <span
          className="builder-node-peers"
          role="img"
          title={t('collabNodePeersAria', { names: d.peers.map((p) => p.name).join(', ') })}
          aria-label={t('collabNodePeersAria', { names: d.peers.map((p) => p.name).join(', ') })}
        >
          {d.peers.slice(0, 3).map((p) => (
            <span key={p.clientId} className="builder-node-peer-dot" style={{ background: p.color }} />
          ))}
          {/* ux-M1 — dots cap at 3; the remainder is said, not hidden. */}
          {d.peers.length > 3 && (
            <span className="builder-node-peers-more">+{d.peers.length - 3}</span>
          )}
        </span>
      )}
      {runMeta && (
        <span
          role="img"
          className="builder-node-run-badge basenode-run-badge"
          title={runMetaLabel}
          aria-label={t('runStatusBadgeAria', { status: runMetaLabel })}
          style={{
            background: runMeta.color,
            // running → live breathe; landed (completed/failed) → one-shot
            // "stamp" press so the run visibly settles down the graph (§6).
            animation: d.runStatus === 'running'
              ? 'openwop-pulse 1.2s ease-in-out infinite'
              : (d.runStatus === 'completed' || d.runStatus === 'failed')
                ? 'openwop-stamp-in 280ms cubic-bezier(0.34, 1.56, 0.64, 1) 1'
                : 'none',
          }}
        >
          {runMeta.glyph}
        </span>
      )}
      {/* NPV2-U-9 — a node with at most one port per side keeps its handles
          centred on the node. As soon as EITHER side has several, EVERY handle
          renders inside its own label row (below), so no handle sits beside
          another port's label — including the lone port on a mixed node. That matters
          beyond looks: a handle's id is its input field, and an edge dropped on
          it routes data into that field. */}
      {!handlesInRows && entry.inputs.map((p) => (
        <Handle key={`in-${p.name}`} id={p.name} type="target" position={Position.Left} style={{ top: '50%', background: entry.accent }} />
      ))}
      {!handlesInRows && entry.outputs.map((p) => (
        <Handle key={`out-${p.name}`} id={p.name} type="source" position={Position.Right} style={{ top: '50%', background: entry.accent }} />
      ))}
      <div className="builder-node-header">
        {/* grade-ux U-5 — the letter + fill are decorative; the category is
            otherwise conveyed by colour alone, so name it for screen readers. */}
        <span className="builder-node-badge" style={{ background: entry.accent }} aria-hidden="true">
          {entry.badge}
        </span>
        <span className="sr-only">{t(CATEGORY_LABEL_KEYS[entry.category])}</span>
        <EditableTitle nodeId={id} name={d.name} />
        {/* §7.4 / CV-5 — keyboard-connect: the selected node arms a source;
            armed, every type-compatible node offers a validated target. */}
        {d.connect && selected && !d.connect.armed && entry.outputs.length > 0 ? (
          <Button
            variant="quiet" size="sm" className="builder-node-connect nodrag"
            title={t('connectArmFromNode', { name: d.name })}
            aria-label={t('connectArmFromNode', { name: d.name })}
            onClick={(e) => { e.stopPropagation(); d.connect?.onArm(); }}
          >
            <LinkIcon size={12} aria-hidden />
          </Button>
        ) : null}
        {d.connect?.canTarget ? (
          <Button
            variant="accent" size="sm" className="builder-node-connect nodrag"
            title={t('connectTargetNode', { name: d.name })}
            aria-label={t('connectTargetNode', { name: d.name })}
            onClick={(e) => { e.stopPropagation(); d.connect?.onTarget(); }}
          >
            <LinkIcon size={12} aria-hidden /> {t('connectTo')}
          </Button>
        ) : null}
      </div>
      <div className="builder-node-ports">
        <div className="builder-node-ports-col">
          {entry.inputs.map((p) => (
            <div key={p.name} className="builder-node-port">
              {handlesInRows && (
                <Handle id={p.name} type="target" position={Position.Left} style={{ background: entry.accent }} />
              )}
              <span className="builder-node-port-label">{p.name}</span>
            </div>
          ))}
        </div>
        <div className="builder-node-ports-col builder-node-ports-col-right">
          {entry.outputs.map((p) => (
            <div key={p.name} className="builder-node-port builder-node-port-right">
              {handlesInRows && (
                <Handle id={p.name} type="source" position={Position.Right} style={{ background: entry.accent }} />
              )}
              <span className="builder-node-port-label">{p.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Canvas annotation (sticky note, etc). The content lives on the node's
// `config.content` field and is edited in the Inspector; here we just
// surface it on the canvas so the annotation is readable in context.
// Pale-yellow paper, italic body, no port handles. Click on the body to
// select the node so the Inspector opens (matches BaseNode click target).
function ClientOnlyNode({ nodeId, selected, accent, badge }: {
  nodeId: string;
  selected: boolean;
  accent: string;
  badge: string;
}) {
  const { t } = useTranslation('builder');
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId) ?? null);
  if (!node) return null;
  const content = (node.config['content'] as string | undefined) ?? '';
  return (
    <div
      className={`builder-node builder-node-client-only${selected ? ' builder-node-selected' : ''}`}
      style={{ borderLeftColor: accent }}
    >
      <div className="builder-node-client-only__head">
        <span className="builder-node-client-only__badge">{badge}</span>
        <span className="muted builder-node-client-only__name">{node.name}</span>
      </div>
      <div className={`builder-node-client-only__body${content ? '' : ' builder-node-client-only__body--empty'}`}>
        {content || t('emptyNote')}
      </div>
    </div>
  );
}

// Inline node-title editing: double-click the title to rename. The
// `nodrag` class stops xyflow from dragging the node while editing, and
// stopPropagation keeps the canvas keyboard shortcuts (Delete / ⌘D)
// from firing keystrokes meant for the input.
function EditableTitle({ nodeId, name }: { nodeId: string; name: string }) {
  const { t } = useTranslation('builder');
  const canvasStore = useCanvasStoreApi();
  const readOnly = useCanvasStore((s) => s.readOnly);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  // ADR 0960 D3 — a run view shows the title; it never offers a rename.
  if (readOnly) return <span className="builder-node-title">{name}</span>;
  if (!editing) {
    return (
      <span
        className="builder-node-title"
        title={t('doubleClickToRename')}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(name);
          setEditing(true);
        }}
      >
        {name}
      </span>
    );
  }
  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) canvasStore.getState().updateNode(nodeId, { name: trimmed });
    setEditing(false);
  };
  return (
    <input
      className="builder-node-title-input nodrag"
      value={draft}
      autoFocus
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

export const BaseNode = memo(BaseNodeImpl);
