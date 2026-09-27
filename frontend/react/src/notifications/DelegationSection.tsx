/**
 * Approval-delegation section (ADR 0198) — self-service out-of-office coverage,
 * rendered at the foot of the approvals inbox (where approvers already act).
 * A delegation makes someone eligible wherever YOU are, for a time window;
 * their sign-off counts as yours (one identity — never a double vote).
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../ui/Notice.js';
import { UserPicker } from '../orgs/UserPicker.js';
import { toast } from '../ui/toast.js';
import { formatDateTime } from '../i18n/format.js';
import {
  listMyDelegations,
  createDelegation,
  revokeDelegation,
  type ApprovalDelegation,
} from './delegationsClient.js';

function toLocalInput(date: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function DelegationSection(): JSX.Element {
  const { t } = useTranslation('notifications');
  const [rows, setRows] = useState<ApprovalDelegation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toSubject, setToSubject] = useState('');
  const [startsAt, setStartsAt] = useState(() => toLocalInput(new Date()));
  const [endsAt, setEndsAt] = useState(() => toLocalInput(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)));
  const [reason, setReason] = useState('');

  const refresh = useCallback(async () => {
    try {
      setRows(await listMyDelegations());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = useCallback(async () => {
    if (!toSubject.trim()) return;
    setBusy(true);
    try {
      await createDelegation({
        toSubject: toSubject.trim(),
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      toast.success(t('delegationCreated'));
      setToSubject('');
      setReason('');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('delegationCreateFailed'));
    } finally {
      setBusy(false);
    }
  }, [toSubject, startsAt, endsAt, reason, refresh, t]);

  const revoke = useCallback(async (d: ApprovalDelegation) => {
    setBusy(true);
    try {
      await revokeDelegation(d.delegationId);
      toast.success(t('delegationRevoked'));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('delegationRevokeFailed'));
    } finally {
      setBusy(false);
    }
  }, [refresh, t]);

  const active = (rows ?? []).filter((d) => !d.revokedAt);

  return (
    <section className="surface-card" aria-labelledby="delegation-heading">
      <h3 id="delegation-heading">{t('delegationHeading')}</h3>
      <p className="muted u-fs-13">{t('delegationLede')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}

      {active.length > 0 ? (
        <ul className="delegation-list">
          {active.map((d) => (
            <li key={d.delegationId} className="delegation-row">
              <span className="chip chip--muted">{d.fromSubject}</span>
              <span aria-hidden="true">→</span>
              <span className="chip">{d.toSubject}</span>
              <span className="muted u-fs-13">
                {formatDateTime(d.startsAt)} – {formatDateTime(d.endsAt)}
                {d.reason ? ` · ${d.reason}` : ''}
              </span>
              <Button variant="secondary" size="sm" className="u-ml-auto" disabled={busy} onClick={() => { void revoke(d); }}>
                {t('delegationRevoke')}
              </Button>
            </li>
          ))}
        </ul>
      ) : rows !== null ? (
        <p className="muted u-fs-13">{t('delegationEmpty')}</p>
      ) : null}

      <div className="delegation-form">
        <UserPicker
          label={t('delegationToLabel')}
          emptyLabel={t('delegationToPlaceholder')}
          value={toSubject}
          onChange={setToSubject}
        />
        <label>
          <span>{t('delegationFromDate')}</span>
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </label>
        <label>
          <span>{t('delegationToDate')}</span>
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>
        <label>
          <span>{t('delegationReasonLabel')}</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('delegationReasonPlaceholder')}
          />
        </label>
        <Button variant="primary" disabled={busy || !toSubject.trim()} onClick={() => { void create(); }}>
          {t('delegationCreateCta')}
        </Button>
      </div>
    </section>
  );
}
