/**
 * Chain-template parameter modal (ADR 0163 Phase 4).
 *
 * Collects a workflow-chain pack's RFC 0013 `parameters` before instantiating it
 * ("Use template" → POST /workflows/from-chain). A minimal JSON-Schema field form
 * over the existing `Modal` + `Field` primitives (no bespoke CSS): string →
 * TextField, enum → SelectField, boolean → CheckboxField. Unsupported shapes
 * (nested objects / arrays) degrade to a raw-JSON TextareaField rather than
 * crashing or silently dropping the value (architect review R-form).
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { TextField, SelectField, CheckboxField, TextareaField } from '../../ui/Field.js';
import type { ChainTemplate, ChainParamSpec } from '../persistence/backendStore.js';

interface Props {
  template: ChainTemplate;
  submitting: boolean;
  error?: string | undefined;
  onSubmit(params: Record<string, unknown>): void;
  onClose(): void;
}

type FieldKind = 'string' | 'enum' | 'boolean' | 'json';

function kindOf(spec: ChainParamSpec): FieldKind {
  if (Array.isArray(spec.enum) && spec.enum.length > 0) return 'enum';
  if (spec.type === 'boolean') return 'boolean';
  if (spec.type === 'string' || spec.type === 'number' || spec.type === 'integer' || !spec.type) return 'string';
  return 'json'; // object/array/unknown → raw JSON fallback (R-form)
}

export function ChainTemplateModal({ template, submitting, error, onSubmit, onClose }: Props) {
  const { t } = useTranslation('builder');
  const props = useMemo(() => Object.entries(template.parameters?.properties ?? {}), [template]);
  const required = useMemo(() => new Set(template.parameters?.required ?? []), [template]);

  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const init: Record<string, string | boolean> = {};
    for (const [key, spec] of props) {
      init[key] = kindOf(spec) === 'boolean' ? Boolean(spec.default ?? false) : String(spec.default ?? '');
    }
    return init;
  });
  const [touched, setTouched] = useState(false);

  function missingRequired(): string[] {
    return [...required].filter((k) => {
      const v = values[k];
      return v === undefined || v === '' || (typeof v === 'string' && v.trim() === '');
    });
  }

  function submit() {
    setTouched(true);
    if (missingRequired().length > 0) return;
    // Coerce JSON-fallback fields; leave the rest as collected.
    const out: Record<string, unknown> = {};
    for (const [key, spec] of props) {
      const raw = values[key];
      if (kindOf(spec) === 'json' && typeof raw === 'string' && raw.trim()) {
        try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
      } else if (raw !== '' && raw !== undefined) {
        out[key] = raw;
      }
    }
    onSubmit(out);
  }

  return (
    <Modal onClose={onClose} label={t('configureTemplate', { name: template.label })} loading={submitting} {...(error ? { error } : {})}>
      <h2 className="u-fs-16 u-mb-2">{t('configureTemplate', { name: template.label })}</h2>
      <p className="muted u-mb-3">{template.description}</p>
      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="u-flex u-flex-col u-gap-3"
      >
        {props.length === 0 ? (
          <p className="muted">{t('templateNoParams')}</p>
        ) : (
          props.map(([key, spec]) => {
            const kind = kindOf(spec);
            const isReq = required.has(key);
            const err = touched && isReq && (values[key] === '' || values[key] === undefined) ? t('parameterRequired', { name: key }) : undefined;
            if (kind === 'boolean') {
              return (
                <CheckboxField key={key} label={key} help={spec.description}
                  checked={Boolean(values[key])}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.checked }))} />
              );
            }
            if (kind === 'enum') {
              return (
                <SelectField key={key} label={key} help={spec.description} required={isReq} error={err}
                  value={String(values[key] ?? '')}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}>
                  <option value="">{t('selectPlaceholder')}</option>
                  {spec.enum!.map((opt) => <option key={String(opt)} value={String(opt)}>{String(opt)}</option>)}
                </SelectField>
              );
            }
            if (kind === 'json') {
              return (
                <TextareaField key={key} label={`${key} (JSON)`} help={spec.description} required={isReq} error={err}
                  rows={3} value={String(values[key] ?? '')}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} />
              );
            }
            return (
              <TextField key={key} label={key} help={spec.description} required={isReq} error={err}
                value={String(values[key] ?? '')}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} />
            );
          })
        )}
        <div className="u-flex u-gap-2 u-justify-end u-mt-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
            {t('common:cancel')}
          </button>
          <button type="submit" className="btn-accent-solid" disabled={submitting}>
            {t('useTemplate')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
