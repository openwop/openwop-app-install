/**
 * Support queue + ticket detail (ADR 0422 P4). One page: the org queue
 * (DataTable, views + status filter) with an inline detail panel — thread,
 * reply composer (outbound vs internal note), status, priority and assignee.
 * Agent-drafted replies arrive via the approvals inbox (the P3 lane) — this page
 * is the human's direct surface.
 *
 * ADR 0878 D7 — every outbound reply shows what happened to it (delivered, not
 * sent and why, failed with Retry). Before ADR 0878 a reply was stored and sent
 * nowhere while the thread read as answered; the composer now says up front when
 * a ticket has no reply channel, instead of after.
 */
import { ChatPocket } from '../../chat/ChatPocket.js';
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Notice } from '../../ui/Notice.js';
import { Menu } from '../../ui/Menu.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { LifeBuoyIcon, RotateCwIcon, SendIcon } from '../../ui/icons/index.js';
import { formatDateTime } from '../../i18n/format.js';
import { announce } from '../../ui/announce.js';
import { listOrgs, type Organization } from '../../client/accessClient.js';
import {
  listSupportTickets, getSupportTicket, postTicketMessage, setTicketStatus, setTicketPriority,
  assignTicket, listAssignees, retryDelivery, getIntakeConfig, setIntakeOrg,
  type Ticket, type TicketDetail, type IntakeStatus, type Delivery, type QueueView, type Assignee,
} from './serviceDeskClient.js';

