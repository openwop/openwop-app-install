/**
 * `/heartbeat-settings` (Settings → Platform → Heartbeat) — the host-wide,
 * superadmin control over the ADR 0313 autonomous work loop (ADR 0318). Master
 * on/off, an auto-disabling "run for N hours" window, the host-default cadence,
 * and a per-tenant run-budget override — all runtime-editable (no redeploy).
 *
 * Backend is the authority (`features/heartbeat-admin`); this page reads the
 * effective state + saves. With no saved config the loop inherits the
 * `OPENWOP_HEARTBEAT_DEFAULT_MS` env default, and the banner says so.
 *
 * @see docs/adr/0318-heartbeat-admin-settings.md
 */
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../ui/PageHeader.js';
import { Notice } from '../ui/Notice.js';
import { TextField, SelectField } from '../ui/Field.js';
import { toast } from '../ui/toast.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StateCard } from '../ui/StateCard.js';
import { ActivityIcon } from '../ui/icons/index.js';
import {
  getHeartbeatSettings,
  saveHeartbeatSettings,
  type HeartbeatAdminView,
} from '../client/heartbeatAdminClient.js';

const MIN = 60_000;
const HOUR = 3_600_000;
/** Cadence presets (minutes) for the host-default check interval. */
const CADENCE_MIN = [5, 10, 15, 30, 60] as const;
/** "Run for" window presets → hours (0 ⇒ indefinite). */
const DURATION_HOURS = [0, 1, 4, 8, 24] as const;

function fmtRemaining(ms: number): string {
  const totalMin = Math.round(ms / MIN);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function HeartbeatSettingsPage(): JSX.Element {
  const { t } = useTranslation('settings');
  const [view, setView] = useState<HeartbeatAdminView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Editable form state
  const [status, setStatus] = useState<'on' | 'off'>('off');
  const [cadenceMin, setCadenceMin] = useState(10);
  // HBUX-2 — the duration picker: -1 = KEEP the current window (the default
  // whenever one is live, so an unrelated save can't silently reset an active
  // countdown), 0 = indefinite, N>0 = start a new N-hour window on save.
  const [durationHours, setDurationHours] = useState(0);
  const [budgetStr, setBudgetStr] = useState(''); // '' = inherit env cap

  const load = useCallback(async () => {
    setError(null);
    try {
      const v = await getHeartbeatSettings();
      setView(v);
      setStatus(v.config.status);
      setCadenceMin(Math.max(1, Math.round(v.config.hostDefaultIntervalMs / MIN)));
      setBudgetStr(v.config.runBudgetPerHour == null ? '' : String(v.config.runBudgetPerHour));
      setDurationHours(v.config.enabledUntil ? -1 : 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onSave = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const budget = budgetStr.trim() === '' ? null : Number(budgetStr);
      if (budget != null && (!Number.isInteger(budget) || budget < 0)) {
        throw new Error(t('hbBudgetInvalid'));
      }
      const enabledUntil =
        status !== 'on' ? null
        : durationHours === -1 ? (view?.config.enabledUntil ?? null) // keep the live window untouched
        : durationHours > 0 ? new Date(Date.now() + durationHours * HOUR).toISOString()
        : null;
      const saved = await saveHeartbeatSettings({
        status,
        enabledUntil,
        hostDefaultIntervalMs: cadenceMin * MIN,
        runBudgetPerHour: budget,
      });
      setView(saved);
      setDurationHours(saved.config.enabledUntil ? -1 : 0);
      toast.success(t('hbSaved'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }, [status, cadenceMin, durationHours, budgetStr, view, t]);

  const banner = useMemo(() => {
    if (!view) return null;
    const eff = view.effective;
    if (!view.overridden) {
      return <Notice variant="info">{t('hbBannerInherit')}</Notice>;
    }
    if (eff.status === 'on') {
      const windowText = eff.autoDisablesInMs != null
        ? t('hbBannerOnWindow', { remaining: fmtRemaining(eff.autoDisablesInMs) })
        : t('hbBannerOnIndef');
      return <Notice variant="success">{t('hbBannerOn', { cadence: Math.round(eff.hostDefaultIntervalMs / MIN) })} {windowText}</Notice>;
    }
    return <Notice variant="warning">{eff.autoDisabled ? t('hbBannerAutoDisabled') : t('hbBannerOff')}</Notice>;
  }, [view, t]);

  return (
    <div className="page-shell" data-walkthrough="heartbeat-settings.page">
      <PageHeader eyebrow={t('hbEyebrow')} title={t('hbTitle')} lede={t('hbLede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {/* `view === null && !error` was written to avoid a permanent skeleton on
          error — correct about the skeleton, and it unveiled the FORM. On a
          failed read the form rendered with this component's initial defaults
          (`off` / 10 min / no budget), which look like a real configuration, and
          `onSave` sends a FULL REPLACEMENT. One click turned the workspace's
          autonomous work loop off from a network error.
          The read is the only source of truth for these fields, so if it failed
          there is nothing honest to put in them: offer a retry, not a form. */}
      {view === null && error ? (
        <StateCard
          announce
          title={t('hbLoadFailedTitle')}
          body={t('hbLoadFailedBody')}
          action={<Button variant="secondary" onClick={() => void load()}>{t('hbRetry')}</Button>}
        />
      ) : view === null && !error ? (
        <SkeletonRows rows={4} columns={['40%', '60%']} />
      ) : (
        <>
          {banner}
          <form onSubmit={(e) => void onSave(e)} className="surface-card surface-form u-mt-3" aria-label={t('hbTitle')}>
            <SelectField
              label={t('hbStatusLabel')}
              help={t('hbStatusHelp')}
              value={status}
              onChange={(e) => setStatus(e.target.value as 'on' | 'off')}
            >
              <option value="off">{t('hbStatusOff')}</option>
              <option value="on">{t('hbStatusOn')}</option>
            </SelectField>

            <SelectField
              label={t('hbCadenceLabel')}
              help={t('hbCadenceHelp')}
              value={String(cadenceMin)}
              onChange={(e) => setCadenceMin(Number(e.target.value))}
              disabled={status === 'off'}
            >
              {CADENCE_MIN.map((m) => <option key={m} value={m}>{t('hbCadenceOption', { count: m })}</option>)}
            </SelectField>

            <SelectField
              label={t('hbDurationLabel')}
              help={t('hbDurationHelp')}
              value={String(durationHours)}
              onChange={(e) => setDurationHours(Number(e.target.value))}
              disabled={status === 'off'}
            >
              {view?.config.enabledUntil ? <option value={-1}>{t('hbDurationKeep')}</option> : null}
              {DURATION_HOURS.map((h) => (
                <option key={h} value={h}>{h === 0 ? t('hbDurationIndef') : t('hbDurationHours', { count: h })}</option>
              ))}
            </SelectField>

            <TextField
              label={t('hbBudgetLabel')}
              help={t('hbBudgetHelp')}
              type="number"
              min={0}
              inputMode="numeric"
              value={budgetStr}
              onChange={(e) => setBudgetStr(e.target.value)}
              placeholder={t('hbBudgetPlaceholder')}
            />

            <Button type="submit" variant="accent-solid" disabled={saving}>
              <ActivityIcon size={14} /> {saving ? t('hbSaving') : t('hbSave')}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
