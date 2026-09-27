/**
 * Schema-driven run-input form (ADR 0197 Phase 1) — renders a workflow's
 * `inputSchema` as typed `ui/Field` controls with client-side subset
 * validation (see `inputSchemaForm.ts`) and an "Edit as JSON" escape hatch.
 *
 * Controlled component over the RAW JSON string the launch form already
 * owns (`inputsRaw`) so the two editing modes never fork state: the form
 * writes through to the same string the JSON tab and the submit path read.
 * Complex subschemas degrade per-field to a JSON sub-editor; a schema that
 * isn't a renderable object at all is the CALLER's cue to fall back to the
 * plain textarea (isRenderableSchema).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckboxField, Field, SelectField, TextField, TextareaField } from '../ui/Field.js';
import {
  compactInputs, deriveFields, seedDefaults, validateInputs,
  type DerivedField, type FieldError, type SchemaObject,
} from './inputSchemaForm.js';

function parseRaw(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function SchemaInputForm({ schema, raw, onRawChange, onBlockingChange }: {
  schema: SchemaObject;
  raw: string;
  onRawChange: (raw: string) => void;
  /** ADR 0729 D1 — report whether the FORM would refuse this payload, so the owner can
   *  gate submit. MODE-SCOPED on purpose: in `json` mode the user has explicitly left the
   *  typed form, and that remains the documented way to post something the form rejects —
   *  so this reports `false` there however bad the value looks. */
  onBlockingChange?: (blocking: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation('runs');
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const fields = useMemo(() => deriveFields(schema), [schema]);
  const value = useMemo(() => {
    const parsed = parseRaw(raw);
    // Seed schema defaults for keys the user hasn't touched yet.
    return { ...seedDefaults(fields), ...parsed };
  }, [raw, fields]);
  const errors = useMemo(() => validateInputs(fields, value), [fields, value]);
  const errorFor = (name: string): FieldError | undefined => errors.find((e) => e.name === name);

  // ADR 0729 D1 — the form told the user the value was wrong and then let it submit.
  const blocking = mode === 'form' && errors.length > 0;
  useEffect(() => { onBlockingChange?.(blocking); }, [blocking, onBlockingChange]);
  // Leaving the component (or the schema going away) must not strand a stale block.
  useEffect(() => () => onBlockingChange?.(false), [onBlockingChange]);

  const set = (name: string, v: unknown) => {
    const next = { ...value, [name]: v };
    onRawChange(JSON.stringify(compactInputs(fields, next), null, 2));
  };

  return (
    <div className="schema-input-form">
      {/* The canonical `.segmented` register (ViewToggle precedent): a group of
          aria-pressed buttons — NOT tablist/tab, which would demand arrow-key
          nav + tabpanel semantics this simple mode switch doesn't have. */}
      <div className="segmented u-mb-2" role="group" aria-label={t('inputsModeLabel')}>
        <button type="button" aria-pressed={mode === 'form'} className={mode === 'form' ? 'is-active' : ''} onClick={() => setMode('form')}>{t('inputsModeForm')}</button>
        <button type="button" aria-pressed={mode === 'json'} className={mode === 'json' ? 'is-active' : ''} onClick={() => setMode('json')}>{t('inputsModeJson')}</button>
      </div>
      {mode === 'json' ? (
        <TextareaField
          label={t('inputsFieldLabel')}
          rows={6}
          value={raw}
          onChange={(e) => onRawChange(e.target.value)}
          help={t('inputsJsonHelp')}
        />
      ) : (
        <div className="u-grid u-gap-2">
          {fields.map((f) => <SchemaField key={f.name} field={f} value={value[f.name]} error={errorFor(f.name)} onChange={(v) => set(f.name, v)} />)}
        </div>
      )}
    </div>
  );
}

function SchemaField({ field, value, error, onChange }: {
  field: DerivedField;
  value: unknown;
  error: FieldError | undefined;
  onChange: (v: unknown) => void;
}): JSX.Element {
  const { t } = useTranslation('runs');
  const shell = {
    label: field.label,
    required: field.required,
    ...(field.description ? { help: field.description } : {}),
    ...(error ? { error: t(error.key) } : {}),
  };
  switch (field.kind) {
    case 'boolean':
      return <CheckboxField {...shell} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case 'enum':
      return (
        <SelectField {...shell} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{t('inputsEnumNone')}</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </SelectField>
      );
    case 'number':
    case 'integer':
      return (
        <TextField
          {...shell}
          type="number"
          {...(field.kind === 'integer' ? { step: 1 } : {})}
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(e) => {
            const s = e.target.value;
            onChange(s === '' ? undefined : Number(s));
          }}
        />
      );
    case 'date':
      return <TextField {...shell} type="date" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)} />;
    case 'email':
      return <TextField {...shell} type="email" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)} />;
    case 'uri':
      return <TextField {...shell} type="url" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)} />;
    case 'json':
      return <JsonSubField shell={shell} value={value} onChange={onChange} />;
    default:
      return <TextField {...shell} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)} />;
  }
}

/** Complex subschema degrade path: a small JSON editor for ONE field. Keeps
 *  its own text state so mid-edit invalid JSON doesn't wipe the field; only
 *  valid parses write through. */
function JsonSubField({ shell, value, onChange }: {
  shell: { label: string; required: boolean; help?: string; error?: string };
  value: unknown;
  onChange: (v: unknown) => void;
}): JSX.Element {
  const { t } = useTranslation('runs');
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [parseError, setParseError] = useState(false);
  return (
    <Field
      label={shell.label}
      required={shell.required}
      {...(shell.help ? { help: shell.help } : {})}
      {...(parseError ? { error: t('errJson') } : shell.error ? { error: shell.error } : {})}
    >
      {(wiring) => (
        <textarea
          {...wiring}
          rows={3}
          value={text}
          onChange={(e) => {
            const s = e.target.value;
            setText(s);
            if (s.trim() === '') { setParseError(false); onChange(undefined); return; }
            try { onChange(JSON.parse(s)); setParseError(false); } catch { setParseError(true); }
          }}
        />
      )}
    </Field>
  );
}
