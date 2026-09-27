/**
 * Entities schema graph (ADR 0386 Phase 5) — a read-only ER-style view of the
 * workspace's content model over the EXISTING xyflow dep (reuse, not a new
 * graph lib). Nodes are entity types (fields listed); solid edges are declared
 * Relationship policies, dashed edges are `reference` fields. All colors ride
 * design tokens via classes — nothing hardcoded (the xyflow theming rule).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DatabaseIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import {
  listEntityTypes,
  listRelationships,
  type EntityType,
  type Relationship,
} from './entitiesClient.js';

interface TypeNodeData extends Record<string, unknown> {
  type: EntityType;
}

/** One entity type as a compact card: name, status, field list. */
function TypeNode({ data }: NodeProps<Node<TypeNodeData>>): JSX.Element {
  const { t } = useTranslation('entities');
  const { type } = data;
  return (
    <div className="surface-card u-p-3" data-testid={`schema-node-${type.name}`}>
      <div className="u-flex u-items-center u-gap-2 u-mb-1">
        <strong className="u-fs-13">{type.displayName}</strong>
        <span className={type.status === 'published' ? 'chip chip--success' : 'chip chip--warning'}>
          {type.status === 'published' ? t('statusPublished') : t('statusDraft')}
        </span>
      </div>
      <ul className="u-list-none u-p-0 u-m-0">
        {type.fields.map((f) => (
          <li key={f.key} className="u-fs-12 u-flex u-gap-2">
            <span>{f.key}</span>
            <span className="muted">
              {f.type}
              {f.type === 'reference' && f.refEntityType ? ` → ${f.refEntityType}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const NODE_TYPES = { entityType: TypeNode };

/** Deterministic circle layout — no layout dep for a bounded type count. */
function positionOf(index: number, total: number): { x: number; y: number } {
  if (total === 1) return { x: 0, y: 0 };
  const radius = Math.max(240, total * 60);
  const angle = (index / total) * 2 * Math.PI;
  return { x: Math.round(radius * Math.cos(angle)), y: Math.round(radius * Math.sin(angle)) };
}

export function SchemaGraphPage(): JSX.Element {
  const { t } = useTranslation('entities');
  const { t: tc } = useTranslation('common');
  const access = useFeatureAccess('entities');
  const [types, setTypes] = useState<EntityType[] | null>(null);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!access.enabled) return;
    void (async () => {
      try {
        const [tl, rl] = await Promise.all([listEntityTypes(), listRelationships()]);
        setTypes(tl);
        setRelationships(rl);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setTypes([]);
      }
    })();
  }, [access.enabled]);

  const { nodes, edges } = useMemo((): { nodes: Node<TypeNodeData>[]; edges: Edge[] } => {
    if (!types) return { nodes: [], edges: [] };
    const nodes = types.map((type, i) => ({
      id: type.typeId,
      type: 'entityType' as const,
      position: positionOf(i, types.length),
      data: { type },
    }));
    const byName = new Map(types.map((x) => [x.name, x]));
    const edges: Edge[] = [];
    for (const rel of relationships) {
      edges.push({
        id: rel.relId,
        source: rel.fromTypeId,
        target: rel.toTypeId,
        label: `${t(`cardinality_${rel.cardinality.replace('-', '_')}`)} · ${t(`onDeleteChip_${rel.onDelete.replace('-', '')}`)}`,
      });
    }
    for (const type of types) {
      for (const f of type.fields) {
        if (f.type !== 'reference' || !f.refEntityType) continue;
        const target = byName.get(f.refEntityType);
        if (!target) continue;
        edges.push({
          id: `ref:${type.typeId}:${f.key}`,
          source: type.typeId,
          target: target.typeId,
          label: f.key,
          style: { strokeDasharray: '6 3' },
        });
      }
    }
    return { nodes, edges };
  }, [types, relationships, t]);

  // ENTU-1 — lookups for the accessible list equivalent: relationship endpoints
  // resolve typeId→displayName; reference fields resolve their target name→type.
  const byId = useMemo(() => new Map((types ?? []).map((x) => [x.typeId, x])), [types]);
  const byName = useMemo(() => new Map((types ?? []).map((x) => [x.name, x])), [types]);

  if (!access.enabled) {
    return (
      <div className="u-p-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('schemaGraphTitle')} lede={t('schemaGraphLede')} />
        <StateCard icon={<DatabaseIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </div>
    );
  }

  return (
    <div data-walkthrough="entities-schema.page" className="u-p-4 u-flex u-flex-col" data-testid="entities-schema-graph">
      <PageHeader eyebrow={t('eyebrow')} title={t('schemaGraphTitle')} lede={t('schemaGraphLede')} />
      <p className="u-fs-13">
        <Link to="/entities">{t('backToEntities')}</Link>
      </p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {types === null ? (
        <SkeletonRows rows={4} columns={['60%']} />
      ) : error ? (
        // EntitiesPage guards its twin of this card with `&& !error`; this one did not,
        // so a failed read drew "Model your first content type" — onboarding copy shown
        // to someone who may already have a full schema.
        <StateCard announce icon={<DatabaseIcon />} title={tc('loadFailedTitle')} body={tc('loadFailedBody')} />
      ) : types.length === 0 ? (
        <StateCard icon={<DatabaseIcon />} title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <>
          <p className="u-fs-12 muted">{t('schemaGraphAlt')}</p>
          {/* .builder-canvas scopes the DESIGN.md §7.11 xyflow token overrides
              (edges, edge labels, dots) — without it the graph falls back to
              xyflow's stock hardcoded colors and breaks in dark mode.
              ENTU-1: the graph is a DECORATIVE visual overview — `aria-hidden` +
              non-focusable nodes/edges keep it (and its raw-typeId edge labels)
              out of the AT tree and the tab order, so the accessible list below
              is the single screen-reader/keyboard representation. Controls are
              dropped: a decorative subtree must contain no focusable elements. */}
          <div
            className="surface-card builder-canvas u-h-70vh"
            data-canvas-root="entities-schema"
            aria-hidden="true"
          >
            <ReactFlowProvider>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                fitView
                nodesDraggable
                nodesConnectable={false}
                nodesFocusable={false}
                edgesFocusable={false}
                elementsSelectable={false}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={24} />
              </ReactFlow>
            </ReactFlowProvider>
          </div>
          {/* ENTU-1 (WCAG 2.1.1 / 1.1.1 / 1.3.1) — the SR/keyboard-navigable
              equivalent of the canvas above. The @xyflow graph is visual-only
              (unfocusable nodes, SVG edge labels); this section conveys the same
              content model as real DOM: a list of types + their fields (each
              reference field names its target = the dashed edges) and a table of
              declared relationships (= the solid edges). Static content — no live
              region (would be the MTCU-201 mounted-with-content anti-pattern). */}
          <section
            className="surface-card u-p-3 u-mt-3"
            data-testid="schema-accessible-list"
            aria-labelledby="schema-list-heading"
          >
            <h2 id="schema-list-heading" className="u-fs-15 u-m-0">{t('schemaListTitle')}</h2>
            <p className="u-fs-12 muted u-mt-1">{t('schemaListHint')}</p>

            <h3 className="u-fs-13 u-mb-1 u-mt-3">{t('schemaTypesHeading')}</h3>
            <ul className="u-list-none u-p-0 u-m-0 u-grid u-gap-3" data-testid="schema-types-list">
              {types.map((type) => (
                <li key={type.typeId}>
                  <div className="u-flex u-items-center u-gap-2">
                    <strong className="u-fs-13">{type.displayName}</strong>
                    <span className={type.status === 'published' ? 'chip chip--success' : 'chip chip--warning'}>
                      {type.status === 'published' ? t('statusPublished') : t('statusDraft')}
                    </span>
                  </div>
                  {type.fields.length === 0 ? (
                    <p className="u-fs-12 muted u-m-0 u-pl-3">{t('schemaNoFields')}</p>
                  ) : (
                    <ul className="u-fs-12 u-list-none u-pl-3 u-m-0" aria-label={t('schemaFieldsLabel', { type: type.displayName })}>
                      {type.fields.map((f) => {
                        const target = f.type === 'reference' && f.refEntityType
                          ? (byName.get(f.refEntityType)?.displayName ?? f.refEntityType)
                          : null;
                        return (
                          <li key={f.key}>
                            {f.label} · <span className="muted">{t(`fieldType_${f.type}`)}{target ? ` → ${target}` : ''}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ul>

            <h3 className="u-fs-13 u-mb-1 u-mt-3">{t('relationshipsHeading')}</h3>
            {relationships.length === 0 ? (
              <p className="u-fs-12 muted u-m-0">{t('schemaNoRelationships')}</p>
            ) : (
              <table className="u-w-full u-fs-12">
                <caption className="sr-only">{t('schemaRelCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="u-text-left">{t('schemaColFrom')}</th>
                    <th scope="col" className="u-text-left">{t('schemaColTo')}</th>
                    <th scope="col" className="u-text-left">{t('schemaColCardinality')}</th>
                    <th scope="col" className="u-text-left">{t('schemaColOnDelete')}</th>
                  </tr>
                </thead>
                <tbody>
                  {relationships.map((rel) => (
                    <tr key={rel.relId}>
                      <td>{byId.get(rel.fromTypeId)?.displayName ?? rel.fromTypeId}</td>
                      <td>{byId.get(rel.toTypeId)?.displayName ?? rel.toTypeId}</td>
                      <td>{t(`cardinality_${rel.cardinality.replace('-', '_')}`)}</td>
                      <td>{t(`onDeleteChip_${rel.onDelete.replace('-', '')}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
