/**
 * Inspector mode when nothing is selected: workflow-level fields (name +
 * default inputs JSON + the ADR 0197 run-input schema). These apply when no
 * node or edge is selected.
 *
 * "Run inputs" (Deferred Phase E.2 / ADR 0197 OQ-2): the author edits
 * `definition.inputSchema` as raw JSON — SchemaInputForm is reused verbatim
 * as the live PREVIEW of the launch form it produces (it is a renderer, not
 * a schema editor). A draft that doesn't parse is kept locally but never
 * published (serialize omits it), so a half-typed schema can't break runs.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBuilderStore } from '../store/builderStore.js';
import { TextField, TextareaField } from '../../ui/Field.js';
import { SchemaInputForm } from '../../runs/SchemaInputForm.js';
import { isRenderableSchema, type SchemaObject } from '../../runs/inputSchemaForm.js';

export function WorkflowInspector() {
  const { t } = useTranslation('builder');
  const name = useBuilderStore((s) => s.name);
  const defaultInputs = useBuilderStore((s) => s.defaultInputs);
  const inputSchema = useBuilderStore((s) => s.inputSchema);
  const workflowId = useBuilderStore((s) => s.workflowId);
  // Preview-only values — never persisted; the preview IS the point (OQ-2).
  const [previewRaw, setPreviewRaw] = useState('{}');
  const parsedSchema = useMemo<SchemaObject | null>(() => {
    const raw = inputSchema.trim();
    if (!raw) return null;
    try {
      const v: unknown = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as SchemaObject) : null;
    } catch {
      return null;
    }
  }, [inputSchema]);

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
      <div className="builder-inspector-divider" />
      <div className="builder-inspector-section-label">{t('inputSchemaSection')}</div>
      <TextareaField
        label={t('inputSchemaLabel')}
        rows={6}
        spellCheck={false}
        value={inputSchema}
        onChange={(e) => useBuilderStore.getState().setInputSchema(e.target.value)}
        help={t('inputSchemaHelp')}
      />
      {inputSchema.trim() !== '' && !parsedSchema && (
        <p className="muted builder-inspector-desc">{t('inputSchemaInvalid')}</p>
      )}
      {parsedSchema && (isRenderableSchema(parsedSchema) ? (
        <>
          <div className="builder-inspector-section-label">{t('inputSchemaPreview')}</div>
          <SchemaInputForm schema={parsedSchema} raw={previewRaw} onRawChange={setPreviewRaw} />
        </>
      ) : (
        <p className="muted builder-inspector-desc">{t('inputSchemaNotRenderable')}</p>
      ))}
    </aside>
  );
}
