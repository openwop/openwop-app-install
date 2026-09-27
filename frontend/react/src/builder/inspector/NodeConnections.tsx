/**
 * NodeConnections — the keyboard path for wiring nodes (DESIGN.md §11; closes
 * UX-ASSESSMENT BLD-1). The canvas connect gesture is pointer-only (xyflow
 * handle→handle drag), so this Inspector section is the accessible way to
 * create and remove a selected node's edges: pick one of the node's output
 * ports, a compatible target node, and a compatible target input — enforcing
 * the same catalog + port-compatibility rules the canvas drag applies via
 * `isValidConnection`.
 *
 * Mount keyed by node id (`<NodeConnections key={node.id} …/>`) so the picker
 * state resets when the selection moves to another node.
 */

import { Button } from '../../ui/Button.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBuilderStore } from '../store/builderStore.js';
import { catalogEntry } from '../palette/catalogRegistry.js';
import { isPortCompatible } from '../canvas/portCompatibility.js';
import type { BuilderNode } from '../schema/workflow.js';
import { SelectField } from '../../ui/Field.js';
import { scrollBehavior } from '../../ui/motion.js';
import { IconButton } from '../../ui/IconButton.js';
import { TrashIcon } from '../../ui/icons/index.js';

export function NodeConnections({ node }: { node: BuilderNode }): JSX.Element {
  const { t } = useTranslation('builder');
  const nodes = useBuilderStore((s) => s.nodes);
  const edges = useBuilderStore((s) => s.edges);
  const addEdge = useBuilderStore((s) => s.addEdge);
  const removeEdge = useBuilderStore((s) => s.removeEdge);

  // E.1 — the canvas "Connect…" hint requests focus here via a store nonce
  // (the RunsIndexPage focusCreateForm pattern: scroll + focus first control;
  // with no connect form rendered, the scroll still lands on the section note).
  const focusReq = useBuilderStore((s) => s.connectionsFocusRequest);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Baseline the nonce at mount: this component remounts per selection
  // (key={node.id}), so without it a stale nonce would replay and steal
  // focus on EVERY later selection once the hint had been used once.
  const lastReq = useRef(focusReq);
  useEffect(() => {
    if (focusReq === lastReq.current) return;
    lastReq.current = focusReq;
    const el = rootRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    (el.querySelector<HTMLElement>('select') ?? el.querySelector<HTMLElement>('button'))?.focus();
  }, [focusReq]);

  const outputs = catalogEntry(node.kind)?.outputs ?? [];
  const [sourcePort, setSourcePort] = useState(outputs[0]?.name ?? '');
  const sourceType = outputs.find((p) => p.name === sourcePort)?.type;

  // Nodes exposing at least one input compatible with the chosen output —
  // the same rule the canvas drag enforces, so this path can't author an
  // edge the canvas would refuse.
  const targets = useMemo(
    () =>
      nodes
        .map((n) => ({
          node: n,
          inputs: (catalogEntry(n.kind)?.inputs ?? []).filter((p) => isPortCompatible(sourceType, p.type)),
        }))
        .filter((c) => c.node.id !== node.id && c.inputs.length > 0),
    [nodes, node.id, sourceType],
  );
  const [targetId, setTargetId] = useState('');
  const target = targets.find((c) => c.node.id === targetId) ?? null;
  const [targetPort, setTargetPort] = useState('');
  // Keep the input pick valid when the target (or output) changes.
  const resolvedTargetPort = target?.inputs.some((p) => p.name === targetPort)
    ? targetPort
    : (target?.inputs[0]?.name ?? '');
  const duplicate = target !== null && edges.some(
    (e) =>
      e.source === node.id &&
      e.target === target.node.id &&
      e.sourcePort === sourcePort &&
      e.targetPort === resolvedTargetPort,
  );
  // Announced via the role=status region below so SR users hear the result
  // (the new edge itself renders on the canvas, outside their focus).
  const [added, setAdded] = useState('');

  const nodeName = (id: string): string => nodes.find((n) => n.id === id)?.name ?? id;
  const mine = edges.filter((e) => e.source === node.id || e.target === node.id);

  return (
    <div ref={rootRef}>
      <div className="builder-inspector-divider" />
      <div className="builder-inspector-section-label">{t('connectionsSection')}</div>
      {mine.length === 0 ? (
        <p className="muted binspector-conn-note">{t('noConnections')}</p>
      ) : (
        <ul className="u-list-none binspector-conn-list">
          {mine.map((e) => {
            const desc = e.source === node.id
              ? t('connectionOut', { port: e.sourcePort, node: nodeName(e.target), targetPort: e.targetPort })
              : t('connectionIn', { targetPort: e.targetPort, node: nodeName(e.source), port: e.sourcePort });
            return (
              <li key={e.id} className="u-flex u-items-center u-justify-between u-gap-2">
                <span className="binspector-conn-desc">{desc}</span>
                <IconButton
                  label={t('removeConnection', { desc })}
                  icon={<TrashIcon size={12} />}
                  onClick={() => removeEdge(e.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
      {outputs.length > 0 && (
        targets.length === 0 ? (
          <p className="muted binspector-conn-note">{t('noCompatibleTargets')}</p>
        ) : (
          <>
            <SelectField
              label={t('connectFromOutput')}
              value={sourcePort}
              onChange={(e) => setSourcePort(e.target.value)}
            >
              {outputs.map((p) => (
                <option key={p.name} value={p.name}>{p.name} ({p.type ?? 'any'})</option>
              ))}
            </SelectField>
            <SelectField
              label={t('connectToNode')}
              value={target ? target.node.id : ''}
              onChange={(e) => setTargetId(e.target.value)}
            >
              <option value="">{t('connectPickNode')}</option>
              {targets.map((c) => (
                <option key={c.node.id} value={c.node.id}>{c.node.name}</option>
              ))}
            </SelectField>
            {target && (
              <SelectField
                label={t('connectToInput')}
                value={resolvedTargetPort}
                onChange={(e) => setTargetPort(e.target.value)}
              >
                {target.inputs.map((p) => (
                  <option key={p.name} value={p.name}>{p.name} ({p.type ?? 'any'})</option>
                ))}
              </SelectField>
            )}
            <Button
              variant="secondary"
              disabled={!target || !resolvedTargetPort || duplicate}
              title={duplicate ? t('connectionExists') : undefined}
              onClick={() => {
                if (!target || !resolvedTargetPort) return;
                addEdge({
                  source: node.id,
                  sourcePort,
                  target: target.node.id,
                  targetPort: resolvedTargetPort,
                });
                setAdded(t('connectionAdded', { source: node.name, target: target.node.name }));
              }}
            >
              {t('addConnection')}
            </Button>
            <span role="status" className="sr-only">{added}</span>
          </>
        )
      )}
    </div>
  );
}
