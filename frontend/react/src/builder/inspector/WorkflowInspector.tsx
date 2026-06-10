/**
 * Inspector mode when nothing is selected: workflow-level fields (name +
 * default inputs JSON). These apply when no node or edge is selected.
 */

import { useBuilderStore } from '../store/builderStore.js';
import { TextField, TextareaField } from '../../ui/Field.js';

export function WorkflowInspector() {
  const name = useBuilderStore((s) => s.name);
  const defaultInputs = useBuilderStore((s) => s.defaultInputs);
  const workflowId = useBuilderStore((s) => s.workflowId);

  return (
    <aside className="builder-inspector">
      <h3 className="builder-inspector-title">Workflow</h3>
      <p className="muted builder-inspector-desc">
        Click a node to edit it. These fields apply when no node is selected.
      </p>
      <TextField
        label="Workflow name"
        value={name}
        onChange={(e) => useBuilderStore.getState().setName(e.target.value)}
      />
      <div className="form-row">
        <span className="builder-inspector-field-label">Workflow ID</span>
        <code className="builder-inspector-typeid">{workflowId || '—'}</code>
      </div>
      <TextareaField
        label="Default inputs (JSON)"
        rows={6}
        spellCheck={false}
        value={defaultInputs}
        onChange={(e) => useBuilderStore.getState().setDefaultInputs(e.target.value)}
        help={<>Passed to the first node as <code>ctx.inputs</code> when this workflow runs.</>}
      />
    </aside>
  );
}
