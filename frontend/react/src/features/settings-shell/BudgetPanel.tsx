/**
 * Personal AI Usage & Budget panel (ADR 0396 P3) — a SELF-SERVICE daily BYOK
 * token cap that can only LOWER the org backstop (`min(orgCap, personalCap)`
 * server-side). Tokens are the unit; USD never drives enforcement. Shows
 * today's recorded personal usage (the read-only ADR 0118-fed counter).
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice, StateCard } from '../../ui/index.js';
import { toast } from '../../ui/toast.js';
import { getPrefs, putPrefs, type UserPrefsView } from '../../client/settingsClient.js';

export function BudgetPanel(): JSX.Element {
  const { t } = useTranslation('settings-shell');
  const [prefs, setPrefs] = useState<UserPrefsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState('');
  const [warnPct, setWarnPct] = useState('80');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPrefs()
      .then((p) => {
        setPrefs(p);
        setCap(p.personalBudget ? String(p.personalBudget.dailyTokenCap) : '');
        setWarnPct(String(p.personalBudget?.softWarningPct ?? 80));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const [capError, setCapError] = useState<string | null>(null);
  const [warnError, setWarnError] = useState<string | null>(null);

  const onSave = async (): Promise<void> => {
    const capN = cap.trim() === '' ? 0 : Number(cap);
    const warnN = Number(warnPct);
    // GRADE-UX 2026-07-17 — field-ASSOCIATED errors (aria-invalid +
    // aria-describedby + role=alert), the SyncModal/PublishModal F6 pattern.
    const capBad = !Number.isInteger(capN) || capN < 0;
    const warnBad = !Number.isInteger(warnN) || warnN < 1 || warnN > 100;
    setCapError(capBad ? t('budgetCapInvalid') : null);
    setWarnError(warnBad ? t('budgetWarnInvalid') : null);
    if (capBad || warnBad) return;
    setBusy(true); setError(null);
    try {
      const saved = await putPrefs({ personalBudget: capN === 0 ? null : { dailyTokenCap: capN, softWarningPct: warnN } });
      setPrefs((p) => (p ? { ...p, personalBudget: saved.personalBudget } : p));
      toast.success(capN === 0 ? t('budgetCleared') : t('budgetSaved'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('budgetSaveFailed'));
    } finally { setBusy(false); }
  };

  if (error && !prefs) return <StateCard announce title={t('loadFailed')} body={error} />;
  if (!prefs) return <StateCard loading title={t('loading')} />;

  return (
    <div className="u-grid u-gap-3">
      <p>{t('budgetHint')}</p>
      {prefs.usageToday ? (
        <p><span className="chip chip--muted">{t('budgetUsedToday', { n: prefs.usageToday.tokens })}</span></p>
      ) : null}
      {/* ADR 0693 phase 5. The SCOPE line is the load-bearing half: phases 0-4
          gave each participant a private allowance, and a bare number cannot
          tell you whether "the free tier is exhausted" is about you or about
          everyone in the workspace. Rendered only when the server actually
          reports a free tier — absent is not zero. */}
      {prefs.managedUsageToday ? (
        <p className="u-grid u-gap-1">
          <span className="chip chip--muted">
            {t('freeTierUsedToday', {
              n: prefs.managedUsageToday.tokens,
              cap: prefs.managedUsageToday.dailyTokenCap,
            })}
          </span>
          <span className="u-label-sm u-text-muted">
            {prefs.managedUsageToday.scope === 'subject'
              ? t('freeTierScopeSubject')
              : t('freeTierScopeTenant')}
          </span>
        </p>
      ) : null}
      {error ? <Notice variant="error">{error}</Notice> : null}
      <div className="cv-editor__field">
        <label htmlFor="budget-cap" className="u-label-sm">{t('budgetCapLabel')}</label>
        <input id="budget-cap" type="number" min={0} className="cv-editor__input" value={cap} placeholder={t('budgetCapPlaceholder')} aria-invalid={capError !== null} aria-describedby="budget-cap-err" onChange={(e) => { setCap(e.target.value); setCapError(null); }} />
        <span id="budget-cap-err" role="alert" className="cv-editor__field-error">{capError ?? ''}</span>
      </div>
      <div className="cv-editor__field">
        <label htmlFor="budget-warn" className="u-label-sm">{t('budgetWarnLabel')}</label>
        <input id="budget-warn" type="number" min={1} max={100} className="cv-editor__input" value={warnPct} aria-invalid={warnError !== null} aria-describedby="budget-warn-err" onChange={(e) => { setWarnPct(e.target.value); setWarnError(null); }} />
        <span id="budget-warn-err" role="alert" className="cv-editor__field-error">{warnError ?? ''}</span>
      </div>
      <span className="action-bar">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void onSave()}>{busy ? t('saving') : t('save')}</Button>
      </span>
      <p className="u-label-sm u-text-muted">{t('budgetMinNote')}</p>
    </div>
  );
}
