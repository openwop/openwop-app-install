/**
 * ADR 0773 D5 — a node the Architect SUGGESTS adding: dashed clay, numbered,
 * not selectable/draggable/deletable (it is not in the workflow yet). Clicking
 * it focuses that change in the review. Ports are rendered so ghost edges have
 * somewhere to attach; they are not connectable.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { ShieldIcon } from '../../ui/icons/index.js';
import { Button } from '../../ui/Button.js';
import { catalogEntry } from '../palette/catalogRegistry.js';
import { usePairStore } from './pairStore.js';

interface GhostData extends Record<string, unknown> {
  kind: string;
  name: string;
  index: number;
  gateSensitive: boolean;
  focused: boolean;
  /** G-03b — a DROPPED add, kept visible (faint) so the drop is reversible. */
  dropped?: boolean;
  /** G-05a — just arrived in an append batch (animates in). */
  landing?: boolean;
  /** G-06b — a collaborator's shared suggestion: their display name; read-only. */
  peer?: string;
}

function GhostNodeImpl({ data }: NodeProps): JSX.Element {
  const { t } = useTranslation('builder');
  const d = data as GhostData;
  const entry = catalogEntry(d.kind);
  const cls = `builder-node builder-node--ghost${d.focused ? ' is-focused' : ''}${d.dropped ? ' is-dropped' : ''}${d.landing ? ' is-landing' : ''}${d.peer !== undefined ? ' is-peer' : ''}`;
  if (d.peer !== undefined) {
    return (
      <div className={cls}>
        {(entry?.inputs.length ?? 1) > 0 ? <Handle type="target" position={Position.Left} isConnectable={false} /> : null}
        <div className="builder-node--ghost__body">
          <span className="builder-node--ghost__eyebrow">{d.peer ? t('pairPeerGhost', { name: d.peer }) : t('pairPeerGhostAnon')}</span>
          <span className="builder-node--ghost__name">{d.name}</span>
        </div>
        {(entry?.outputs.length ?? 1) > 0 ? <Handle type="source" position={Position.Right} isConnectable={false} /> : null}
      </div>
    );
  }
  if (d.dropped) {
    return (
      <div className={cls}>
        <Button variant="quiet" className="builder-node--ghost__body" aria-label={t('pairGhostRestoreAria', { n: d.index + 1, name: d.name })} onClick={() => usePairStore.getState().restore([d.index])}>
          <span className="builder-node--ghost__eyebrow">{t('pairOpDropped')}</span>
          <span className="builder-node--ghost__name">{d.name}</span>
          <span className="u-fs-12">{t('pairRestore')}</span>
        </Button>
      </div>
    );
  }
  return (
    <div className={cls}>
      {(entry?.inputs.length ?? 1) > 0 ? <Handle type="target" position={Position.Left} isConnectable={false} /> : null}
      <Button
        variant="quiet"
        className="builder-node--ghost__body"
        aria-label={t('pairGhostAria', { n: d.index + 1, name: d.name })}
        onClick={() => usePairStore.getState().focusOp(d.index)}
      >
        <span className="builder-node--ghost__eyebrow">
          <span>{entry?.category ?? t('pairGhostNew')}</span>
          {d.gateSensitive ? <ShieldIcon size={11} aria-hidden /> : null}
          <span className="builder-node--ghost__num" aria-hidden>{d.index + 1}</span>
        </span>
        <span className="builder-node--ghost__name">{d.name}</span>
      </Button>
      {(entry?.outputs.length ?? 1) > 0 ? <Handle type="source" position={Position.Right} isConnectable={false} /> : null}
    </div>
  );
}

export const GhostNode = memo(GhostNodeImpl);
