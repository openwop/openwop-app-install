/**
 * Per-field config editor for a selected node, dispatching on
 * `ConfigField.kind`. Includes `StringListInput`, the newline-separated
 * editor for `string-list` fields: it parses on blur, decorates `maxItems`
 * overflow with a warning, and uses a last-known-external-value ref so
 * external resets reseed the draft without clobbering in-progress edits.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBuilderStore } from '../store/builderStore.js';
import { type ConfigField } from '../palette/nodeCatalog.js';
import { AlertIcon } from '../../ui/icons/index.js';
import { PromptPickerInput } from '../../prompts/PromptPickerInput.js';
import { CredentialPickerInput } from './CredentialPickerInput.js';
import { ProviderPickerInput } from './ProviderPickerInput.js';
import { ModelPickerInput } from './ModelPickerInput.js';
import { countNonBlankLines, textareaValue } from './inspectorHelpers.js';

export function ConfigInput({
  nodeId,
  config,
  field,
  allFields,
}: {
  nodeId: string;
  config: Record<string, unknown>;
  field: ConfigField;
  allFields: readonly ConfigField[];
}) {
  const value = config[field.key];
  const onChange = (next: unknown) => {
    // Cascade: when this field's value changes, clear every sibling
    // field whose `dependsOn` points back at it (e.g., changing the
    // provider clears the model + credentialRef since both are
    // resolved against the provider). Avoids stale config like
    // "provider: anthropic, model: gpt-5" surviving a swap.
    const nextConfig: Record<string, unknown> = { ...config, [field.key]: next };
    for (const sibling of allFields) {
      if (sibling.dependsOn === field.key && sibling.key !== field.key) {
        nextConfig[sibling.key] = undefined;
      }
    }
    useBuilderStore.getState().updateNode(nodeId, { config: nextConfig });
  };
  // Resolve the dependency-source value for this field (e.g., a
  // model-picker with dependsOn: 'provider' looks up
  // `config.provider`). Undefined when this field has no dependency.
  const dependsOnValue = field.dependsOn ? (config[field.dependsOn] as string | undefined) : undefined;
  return (
    <div className="form-row">
      <label>
        {field.label}
        {field.required && <span className="builder-inspector-required" aria-hidden> *</span>}
      </label>
      {field.kind === 'checkbox' ? (
        <input
          type="checkbox"
          checked={value === true}
          required={field.required}
          onChange={(e) => onChange(e.target.checked)}
          className="u-w-auto"
        />
      ) : field.kind === 'prompt-picker' ? (
        <PromptPickerInput
          value={typeof value === 'string' ? value : undefined}
          onChange={(next) => onChange(next)}
          promptKind={field.promptKind}
          required={field.required}
        />
      ) : field.kind === 'credential-picker' ? (
        <CredentialPickerInput
          value={typeof value === 'string' ? value : undefined}
          onChange={(next) => onChange(next)}
          {...(field.credentialProvider
            ? { providerFilter: field.credentialProvider }
            : dependsOnValue
              ? { providerFilter: dependsOnValue }
              : {})}
          required={field.required}
        />
      ) : field.kind === 'provider-picker' ? (
        <ProviderPickerInput
          value={typeof value === 'string' ? value : undefined}
          onChange={(next) => onChange(next)}
          required={field.required}
        />
      ) : field.kind === 'model-picker' ? (
        <ModelPickerInput
          value={typeof value === 'string' ? value : undefined}
          onChange={(next) => onChange(next)}
          providerId={dependsOnValue}
          required={field.required}
        />
      ) : field.kind === 'textarea' ? (
        <textarea
          rows={3}
          value={textareaValue(value)}
          placeholder={field.placeholder}
          required={field.required}
          {...(field.minLength !== undefined ? { minLength: field.minLength } : {})}
          {...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.kind === 'number' ? (
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          placeholder={field.placeholder}
          required={field.required}
          {...(field.min !== undefined ? { min: field.min } : {})}
          {...(field.max !== undefined ? { max: field.max } : {})}
          {...(field.step !== undefined ? { step: field.step } : {})}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      ) : field.kind === 'select' ? (
        <select
          value={typeof value === 'string' ? value : ''}
          required={field.required}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        >
          {!field.required && <option value="">—</option>}
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : field.kind === 'string-list' ? (
        <StringListInput
          value={Array.isArray(value) ? (value as unknown[]).filter((v) => typeof v === 'string') as string[] : []}
          onChange={(next) => onChange(next.length === 0 ? undefined : next)}
          placeholder={field.placeholder}
          maxItems={field.maxItems}
        />
      ) : (
        <input
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          required={field.required}
          {...(field.minLength !== undefined ? { minLength: field.minLength } : {})}
          {...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
          {...(field.pattern !== undefined ? { pattern: field.pattern } : {})}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.help && <div className="muted builder-inspector-help">{field.help}</div>}
    </div>
  );
}

/** One-per-line textarea that round-trips to `string[]`. Used for
 *  JSON-Schema `{ type: 'array', items: { type: 'string' } }` configs
 *  like `stopSequences` — far less hostile than a raw-JSON textarea
 *  for the (common) case of a small list of plain strings.
 *
 *  Blank lines are stripped (a trailing newline while typing doesn't
 *  add an empty entry); when the parsed list would exceed `maxItems`,
 *  the input clamps to the first `maxItems` entries and surfaces a
 *  warning via the help row above. */
function StringListInput({
  value,
  onChange,
  placeholder,
  maxItems,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string | undefined;
  maxItems?: number | undefined;
}): JSX.Element {
  const { t } = useTranslation('builder');
  const [draft, setDraft] = useState<string>(value.join('\n'));
  // Reset the draft when the store-side value changes from somewhere
  // OTHER than this input (e.g., reset, import, multi-select edit).
  // We compare the new external value against the last-known external
  // value via a ref — so an external change reseeds the draft, but the
  // user's in-progress edits don't (we don't read `draft` here, so the
  // exhaustive-deps lint is honest without suppression).
  const lastExternalRef = useRef<string>(value.join('\n'));
  useEffect(() => {
    const next = value.join('\n');
    if (next !== lastExternalRef.current) {
      lastExternalRef.current = next;
      setDraft(next);
    }
  }, [value]);
  const overLimit = maxItems !== undefined && countNonBlankLines(draft) > maxItems;
  return (
    <>
      <textarea
        rows={Math.min(6, Math.max(2, value.length + 1))}
        value={draft}
        placeholder={placeholder ?? t('stringListPlaceholder')}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          const parsed = next.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
          const clamped = maxItems !== undefined ? parsed.slice(0, maxItems) : parsed;
          onChange(clamped);
        }}
      />
      {overLimit ? (
        <div className="muted builder-inspector-help" role="status">
          <AlertIcon size={12} /> {t('stringListOverLimit', { count: maxItems })}
        </div>
      ) : null}
    </>
  );
}
