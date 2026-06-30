/**
 * Inspector ConfigInput for fields of `kind: 'prompt-picker'`. Renders a
 * select populated from the prompt library (filtered by the field's
 * `promptKind` constraint when set). Stores the canonical stringy
 * PromptRef (`prompt:templateId@version`) in `node.config[field.key]`.
 *
 * The field is the integration point for RFC 0027's `*PromptRef` node-
 * config convention. When a host advertises `capabilities.prompts`, the
 * options reflect the host's library; otherwise they reflect the local
 * sample list (`promptsClient.ts` handles the fallback transparently).
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getPrompt, listPrompts } from './promptsClient.js';
import type { PromptKind, PromptTemplate } from './types.js';
import { parseRef, refToString } from './types.js';
import { Notice } from '../ui/Notice.js';
import { Skeleton } from '../ui/Skeleton.js';

export interface PromptPickerInputProps {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  /** When set, the picker only shows templates of this kind. */
  promptKind?: PromptKind | undefined;
  /** Optional label override; inspector usually provides one above. */
  label?: string | undefined;
  /** Whether selection is required. */
  required?: boolean | undefined;
}

export function PromptPickerInput({ value, onChange, promptKind, required }: PromptPickerInputProps) {
  const { t } = useTranslation('prompts');
  const [prompts, setPrompts] = useState<PromptTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPrompts(promptKind ? { kind: promptKind } : {})
      .then((items) => {
        if (!cancelled) setPrompts(items);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [promptKind]);

  if (error) {
    return <Notice variant="error">{t('pickerFailedToLoad', { error })}</Notice>;
  }
  if (prompts === null) {
    return <Skeleton />;
  }

  return (
    <>
      <select
        value={value ?? ''}
        required={required}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      >
        <option value="">{t('pickerNone')}</option>
        {prompts.map((p) => {
          const ref = refToString(p);
          return (
            <option key={ref} value={ref}>
              {p.name ? t('pickerOptionWithName', { name: p.name, ref }) : ref}
            </option>
          );
        })}
      </select>
      {value && <PromptPreview ref={value} />}
    </>
  );
}

function PromptPreview({ ref }: { ref: string }) {
  const { t } = useTranslation('prompts');
  const [preview, setPreview] = useState<PromptTemplate | null>(null);
  useEffect(() => {
    let cancelled = false;
    const parsed = parseRef(ref);
    if (!parsed) {
      setPreview(null);
      return () => {
        cancelled = true;
      };
    }
    getPrompt(parsed.templateId, parsed.version).then((p) => {
      if (!cancelled) setPreview(p);
    });
    return () => {
      cancelled = true;
    };
  }, [ref]);
  if (!preview) return null;
  return (
    <div className="prompt-picker-preview">
      <details>
        <summary className="muted">{t('pickerShowBody')}</summary>
        <pre className="prompt-preview">{preview.text}</pre>
        {preview.variables && preview.variables.length > 0 && (
          <div className="muted prompt-picker-preview-vars">
            {t('pickerVariables', { vars: preview.variables.map((v) => v.name).join(', ') })}
          </div>
        )}
      </details>
    </div>
  );
}
