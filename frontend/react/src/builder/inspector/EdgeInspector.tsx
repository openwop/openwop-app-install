/**
 * Inspector mode for a selected edge: trigger rule + condition predicate
 * (DAG fan-in). The trigger rule controls fan-in behavior when a target has
 * multiple incoming edges; the optional condition predicate gates whether the
 * edge fires based on the source's output.
 */

import { useBuilderStore } from '../store/builderStore.js';
import type { BuilderEdge, EdgeCondition, EdgeTriggerRule } from '../schema/workflow.js';
import { CONDITION_OPS, TRIGGER_RULE_OPTIONS } from './inspectorHelpers.js';
import { TextField, SelectField } from '../../ui/Field.js';

export function EdgeInspector({ edge }: { edge: BuilderEdge }) {
  const rule = edge.triggerRule ?? 'all_success';
  const cond = edge.condition;
  const updateEdge = useBuilderStore.getState().updateEdge;
  const removeEdge = useBuilderStore.getState().removeEdge;
  const conditionOp = cond?.op ?? 'eq';
  const conditionMeta = CONDITION_OPS.find((o) => o.value === conditionOp)!;
  return (
    <aside className="builder-inspector">
      <h3 className="builder-inspector-title">Edge</h3>
      <p className="muted builder-inspector-desc">
        Edges connect node outputs to downstream inputs. The trigger rule
        controls fan-in behavior when a target has multiple incoming edges.
      </p>

      <div className="form-row">
        <span className="builder-inspector-field-label">From → To</span>
        <code className="builder-inspector-typeid">
          {edge.source} → {edge.target}
        </code>
      </div>

      <TextField
        label="Label (optional)"
        value={edge.label ?? ''}
        placeholder="e.g. 'on success', 'high confidence'"
        onChange={(e) => updateEdge(edge.id, { label: e.target.value || undefined })}
      />

      <div className="builder-inspector-divider" />
      <div className="builder-inspector-section-label">Trigger rule</div>

      <div className="form-row">
        <select
          value={rule}
          onChange={(e) => updateEdge(edge.id, { triggerRule: e.target.value as EdgeTriggerRule })}
        >
          {TRIGGER_RULE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <div className="muted builder-inspector-help">
          {TRIGGER_RULE_OPTIONS.find((o) => o.value === rule)?.help}
        </div>
        <div className="muted builder-inspector-help u-mt-1">
          Applies to target <code>{edge.target}</code>. When multiple edges target
          the same node, all should declare the same rule (the scheduler picks
          the rule from the lexicographically-first edge id if they diverge).
        </div>
      </div>

      <div className="builder-inspector-divider" />
      <div className="builder-inspector-section-label">Condition predicate (optional)</div>

      <TextField
        label="Path (into source output)"
        value={cond?.path ?? ''}
        placeholder="e.g. 'completion' or 'data.score'"
        onChange={(e) => {
          const path = e.target.value;
          if (!path) {
            updateEdge(edge.id, { condition: undefined });
            return;
          }
          const next: EdgeCondition = { path, op: conditionOp, ...(cond?.value !== undefined ? { value: cond.value } : {}) };
          updateEdge(edge.id, { condition: next });
        }}
        help="When set, this edge fires only when the predicate matches the source's output."
      />

      {cond?.path ? (
        <>
          <SelectField
            label="Operator"
            value={conditionOp}
            onChange={(e) =>
              updateEdge(edge.id, {
                condition: { ...cond, op: e.target.value as EdgeCondition['op'] },
              })
            }
          >
            {CONDITION_OPS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </SelectField>

          {conditionMeta.needsValue ? (
            <TextField
              label="Value"
              value={typeof cond.value === 'string' ? cond.value : cond.value === undefined ? '' : JSON.stringify(cond.value)}
              placeholder="literal or JSON"
              onChange={(e) => {
                // Try parsing as JSON for numbers/booleans/objects; fall back to plain string.
                const raw = e.target.value;
                let parsed: unknown = raw;
                try { parsed = JSON.parse(raw); } catch { /* keep as string */ }
                updateEdge(edge.id, { condition: { ...cond, value: parsed } });
              }}
              help={<>
                Plain text stays a string. Values that parse as JSON
                (<code>5</code>, <code>true</code>, <code>null</code>,
                <code>{`["a","b"]`}</code>) are stored as the parsed value.
                Partial JSON (<code>{`{"x": 1`}</code>) silently stays a string.
              </>}
            />
          ) : null}
        </>
      ) : null}

      <div className="builder-inspector-divider" />
      <button className="secondary" onClick={() => removeEdge(edge.id)}>
        Delete edge
      </button>
    </aside>
  );
}