const STATUSES = ['open', 'pending', 'waiting_on_customer', 'solved', 'closed'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const VIEWS: readonly QueueView[] = ['all', 'mine', 'unassigned', 'overdue'];

const statusTone = (s: Ticket['status']): string =>
  s === 'open' ? 'chip--danger' : s === 'pending' || s === 'waiting_on_customer' ? 'chip--warning' : 'chip--success';

const isSettled = (t: Pick<Ticket, 'status'>): boolean => t.status === 'solved' || t.status === 'closed';
const isOverdue = (t: Pick<Ticket, 'status' | 'slaDueAt'>, now: number): boolean =>
  !!t.slaDueAt && !isSettled(t) && Date.parse(t.slaDueAt) <= now;

const deliveryTone = (d: Delivery): string =>
  d.state === 'sent' || d.state === 'visible' ? 'chip--success'
    : d.state === 'failed' ? 'chip--danger'
      : 'chip--warning';

/** Failures a retry cannot fix (grade-ux SD2UX-10): the customer has not opted
 *  in, the 24-hour window closed, the number was erased. Offering Retry for them
 *  promises an outcome the send cannot produce. A connection or toggle problem IS
 *  fixable, after which Retry works. */
const UNRETRYABLE = new Set(['consent_denied', 'opted_out', 'subject_erased', 'outside_window', 'no_recipient', 'no_reply_channel']);
const canRetry = (d: Delivery): boolean =>
  d.state === 'unknown' || (d.state === 'failed' && !UNRETRYABLE.has(d.code ?? ''));

/** The ticket (and its org) a deep link — `/support?org=…&ticket=…`, from the
 *  assignment + SLA notifications — asks for, read once at mount. */
function deepLink(): { ticket: string | null; org: string } {
  try {
    const q = new URLSearchParams(window.location.search);
    return { ticket: q.get('ticket'), org: q.get('org') ?? '' };
  } catch { return { ticket: null, org: '' }; }
}

export function SupportPage(): JSX.Element {
  const { t } = useTranslation('service-desk');
  // `.catch(() => setOrgs([]))` left `orgId` '' and `if (!orgId) return` (below)
  // then meant the tickets read never started — so `rows` stayed null and the
  // page showed its skeleton forever. `error` could not save it: it is set only
  // by the tickets read, which is the read that never runs.
  const [link] = useState(deepLink);
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Organization>(listOrgs, true, link.org);
  const [rows, setRows] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The tickets read failed — distinct from "this workspace has no tickets". */
  const [rowsFailed, setRowsFailed] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [view, setView] = useState<QueueView>('all');
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [me, setMe] = useState<string[]>([]);
  const [pendingDeepLink, setPendingDeepLink] = useState<string | null>(link.ticket);
  const [deepLinkMissed, setDeepLinkMissed] = useState(false);
  /** One in-flight ticket write at a time (grade-ux SD2UX-14): a double-clicked
   *  Retry used to 409, and a button vanishing mid-click dropped focus. */
  const [acting, setActing] = useState(false);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const openedFrom = useRef<HTMLElement | null>(null);
  const [reply, setReply] = useState('');
  const [replyMode, setReplyMode] = useState<'outbound' | 'internal'>('outbound');
  const [busy, setBusy] = useState(false);
  const [intake, setIntake] = useState<IntakeStatus | null>(null);
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
    listSupportTickets(orgId, statusFilter || undefined, view)
      .then(setRows)
      // NOT `setRows([])`: that lands on "No tickets yet — configure intake below
      // or create tickets from WhatsApp, forms, or the API", which then renders
      // BESIDE the error Notice above. An error next to a false claim is still a
      // false claim, and the instruction is the half that reads as the answer.
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setRowsFailed(true); });
    getIntakeConfig(orgId)
      .then((c) => { setIntake(c); setIntakeFailed(false); })
      .catch(() => { setIntake(null); setIntakeFailed(true); });
    // The assignee picker is enrichment: a failed read leaves the picker empty
    // (assignment by "Assign to me" still works), never blocks the queue.
    listAssignees(orgId)
      .then((a) => { setAssignees(a.assignees); setMe(a.me); })
      .catch(() => { setAssignees([]); setMe([]); });
  }, [orgId, statusFilter, view]);
  useEffect(() => { load(); }, [load]);

  const open = (ticket: Ticket): void => {
    // Focus follows the panel (grade-ux SD2UX-4): it renders below the whole queue,
    // so on a long list it opened off-screen with focus still on the row.
    openedFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelected(ticket);
    setThreadStale(false);
    // Keeping the row copy on failure is right — an open panel beats a blank one.
    // Claiming it is the full thread is not.
    getSupportTicket(orgId, ticket.ticketId)
      .then((full) => { setSelected(full); setThreadStale(false); })
      .catch(() => setThreadStale(true));
  };

  // A deep link opens its ticket once the queue that holds it has loaded.
  useEffect(() => {
    if (!pendingDeepLink || !rows || !orgId) return;
    const row = rows.find((r) => r.ticketId === pendingDeepLink);
    setPendingDeepLink(null);
    if (row) open(row);
    else setDeepLinkMissed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` is recreated every render; this fires once per deep link
  }, [pendingDeepLink, rows, orgId]);

  // The panel takes focus when a ticket opens, and gives it back when it closes.
  const openId = selected?.ticketId;
  useEffect(() => {
    if (!openId) return;
    panelHeading.current?.focus();
    panelHeading.current?.scrollIntoView?.({ block: 'nearest' });
  }, [openId]);
  const closePanel = (): void => {
    setSelected(null);
    const back = openedFrom.current;
    if (back && back.isConnected) back.focus();
  };

  /** Say what happened to a reply out loud (grade-ux SD2UX-3) — the badge alone is
   *  visual, and a failed send is exactly what a screen-reader user must not miss. */
  const announceDelivery = (d: Delivery | undefined): void => {
    if (!d) return;
    const reason = d.code ? ` ${t(`deliveryCode_${d.code}`, { defaultValue: d.message ?? '' })}` : '';
    announce(`${t(`delivery_${d.state}`)}.${reason}`, { assertive: d.state === 'failed' || d.state === 'not_sent' });
  };

  const send = (): void => {
    if (!selected || !reply.trim()) return;
    setBusy(true);
    // One key per composed message: a network retry of THIS send lands once.
    const key = `${selected.ticketId}:${Date.now()}`;
    postTicketMessage(orgId, selected.ticketId, reply.trim(), replyMode, key)
      .then((ticket) => {
        setSelected(ticket); setReply(''); load();
        if (replyMode === 'outbound') {
          const last = [...ticket.messages].reverse().find((m) => m.direction === 'outbound');
          announceDelivery(last ? ticket.deliveries?.[last.messageId] : undefined);
        } else {
          announce(t('noteSaved'));
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // Writes that return the ticket without its deliveries keep the ones we hold.
  const keepDeliveries = (ticket: Ticket): void => setSelected((cur) => ({ ...ticket, deliveries: cur?.deliveries ?? {} }));

  /** Run one ticket write: busy while in flight, the error inside the panel. */
  const act = (run: () => Promise<void>): void => {
    if (acting) return;
    setActing(true);
    run()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setActing(false));
  };

  const changeStatus = (status: string): void => {
    if (!selected) return;
    act(() => setTicketStatus(orgId, selected.ticketId, status).then((ticket) => { keepDeliveries(ticket); load(); }));
  };

  const changePriority = (priority: Ticket['priority']): void => {
    if (!selected) return;
    act(() => setTicketPriority(orgId, selected.ticketId, priority).then((ticket) => { keepDeliveries(ticket); load(); }));
  };

  const assign = (to: { subject: string } | 'self' | null): void => {
    if (!selected) return;
    act(() => assignTicket(orgId, selected.ticketId, to).then((ticket) => {
      keepDeliveries(ticket); load();
      announce(t('assignedTo', { name: assigneeName(ticket.assigneeMemberId) }));
    }));
  };

  const retry = (messageId: string): void => {
    if (!selected) return;
    act(() => retryDelivery(orgId, selected.ticketId, messageId).then((deliveries) => {
      setSelected((cur) => (cur ? { ...cur, deliveries } : cur));
      announceDelivery(deliveries[messageId]);
    }));
  };

  const assigneeName = (subject: string | undefined): string => {
    if (!subject) return t('unassigned');
    if (me.includes(subject)) return t('assigneeYou');
    return assignees.find((a) => a.subject === subject)?.displayName ?? subject;
  };

  const now = Date.now();

  const columns: DataColumn<Ticket>[] = [
    { key: 'subject', header: t('colSubject'), render: (r) => <Button variant="link" className="u-text-left" onClick={() => open(r)}>{r.subject}</Button>, sortValue: (r) => r.subject },
    { key: 'status', header: t('colStatus'), render: (r) => <span className={`chip ${statusTone(r.status)}`}>{t(`status_${r.status}`)}</span>, sortValue: (r) => r.status },
    { key: 'priority', header: t('colPriority'), render: (r) => <span className="u-fs-12">{t(`priority_${r.priority}`)}</span>, sortValue: (r) => r.priority },
    { key: 'channel', header: t('colChannel'), render: (r) => <span className="u-fs-12 u-text-muted">{t(`channel_${r.channel}`, { defaultValue: r.channel })}</span> },
    { key: 'assignee', header: t('colAssignee'), render: (r) => <span className={`u-fs-12${r.assigneeMemberId ? '' : ' u-text-muted'}`}>{assigneeName(r.assigneeMemberId)}</span>, sortValue: (r) => r.assigneeMemberId ?? '' },
    {
      key: 'sla', header: t('colSla'), sortValue: (r) => r.slaDueAt ?? '',
      render: (r) => isOverdue(r, now)
        ? <span className="chip chip--danger">{t('overdue')}</span>
        : <span className="u-fs-12 u-text-muted">{r.slaDueAt && !isSettled(r) ? formatDateTime(r.slaDueAt) : '—'}</span>,
    },
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
      {orgId && !intakeFailed && intake !== null && !intake.configured && rows !== null && (
        <Notice variant="info">
          {t('intakeUnconfigured')}{' '}
          <Button variant="quiet" size="sm" onClick={() => { void setIntakeOrg(orgId).then(() => load()).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }}>{t('intakeEnable')}</Button>
        </Notice>
      )}
      {/* ADR 0878 D2 — configured for ANOTHER organization: say so, and offer no
          takeover (moving intake is a workspace-admin act, done from that org). */}
      {orgId && !intakeFailed && intake?.configured && !intake.here && rows !== null && (
        <Notice variant="info">{t('intakeElsewhere')}</Notice>
      )}
      <div className="filterbar action-bar u-wrap u-mb-3">
        <div className="segmented" role="group" aria-label={t('viewsAria')}>
          {VIEWS.map((v) => (
            <Button key={v} variant="primary" aria-pressed={view === v} onClick={() => { setSelected(null); setView(v); }}>{t(`view_${v}`)}</Button>
          ))}
        </div>
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
      {error && <Notice variant="error" announce={error}>{error}</Notice>}
      {deepLinkMissed && (
        <Notice variant="info">
          {t('deepLinkMissed')}{' '}
          <Button variant="quiet" size="sm" onClick={() => setDeepLinkMissed(false)}>{t('dismiss')}</Button>
        </Notice>
      )}
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
        view === 'all' && !statusFilter
          ? <StateCard icon={<LifeBuoyIcon size={20} />} title={t('emptyTitle')} body={t('emptyBody')} />
          : <StateCard icon={<LifeBuoyIcon size={20} />} title={t('emptyViewTitle')} body={t(`emptyView_${view}`)} />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.ticketId} />
      )}
      </OrgSelectionState>

      {selected && (
        <div className="surface-card u-mt-3">
          <div className="action-bar u-wrap">
            <h2 className="u-mt-0 u-mb-0" ref={panelHeading} tabIndex={-1}>{selected.subject}</h2>
            <select value={selected.status} disabled={acting} onChange={(e) => changeStatus(e.target.value)} aria-label={t('statusChangeAria')}>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
            </select>
            <select value={selected.priority} disabled={acting} onChange={(e) => changePriority(e.target.value as Ticket['priority'])} aria-label={t('priorityChangeAria')}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{t(`priority_${p}`)}</option>)}
            </select>
            {isOverdue(selected, now) && <span className="chip chip--danger">{t('overdue')}</span>}
            <Button variant="quiet" size="sm" onClick={closePanel}>{t('closePanel')}</Button>
          </div>
          <div className="action-bar u-wrap u-fs-12 u-text-muted">
            <span>{t(`channel_${selected.channel}`, { defaultValue: selected.channel })}</span>
            {selected.requester?.phone && <span>· {selected.requester.phone}</span>}
            {selected.requester?.email && <span>· {selected.requester.email}</span>}
            <span>·</span>
            {/* A menu, not a <select> (grade-ux SD2UX-7): assignment notifies the
                assignee, and arrowing through a closed <select> commits every option
                it passes on some platforms — one keyboard sweep would assign (and
                notify) each person in turn. A menu commits only on choice. */}
            <Menu
              label={t('assigneeChangeAria')}
              triggerContent={<>{t('colAssignee')}: {assigneeName(selected.assigneeMemberId)}</>}
              triggerClassName="btn btn-ghost btn-sm"
              align="start"
              portal
              disabled={acting}
              items={[
                { id: 'none', label: t('unassigned'), onSelect: () => assign(null), disabled: !selected.assigneeMemberId },
                ...assignees.map((a) => ({
                  id: a.subject,
                  label: me.includes(a.subject) ? t('assigneeYou') : a.displayName,
                  onSelect: () => assign({ subject: a.subject }),
                  disabled: a.subject === selected.assigneeMemberId,
                })),
              ]}
            />
            {!(selected.assigneeMemberId && me.includes(selected.assigneeMemberId)) && (
              <Button variant="quiet" size="sm" disabled={acting} onClick={() => assign('self')}>{t('assignToMe')}</Button>
            )}
          </div>
          {threadStale && (
            <Notice variant="warning" announce={t('threadStale')}>
              {t('threadStale')}{' '}
              <Button variant="quiet" size="sm" onClick={() => open(selected)}>{t('threadRetry')}</Button>
            </Notice>
          )}
          <ol className="u-list-none u-p-0" aria-label={t('threadAria', { subject: selected.subject })}>
            {selected.messages.map((m) => {
              const d = m.direction === 'outbound' ? selected.deliveries?.[m.messageId] : undefined;
              return (
                <li key={m.messageId} className={`u-mb-2 ${m.direction === 'inbound' ? '' : 'u-text-right'}`}>
                  <div className="u-fs-12 u-text-muted">{m.author} · {formatDateTime(m.at)} · {t(`dir_${m.direction}`)}</div>
                  <div className={`u-prewrap${m.direction === 'internal' ? ' u-text-muted' : ''}`}>{m.body}</div>
                  {m.direction === 'outbound' && !d && (
                    // A reply with no delivery record (written before ADR 0878, or a
                    // send that never claimed) must not read as sent (SD2UX-9).
                    <div className="u-fs-12 u-mt-1"><span className="chip">{t('delivery_none')}</span></div>
                  )}
                  {d && (
                    <div className="u-fs-12 u-mt-1">
                      <span className={`chip ${deliveryTone(d)}`}>{t(`delivery_${d.state}`)}</span>
                      {d.code && <span className="u-text-muted">: {t(`deliveryCode_${d.code}`, { defaultValue: d.message ?? '' })}</span>}
                      {canRetry(d) && (
                        <>{' '}<Button variant="quiet" size="sm" disabled={acting} onClick={() => retry(m.messageId)}>{t('deliveryRetry')}</Button></>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="action-bar u-wrap">
            <select value={replyMode} onChange={(e) => setReplyMode(e.target.value === 'internal' ? 'internal' : 'outbound')} aria-label={t('replyModeAria')}>
              <option value="outbound">{t(selected.replyChannel ? `replyOutbound_${selected.replyChannel.kind}` : 'replyOutboundNone')}</option>
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
              <SendIcon size={13} /> {busy ? t('sending') : replyMode === 'outbound' && !selected.replyChannel ? t('saveReply') : t('send')}
            </Button>
          </div>
          <p className="muted u-fs-11 u-mt-1">
            {replyMode === 'outbound' && !selected.replyChannel ? `${t('replyNoChannelHint')} ` : ''}{t('replyComposerHint')}
          </p>
        </div>
      )}
      {/* ADR 0768 D5 — the feature's assistant in a Pocket. Honest scope: the agent's
          tools read every org the caller can read, not only the one on screen. */}
      <ChatPocket
        agentId="vendor.openwop-app.service-desk.agents.support"
        title={t('pocketTitle')}
        contextLabel={t('pocketScope')}
        renderEmptyState={() => <p className="chat-pocket__hint">{t('pocketHint')}</p>}
      />
    </section>
  );
}
