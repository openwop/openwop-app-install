/**
 * CRM activity timeline (gap-analysis §5 B1) — the UI over the append-only
 * Activities API (ADR 0008 Phase 2). Quick-log form for the four kinds +
 * newest-first feed. Org-scoped; the parent picks the record filter
 * (companyId / dealId / contactId — scalar props so hook deps stay literal).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../i18n/format.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { MessageSquareIcon } from '../../ui/icons/index.js';
import {
  ACTIVITY_KINDS,
  createActivity,
  listActivities,
  type Activity,
  type ActivityKind,
} from './crmOrgClient.js';
import { crmActionError } from './crmUiHelpers.js';

export function ActivityTimeline({ orgId, dealId, companyId, contactId }: {
  orgId: string;
  dealId?: string;
  companyId?: string;
  contactId?: string;
}): JSX.Element {
  const { t } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const [rows, setRows] = useState<Activity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<ActivityKind>('note');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void listActivities(orgId, {
      ...(dealId ? { dealId } : {}),
      ...(companyId ? { companyId } : {}),
      ...(contactId ? { contactId } : {}),
    })
      .then(setRows)
      .catch((e) => {
        // HIGH-1 — UNKNOWN (`null`), never `[]`. The failure branch below is
        // now checked BEFORE the skeleton branch, so nothing strands; the
        // stale `[]` it replaces rendered "No activities yet" for the whole
        // RETRY request, because `load()` clears `error` synchronously.
        setRows(null);
        setError(crmActionError(e, 'loadFailed'));
      });
  }, [orgId, dealId, companyId, contactId]);
  useEffect(() => { setRows(null); load(); }, [load]);

  const add = useCallback(async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await createActivity(orgId, {
        kind,
        body: body.trim(),
        ...(dealId ? { dealId } : {}),
        ...(companyId ? { companyId } : {}),
        ...(contactId ? { contactId } : {}),
      });
      setBody(''); setKind('note'); load();
      toast.success(t('activityLogged'));
    } catch (e) { toast.error(crmActionError(e, 'addFailed')); } finally { setBusy(false); }
  }, [orgId, kind, body, dealId, companyId, contactId, load, t]);

  const kindLabel = useMemo<Record<ActivityKind, string>>(() => ({
    note: t('activityKindNote'),
    call: t('activityKindCall'),
    email: t('activityKindEmail'),
    meeting: t('activityKindMeeting'),
  }), [t]);

  return (
    <section className="surface-card u-p-4 u-grid u-gap-3" aria-label={t('activityTimelineLabel')}>
      <h2 className="u-fs-14 u-m-0">{t('activityTimelineTitle')}</h2>
      <form className="action-bar" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-iflex u-items-center u-gap-2">
          <span className="u-label-sm">{t('activityKindLabel')}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as ActivityKind)} className="u-w-auto">
            {ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{kindLabel[k]}</option>)}
          </select>
        </label>
        <label className="u-iflex u-items-center u-gap-2 u-flex-1">
          <span className="u-label-sm">{t('activityBodyLabel')}</span>
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('activityBodyPlaceholder')}
          />
        </label>
        <Button type="submit" variant="primary" size="sm" disabled={busy || !body.trim()}>{t('logActivity')}</Button>
      </form>
      {error ? (
        // HIGH-1 — this branch is FIRST: on a failure `rows` is `null`, so a
        // skeleton-first order would hide the failure card behind a spinner
        // that never resolves.
        // CRM-UX-4 — the failure REPLACES the feed (it never co-renders with
        // "No activities yet": that would tell the user both "it broke" and
        // "you have none"). The announced StateCard + Retry is the SignTab.tsx
        // bar; the bare Notice it replaces carried the transport's raw string
        // and left a page reload as the only recovery. The quick-log form above
        // stays usable — a write does not depend on this read.
        <StateCard
          announce
          icon={<MessageSquareIcon />}
          title={tc('loadFailedTitle')}
          body={tc('loadFailedBody')}
          action={<Button variant="secondary" size="sm" onClick={load}>{tc('retry')}</Button>}
        />
      ) : rows === null ? (
        <SkeletonRows rows={3} columns={[80, 320, 120]} />
      ) : rows.length === 0 ? (
        <StateCard icon={<MessageSquareIcon />} title={t('noActivitiesTitle')} body={t('noActivitiesBody')} />
      ) : (
        <ol role="list" className="u-grid u-gap-2 u-m-0 u-p-0 u-list-plain">
          {rows.map((a) => (
            <li key={a.activityId} className="u-grid u-gap-1">
              <div className="action-bar">
                <span className="chip">{kindLabel[a.kind] ?? a.kind}</span>
                <span className="muted u-fs-12">{formatDateTime(a.createdAt)}</span>
              </div>
              <p className="u-m-0">{a.body}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
