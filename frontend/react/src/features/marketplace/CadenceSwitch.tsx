/**
 * The feature store's Monthly / Yearly switch (ADR 0820 §7 UI) — a real
 * `role="radiogroup"` (APG: selection follows focus, one tab stop) on the shared
 * `.segmented` chrome. The page renders one; the bundle detail panel renders a
 * second bound to the SAME state, so the panel never disagrees with the page.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { handleRadiogroupKeyDown } from '../../ui/rovingTabs.js';
import type { Cadence } from './bundleStoreModel.js';

export function CadenceSwitch({
  value, onChange, labelledBy, label, yearHint, monthDetail, yearDetail,
}: {
  value: Cadence;
  onChange: (c: Cadence) => void;
  /** id of a visible label, or… */
  labelledBy?: string;
  /** …an accessible name when there is none. */
  label?: string;
  /** Optional note on the yearly option ("save $58"), only when real. */
  yearHint?: string | null;
  /** Optional second line per option (the panel shows each option's price). */
  monthDetail?: string | null;
  yearDetail?: string | null;
}): JSX.Element {
  const { t } = useTranslation('marketplace');
  const opt = (c: Cadence, text: string, hint?: string | null, detail?: string | null): JSX.Element => (
    <Button
      variant="primary"
      role="radio"
      aria-checked={value === c}
      tabIndex={value === c ? 0 : -1}
      className="fstore-cadence__opt"
      onClick={() => onChange(c)}
    >
      <span className="fstore-cadence__label">
        {text}
        {hint ? <span className="fstore-cadence__hint">{hint}</span> : null}
      </span>
      {detail ? <span className="fstore-cadence__detail">{detail}</span> : null}
    </Button>
  );
  return (
    <div
      role="radiogroup"
      className="segmented fstore-cadence"
      onKeyDown={handleRadiogroupKeyDown}
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : { 'aria-label': label ?? t('storeCadenceLabel') })}
    >
      {opt('month', t('storeMonthly'), null, monthDetail)}
      {opt('year', t('storeYearly'), yearHint, yearDetail)}
    </div>
  );
}
