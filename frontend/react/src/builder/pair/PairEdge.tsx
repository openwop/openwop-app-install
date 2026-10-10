/**
 * ADR 0773 G-02e — the builder's edge when pairing is on: the ordinary bezier
 * edge, plus a "+" at its midpoint on hover or selection (keyboard: select the
 * edge, then Tab to the "+"). The "+" opens:
 *   - the ports-filtered list of steps that fit between the two ends (the same
 *     `isPortCompatible` rule the drop picker uses) — picking one inserts it,
 *     splitting the edge, as ONE undo step (`applyEditOps`), and
 *   - one "from your words" ask scoped to this edge, which may come back as an
 *     edge condition instead of a new node (the smallest correct change).
 * No silent caps: the list says how many more fit.
 */

import { useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { PlusIcon, XIcon } from '../../ui/icons/index.js';
import { useBuilderStore } from '../store/builderStore.js';
import { catalogEntry, useCatalog } from '../palette/catalogRegistry.js';
import { isPortCompatible } from '../canvas/portCompatibility.js';
import { QuickAsk } from './QuickAsk.js';

const SHOWN = 6;

export interface PairEdgeData extends Record<string, unknown> {
  showPlus?: boolean;
  sourcePort?: string;
  targetPort?: string;
}

export function PairEdge(props: EdgeProps): JSX.Element {
  const { t } = useTranslation('builder');
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, label } = props;
  const data = (props.data ?? {}) as PairEdgeData;
  const [open, setOpen] = useState(false);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const catalog = useCatalog();
  const nodes = useBuilderStore((s) => s.nodes);
  const src = nodes.find((n) => n.id === source);
  const tgt = nodes.find((n) => n.id === target);

  const srcType = src ? catalogEntry(src.kind)?.outputs.find((p) => p.name === data.sourcePort)?.type : undefined;
  const tgtType = tgt ? catalogEntry(tgt.kind)?.inputs.find((p) => p.name === data.targetPort)?.type : undefined;
  const fits = open
    ? catalog.filter((e) => !e.clientOnly
      && e.inputs.some((p) => isPortCompatible(srcType, p.type))
      && e.outputs.some((p) => isPortCompatible(p.type, tgtType)))
    : [];

  const insert = (kind: string): void => {
    const entry = catalogEntry(kind);
    if (!entry || !src || !tgt) return;
    const newId = `n_${crypto.randomUUID().slice(0, 8)}`;
    const inPort = entry.inputs.find((p) => isPortCompatible(srcType, p.type))?.name;
    const outPort = entry.outputs.find((p) => isPortCompatible(p.type, tgtType))?.name;
    // ONE undo step: the split is one gesture (§7 one-gesture-one-step).
    useBuilderStore.getState().applyEditOps([
      { kind: 'removeEdge', edgeId: id },
      { kind: 'addNode', nodeId: newId, typeId: entry.typeId, name: entry.label, position: { x: (src.position.x + tgt.position.x) / 2, y: (src.position.y + tgt.position.y) / 2 } },
      { kind: 'addEdge', edgeId: `e_${crypto.randomUUID().slice(0, 8)}`, sourceNodeId: src.id, targetNodeId: newId, ...(data.sourcePort ? { sourceOutput: data.sourcePort } : {}), ...(inPort ? { targetInput: inPort } : {}) },
      { kind: 'addEdge', edgeId: `e_${crypto.randomUUID().slice(0, 8)}`, sourceNodeId: newId, targetNodeId: tgt.id, ...(outPort ? { sourceOutput: outPort } : {}), ...(data.targetPort ? { targetInput: data.targetPort } : {}) },
    ]);
    setOpen(false);
  };

  return (
    <>
      <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} />
      <EdgeLabelRenderer>
        <div className="pair-edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
          {label ? <span className="pair-edge-label__text">{label}</span> : null}
          {data.showPlus || open ? (
            <Button
              size="sm"
              variant="accent-solid"
              className="pair-edge-plus"
              aria-label={t('pairEdgeInsertAria', { from: src?.name ?? source, to: tgt?.name ?? target })}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <XIcon size={12} aria-hidden /> : <PlusIcon size={12} aria-hidden />}
            </Button>
          ) : null}
          {open ? (
            <div className="pair-edge-popover surface-card" role="group" aria-label={t('pairEdgeInsertTitle')}>
              <p className="pair-edge-popover__title u-fs-12">{t('pairEdgeInsertTitle')}</p>
              <QuickAsk
                autoFocus
                inline
                framing={t('pairEdgeInsertFraming', { from: src?.name ?? source, to: tgt?.name ?? target })}
                onDone={() => setOpen(false)}
              />
              <ul className="pair-edge-popover__list">
                {fits.slice(0, SHOWN).map((e) => (
                  <li key={e.kind}>
                    <Button size="sm" variant="quiet" onClick={() => insert(e.kind)}>{e.label}</Button>
                  </li>
                ))}
              </ul>
              {fits.length > SHOWN ? <p className="muted u-fs-12 u-m-0">{t('pairEdgeMoreFit', { count: fits.length - SHOWN })}</p> : null}
            </div>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
