/**
 * ColorField — the shared color input (ADR 0333 Phase 6, the research doc's
 * C13). Upgrades the ADR 0305 native-picker+hex pair with the constrained-
 * palette-first pattern (Excalidraw/FigJam, verified in the research doc):
 * a labeled swatch row of THEME-DERIVED colors (token values resolved at
 * runtime — the doc stores the CONCRETE value, so no `var()` leaks into
 * documents), a `none` swatch, session recents, the native picker + hex
 * escape hatch, and the platform EyeDropper when available. Fully
 * keyboard-operable: every swatch is a real labeled button.
 */
import { Button } from '../ui/Button.js';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { STOCK_ACCENT } from '../brand/theme/generate.js';
import { parseColorToRgb, rgbToHex } from '../brand/theme/oklch.js';
import { PipetteIcon } from './icons/index.js';

const TOKEN_SWATCHES: { token: string; labelKey: string }[] = [
  { token: '--clay-text', labelKey: 'colorAccent' },
  { token: '--ink', labelKey: 'colorText' },
  { token: '--ink-3', labelKey: 'colorMuted' },
  { token: '--color-success', labelKey: 'colorSuccess' },
  { token: '--color-warning', labelKey: 'colorWarn' }, // was '--color-warn' — a token that never existed; the swatch resolved EMPTY (caught by the ADR 0510 P3 alias sweep)
  { token: '--color-danger', labelKey: 'colorDanger' },
  { token: '--color-info', labelKey: 'colorInfo' },
];

// Session recents shared across fields (a default-feeder, like style memory).
const recents: string[] = [];
/** Case/format-normalize for swatch matching (ADR 0333 grade pass UX-D9): the
 *  native picker emits lowercase hex, tokens may be authored otherwise, so a
 *  raw `===` silently never matched after a picker round-trip. */
const norm = (v: string): string => v.trim().toLowerCase();

function remember(v: string): void {
  const i = recents.indexOf(v);
  if (i >= 0) recents.splice(i, 1);
  recents.unshift(v);
  if (recents.length > 6) recents.pop();
}

/** Resolve the theme swatches ONCE per mount (theme flips remount the app
 *  shell; a stale value is at worst one toggle old and purely cosmetic). */
function useThemeSwatches(): { value: string; labelKey: string }[] {
  return useMemo(() => {
    if (typeof getComputedStyle !== 'function' || !document.documentElement) return [];
    const cs = getComputedStyle(document.documentElement);
    return TOKEN_SWATCHES
      .map(({ token, labelKey }) => ({ value: cs.getPropertyValue(token).trim(), labelKey }))
      .filter((s) => s.value.length > 0);
  }, []);
}

interface EyeDropperLike { open: () => Promise<{ sRGBHex: string }> }

export function ColorField({
  id,
  value,
  onChange,
  hexAriaLabel,
  /** Offer the `none` swatch (SVG fills; text colors usually shouldn't). */
  allowNone = true,
}: {
  id: string;
  value: string;
  onChange: (v: string | undefined) => void;
  /** Accessible name for the free-text input (the field label names the group). */
  hexAriaLabel: string;
  allowNone?: boolean;
}): JSX.Element {
  const { t } = useTranslation('ui');
  const swatches = useThemeSwatches();
  const [, bump] = useState(0);
  const pick = (v: string | undefined): void => {
    if (v) remember(v);
    bump((n) => n + 1); // recents changed
    onChange(v);
  };
  const dropper = (globalThis as { EyeDropper?: new () => EyeDropperLike }).EyeDropper;
  const isHex = /^#[0-9a-fA-F]{6}$/.test(value);

  return (
    <div className="ui-color-field">
      <div className="ui-color-field__swatches" role="group" aria-label={t('colorSwatches')}>
        {swatches.map((s) => (
          <button
            key={s.labelKey}
            type="button"
            className={`ui-color-field__swatch${norm(value) === norm(s.value) ? ' is-active' : ''}`}
            style={{ background: s.value }}
            onClick={() => pick(s.value)}
            title={t(s.labelKey)}
            aria-label={t(s.labelKey)}
            aria-pressed={norm(value) === norm(s.value)}
          />
        ))}
        {allowNone ? (
          <button
            type="button"
            className={`ui-color-field__swatch ui-color-field__swatch--none${norm(value) === 'none' ? ' is-active' : ''}`}
            onClick={() => pick('none')}
            title={t('colorNone')}
            aria-label={t('colorNone')}
            aria-pressed={norm(value) === 'none'}
          />
        ) : null}
        {recents.filter((r) => !swatches.some((s) => norm(s.value) === norm(r)) && norm(r) !== 'none').slice(0, 3).map((r) => (
          <button
            key={`r-${r}`}
            type="button"
            className={`ui-color-field__swatch${norm(value) === norm(r) ? ' is-active' : ''}`}
            style={{ background: r }}
            onClick={() => pick(r)}
            title={t('colorRecent', { value: r })}
            aria-label={t('colorRecent', { value: r })}
            aria-pressed={norm(value) === norm(r)}
          />
        ))}
      </div>
      <span className="cv-editor__color-row">
        <input
          id={id}
          type="color"
          className="cv-editor__color"
          // A non-hex current value (token color, 'none') previews as the
          // resolved accent — the text input remains the source of truth.
          value={isHex ? value : (swatches[0]?.value.match(/^#[0-9a-fA-F]{6}$/) ? swatches[0].value : rgbToHex(parseColorToRgb(STOCK_ACCENT) ?? [0, 0, 0]))}
          onChange={(e) => pick(e.target.value)}
        />
        <input
          type="text"
          className="cv-editor__input"
          aria-label={hexAriaLabel}
          value={value}
          placeholder={t('colorHexPlaceholder')}
          onChange={(e) => onChange(e.target.value || undefined)}
          onBlur={() => { if (value) remember(value); }}
        />
        {dropper ? (
          <Button
            variant="quiet" size="sm"
            aria-label={t('colorPickFromScreen')}
            title={t('colorPickFromScreen')}
            onClick={() => {
              void new dropper().open().then((r) => pick(r.sRGBHex)).catch(() => undefined);
            }}
          >
            <PipetteIcon size={13} />
          </Button>
        ) : null}
      </span>
    </div>
  );
}
