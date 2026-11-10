/**
 * ADR 1080 — the Page Builder fields for the design section types. Their
 * content is nested (rows, groups, trees, milestones), so the editor shows the
 * section's data as JSON. Each valid edit replaces the data; the server
 * validates it on save like any other section. Invalid text is kept on screen
 * and never saved.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const HEAD_KEYS = ['eyebrow', 'heading', 'lede'];

export function DesignJsonFields({ d, set, head }: { d: Record<string, unknown>; set: (k: string, v: unknown) => void; head: JSX.Element }): JSX.Element {
  const { t } = useTranslation('cms');
  // The head fields have their own inputs above; the JSON holds the rest.
  const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !HEAD_KEYS.includes(k)));
  const [text, setText] = useState(() => JSON.stringify(rest, null, 2));
  const [valid, setValid] = useState(true);
  const onChange = (value: string): void => {
    setText(value);
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { setValid(false); return; }
      setValid(true);
      const next = parsed as Record<string, unknown>;
      for (const k of Object.keys(rest)) if (!(k in next)) set(k, undefined);
      for (const [k, v] of Object.entries(next)) set(k, v);
    } catch {
      setValid(false);
    }
  };
  return (
    <div className="u-grid u-gap-2">
      {head}
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('designJsonLabel')}</span>
        <textarea rows={14} spellCheck={false} className="u-mono" value={text} onChange={(e) => onChange(e.target.value)} aria-invalid={!valid} />
      </label>
      {valid ? null : <span className="u-label-sm" role="status">{t('designJsonInvalid')}</span>}
    </div>
  );
}
