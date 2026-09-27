/**
 * Single xyflow custom node component used for every BuilderNodeKind.
 * Reads the catalog entry off `data.kind` to render the badge,
 * accent stripe, port labels, and handle positions.
 *
 * During a live-run overlay, `data.runStatus` paints a status badge +
 * glow so the canvas doubles as an execution view.
 */

import { Button } from '../../../ui/Button.js';
import { memo, useState, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { catalogEntry } from '../../palette/catalogRegistry.js';
import { formatUsd } from '../../../i18n/format.js';
import { useBuilderStore, type NodeRunStatus } from '../../store/builderStore.js';
import { CircleIcon, CheckIcon, XIcon, PauseIcon, AlertIcon, LinkIcon, PinIcon } from '../../../ui/icons/index.js';

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
      }${showCapWarning ? ' builder-node-warn' : ''}`}
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
      {entry.inputs.map((p, i, arr) => (
        <Handle
          key={`in-${p.name}`}
          id={p.name}
          type="target"
          position={Position.Left}
          style={{ top: handleTop(i, arr.length), background: entry.accent }}
        />
      ))}
      {entry.outputs.map((p, i, arr) => (
        <Handle
          key={`out-${p.name}`}
          id={p.name}
          type="source"
          position={Position.Right}
          style={{ top: handleTop(i, arr.length), background: entry.accent }}
        />
      ))}
      <div className="builder-node-header">
        <span className="builder-node-badge" style={{ background: entry.accent }}>
          {entry.badge}
        </span>
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
              <span className="builder-node-port-label">{p.name}</span>
            </div>
          ))}
        </div>
        <div className="builder-node-ports-col builder-node-ports-col-right">
          {entry.outputs.map((p) => (
            <div key={p.name} className="builder-node-port builder-node-port-right">
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
  const node = useBuilderStore((s) => s.nodes.find((n) => n.id === nodeId) ?? null);
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
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
    if (trimmed && trimmed !== name) useBuilderStore.getState().updateNode(nodeId, { name: trimmed });
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

// Single port → exactly on vertical center. Multi-port → evenly
// spaced around vertical center (20px between adjacent handles).
function handleTop(index: number, count: number): string {
  if (count <= 1) return '50%';
  const SPACING = 20;
  const offsetPx = (index - (count - 1) / 2) * SPACING;
  return `calc(50% + ${offsetPx}px)`;
}

export const BaseNode = memo(BaseNodeImpl);
