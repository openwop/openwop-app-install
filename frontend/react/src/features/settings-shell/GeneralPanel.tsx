/**
 * General panel (ADR 0396 P1/P2) — re-surfaces the EXISTING theme control and
 * the motion pref, and owns the density pref (localStorage tier, same store as
 * the a11y prefs). No second store anywhere.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ThemeToggle } from '../../ui/ThemeToggle.js';
import {
  applyA11yDepthPrefs, readDensity, readFontScale, readFocusStyle, writeDensity,
  applyA11yPrefs, readReduceMotion, readContrast, writeReduceMotion,
  type DensityPref, type ReduceMotionPref,
} from '../../ui/a11yPrefs.js';

export function GeneralPanel(): JSX.Element {
  const { t } = useTranslation('settings-shell');
  const [density, setDensity] = useState<DensityPref>(readDensity);
  const [motion, setMotion] = useState<ReduceMotionPref>(readReduceMotion);

  useEffect(() => {
    writeDensity(density);
    applyA11yDepthPrefs(readFontScale(), readFocusStyle(), density);
  }, [density]);
  useEffect(() => {
    writeReduceMotion(motion);
    applyA11yPrefs(motion, readContrast());
  }, [motion]);

  return (
    <div className="u-grid u-gap-3">
      <div className="action-bar">
        <span className="u-label-sm">{t('themeLabel')}</span>
        <ThemeToggle />
      </div>
      <fieldset className="u-grid u-gap-1 u-border-0 u-p-0">
        <legend className="u-label-sm">{t('densityLabel')}</legend>
        <div className="segmented">
          <Button variant="primary" aria-pressed={density === 'comfortable'} onClick={() => setDensity('comfortable')}>{t('densityComfortable')}</Button>
          <Button variant="primary" aria-pressed={density === 'compact'} onClick={() => setDensity('compact')}>{t('densityCompact')}</Button>
        </div>
      </fieldset>
      <fieldset className="u-grid u-gap-1 u-border-0 u-p-0">
        <legend className="u-label-sm">{t('motionLabel')}</legend>
        <div className="segmented">
          <Button variant="primary" aria-pressed={motion === 'system'} onClick={() => setMotion('system')}>{t('motionSystem')}</Button>
          <Button variant="primary" aria-pressed={motion === 'reduce'} onClick={() => setMotion('reduce')}>{t('motionReduce')}</Button>
        </div>
      </fieldset>
    </div>
  );
}
