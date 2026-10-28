/**
 * `/free-tier-settings` (Settings → AI & automation → Free tier) — the host-wide,
 * superadmin choice of which provider and model the free tier runs on (ADR 0990).
 * Runtime-editable, no redeploy.
 *
 * Backend is the authority (`features/managed-tier-admin`); this page reads what
 * is serving and which providers have a key, tests a candidate, and saves. It
 * never shows or takes a key: keys go in the Secrets Vault, and a provider with
 * no key cannot be selected.
 *
 * @see docs/adr/0990-managed-tier-owner-select.md
 */
import { Link } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { PageHeader } from '../ui/PageHeader.js';
import { Notice } from '../ui/Notice.js';
import { TextField, SelectField } from '../ui/Field.js';
import { toast } from '../ui/toast.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StateCard } from '../ui/StateCard.js';
import { SparklesIcon } from '../ui/icons/index.js';
import {
  clearManagedTierSettings,
  getManagedTierSettings,
  saveManagedTierSettings,
  testManagedTierCandidate,
  type ManagedTierProvider,
  type ManagedTierTestResult,
  type ManagedTierView,
} from '../client/managedTierAdminClient.js';

/** Product names, the same in every locale. */
const PROVIDER_NAMES: Record<string, string> = {
  minimax: 'MiniMax',
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  google: 'Google (Gemini)',
};
const providerName = (p: string | null): string => (p ? PROVIDER_NAMES[p] ?? p : '');

