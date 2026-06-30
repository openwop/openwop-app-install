/**
 * CSM page (host-extension product feature — ADR 0001 §6 Phase 6). Mirrors the
 * CRM page's gating shape: hidden in nav when off, disabled state on the page,
 * accounts list + add when on.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { toast } from '../../ui/toast.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { createAccount, deleteAccount, listAccounts, type Account } from './csmClient.js';

/** Health is a severity signal (low = at-risk), the §5.3-sanctioned reuse of the
 *  functional tokens outside run-state. The number rides alongside, so the color
 *  is never the sole signal. */
const healthChip = (s: number): string =>
  s >= 70 ? 'chip chip--success' : s >= 40 ? 'chip chip--warning' : 'chip chip--danger';

export function CsmPage(): JSX.Element {
  const { t } = useTranslation('csm');
  const csm = useFeatureAccess('csm');
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [score, setScore] = useState(50);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void listAccounts()
      .then(setAccounts)
      .catch((err) => setError(err instanceof Error ? err.message : t('loadAccountsFailed')));
  }, [t]);

  useEffect(() => {
    if (csm.enabled) load();
  }, [csm.enabled, load]);

  const add = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createAccount({ name: name.trim(), healthScore: score });
      setName('');
      setScore(50);
      load();
      toast.success(t('accountAdded'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('addFailed'));
    } finally {
      setBusy(false);
    }
  }, [name, score, load, t]);

  const remove = useCallback(async (id: string) => {
    try {
      await deleteAccount(id);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('deleteFailed'));
    }
  }, [load, t]);

  const accountColumns = useMemo<DataColumn<Account>[]>(() => [
    { key: 'name', header: t('colAccount'), render: (a) => a.name, sortValue: (a) => a.name },
    { key: 'health', header: t('colHealth'), render: (a) => <span className={healthChip(a.healthScore)}>{a.healthScore}</span>, sortValue: (a) => a.healthScore },
    {
      key: 'actions',
      header: '',
      render: (a) => (
        <span className="action-bar">
          <button type="button" className="btn-ghost" onClick={() => void remove(a.accountId)} aria-label={t('deleteRowLabel', { name: a.name })}>{t('common:delete')}</button>
        </span>
      ),
    },
  ], [remove, t]);

  if (csm.loading) return <Skeleton />;
  if (!csm.enabled) {
    return (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('fieldAccount')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('accountNamePlaceholder')} />
        </label>
        <label className="u-grid u-gap-1 is-narrow">
          <span className="u-label-sm">{t('fieldHealth')}</span>
          <input type="number" min={0} max={100} value={score} onChange={(e) => setScore(Math.trunc(Number(e.target.value)) || 0)} className="csm-score-input" />
        </label>
        <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
          {t('addAccount')}
        </button>
      </form>

      <DataTable
        rows={accounts ?? []}
        rowKey={(a) => a.accountId}
        columns={accountColumns}
        caption={t('captionAccounts')}
        empty={
          accounts === null
            ? <SkeletonRows rows={3} columns={[200, 90, 100]} />
            : <StateCard icon={<ActivityIcon />} title={t('noAccountsTitle')} body={t('noAccountsBody')} />
        }
      />
    </section>
  );
}
