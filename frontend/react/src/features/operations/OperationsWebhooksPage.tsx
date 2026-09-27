/**
 * Webhook-delivery health panel (ADR 0395 Phase A). ONE batched summary read
 * (D2 — no per-row fetch); a bounded 30s auto-refresh + manual refresh. Shows
 * per-subscription delivery counts, recent attempts with backoff state, and
 * trigger-subscription pause/resume. The two write affordances (manual retry,
 * pause/resume) are superadmin-gated server-side — the buttons surface the
 * backend's 404/403 honestly when the caller lacks the power.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice, StateCard } from '../../ui/index.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { listOrgs } from '../../client/accessClient.js';
import {
  getWebhookSummary, retryDelivery, setTriggerSubscriptionState,
  type WebhookSummary, type OpsDelivery,
} from '../../client/operationsClient.js';
import { AdminPageHeader } from '../../chrome/AdminPageHeader.js';

const REFRESH_MS = 30_000;

function statusChip(status: OpsDelivery['status']): string {
  return status === 'delivered' ? 'chip chip--success' : status === 'dead' ? 'chip chip--danger' : 'chip chip--warning';
}

// The `dead-lettered` state can't be a hyphenated i18n key, so it maps to a
// camelCase key; the other states use their `state_<value>` key directly.
function stateLabelKey(state: string): string {
  return state === 'dead-lettered' ? 'stateDeadLettered' : `state_${state}`;
}

export function OperationsWebhooksPage(): JSX.Element {
  const { t } = useTranslation('operations');
  const { t: tn } = useTranslation('nav');
  const [summary, setSummary] = useState<WebhookSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // §4.5 collection filters — the subscriptions list gets search + a `state`
  // facet (a real closed enum); the webhooks list gets search only (a webhook
  // row carries delivery counts, not a single status field, so no facet).
  const [subQuery, setSubQuery] = useState('');
  const [subState, setSubState] = useState('');
  const [whQuery, setWhQuery] = useState('');

  const load = useCallback(async () => {
    try {
      const orgs = await listOrgs();
      const orgId = orgs.length > 0 ? orgs[0]!.orgId : null;
      setSummary(await getWebhookSummary(orgId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const visibleSubscriptions = useMemo(() => {
    const subs = summary?.triggerSubscriptions ?? [];
    const q = subQuery.trim().toLowerCase();
    return subs.filter((s) =>
      (!subState || s.state === subState) &&
      (!q || `${s.label ?? ''} ${s.subscriptionId} ${s.source} ${s.tenantId}`.toLowerCase().includes(q)));
  }, [summary, subQuery, subState]);

  const visibleWebhooks = useMemo(() => {
    const whs = summary?.webhooks ?? [];
    const q = whQuery.trim().toLowerCase();
    return whs.filter((w) => !q || `${w.url} ${w.tenantId}`.toLowerCase().includes(q));
  }, [summary, whQuery]);

  const clearSubFilters = (): void => { setSubQuery(''); setSubState(''); };

  const onRetry = async (deliveryId: string): Promise<void> => {
    if (!(await confirm({ title: t('retryConfirmTitle'), body: t('retryConfirmBody'), confirmLabel: t('retryConfirm') }))) return;
    setBusy(true);
    try {
      await retryDelivery(deliveryId);
      toast.success(t('retryQueued'));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('retryFailed'));
    } finally { setBusy(false); }
  };

  const onToggleState = async (subscriptionId: string, current: string): Promise<void> => {
    const next = current === 'paused' ? 'active' : 'paused';
    setBusy(true);
    try {
      await setTriggerSubscriptionState(subscriptionId, next);
      toast.success(next === 'paused' ? t('subscriptionPaused') : t('subscriptionResumed'));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('stateChangeFailed'));
    } finally { setBusy(false); }
  };

  if (error && !summary) return <StateCard announce title={t('loadFailed')} body={error} action={<Button variant="primary" size="sm" onClick={() => void load()}>{t('refresh')}</Button>} />;
  if (!summary) return <StateCard loading title={t('loading')} />;

  return (
    <div className="page-shell" data-walkthrough="operations-webhooks.page">
      <AdminPageHeader
        eyebrow={tn('groupSystemOperations', { defaultValue: 'System operations' })}
        title={t('webhooksTitle')}
        actions={<><span className={summary.crossTenant ? 'chip chip--accent' : 'chip chip--muted'}>{summary.crossTenant ? t('scopeAllTenants') : t('scopeOwnTenant')}</span><Button variant="secondary" size="sm" disabled={busy} onClick={() => void load()}>{t('refresh')}</Button></>}
      />
      {error ? <Notice variant="warning">{error}</Notice> : null}

      <section>
        <h2>{t('triggerSubscriptionsHeading')}</h2>
        {summary.triggerSubscriptions.length > 3 ? (
          <div className="filterbar" role="group" aria-label={t('filterGroup')}>
            <input
              type="search"
              className="ui-input filterbar-search"
              placeholder={t('subscriptionSearchPlaceholder')}
              aria-label={t('subscriptionSearchAria')}
              value={subQuery}
              onChange={(e) => setSubQuery(e.target.value)}
            />
            <select className="ui-input filterbar-select" aria-label={t('stateFacetAria')} value={subState} onChange={(e) => setSubState(e.target.value)}>
              <option value="">{t('allStates')}</option>
              <option value="active">{t('state_active')}</option>
              <option value="paused">{t('state_paused')}</option>
              <option value="failed">{t('state_failed')}</option>
              <option value="dead-lettered">{t('stateDeadLettered')}</option>
            </select>
          </div>
        ) : null}
        {summary.triggerSubscriptions.length === 0 ? (
          <StateCard title={t('noTriggerSubscriptions')} body={t('noTriggerSubscriptionsHint')} />
        ) : visibleSubscriptions.length === 0 ? (
          <StateCard title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" size="sm" onClick={clearSubFilters}>{t('clearFilters')}</Button>} />
        ) : (
          <div className="card-grid">
            {visibleSubscriptions.map((s) => (
              <article key={s.subscriptionId} className="surface-card">
                <header className="action-bar">
                  <strong>{s.label ?? s.subscriptionId}</strong>
                  <span className={s.state === 'active' ? 'chip chip--success' : s.state === 'paused' ? 'chip chip--warning' : 'chip chip--danger'}>{t(stateLabelKey(s.state), { defaultValue: s.state })}</span>
                  <span className="chip chip--muted">{s.source}</span>
                  {summary.crossTenant ? <span className="chip chip--muted">{s.tenantId}</span> : null}
                </header>
                <p>{t('recentDeliveries', { n: s.recentDeliveries.length })}</p>
                {(s.state === 'active' || s.state === 'paused') ? (
                  <span className="action-bar">
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onToggleState(s.subscriptionId, s.state)}>
                      {s.state === 'paused' ? t('resume') : t('pause')}
                    </Button>
                  </span>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>{t('webhooksHeading')}</h2>
        {summary.webhooks.length > 3 ? (
          <div className="filterbar" role="group" aria-label={t('filterGroup')}>
            <input
              type="search"
              className="ui-input filterbar-search"
              placeholder={t('webhookSearchPlaceholder')}
              aria-label={t('webhookSearchAria')}
              value={whQuery}
              onChange={(e) => setWhQuery(e.target.value)}
            />
          </div>
        ) : null}
        {summary.webhooks.length === 0 ? (
          <StateCard title={t('noWebhooks')} body={t('noWebhooksHint')} />
        ) : visibleWebhooks.length === 0 ? (
          <StateCard title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" size="sm" onClick={() => setWhQuery('')}>{t('clearFilters')}</Button>} />
        ) : (
          <div className="card-grid">
            {visibleWebhooks.map((w) => (
              <article key={w.subscriptionId} className="surface-card">
                <header className="action-bar">
                  <strong>{w.url}</strong>
                  {summary.crossTenant ? <span className="chip chip--muted">{w.tenantId}</span> : null}
                </header>
                <p>
                  <span className="chip chip--warning">{t('pendingCount', { n: w.counts.pending })}</span>{' '}
                  <span className="chip chip--danger">{t('deadCount', { n: w.counts.dead })}</span>{' '}
                  <span className="chip chip--success">{t('deliveredCount', { n: w.counts.delivered })}</span>
                </p>
                {w.recent.length > 0 ? (
                  <ul>
                    {w.recent.map((d) => (
                      <li key={d.deliveryId} className="action-bar">
                        <span className={statusChip(d.status)}>{t(`status_${d.status}`, { defaultValue: d.status })}</span>
                        <span>{d.eventType}</span>
                        <span className="chip chip--muted">{t('attempts', { n: d.attempts, max: d.maxAttempts })}</span>
                        {d.status === 'dead' ? (
                          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onRetry(d.deliveryId)}>{t('retry')}</Button>
                        ) : null}
                        {/* GRADE-UX 2026-07-17 — the failure reason is visible
                            text (a tooltip was unreachable by keyboard/touch/SR). */}
                        {d.lastError ? <span className="u-label-sm u-text-muted">{t('lastError', { error: d.lastError })}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
