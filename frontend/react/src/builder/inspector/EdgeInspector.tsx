/**
 * Inspector mode for a selected edge: trigger rule + condition predicate
 * (DAG fan-in). The trigger rule controls fan-in behavior when a target has
 * multiple incoming edges; the optional condition predicate gates whether the
 * edge fires based on the source's output.
 */

import { useTranslation } from 'react-i18next';
import { useBuilderStore } from '../store/builderStore.js';
import type { BuilderEdge, EdgeCondition, EdgeTriggerRule } from '../schema/workflow.js';
import { CONDITION_OPS, TRIGGER_RULE_OPTIONS } from './inspectorHelpers.js';
import { TextField, SelectField } from '../../ui/Field.js';

export function EdgeInspector({ edge }: { edge: BuilderEdge }) {
  const { t } = useTranslation('builder');
  const rule = edge.triggerRule ?? 'all_success';
  const cond = edge.condition;
  const updateEdge = useBuilderStore.getState().updateEdge;
  const removeEdge = useBuilderStore.getState().removeEdge;
  const conditionOp = cond?.op ?? 'eq';
  const conditionMeta = CONDITION_OPS.find((o) => o.value === conditionOp)!;
  return (
    <aside className="builder-inspector">
      <h3 className="builder-inspector-title">{t('edge')}</h3>
      <p className="muted builder-inspector-desc">
        {t('edgeInspectorDesc')}
      </p>

      <div className="form-row">
        <span className="builder-inspector-field-label">{t('fromTo')}</span>
        <code className="builder-inspector-typeid">
          {edge.source} → {edge.target}
        </code>
      </div>

      <TextField
        label={t('edgeLabel')}
        value={edge.label ?? ''}
        placeholder={t('edgeLabelPlaceholder')}
        onChange={(e) => updateEdge(edge.id, { label: e.target.value || undefined })}
      />

      <div className="builder-inspector-divider" />
      <div className="builder-inspector-section-label">{t('triggerRule')}</div>

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
          {(() => {
            const k = TRIGGER_RULE_OPTIONS.find((o) => o.value === rule)?.helpKey;
            return k ? t(k) : '';
          })()}
        </div>
        <div className="muted builder-inspector-help u-mt-1">
          {t('triggerRuleAppliesTo')} <code>{edge.target}</code>{t('triggerRuleAppliesToAfter')}
        </div>
      </div>

      <div className="builder-inspector-divider" />
      <div className="builder-inspector-section-label">{t('conditionPredicate')}</div>

      <TextField
        label={t('conditionPath')}
        value={cond?.path ?? ''}
        placeholder={t('conditionPathPlaceholder')}
        onChange={(e) => {
          const path = e.target.value;
          if (!path) {
            updateEdge(edge.id, { condition: undefined });
            return;
          }
          const next: EdgeCondition = { path, op: conditionOp, ...(cond?.value !== undefined ? { value: cond.value } : {}) };
          updateEdge(edge.id, { condition: next });
        }}
        help={t('conditionPathHelp')}
      />

      {cond?.path ? (
        <>
          <SelectField
            label={t('conditionOperator')}
            value={conditionOp}
            onChange={(e) =>
              updateEdge(edge.id, {
                condition: { ...cond, op: e.target.value as EdgeCondition['op'] },
              })
            }
          >
            {CONDITION_OPS.map((o) => (
              <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
            ))}
          </SelectField>

          {conditionMeta.needsValue ? (
            <TextField
              label={t('conditionValue')}
              value={typeof cond.value === 'string' ? cond.value : cond.value === undefined ? '' : JSON.stringify(cond.value)}
              placeholder={t('conditionValuePlaceholder')}
              onChange={(e) => {
                // Try parsing as JSON for numbers/booleans/objects; fall back to plain string.
                const raw = e.target.value;
                let parsed: unknown = raw;
                try { parsed = JSON.parse(raw); } catch { /* keep as string */ }
                updateEdge(edge.id, { condition: { ...cond, value: parsed } });
              }}
              help={<>
                {t('conditionValueHelpPre')}
                {' '}(<code>5</code>, <code>true</code>, <code>null</code>,
                <code>{`["a","b"]`}</code>) {t('conditionValueHelpMid')}
                {' '}(<code>{`{"x": 1`}</code>) {t('conditionValueHelpPost')}
              </>}
            />
          ) : null}
        </>
      ) : null}

      <div className="builder-inspector-divider" />
      <button className="secondary" onClick={() => removeEdge(edge.id)}>
        {t('deleteEdge')}
      </button>
    </aside>
  );
}
