/**
 * ADR 0907 D3 — live-sync settings + backfill for one org. Which campaigns the
 * daily sync reads (the dispatched ones, or every campaign of the configured
 * ad accounts), Meta's conversion action types, and a bounded, resumable
 * backfill. No credentials here: the ad-platform token stays in Connections.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { formatTime } from '../../i18n/format.js';
import {
  getConnectorSettings, saveConnectorSettings, runBackfill,
  type BackfillResult, type ConnectorSettings, type LiveSyncPlatform, type SyncScope,
} from './campaignConnectorsClient.js';

const splitList = (v: string): string[] => v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

export function SyncSettingsCard({ orgId, platforms, onSynced }: { orgId: string; platforms: readonly LiveSyncPlatform[]; onSynced: () => void }): JSX.Element | null {
  const { t } = useTranslation('campaign-connectors');
  const [platform, setPlatform] = useState<LiveSyncPlatform>('meta');
  // Follow the server's live list: a platform that is not live has no card.
  useEffect(() => { if (platforms.length > 0 && !platforms.includes(platform)) setPlatform(platforms[0]!); }, [platforms, platform]);
  const [settings, setSettings] = useState<ConnectorSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [scope, setScope] = useState<SyncScope>('dispatched');
  const [accounts, setAccounts] = useState('');
  const [actionTypes, setActionTypes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [days, setDays] = useState('30');
  const [backfill, setBackfill] = useState<BackfillResult | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setSettings(null); setLoadFailed(false); setError(null); setSaved(false); setBackfill(null);
    try {
      const s = await getConnectorSettings(orgId, platform);
      if (mine !== seq.current) return;
      setSettings(s);
      setScope(s.syncScope);
      setAccounts(s.adAccountIds.join(', '));
      setActionTypes((s.conversionActionTypes ?? []).join(', '));
    } catch {
      if (mine === seq.current) setLoadFailed(true); // never render defaults as if they were saved
    }
  }, [orgId, platform]);
  useEffect(() => { void load(); }, [load]);

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const types = splitList(actionTypes);
      const next = await saveConnectorSettings(orgId, platform, {
        syncScope: scope, adAccountIds: splitList(accounts),
        ...(platform === 'meta' ? { conversionActionTypes: types.length > 0 ? types : null } : {}),
      });
      setSettings(next);
      setSaved(true);
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };

  const step = async (): Promise<void> => {
    if (busy) return;
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 90) { setError(t('backfillDaysInvalid')); return; }
    setBusy(true); setError(null);
    try {
      const r = await runBackfill(orgId, platform, n);
      setBackfill(r);
      if (r.outcome === 'progress' || r.outcome === 'done') onSynced();
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };

  const backfillLine = (r: BackfillResult): string => {
    switch (r.outcome) {
      case 'done': return t('backfillDone', { since: r.targetSince ?? '', imported: r.imported ?? 0 });
      case 'progress': return t('backfillProgress', { remaining: r.remainingDays ?? 0, imported: r.imported ?? 0 });
      case 'rate_limited': return t('backfillRateLimited', { remaining: r.remainingDays ?? 0 });
      case 'busy': return t('backfillBusy', { retryAt: r.retryAtIso ? formatTime(r.retryAtIso) : '' });
      case 'no_accounts': return t('syncNoAccounts');
      case 'not_verified': return t('syncNotVerified');
      default: return t('syncNoDispatches');
    }
  };

  if (!orgId || platforms.length === 0) return null;
  return (
    <section className="surface-card u-mt-4" aria-labelledby="cc-sync-settings-title">
      <h2 id="cc-sync-settings-title" className="u-mt-0 u-fs-15">{t('syncSettingsTitle')}</h2>
      <p className="muted u-fs-13">{t('syncSettingsHint')}</p>
      <div className="u-mb-3">
        <SelectField label={t('pixelPlatform')} value={platform} onChange={(e) => setPlatform(e.target.value as LiveSyncPlatform)}>
          {platforms.map((p) => <option key={p} value={p}>{t(`platform_${p}`, { defaultValue: p })}</option>)}
        </SelectField>
      </div>
      {loadFailed ? (
        <p className="muted u-fs-13 u-mb-0" role="alert">{t('syncSettingsLoadFailed')}</p>
      ) : settings === null ? (
        <p className="muted u-fs-13 u-mb-0">{t('loading')}</p>
      ) : (
        <>
          <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <SelectField label={t('syncScopeLabel')} help={t('syncScopeHelp')} value={scope} onChange={(e) => setScope(e.target.value as SyncScope)}>
              <option value="dispatched">{t('syncScopeDispatched')}</option>
              <option value="account">{t('syncScopeAccount')}</option>
            </SelectField>
            <TextField label={t('adAccountsLabel')} help={t(`adAccountsHelp_${platform}`)}
              value={accounts} onChange={(e) => setAccounts(e.target.value)} autoComplete="off" spellCheck={false}
              required={scope === 'account'} />
            {platform === 'meta' ? (
              <TextField label={t('conversionActionsLabel')} help={t('conversionActionsHelp')}
                value={actionTypes} onChange={(e) => setActionTypes(e.target.value)} autoComplete="off" spellCheck={false} />
            ) : null}
            <div className="action-bar u-flex u-gap-2 u-justify-end">
              <Button type="submit" variant="primary" size="sm" disabled={busy}>{t('saveSyncSettings')}</Button>
            </div>
          </form>
          {saved ? <Notice variant="success" announce={t('syncSettingsSaved')}>{t('syncSettingsSaved')}</Notice> : null}

          <h3 className="u-fs-14 u-mt-4">{t('backfillTitle')}</h3>
          <p className="muted u-fs-13">{t('backfillHint')}</p>
          <form className="u-flex u-gap-2 u-items-end u-flex-wrap" onSubmit={(e) => { e.preventDefault(); void step(); }}>
            <TextField label={t('backfillDaysLabel')} type="number" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
            <Button type="submit" variant="secondary" size="sm" disabled={busy} aria-busy={busy}>
              {backfill?.outcome === 'progress' || backfill?.outcome === 'rate_limited' ? t('backfillContinue') : t('backfillStart')}
            </Button>
          </form>
          {backfill ? (
            <Notice variant={backfill.outcome === 'done' ? 'success' : backfill.outcome === 'progress' ? 'info' : 'warning'} announce={backfillLine(backfill)}>
              {backfillLine(backfill)}
              {(backfill.failures?.length ?? 0) > 0 ? (
                <ul className="u-m-0 u-mt-1 u-fs-13">
                  {backfill.failures!.slice(0, 5).map((f, i) => <li key={`${f.adAccountId ?? ''}-${i}`}><code>{f.adAccountId}</code>: {f.reason}</li>)}
                </ul>
              ) : null}
              {backfill.truncated ? <p className="u-m-0 u-mt-1 u-fs-13">{t('syncTruncated')}</p> : null}
            </Notice>
          ) : null}
        </>
      )}
      {error ? <p className="field-error u-mt-2" role="alert">{error}</p> : null}
    </section>
  );
}
