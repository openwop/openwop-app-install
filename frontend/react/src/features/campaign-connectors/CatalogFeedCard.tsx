/**
 * ADR 0952 D6 (P7) — the product feed for one org, generated from the commerce
 * catalog (no second product store). Turn it on, hand the signed URL to Google
 * Merchant Center or Meta Commerce Manager, rotate it if it leaks, and push the
 * changed items now. No credentials here: the merchant and ad tokens stay in
 * Connections.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { TextField, CheckboxField } from '../../ui/Field.js';
import { confirm } from '../../ui/confirm.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import {
  getCatalogFeed, saveCatalogFeed, rotateCatalogFeed, pushCatalogFeed,
  type CatalogFeed, type CatalogPlatform, type CatalogPushResult,
} from './campaignConnectorsClient.js';

export function CatalogFeedCard({ orgId }: { orgId: string }): JSX.Element | null {
  const { t } = useTranslation('campaign-connectors');
  const [feed, setFeed] = useState<CatalogFeed | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [metaCatalogId, setMetaCatalogId] = useState('');
  const [merchantAccountId, setMerchantAccountId] = useState('');
  const [merchantDataSource, setMerchantDataSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [push, setPush] = useState<{ platform: CatalogPlatform; result: CatalogPushResult } | null>(null);
  const seq = useRef(0);

  const adopt = (f: CatalogFeed): void => {
    setFeed(f);
    setMetaCatalogId(f.metaCatalogId ?? '');
    setMerchantAccountId(f.merchantAccountId ?? '');
    setMerchantDataSource(f.merchantDataSource ?? '');
  };
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setFeed(null); setLoadFailed(false); setError(null); setSaved(false); setPush(null);
    try {
      const f = await getCatalogFeed(orgId);
      if (mine === seq.current) adopt(f);
    } catch {
      if (mine === seq.current) setLoadFailed(true);
    }
  }, [orgId]);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null); setSaved(false);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); } finally { setBusy(false); }
  };
  // Keeps any target ids typed but not saved yet.
  const toggle = (enabled: boolean): Promise<void> => run(async () => { setFeed(await saveCatalogFeed(orgId, { enabled })); });
  const save = (): Promise<void> => run(async () => {
    adopt(await saveCatalogFeed(orgId, {
      metaCatalogId: metaCatalogId.trim() || null,
      merchantAccountId: merchantAccountId.trim() || null,
      merchantDataSource: merchantDataSource.trim() || null,
    }));
    setSaved(true);
  });
  const rotate = async (): Promise<void> => {
    if (!(await confirm({ title: t('feedRotateConfirm'), body: t('feedRotateConfirmBody'), danger: true, confirmLabel: t('feedRotate') }))) return;
    await run(async () => { adopt(await rotateCatalogFeed(orgId)); });
  };
  const pushNow = (platform: CatalogPlatform): Promise<void> => run(async () => { setPush({ platform, result: await pushCatalogFeed(orgId, platform) }); });

  const pushLine = (p: { platform: CatalogPlatform; result: CatalogPushResult }): string => {
    const name = t(`feedPlatform_${p.platform}`);
    const r = p.result;
    switch (r.outcome) {
      case 'pushed': return t('feedPushed', { platform: name, sent: r.sent, unchanged: r.unchanged, removed: r.removed, failed: r.failed });
      case 'unsupported': return t('feedPushNotVerified', { platform: name });
      case 'no_connection': return t('feedPushNoConnection', { platform: name });
      case 'disabled': return t('feedPushDisabled');
      default: return t('feedPushNotConfigured', { platform: name });
    }
  };
  const pushVariant = (r: CatalogPushResult): 'success' | 'warning' =>
    r.outcome === 'pushed' && r.failed === 0 ? 'success' : 'warning';

  if (!orgId) return null;
  return (
    <section className="surface-card u-mt-4" aria-labelledby="cc-feed-title">
      <h2 id="cc-feed-title" className="u-mt-0 u-fs-15">{t('feedTitle')}</h2>
      <p className="muted u-fs-13">{t('feedHint')}</p>
      {loadFailed ? (
        <p className="muted u-fs-13 u-mb-0" role="alert">{t('feedLoadFailed')}</p>
      ) : feed === null ? (
        <p className="muted u-fs-13 u-mb-0">{t('feedLoading')}</p>
      ) : (
        <>
          <CheckboxField label={t('feedEnabled')} checked={feed.enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
          <p className="u-fs-13 u-mb-2">
            {t('feedItemCount', { count: feed.items })}
            {feed.excluded.length > 0 ? ` ${t('feedExcludedCount', { count: feed.excluded.length })}` : ''}
          </p>
          {feed.excluded.length > 0 ? (
            <details className="u-mb-3 u-fs-13">
              <summary>{t('feedExcludedShow')}</summary>
              <ul className="u-m-0 u-mt-1">
                {feed.excluded.slice(0, 20).map((x) => <li key={x.productId}><code>{x.productId}</code>: {t(`feedExcluded_${x.reason}`)}</li>)}
              </ul>
            </details>
          ) : null}
          {feed.feedUrl ? (
            <div className="u-mb-3">
              <TextField label={t('feedUrlLabel')} help={t('feedUrlHelp')} value={feed.feedUrl} readOnly spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
              <div className="u-flex u-gap-2 u-flex-wrap">
                <Button variant="secondary" size="sm" onClick={() => void copyToClipboard(feed.feedUrl ?? '', t('feedUrlCopied'))}>{t('feedCopy')}</Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void rotate()}>{t('feedRotate')}</Button>
              </div>
            </div>
          ) : null}

          <h3 className="u-fs-14 u-mt-4">{t('feedPushTitle')}</h3>
          <p className="muted u-fs-13">{t('feedPushHint')}</p>
          {!feed.enabled ? <p className="muted u-fs-13">{t('feedPushDisabled')}</p> : null}
          <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <TextField label={t('feedMetaCatalogId')} help={t('feedMetaCatalogIdHelp')} value={metaCatalogId}
              onChange={(e) => setMetaCatalogId(e.target.value)} inputMode="numeric" autoComplete="off" spellCheck={false} />
            <TextField label={t('feedMerchantAccountId')} value={merchantAccountId}
              onChange={(e) => setMerchantAccountId(e.target.value)} inputMode="numeric" autoComplete="off" spellCheck={false} />
            <TextField label={t('feedMerchantDataSource')} help={t('feedMerchantDataSourceHelp')} value={merchantDataSource}
              onChange={(e) => setMerchantDataSource(e.target.value)} autoComplete="off" spellCheck={false} />
            <div className="action-bar u-flex u-gap-2 u-justify-end u-flex-wrap">
              <Button type="submit" variant="secondary" size="sm" disabled={busy}>{t('feedSaveTargets')}</Button>
              <Button variant="primary" size="sm" disabled={busy || !feed.enabled || !feed.metaCatalogId} aria-busy={busy} onClick={() => void pushNow('meta')}>{t('feedPushMeta')}</Button>
              <Button variant="primary" size="sm" disabled={busy || !feed.enabled || !feed.merchantDataSource} aria-busy={busy} onClick={() => void pushNow('google')}>{t('feedPushGoogle')}</Button>
            </div>
          </form>
          {saved ? <Notice variant="success" announce={t('feedTargetsSaved')}>{t('feedTargetsSaved')}</Notice> : null}
          {push ? (
            <Notice variant={pushVariant(push.result)} announce={pushLine(push)}>
              {pushLine(push)}
              {push.result.outcome === 'pushed' && push.result.failures.length > 0 ? (
                <ul className="u-m-0 u-mt-1 u-fs-13">
                  {push.result.failures.slice(0, 5).map((f) => <li key={`${f.op}-${f.id}`}><code>{f.id}</code>: {f.error}</li>)}
                </ul>
              ) : null}
            </Notice>
          ) : null}
        </>
      )}
      {error ? <p className="field-error u-mt-2" role="alert">{error}</p> : null}
    </section>
  );
}
