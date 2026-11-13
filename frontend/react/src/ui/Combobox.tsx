/**
 * Combobox (ADR 1110 P2) — the shared "type to find one of many" single-select, for
 * lists too long to load whole into a `<select>` (a catalog of up to 500,000
 * products). The options come from the server as the person types.
 *
 * The WAI-ARIA APG combobox pattern, list autocomplete with manual selection:
 *  - the input is `role="combobox"` with `aria-expanded`, `aria-controls`,
 *    `aria-autocomplete="list"` and `aria-activedescendant`; the popup is a
 *    `role="listbox"` of `role="option"` rows;
 *  - the list opens on typing, ArrowDown / ArrowUp or a click, not on focus (tabbing
 *    through a form fetches nothing and announces nothing);
 *  - no option is active until the arrows move to one (manual selection); Enter
 *    chooses the active option; Escape closes the list and restores the chosen value's
 *    text; Tab closes it without choosing;
 *  - an optional field is cleared by emptying the text (on Enter or on leaving);
 *  - focus never leaves the input (options and the popup take `mousedown` without it);
 *  - the result count is said in a polite live region, debounced with the query, and a
 *    page that has more says so ("20+ matches"), never a page size read as a total.
 *
 * Robustness: a slow answer to an older query never replaces a newer one (sequence
 * guard); a failed read says so in the list instead of looking like "no matches", and
 * ArrowDown retries it; a value the server no longer returns stays shown.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from './Field.js';

export interface ComboboxOption {
  id: string;
  label: string;
  /** A second, quieter line (a price, a type). */
  hint?: string | undefined;
}

export interface ComboboxProps {
  label: React.ReactNode;
  /** The chosen option; null = nothing chosen. */
  value: ComboboxOption | null;
  onChange: (option: ComboboxOption | null) => void;
  /** Fetch the options for a query ('' = the first page). Abort when `signal` fires.
   *  Return `{ options, more: true }` when the server had more than it sent. */
  load: (query: string, signal: AbortSignal) => Promise<ComboboxOption[] | { options: ComboboxOption[]; more?: boolean }>;
  placeholder?: string | undefined;
  help?: React.ReactNode | undefined;
  error?: React.ReactNode | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  /** Milliseconds between the last keystroke and the read. */
  debounceMs?: number | undefined;
  autoFocus?: boolean | undefined;
}

type Status = 'idle' | 'loading' | 'ready' | 'failed';

export function Combobox({
  label, value, onChange, load, placeholder, help, error, required, disabled, className, debounceMs = 250, autoFocus,
}: ComboboxProps): JSX.Element {
  const { t } = useTranslation('common');
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value?.label ?? '');
  const [options, setOptions] = useState<ComboboxOption[]>([]);
  const [more, setMore] = useState(false);
  const [active, setActive] = useState(-1);
  const [status, setStatus] = useState<Status>('idle');
  const seq = useRef(0);
  const abort = useRef<AbortController | null>(null);

  // The chosen value's text follows the value whenever the list is closed.
  useEffect(() => { if (!open) setText(value?.label ?? ''); }, [value, open]);

  const fetchFor = useCallback((query: string) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const mine = ++seq.current;
    setStatus('loading');
    load(query, ctl.signal).then(
      (got) => {
        if (mine !== seq.current) return;
        const rows = Array.isArray(got) ? got : got.options;
        setOptions(rows); setMore(!Array.isArray(got) && got.more === true); setActive(-1); setStatus('ready');
      },
      () => { if (mine === seq.current && !ctl.signal.aborted) { setOptions([]); setMore(false); setActive(-1); setStatus('failed'); } },
    );
  }, [load]);

  const queryOf = useCallback((): string => (text === value?.label ? '' : text.trim()), [text, value?.label]);
  // Debounced read while open.
  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => fetchFor(queryOf()), debounceMs);
    return () => clearTimeout(timer);
  }, [open, fetchFor, debounceMs, queryOf]);

  useEffect(() => () => abort.current?.abort(), []);

  const choose = (opt: ComboboxOption): void => {
    onChange(opt);
    setText(opt.label);
    setOpen(false);
  };
  /** An optional field emptied by the person is cleared, not silently restored. */
  const clearIfEmptied = (): boolean => {
    if (text.trim() !== '' || !value || required) return false;
    onChange(null);
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (status === 'failed') { fetchFor(queryOf()); return; } // retry a failed read
      if (options.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + options.length) % options.length);
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && options[active]) { e.preventDefault(); choose(options[active]); }
      else if (clearIfEmptied()) { e.preventDefault(); setOpen(false); }
    } else if (e.key === 'Escape') {
      // Closing restores the chosen value's text (the effect above).
      if (open) { e.preventDefault(); setOpen(false); }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const optionId = (i: number): string => `${listId}-opt-${i}`;
  const statusText = status === 'loading' ? t('comboboxLoading')
    : status === 'failed' ? t('comboboxFailed')
    : status === 'ready' ? (options.length === 0 ? t('comboboxNoResults') : t(more ? 'comboboxResultsMore' : 'comboboxResults', { count: options.length }))
    : '';

  return (
    <Field label={label} help={help} error={error} required={required} className={className ? `ui-combobox ${className}` : 'ui-combobox'}>
      {(w) => (
        <div className="ui-combobox__wrap">
          <input
            {...w}
            type="text"
            className="ui-input"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            {...(open && active >= 0 ? { 'aria-activedescendant': optionId(active) } : {})}
            autoComplete="off"
            value={text}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={(e) => { setText(e.target.value); setOpen(true); }}
            onClick={() => setOpen(true)}
            onBlur={() => { clearIfEmptied(); setOpen(false); }}
            onKeyDown={onKeyDown}
          />
          {open ? (
            // A press on the popup itself (its scrollbar, the note) must not blur the input.
            <div className="ui-combobox__popup" onMouseDown={(e) => e.preventDefault()}>
            {/* The listbox holds only options (APG); the loading / empty / failed line sits beside it. */}
            <ul id={listId} role="listbox" className="ui-combobox__list" {...(typeof label === 'string' ? { 'aria-label': label } : {})}>
              {options.map((opt, i) => (
                <li
                  key={opt.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={value?.id === opt.id}
                  className={`ui-combobox__option${i === active ? ' is-active' : ''}`}
                  // Chosen on mousedown, before the input's blur closes the list; the keyboard
                  // chooses through the input (APG: focus stays on the combobox).
                  onMouseDown={(e) => { e.preventDefault(); choose(opt); }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="ui-combobox__label">{opt.label}</span>
                  {opt.hint ? <span className="ui-combobox__hint">{opt.hint}</span> : null}
                </li>
              ))}
            </ul>
            {status !== 'ready' || options.length === 0 ? <p className="ui-combobox__note" aria-hidden="true">{statusText}</p> : null}
            </div>
          ) : null}
          <span className="sr-only" role="status" aria-live="polite">{open ? statusText : ''}</span>
        </div>
      )}
    </Field>
  );
}
