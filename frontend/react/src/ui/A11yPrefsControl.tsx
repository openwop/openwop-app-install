/**
 * ADR 0363 P4 — the accessibility-preferences control. A compact icon button in
 * the Sidebar footer (beside ThemeToggle/LanguageSwitcher) opening a small Modal
 * with two segmented groups: reduce-motion and increased-contrast overrides that
 * layer over the OS media queries. Persisted + applied via `ui/a11yPrefs`.
 */
import { Button } from '../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './IconButton.js';
import { Modal } from './Modal.js';
import { EyeIcon } from './icons/index.js';
import {
  applyA11yPrefs,
  applyA11yDepthPrefs,
  readReduceMotion,
  readContrast,
  readFontScale,
  readFocusStyle,
  readDensity,
  writeReduceMotion,
  writeContrast,
  writeFontScale,
  writeFocusStyle,
  type ReduceMotionPref,
  type ContrastPref,
  type FontScalePref,
  type FocusStylePref,
} from './a11yPrefs.js';

// System (follow the OS) or force Reduce. There is no "force Full" — CSS cannot
// reliably re-enable motion against an OS reduce-motion preference.
const MOTION_OPTS: { value: ReduceMotionPref; labelKey: string }[] = [
  { value: 'system', labelKey: 'prefSystem' },
  { value: 'reduce', labelKey: 'motionReduce' },
];
const CONTRAST_OPTS: { value: ContrastPref; labelKey: string }[] = [
  { value: 'system', labelKey: 'prefSystem' },
  { value: 'more', labelKey: 'contrastMore' },
];
// ADR 0396 P2 — the depth prefs (same store, same additive pattern).
const FONT_SCALE_OPTS: { value: FontScalePref; labelKey: string }[] = [
  { value: 'system', labelKey: 'prefSystem' },
  { value: '110', labelKey: 'fontScale110' },
  { value: '125', labelKey: 'fontScale125' },
  { value: '140', labelKey: 'fontScale140' },
];
const FOCUS_OPTS: { value: FocusStylePref; labelKey: string }[] = [
  { value: 'system', labelKey: 'prefSystem' },
  { value: 'bold', labelKey: 'focusBold' },
];

/** ADR 0396 P1 — the shared prefs FIELDS (state + segmented groups), reused by
 *  the footer modal AND the /settings Accessibility panel (one store, one UI). */
export function A11yPrefsFields(): JSX.Element {
  const { t } = useTranslation('a11y');
  const [motion, setMotion] = useState<ReduceMotionPref>(readReduceMotion);
  const [contrast, setContrast] = useState<ContrastPref>(readContrast);
  const [fontScale, setFontScale] = useState<FontScalePref>(readFontScale);
  const [focusStyle, setFocusStyle] = useState<FocusStylePref>(readFocusStyle);

  // One effect persists + applies both prefs (GRADE ANN-1: was split across two).
  useEffect(() => {
    writeReduceMotion(motion);
    writeContrast(contrast);
    applyA11yPrefs(motion, contrast);
  }, [motion, contrast]);
  // ADR 0396 P2 — depth prefs (density is a General-panel concern; its stored
  // value passes through unchanged here).
  useEffect(() => {
    writeFontScale(fontScale);
    writeFocusStyle(focusStyle);
    applyA11yDepthPrefs(fontScale, focusStyle, readDensity());
  }, [fontScale, focusStyle]);

  return (
    <div className="u-grid u-gap-3">
      <fieldset className="u-grid u-gap-1 u-border-0 u-p-0">
        <legend className="u-label-sm">{t('motionLabel')}</legend>
        <div className="segmented">
          {MOTION_OPTS.map(({ value, labelKey }) => (
            <Button variant="primary" key={value} aria-pressed={motion === value} onClick={() => setMotion(value)}>{t(labelKey)}</Button>
          ))}
        </div>
      </fieldset>
      <fieldset className="u-grid u-gap-1 u-border-0 u-p-0">
        <legend className="u-label-sm">{t('contrastLabel')}</legend>
        <div className="segmented">
          {CONTRAST_OPTS.map(({ value, labelKey }) => (
            <Button variant="primary" key={value} aria-pressed={contrast === value} onClick={() => setContrast(value)}>{t(labelKey)}</Button>
          ))}
        </div>
      </fieldset>
      <fieldset className="u-grid u-gap-1 u-border-0 u-p-0">
        <legend className="u-label-sm">{t('fontScaleLabel')}</legend>
        <div className="segmented">
          {FONT_SCALE_OPTS.map(({ value, labelKey }) => (
            <Button variant="primary" key={value} aria-pressed={fontScale === value} onClick={() => setFontScale(value)}>{t(labelKey)}</Button>
          ))}
        </div>
      </fieldset>
      <fieldset className="u-grid u-gap-1 u-border-0 u-p-0">
        <legend className="u-label-sm">{t('focusStyleLabel')}</legend>
        <div className="segmented">
          {FOCUS_OPTS.map(({ value, labelKey }) => (
            <Button variant="primary" key={value} aria-pressed={focusStyle === value} onClick={() => setFocusStyle(value)}>{t(labelKey)}</Button>
          ))}
        </div>
      </fieldset>
      <p className="u-label-sm u-text-muted">{t('prefsHint')}</p>
    </div>
  );
}

export function A11yPrefsControl(): JSX.Element {
  const { t } = useTranslation('a11y');
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label={t('prefsButton')} icon={<EyeIcon />} className="btn-ghost" onClick={() => setOpen(true)} />
      {open ? (
        <Modal onClose={() => setOpen(false)} label={t('prefsTitle')} showClose>
          <A11yPrefsFields />
        </Modal>
      ) : null}
    </>
  );
}