export function FreeTierSettingsPage(): JSX.Element {
  const { t } = useTranslation('settings');
  const [view, setView] = useState<ManagedTierView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | null>(null);
  const [test, setTest] = useState<ManagedTierTestResult | null>(null);

  const [provider, setProvider] = useState<ManagedTierProvider>('minimax');
  const [model, setModel] = useState('');
  const [capStr, setCapStr] = useState(''); // '' = the deployment default

  const fill = useCallback((v: ManagedTierView) => {
    setView(v);
    const p = (v.config?.provider ?? v.effective.provider ?? 'minimax') as ManagedTierProvider;
    setProvider(p);
    setModel(v.config?.model ?? v.effective.model ?? v.providers.find((o) => o.provider === p)?.defaultModel ?? '');
    setCapStr(v.config?.dailyTokenCap == null ? '' : String(v.config.dailyTokenCap));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      fill(await getManagedTierSettings());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fill]);

  useEffect(() => { void load(); }, [load]);

  const option = view?.providers.find((o) => o.provider === provider);

  const onProviderChange = useCallback((next: ManagedTierProvider) => {
    setProvider(next);
    setTest(null);
    // A model id belongs to one provider: switching resets it to the new one's default.
    setModel(view?.providers.find((o) => o.provider === next)?.defaultModel ?? '');
  }, [view]);

  const parseCap = useCallback((): number | null => {
    if (capStr.trim() === '') return null;
    const n = Number(capStr);
    if (!Number.isInteger(n) || n < 1) throw new Error(t('ftCapInvalid'));
    return n;
  }, [capStr, t]);

  const onSave = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setError(null);
    try {
      const saved = await saveManagedTierSettings({ provider, model: model.trim(), dailyTokenCap: parseCap() });
      fill(saved);
      toast.success(t('ftSaved', { provider: providerName(saved.effective.provider), model: saved.effective.model ?? '' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  }, [provider, model, parseCap, fill, t]);

  const onTest = useCallback(async () => {
    setBusy('test');
    setTest(null);
    try {
      setTest(await testManagedTierCandidate({ provider, model: model.trim() }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [provider, model]);

  const onClear = useCallback(async () => {
    setBusy('clear');
    setError(null);
    try {
      fill(await clearManagedTierSettings());
      setTest(null);
      toast.success(t('ftCleared'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  }, [fill, t]);

  const banner = useMemo(() => {
    if (!view) return null;
    const eff = view.effective;
    if (!eff.provider) return <Notice variant="error">{t('ftBannerNone')}</Notice>;
    const sourceText = eff.source === 'setting' ? t('ftSourceSetting') : eff.source === 'env' ? t('ftSourceEnv') : t('ftSourceDefault');
    const serving = t('ftBannerServing', { provider: providerName(eff.provider), model: eff.model ?? '' });
    return eff.ready
      ? <Notice variant="success">{serving} {sourceText}</Notice>
      : <Notice variant="warning">{serving} {sourceText} {t('ftBannerNotReady')}</Notice>;
  }, [view, t]);

  const testText = test
    ? test.ok
      ? t('ftTestOk', { provider: providerName(test.provider), model: test.model, ms: test.latencyMs, reply: test.reply })
      : t('ftTestFailed', { provider: providerName(test.provider), model: test.model, message: test.message })
    : null;
  const testNotice = test && testText
    ? <Notice variant={test.ok ? 'success' : 'error'} announce={testText}>{testText}</Notice>
    : null;

  return (
    <div className="page-shell" data-walkthrough="free-tier-settings.page">
      <PageHeader eyebrow={t('ftEyebrow')} title={t('ftTitle')} lede={t('ftLede')} />
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {/* The heartbeat page's lesson (its own comment): on a failed read there is
          nothing honest to put in the form, and a save is a full replacement. */}
      {view === null && error ? (
        <StateCard
          announce
          title={t('ftLoadFailedTitle')}
          body={t('ftLoadFailedBody')}
          action={<Button variant="secondary" onClick={() => void load()}>{t('ftRetry')}</Button>}
        />
      ) : view === null ? (
        <SkeletonRows rows={4} columns={['40%', '60%']} />
      ) : (
        <>
          {banner}
          {view.vaultUsable ? null : <div className="u-mt-2"><Notice variant="warning">{t('ftVaultEphemeral')}</Notice></div>}
          <form onSubmit={(e) => void onSave(e)} className="surface-card u-p-4 u-mt-3" aria-label={t('ftTitle')}>
            <SelectField
              label={t('ftProviderLabel')}
              help={t('ftProviderHelp')}
              value={provider}
              onChange={(e) => onProviderChange(e.target.value as ManagedTierProvider)}
            >
              {view.providers.map((o) => (
                <option key={o.provider} value={o.provider} disabled={!o.ready}>
                  {o.ready
                    ? t(o.keySource === 'vault' ? 'ftOptionVault' : 'ftOptionEnv', { provider: providerName(o.provider) })
                    : t('ftOptionNoKey', { provider: providerName(o.provider) })}
                </option>
              ))}
            </SelectField>
            {option && !option.ready ? (
              <Notice variant="info">
                {t('ftNoKeyHelp', { provider: providerName(option.provider), ref: option.vaultRef })}{' '}
                <Link to="/access?tab=connections">{t('ftVaultLink')}</Link>
              </Notice>
            ) : null}

            <TextField
              label={t('ftModelLabel')}
              help={t('ftModelHelp', { model: option?.defaultModel ?? '' })}
              value={model}
              onChange={(e) => { setModel(e.target.value); setTest(null); }}
              spellCheck={false}
              autoComplete="off"
              required
            />

            <TextField
              label={t('ftCapLabel')}
              help={t('ftCapHelp')}
              type="number"
              min={1}
              inputMode="numeric"
              value={capStr}
              onChange={(e) => setCapStr(e.target.value)}
              placeholder={t('ftCapPlaceholder')}
            />

            {testNotice}

            <div className="action-bar">
              <Button type="button" variant="secondary" onClick={() => void onTest()} disabled={busy !== null || !option?.ready || model.trim() === ''}>
                {busy === 'test' ? t('ftTesting') : t('ftTest')}
              </Button>
              <Button type="submit" variant="accent-solid" disabled={busy !== null || !option?.ready || model.trim() === ''}>
                <SparklesIcon size={14} /> {busy === 'save' ? t('ftSaving') : t('ftSave')}
              </Button>
              {view.config ? (
                <Button type="button" variant="quiet" onClick={() => void onClear()} disabled={busy !== null}>
                  {busy === 'clear' ? t('ftClearing') : t('ftClear')}
                </Button>
              ) : null}
            </div>
            <p className="field-help">
              {t('ftKeysNote')} <Link to="/access?tab=connections">{t('ftVaultLink')}</Link>
            </p>
          </form>
        </>
      )}
    </div>
  );
}
