/**
 * Inspector mode when nothing is selected: workflow-level fields (name +
 * default inputs JSON). These apply when no node or edge is selected.
 */

import { useTranslation } from 'react-i18next';
import { useBuilderStore } from '../store/builderStore.js';
import { TextField, TextareaField } from '../../ui/Field.js';

export function WorkflowInspector() {
  const { t } = useTranslation('builder');
  const name = useBuilderStore((s) => s.name);
  const defaultInputs = useBuilderStore((s) => s.defaultInputs);
  const workflowId = useBuilderStore((s) => s.workflowId);

  return (
    <aside className="builder-inspector">
      <h3 className="builder-inspector-title">{t('workflow')}</h3>
      <p className="muted builder-inspector-desc">
        {t('workflowInspectorDesc')}
      </p>
      <TextField
        label={t('workflowName')}
        value={name}
        onChange={(e) => useBuilderStore.getState().setName(e.target.value)}
      />
      <div className="form-row">
        <span className="builder-inspector-field-label">{t('workflowId')}</span>
        <code className="builder-inspector-typeid">{workflowId || '—'}</code>
      </div>
      <TextareaField
        label={t('defaultInputsLabel')}
        rows={6}
        spellCheck={false}
        value={defaultInputs}
        onChange={(e) => useBuilderStore.getState().setDefaultInputs(e.target.value)}
        help={<>{t('defaultInputsHelpPre')} <code>ctx.inputs</code> {t('defaultInputsHelpPost')}</>}
      />
    </aside>
  );
}
