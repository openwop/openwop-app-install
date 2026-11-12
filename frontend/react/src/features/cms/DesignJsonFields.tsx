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
      <JsonTextarea label={t('designJsonLabel')} text={text} valid={valid} rows={14} onChange={onChange} />
    </div>
  );
}

/** ADR 1069 D4 — one array field edited as JSON (the pricing section's
 *  `plans`). Same contract as above: a valid array replaces the field, an
 *  empty array clears it, invalid text stays on screen and is never saved. */
export function JsonArrayField({ field, value, set, label, hint }: { field: string; value: unknown; set: (k: string, v: unknown) => void; label: string; hint?: string }): JSX.Element {
  const [text, setText] = useState(() => JSON.stringify(Array.isArray(value) ? value : [], null, 2));
  const [valid, setValid] = useState(true);
  const onChange = (next: string): void => {
    setText(next);
    try {
      const parsed: unknown = JSON.parse(next);
      if (!Array.isArray(parsed)) { setValid(false); return; }
      setValid(true);
      set(field, parsed.length > 0 ? parsed : undefined);
    } catch {
      setValid(false);
    }
  };
  return <JsonTextarea label={label} hint={hint} text={text} valid={valid} rows={8} onChange={onChange} />;
}

function JsonTextarea({ label, hint, text, valid, rows, onChange }: { label: string; hint?: string | undefined; text: string; valid: boolean; rows: number; onChange: (v: string) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  return (
    <div className="u-grid u-gap-1">
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{label}</span>
        <textarea rows={rows} spellCheck={false} className="u-mono" value={text} onChange={(e) => onChange(e.target.value)} aria-invalid={!valid} />
      </label>
      {hint ? <span className="u-label-sm muted">{hint}</span> : null}
      {valid ? null : <span className="u-label-sm" role="status">{t('designJsonInvalid')}</span>}
    </div>
  );
}
