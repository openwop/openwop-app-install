/**
 * Support queue + ticket detail (ADR 0422 P4). One page: the org queue
 * (DataTable, status filter) with an inline detail panel — thread, reply
 * composer (outbound vs internal note), status control. Agent-drafted replies
 * arrive via the approvals inbox (the P3 lane) — this page is the human's
 * direct surface.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Notice } from '../../ui/Notice.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { LifeBuoyIcon, RotateCwIcon, SendIcon } from '../../ui/icons/index.js';
import { formatDateTime } from '../../i18n/format.js';
import { listOrgs, type Organization } from '../../client/accessClient.js';
import {
  listSupportTickets, getSupportTicket, postTicketMessage, setTicketStatus,
  getIntakeConfig, setIntakeOrg, type Ticket, type IntakeConfig,
} from './serviceDeskClient.js';

const STATUSES = ['open', 'pending', 'waiting_on_customer', 'solved', 'closed'] as const;

const statusTone = (s: Ticket['status']): string =>
  s === 'open' ? 'chip--danger' : s === 'pending' || s === 'waiting_on_customer' ? 'chip--warn' : 'chip--success';

export function SupportPage(): JSX.Element {
  const { t } = useTranslation('service-desk');
  // `.catch(() => setOrgs([]))` left `orgId` '' and `if (!orgId) return` (below)
  // then meant the tickets read never started — so `rows` stayed null and the
  // page showed its skeleton forever. `error` could not save it: it is set only
  // by the tickets read, which is the read that never runs.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Organization>(listOrgs);
  const [rows, setRows] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The tickets read failed — distinct from "this workspace has no tickets". */
  const [rowsFailed, setRowsFailed] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [reply, setReply] = useState('');
  const [replyMode, setReplyMode] = useState<'outbound' | 'internal'>('outbound');
  const [busy, setBusy] = useState(false);
  const [intake, setIntake] = useState<IntakeConfig | null>(null);
  // SD-G1 — `getIntakeConfig` returns null for NOT CONFIGURED and THROWS when the
  // read fails, and both landed in the same `null`. The null branch offers
  // "Enable", a PUT that re-points the tenant's inbound intake at this org — so a
  // transient failure invited an agent to re-route support intake for an org that
  // was already configured. Same shape as the app-builder sync binding.
  const [intakeFailed, setIntakeFailed] = useState(false);
  // SD-G2 — a failed detail read silently keeps the LIST row, whose `messages`
  // are the list projection: the thread then reads as complete when it is not.
  const [threadStale, setThreadStale] = useState(false);


  const load = useCallback(() => {
    if (!orgId) return;
    setRows(null); setError(null); setRowsFailed(false);
    listSupportTickets(orgId, statusFilter || undefined)
      .then(setRows)
      // NOT `setRows([])`: that lands on "No tickets yet — configure intake below
      // or create tickets from WhatsApp, forms, or the API", which then renders
      // BESIDE the error Notice above. An error next to a false claim is still a
      // false claim, and the instruction is the half that reads as the answer.
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setRowsFailed(true); });
    getIntakeConfig(orgId)
      .then((c) => { setIntake(c); setIntakeFailed(false); })
      .catch(() => { setIntake(null); setIntakeFailed(true); });
  }, [orgId, statusFilter]);
  useEffect(() => { load(); }, [load]);

  const open = (ticket: Ticket): void => {
    setSelected(ticket);
    setThreadStale(false);
    // Keeping the row copy on failure is right — an open panel beats a blank one.
    // Claiming it is the full thread is not.
    getSupportTicket(orgId, ticket.ticketId)
      .then((full) => { setSelected(full); setThreadStale(false); })
      .catch(() => setThreadStale(true));
  };

  const send = (): void => {
    if (!selected || !reply.trim()) return;
    setBusy(true);
    postTicketMessage(orgId, selected.ticketId, reply.trim(), replyMode)
      .then((ticket) => { setSelected(ticket); setReply(''); load(); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const changeStatus = (status: string): void => {
    if (!selected) return;
    setTicketStatus(orgId, selected.ticketId, status)
      .then((ticket) => { setSelected(ticket); load(); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const columns: DataColumn<Ticket>[] = [
    { key: 'subject', header: t('colSubject'), render: (r) => <Button variant="link" className="u-text-left" onClick={() => open(r)}>{r.subject}</Button>, sortValue: (r) => r.subject },
    { key: 'status', header: t('colStatus'), render: (r) => <span className={`chip ${statusTone(r.status)}`}>{t(`status_${r.status}`)}</span>, sortValue: (r) => r.status },
    { key: 'priority', header: t('colPriority'), render: (r) => <span className="u-fs-12">{t(`priority_${r.priority}`)}</span>, sortValue: (r) => r.priority },
    { key: 'channel', header: t('colChannel'), render: (r) => <span className="u-fs-12 u-text-muted">{r.channel}</span> },
    { key: 'sla', header: t('colSla'), render: (r) => <span className="u-fs-12 u-text-muted">{r.slaDueAt ? formatDateTime(r.slaDueAt) : '—'}</span>, sortValue: (r) => r.slaDueAt ?? '' },
    { key: 'updated', header: t('colUpdated'), render: (r) => <span className="u-fs-12">{formatDateTime(r.updatedAt)}</span>, sortValue: (r) => r.updatedAt },
  ];

  return (
    <section data-walkthrough="support.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {intakeFailed && rows !== null && (
        // No Enable here: we do not know whether intake is configured, and the
        // button would re-point it. Offer only the read again.
        <Notice variant="warning">
          {t('intakeCheckFailed')}{' '}
          <Button variant="quiet" size="sm" onClick={load}>{t('intakeRecheck')}</Button>
        </Notice>
      )}
      {/* ORG-HON-4 — `orgId` FIRST, and it is not decoration. This Notice sits
          ABOVE the org-state chain below, so it does not inherit that chain's
          protection: its button is a PUT that re-points the tenant's inbound
          support intake at `orgId`, and with no organization selected that is
          `setIntakeOrg('')` — intake re-filed against nothing. It was safe only
          because `rows !== null` happens to be false whenever `orgId` is ''
          (`load()` returns early, so `rows` never leaves its initial `null`).
          That is an argument about a DIFFERENT state variable, and it stops
          holding the moment `rows` is populated for one org and the selection is
          then cleared — `load`'s early return leaves the old `rows` in place, so
          the pair (`rows !== null`, `orgId === ''`) is representable. A write
          this consequential does not get to be safe by luck. */}
      {orgId && !intakeFailed && intake === null && rows !== null && (
        <Notice variant="info">
          {t('intakeUnconfigured')}{' '}
          <Button variant="quiet" size="sm" onClick={() => { void setIntakeOrg(orgId).then(() => load()); }}>{t('intakeEnable')}</Button>
        </Notice>
      )}
      <div className="filterbar action-bar u-wrap u-mb-3">
        {orgs && orgs.length > 1 && (
          <select value={orgId} onChange={(e) => { setSelected(null); setOrgId(e.target.value); }} aria-label={t('ui:orgPickerLabel')}>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
        )}
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t('statusFilterAria')}>
          <option value="">{t('statusAll')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
        </select>
        <Button variant="secondary" size="sm" onClick={load}><RotateCwIcon size={13} /> {t('refresh')}</Button>
      </div>
      {error && <Notice variant="error">{error}</Notice>}
      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children)
          are `OrgSelectionState`'s. Both org states still sit above the loading
          branch: `load()`'s `if (!orgId) return` means the tickets read never
          starts, `rows` stays null, and the skeleton's `role="status"`
          "Loading…" live region would tell a screen-reader user forever that
          work is in progress. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<LifeBuoyIcon size={20} />}>
      {rowsFailed ? (
        <StateCard announce title={t('rowsFailedTitle')} body={t('rowsFailedBody')}
          action={<Button variant="secondary" onClick={() => load()}>{t('orgsRetry')}</Button>} />
      ) : rows === null ? (
        <SkeletonRows rows={5} columns={['30%', '12%', '12%', '12%', '17%', '17%']} />
      ) : rows.length === 0 ? (
        <StateCard icon={<LifeBuoyIcon size={20} />} title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.ticketId} />
      )}
      </OrgSelectionState>

      {selected && (
        <div className="surface-card u-mt-3">
          <div className="action-bar u-wrap">
            <h3 className="u-mt-0 u-mb-0">{selected.subject}</h3>
            <select value={selected.status} onChange={(e) => changeStatus(e.target.value)} aria-label={t('statusChangeAria')}>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
            </select>
            <Button variant="quiet" size="sm" onClick={() => setSelected(null)}>{t('closePanel')}</Button>
          </div>
          {threadStale && (
            <Notice variant="warning" announce={t('threadStale')}>
              {t('threadStale')}{' '}
              <Button variant="quiet" size="sm" onClick={() => open(selected)}>{t('threadRetry')}</Button>
            </Notice>
          )}
          <ol className="u-list-none u-p-0" aria-label={t('threadAria', { subject: selected.subject })}>
            {selected.messages.map((m) => (
              <li key={m.messageId} className={`u-mb-2 ${m.direction === 'inbound' ? '' : 'u-text-right'}`}>
                <div className="u-fs-12 u-text-muted">{m.author} · {formatDateTime(m.at)} · {t(`dir_${m.direction}`)}</div>
                <div className={m.direction === 'internal' ? 'u-text-muted' : ''}>{m.body}</div>
              </li>
            ))}
          </ol>
          <div className="action-bar u-wrap">
            <select value={replyMode} onChange={(e) => setReplyMode(e.target.value === 'internal' ? 'internal' : 'outbound')} aria-label={t('replyModeAria')}>
              <option value="outbound">{t('replyOutbound')}</option>
              <option value="internal">{t('replyInternal')}</option>
            </select>
            {/* ADR 0578 (SD-G4) — a textarea that KEEPS the learned gesture:
                Enter sends (the agent-console convention), Shift+Enter inserts
                a newline, Cmd/Ctrl+Enter also sends, and Enter during IME
                composition NEVER sends (the classic CJK defect this class of
                change usually ships). Auto-grow 1→6 rows via rows+CSS. */}
            <textarea
              className="ui-input u-flex-1 sd-reply-composer"
              rows={1}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={t('replyPlaceholder')}
              aria-label={t('replyAria')}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                if (e.nativeEvent.isComposing) return; // IME guard — composing, not sending
                if (e.shiftKey) return;               // Shift+Enter = newline (the textarea's default)


                e.preventDefault();
                send();
              }}
            />
            <Button variant="primary" size="sm" disabled={busy || !reply.trim()} onClick={send}>
              <SendIcon size={13} /> {busy ? t('sending') : t('send')}
            </Button>
          </div>
          <p className="muted u-fs-11 u-mt-1">{t('replyComposerHint')}</p>
        </div>
      )}
    </section>
  );
}
