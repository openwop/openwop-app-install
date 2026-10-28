/**
 * Hard spend caps (ADR 0952 D2) on the Campaign Intelligence page. A cap bounds
 * what one campaign, or a whole client org, may spend in a period; the watchdog
 * pauses covered campaigns when it is reached, or when spend has been unreadable
 * for too long. Anyone with write access can add or LOWER a cap (it only ever
 * stops spend); raising or removing one needs the org owner, and the server says
 * so when it refuses.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { confirm } from '../../ui/confirm.js';
import { formatCurrency, formatDateTime } from '../../i18n/format.js';
import { currencyExponent, isIsoCurrency, majorToMinor } from '../campaign-brief/budgetUnits.js';
import { createSpendCap, deleteSpendCap, listSpendCaps, setSpendCapLimit, type CapStatus, type SpendCapDto } from './campaignIntelClient.js';

const STATUS_CHIP: Record<CapStatus | 'unread', string> = {
  ok: 'chip chip--success', near: 'chip chip--warning', breached: 'chip chip--danger', stale: 'chip chip--danger', unread: 'chip chip--muted',
};

const money = (minor: number, currency: string): string =>
  formatCurrency(minor / 10 ** currencyExponent(currency), currency, { maximumFractionDigits: currencyExponent(currency) });

export function SpendCapsPanel({ orgId, campaigns, focusCapId }: {
  orgId: string;
  campaigns: Array<{ id: string; name: string }>;
  focusCapId?: string | null;
}): JSX.Element {
  const { t } = useTranslation('campaign-intel');
  const [caps, setCaps] = useState<SpendCapDto[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [message, setMessage] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Create form.
  const [scope, setScope] = useState('client');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [period, setPeriod] = useState<SpendCapDto['period']>('calendar-month');
  // Inline limit edit.
  const [editing, setEditing] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const focusRef = useRef<HTMLLIElement | null>(null);

  const load = useCallback(async () => {
    try { setCaps(await listSpendCaps(orgId)); setLoadFailed(false); } catch { setCaps(null); setLoadFailed(true); }
  }, [orgId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (focusCapId && focusRef.current) focusRef.current.focus({ preventScroll: false }); }, [focusCapId, caps]);

  const run = async (fn: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try { await fn(); setMessage({ variant: 'success', text: success }); await load(); }
    catch (e) {
      const text = e instanceof Error && /scope|forbidden/i.test(e.message) ? t('capOwnerOnly') : (e instanceof Error && e.message ? e.message : t('capSaveFailed'));
      setMessage({ variant: 'error', text });
    } finally { setBusy(false); }
  };

  const currencyValid = isIsoCurrency(currency);
  const amountValid = Number(amount) > 0;
  const create = (): Promise<void> => run(() => createSpendCap(orgId, {
    scope: scope === 'client' ? { kind: 'client' } : { kind: 'campaign', campaignId: scope },
    limitMinor: majorToMinor(amount, currency.toUpperCase()), currency: currency.toUpperCase(), period,
  }).then(() => { setAmount(''); }), t('capCreated'));

  const saveLimit = (cap: SpendCapDto): Promise<void> => run(
    () => setSpendCapLimit(orgId, cap.capId, majorToMinor(editAmount, cap.currency), cap.version).then(() => setEditing(null)),
    t('capUpdated'),
  );
  const remove = async (cap: SpendCapDto): Promise<void> => {
    if (!(await confirm({ title: t('capRemoveTitle'), body: t('capRemoveBody'), danger: true, confirmLabel: t('capRemove') }))) return;
    await run(() => deleteSpendCap(orgId, cap.capId), t('capRemoved'));
  };

  /** Known read-failure codes in words; the raw code stays as a suffix for support. */
  const readErrorText = (code: string): string => {
    const head = code.split(':')[0] ?? code;
    const label = t(`capReadReason_${head}`, { defaultValue: '' });
    return label ? `${label} (${code})` : code;
  };
  const scopeLabel = (cap: SpendCapDto): string =>
    cap.scope.kind === 'client' ? t('capScopeClient') : (campaigns.find((c) => cap.scope.kind === 'campaign' && c.id === cap.scope.campaignId)?.name ?? t('capScopeCampaign'));

  return (
    <section className="surface-card u-mb-4" aria-labelledby="caps-title">
      <h2 id="caps-title" className="u-mt-0 u-fs-15">{t('capsTitle')}</h2>
      <p className="muted u-fs-13 u-mt-0">{t('capsLede')}</p>
      {loadFailed ? <p className="muted u-fs-13">{t('capsLoadFailed')}</p> : null}
      {message ? <Notice announce={message.text} variant={message.variant}>{message.text}</Notice> : null}
      {caps && caps.length > 0 ? (
        <ul className="u-list-none u-m-0 u-p-0">
          {caps.map((cap) => {
            const status = cap.state?.status ?? 'unread';
            const focused = cap.capId === focusCapId;
            return (
              <li key={cap.capId} ref={focused ? focusRef : undefined} tabIndex={focused ? -1 : undefined} className={`u-py-2${focused ? ' is-deeplink-focus' : ''}`}>
                <div className="u-flex u-items-center u-gap-3 u-flex-wrap">
                  <span className="u-fw-600">{scopeLabel(cap)}</span>
                  <span className={STATUS_CHIP[status]}>{t(`capStatus_${status}`)}</span>
                  <span className="u-fs-13 muted">
                    {cap.state?.spentMinor !== null && cap.state?.spentMinor !== undefined
                      ? t('capSpentOf', { spent: money(cap.state.spentMinor, cap.currency), limit: money(cap.limitMinor, cap.currency) })
                      : t('capLimitOnly', { limit: money(cap.limitMinor, cap.currency) })}
                    {' · '}{t(cap.period === 'lifetime' ? 'capPeriod_lifetime' : 'capPeriod_calendarMonth')}
                    {cap.state?.readAt ? <>{' · '}{t('capReadAt', { when: formatDateTime(cap.state.readAt) })}</> : null}
                  </span>
                  <span className="u-ml-auto u-flex u-gap-2">
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setEditing(cap.capId); setEditAmount(String(cap.limitMinor / 10 ** currencyExponent(cap.currency))); }}>{t('capEdit')}</Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => { void remove(cap); }}>{t('capRemove')}</Button>
                  </span>
                </div>
                {cap.state?.readError ? <p className="muted u-fs-13 u-mb-0">{t('capReadError', { error: readErrorText(cap.state.readError) })}</p> : null}
                {editing === cap.capId ? (
                  <form className="u-flex u-gap-2 u-items-end u-flex-wrap u-mt-2" onSubmit={(e) => { e.preventDefault(); void saveLimit(cap); }}>
                    <TextField label={t('capNewLimit', { currency: cap.currency })} type="number" min="0" step="any" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} help={t('capRaiseHelp')} />
                    <Button type="submit" size="sm" variant="primary" disabled={busy || !(Number(editAmount) > 0)}>{t('capSave')}</Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(null)}>{t('capCancel')}</Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : caps ? <p className="muted u-fs-13">{t('capsEmpty')}</p> : null}

      <form className="u-flex u-gap-2 u-items-end u-flex-wrap u-mt-3" onSubmit={(e) => { e.preventDefault(); if (currencyValid && amountValid) void create(); }}>
        <SelectField label={t('capScope')} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="client">{t('capScopeClient')}</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <TextField label={t('capAmount')} type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <TextField label={t('capCurrency')} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} error={currency && !currencyValid ? t('capCurrencyInvalid') : undefined} />
        <SelectField label={t('capPeriod')} value={period} onChange={(e) => setPeriod(e.target.value as SpendCapDto['period'])}>
          <option value="calendar-month">{t('capPeriod_calendarMonth')}</option>
          <option value="lifetime">{t('capPeriod_lifetime')}</option>
        </SelectField>
        <Button type="submit" size="sm" variant="primary" disabled={busy || !currencyValid || !amountValid}>{t('capAdd')}</Button>
      </form>
    </section>
  );
}
