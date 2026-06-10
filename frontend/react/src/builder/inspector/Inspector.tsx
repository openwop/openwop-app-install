/**
 * Right sidebar. Three modes:
 *   1. Node selected → name + per-kind config fields from the catalog
 *   2. Edge selected → trigger rule + condition predicate (DAG fan-in)
 *   3. Nothing selected → workflow-level fields (name + default inputs JSON)
 *
 * The per-mode sub-components live in sibling files
 * (`EdgeInspector`, `MultiSelectInspector`, `WorkflowInspector`, `ConfigInput`)
 * and the shared helpers/constants in `inspectorHelpers`.
 */

import { useBuilderStore } from '../store/builderStore.js';
import { catalogEntry } from '../palette/catalogRegistry.js';
import { ConfigInput } from './ConfigInput.js';
import { EdgeInspector } from './EdgeInspector.js';
import { MultiSelectInspector } from './MultiSelectInspector.js';
import { WorkflowInspector } from './WorkflowInspector.js';
import { useHostAdvertisedModelCapabilities } from './inspectorHelpers.js';
import { TextField, SelectField } from '../../ui/Field.js';

export function Inspector() {
  const selectedNodeId = useBuilderStore((s) => s.selectedNodeId);
  const selectedNodeIds = useBuilderStore((s) => s.selectedNodeIds);
  const selectedEdgeId = useBuilderStore((s) => s.selectedEdgeId);
  const node = useBuilderStore((s) => s.nodes.find((n) => n.id === selectedNodeId) ?? null);
  const edge = useBuilderStore((s) => s.edges.find((e) => e.id === selectedEdgeId) ?? null);
  const advertised = useHostAdvertisedModelCapabilities();

  if (edge) return <EdgeInspector edge={edge} />;
  // More than one node selected → group actions (single-node config is
  // ambiguous across heterogeneous kinds, so we expose batch ops instead).
  if (selectedNodeIds.length > 1) return <MultiSelectInspector ids={selectedNodeIds} />;
  if (!node) return <WorkflowInspector />;
  const entry = catalogEntry(node.kind);
  if (!entry) {
    return (
      <aside className="builder-inspector">
        <div className="alert error">Unknown node kind: {node.kind}</div>
      </aside>
    );
  }
  const missing = entry.missingHostSurfaces ?? [];
  // RFC 0031 gap: what does this node need that the host's modelCapabilities
  // advertisement doesn't (yet) cover?
  const requiredCaps = entry.requiredModelCapabilities ?? [];
  const missingModelCaps = advertised
    ? requiredCaps.filter((c) => !advertised.has(c))
    : [];
  return (
    <aside className="builder-inspector">
      <h3 className="builder-inspector-title">{entry.label}</h3>
      <p className="muted builder-inspector-desc">{entry.description}</p>

      {missing.length > 0 ? (
        <div
          className="alert warning builder-inspector-host-warn"
          role="status"
          aria-label="Host capability missing"
        >
          <strong>Needs host capability:</strong> {missing.join(', ')}.
          <div className="muted builder-inspector-help u-mt-1">
            This engine doesn't advertise the required surface. The node will
            still serialize and ship in the workflow, but running it here returns
            <code> HOST_CAPABILITY_MISSING</code>. Wire the surface in your host,
            or run <code>examples/hosts/postgres</code> for a host that advertises
            every surface.
          </div>
        </div>
      ) : null}

      {requiredCaps.length > 0 ? (
        <div
          className={missingModelCaps.length > 0 ? 'alert warning' : 'alert info'}
          role="status"
          aria-label="Model capability requirements"
          style={{ marginTop: missing.length > 0 ? 8 : 0 }}
        >
          <strong>Requires model capabilities:</strong>{' '}
          {requiredCaps.map((c, i) => (
            <span key={c}>
              <code style={{
                background: missingModelCaps.includes(c)
                  ? 'color-mix(in oklch, var(--color-warning) 14%, transparent)'
                  : undefined,
              }}>{c}</code>
              {i < requiredCaps.length - 1 ? ' · ' : ''}
            </span>
          ))}
          .
          <div className="muted builder-inspector-help u-mt-1">
            {advertised === null ? (
              <>Discovering host's <code>modelCapabilities</code> advertisement…</>
            ) : missingModelCaps.length === 0 ? (
              <>The host advertises every required capability; this node will dispatch directly.</>
            ) : (
              <>
                The host's <code>modelCapabilities.advertised[]</code> doesn't cover{' '}
                <code>{missingModelCaps.join(', ')}</code>. At dispatch time the host will
                either substitute a fallback model
                (<code>model.capability.substituted</code>) or refuse with
                <code> capability_not_provided</code> per RFC 0031 §B.
              </>
            )}
          </div>
        </div>
      ) : null}

      <TextField
        label="Name"
        value={node.name}
        onChange={(e) => useBuilderStore.getState().updateNode(node.id, { name: e.target.value })}
      />

      <div className="form-row">
        <span className="builder-inspector-field-label">Type</span>
        <code className="builder-inspector-typeid">{entry.typeId}</code>
      </div>

      {entry.configFields.length > 0 && (
        <>
          <div className="builder-inspector-divider" />
          <div className="builder-inspector-section-label">Configuration</div>
          {entry.configFields.map((f) => (
            <ConfigInput
              key={f.key}
              nodeId={node.id}
              config={node.config}
              field={f}
              allFields={entry.configFields}
            />
          ))}
        </>
      )}

      <div className="builder-inspector-divider" />
      <div className="builder-inspector-section-label">Output role</div>
      <SelectField
        label="Artifact"
        value={node.outputRole ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          useBuilderStore.getState().updateNode(node.id, {
            outputRole: v === 'primary' || v === 'secondary' ? v : undefined,
          });
        }}
        title="RFC 0065 — author hint for which terminal node's output is the workflow's canonical deliverable. Advisory; engine ignores the value."
      >
        <option value="">(none)</option>
        <option value="primary">Primary</option>
        <option value="secondary">Secondary</option>
      </SelectField>
      <p className="muted binspector-output-role-note">
        Tag the canonical-deliverable terminal node so the chat's
        completion card surfaces this output as the workflow's primary
        artifact. RFC 0065 — advisory; the engine ignores the value.
      </p>

      <div className="builder-inspector-divider" />
      <button
        className="secondary"
        onClick={() => useBuilderStore.getState().removeNode(node.id)}
      >
        Delete node
      </button>
    </aside>
  );
}
