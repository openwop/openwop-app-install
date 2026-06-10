/**
 * CSM page (host-extension product feature — ADR 0001 §6 Phase 6). Mirrors the
 * CRM page's gating shape: hidden in nav when off, disabled state on the page,
 * accounts list + add when on.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { toast } from '../../ui/toast.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { createAccount, deleteAccount, listAccounts, type Account } from './csmClient.js';

export function CsmPage(): JSX.Element {
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
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load accounts.'));
  }, []);

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
      toast.success('Account added.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Add failed.');
    } finally {
      setBusy(false);
    }
  }, [name, score, load]);

  const remove = useCallback(async (id: string) => {
    try {
      await deleteAccount(id);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed.');
    }
  }, [load]);

  const accountColumns = useMemo<DataColumn<Account>[]>(() => [
    { key: 'name', header: 'Account', render: (a) => a.name },
    { key: 'health', header: 'Health', render: (a) => <span className="chip">{a.healthScore}</span> },
    {
      key: 'actions',
      header: '',
      render: (a) => (
        <span className="action-bar">
          <button type="button" className="btn-ghost" onClick={() => void remove(a.accountId)} aria-label={`Delete ${a.name}`}>Delete</button>
        </span>
      ),
    },
  ], [remove]);

  if (csm.loading) return <Skeleton />;
  if (!csm.enabled) {
    return (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow="Business" title="CSM" />
        <StateCard title="CSM is not enabled" body="Ask an administrator to turn on the CSM feature in Admin → Feature toggles." />
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow="Business" title="CSM" lede="Customer-success accounts, lowest health first." />
      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="surface-card u-p-4 surface-form">
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">Account</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" />
        </label>
        <label className="u-grid u-gap-1 is-narrow">
          <span className="u-label-sm">Health (0–100)</span>
          <input type="number" min={0} max={100} value={score} onChange={(e) => setScore(Math.trunc(Number(e.target.value)) || 0)} className="csm-score-input" />
        </label>
        <button type="button" className="btn-primary" disabled={busy || !name.trim()} onClick={() => void add()}>
          Add account
        </button>
      </div>

      <DataTable
        rows={accounts ?? []}
        rowKey={(a) => a.accountId}
        columns={accountColumns}
        caption="Accounts"
        empty={
          accounts === null
            ? <SkeletonRows rows={3} columns={[200, 90, 100]} />
            : <StateCard icon={<ActivityIcon />} title="No accounts yet" body="Add your first customer account with the form above — lowest health sorts to the top." />
        }
      />
    </section>
  );
}
