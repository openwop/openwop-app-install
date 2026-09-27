/**
 * CRM Booking tab (ADR 0402 §a) — the operator surface: an availability editor +
 * booking-link manager (create / publish / copy public URL / delete) and a
 * per-link bookings table. Public visitor pages live in PublicBookingPage.tsx.
 *
 * Models the ADR 0008 CRUD-tab pattern (TasksTab.tsx): a `.surface-card` create
 * form, a list, `<Notice>`/`<StateCard>`/`DataTable`, `toast`, `confirm`.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { toast } from '../../ui/toast.js';
import { CalendarIcon, ClockIcon, LinkIcon } from '../../ui/icons/index.js';
import {
  listBookingLinks, createBookingLink, updateBookingLink, deleteBookingLink, listBookingsForLink,
  type BookingLink, type Booking, type WeeklyHours,
} from './bookingClient.js';
import { crmActionError, crudErr } from './crmUiHelpers.js';

interface Props { orgId: string }

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]; // Mon-first display order (0 = Sun)
const browserTz = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};

/** Format a UTC-ms instant in a given IANA zone for display. */
function fmtSlot(ms: number, tz: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(ms));
  } catch { return new Date(ms).toISOString(); }
}

export function BookingTab({ orgId }: Props): JSX.Element {
  const { t, i18n } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const [links, setLinks] = useState<BookingLink[] | null>(null);
  const [linksFailed, setLinksFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  // Create-form state. R2 CC-SP-11 — the SAME form doubles as the edit form
  // (updateBookingLink accepted every field all along; the only affordance a
  // typo'd link used to have was Delete).
  const [editingId, setEditingId] = useState('');
  const [title, setTitle] = useState('');
  const [tz, setTz] = useState(browserTz());
  const [days, setDays] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]));
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [duration, setDuration] = useState(30);
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [videoLink, setVideoLink] = useState('');

  const resetForm = (): void => {
    setEditingId(''); setTitle(''); setTz(browserTz());
    setDays(new Set([1, 2, 3, 4, 5])); setStart('09:00'); setEnd('17:00'); setDuration(30);
    setDescription(''); setLocation(''); setVideoLink('');
  };

  // Review F4 — the schedule controls PREFILL with a collapse of the real
  // (possibly per-day / multi-duration) config, so "changed" must mean the
  // USER moved a control since beginEdit, never "differs from the original".
  const editBaseline = useRef<{ days: string; start: string; end: string; duration: number } | null>(null);
  const beginEdit = (link: BookingLink): void => {
    setEditingId(link.bookingLinkId);
    setTitle(link.title);
    setTz(link.timezone);
    const d = new Set(link.weeklyHours.map((w) => w.day));
    const st = link.weeklyHours[0]?.start ?? '09:00';
    const en = link.weeklyHours[0]?.end ?? '17:00';
    const dur = link.durations[0] ?? 30;
    setDays(d); setStart(st); setEnd(en); setDuration(dur);
    editBaseline.current = { days: [...d].sort().join(','), start: st, end: en, duration: dur };
    setDescription(link.description ?? '');
    setLocation(link.location ?? '');
    setVideoLink(link.videoLink ?? '');
  };

  // Selected link → its bookings.
  const [openLinkId, setOpenLinkId] = useState('');
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  // The sharpest case in this sweep: the failure is reported by a TOAST, which
  // disappears after a few seconds, while "No bookings yet — bookings will appear here
  // once someone picks a time" stays on screen indefinitely. The transient tells the
  // truth, the persistent surface tells the operator nobody booked. For a booking
  // system that is a business-consequential false assurance.
  const [bookingsFailed, setBookingsFailed] = useState(false);

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    // The org-gated read, guarded like every sibling tab's (`if (!orgId) return`).
    // HG-4 moved the page's org states into `ui/OrgSelectionState`, which renders
    // its children while the org read is still in flight — so this tab now mounts
    // for a moment with `orgId` ''. Without the guard that is a real request for
    // the booking links of no organization; with it, `links` stays `null` and the
    // skeleton below is the loading affordance, keyed on this tab's own read.
    if (!orgId) return;
    // Review F1 — the org-switch reset alone does NOT close the race: org A's
    // late response (or late FAILURE) could still land under org B's header.
    const seq = ++loadSeq.current;
    setLinksFailed(false);
    try {
      const rows = await listBookingLinks(orgId);
      if (seq === loadSeq.current) setLinks(rows);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      // CRM-UX-14 — the wire string is for the developer; the user gets the
      // canonical failed-read card below (the ReportsTab shape).
      console.warn('[crm] booking links read failed:', e);
      setLinks([]); setLinksFailed(true);
    }
  }, [orgId]);


  // R2 CC-SP-13 — on an org switch the PREVIOUS org's links (and any open
  // bookings panel) stayed rendered under the new org's header until the new
  // fetch resolved — indefinitely if it failed. Contrast TasksTab's reset.
  // Registered BEFORE the load effect: effects run in order, so the reset's
  // seq bump lands before load() captures its own (else mount deadlocks).
  useEffect(() => {
    loadSeq.current++; // invalidate any in-flight previous-org load (review F1)
    openLinkRef.current = ''; // and any in-flight bookings read (review F8)
    setLinks(null); setOpenLinkId(''); setBookings(null); setBookingsFailed(false); resetForm();
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);


  const toggleDay = (d: number): void => {
    setDays((cur) => { const next = new Set(cur); if (next.has(d)) next.delete(d); else next.add(d); return next; });
  };

  const create = async (): Promise<void> => {
    if (!title.trim() || days.size === 0) return;
    setBusy(true);
    try {
      const weeklyHours: WeeklyHours[] = [...days].map((day) => ({ day, start, end }));
      if (editingId) {
        // Review F3 — the backend clears these on EMPTY STRING and preserves
        // them on omission, so an edit must always send them: omitting an
        // emptied field made clearing a silent no-op.
        // Review F4 — the form collapses per-day hours / multi-durations to
        // one uniform shape; send them only when the user actually CHANGED
        // them, so an API-authored varied schedule survives a title edit.
        const base = editBaseline.current;
        const hoursChanged = !base
          || base.days !== [...days].sort().join(',')
          || base.start !== start
          || base.end !== end;
        const durationsChanged = !base || base.duration !== duration;
        const updated = await updateBookingLink(orgId, editingId, {
          title: title.trim(),
          timezone: tz,
          ...(hoursChanged ? { weeklyHours } : {}),
          ...(durationsChanged ? { durations: [duration] } : {}),
          description: description.trim(),
          location: location.trim(),
          videoLink: videoLink.trim(),
        });
        setLinks((cur) => cur?.map((l) => (l.bookingLinkId === editingId ? updated : l)) ?? null);
        toast.success(t('bookingUpdated'));
        resetForm();
      } else {
        const optional = {
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(location.trim() ? { location: location.trim() } : {}),
          ...(videoLink.trim() ? { videoLink: videoLink.trim() } : {}),
        };
        const link = await createBookingLink(orgId, { title: title.trim(), timezone: tz, weeklyHours, durations: [duration], ...optional });
        toast.success(t('bookingCreated'));
        resetForm();
        setLinks((cur) => (cur ? [link, ...cur] : [link]));
      }
    } catch (e) { toast.error(crmActionError(e, 'actionFailed')); }
    finally { setBusy(false); }
  };

  const setStatus = async (link: BookingLink, status: BookingLink['status']): Promise<void> => {
    try {
      const updated = await updateBookingLink(orgId, link.bookingLinkId, { status });
      setLinks((cur) => cur?.map((l) => (l.bookingLinkId === link.bookingLinkId ? updated : l)) ?? null);
      toast.success(status === 'published' ? t('bookingPublished') : t('bookingUnpublished'));
    } catch (e) { crudErr(e); }
  };

  const copyUrl = async (slug: string): Promise<void> => {
    const url = `${window.location.origin}/book/${slug}`;
    try { await navigator.clipboard.writeText(url); toast.success(t('bookingUrlCopied')); }
    catch { toast.error(t('bookingUrlCopyFailed')); }
  };

  const remove = (link: BookingLink): void => {
    void confirm({ title: t('bookingDeleteConfirm', { title: link.title }), danger: true, confirmLabel: t('common:delete') })
      .then((ok) => { if (ok) deleteBookingLink(orgId, link.bookingLinkId).then(load).catch(crudErr); });
  };

  // R2 CC-SP-12 — open link A then B fast: A's slow response must not land in
  // B's panel (the BookingMonthGrid monthKey pattern; last-write-wins before).
  const openLinkRef = useRef('');
  const openBookings = async (link: BookingLink): Promise<void> => {
    if (openLinkId === link.bookingLinkId) { setOpenLinkId(''); openLinkRef.current = ''; return; }
    setOpenLinkId(link.bookingLinkId);
    openLinkRef.current = link.bookingLinkId;
    setBookings(null);
    setBookingsFailed(false);
    try {
      const rows = await listBookingsForLink(orgId, link.bookingLinkId);
      if (openLinkRef.current !== link.bookingLinkId) return; // superseded
      setBookings(rows);
    } catch (e) {
      if (openLinkRef.current !== link.bookingLinkId) return;
      setBookings([]); setBookingsFailed(true); toast.error(crmActionError(e, 'actionFailed'));
    }
  };

  const statusChip = (status: BookingLink['status']): JSX.Element => {
    const cls = status === 'published' ? 'chip chip--success' : status === 'disabled' ? 'chip chip--muted' : 'chip chip--warning';
    return <span className={cls}>{t(`bookingStatus_${status}`)}</span>;
  };

  const bookingColumns: DataColumn<Booking>[] = [
    { key: 'invitee', header: t('bookingColInvitee'), render: (b) => <span>{b.inviteeName}<br /><span className="u-fs-12 u-text-muted">{b.inviteeEmail}</span></span> },
    { key: 'when', header: t('bookingColWhen'), render: (b) => fmtSlot(b.slotStartUtcMs, tz, i18n.language) },
    { key: 'dur', header: t('bookingColDuration'), render: (b) => t('bookingMinutes', { n: b.durationMin }) },
    { key: 'status', header: t('bookingColStatus'), render: (b) => <span className={b.status === 'confirmed' ? 'chip chip--success' : 'chip chip--muted'}>{t(`bookingBookingStatus_${b.status}`)}</span> },
    // R2 CC-SP-4 — the visitor's note was collected on the public page and
    // shown to NO ONE. It is often the whole point of the booking.
    { key: 'note', header: t('bookingColNote'), render: (b) => b.inviteeNote ? <span className="u-fs-12">{b.inviteeNote}</span> : <span className="muted">—</span> },
  ];

  return (
    <div className="u-grid u-gap-4">
      {/* Availability editor + create */}
      <form className="surface-card u-p-4 surface-form u-grid u-gap-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="u-flex u-items-center u-gap-2"><CalendarIcon size={16} /><strong>{editingId ? t('bookingEditTitle', { title }) : t('bookingNewTitle')}</strong></div>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('bookingFieldTitle')}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('bookingTitlePlaceholder')} required />
        </label>
        <div className="u-grid u-gap-1">
          <span className="u-label-sm" id="booking-days-label">{t('bookingFieldDays')}</span>
          <div className="action-bar u-flex-wrap" role="group" aria-labelledby="booking-days-label">
            {WEEKDAYS.map((d) => (
              <button key={d} type="button" className={days.has(d) ? 'chip chip--accent' : 'chip'} aria-pressed={days.has(d)} onClick={() => toggleDay(d)}>
                {t(`bookingWeekday_${d}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="u-flex u-gap-3 u-flex-wrap">
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('bookingFieldStart')}</span>
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('bookingFieldEnd')}</span>
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('bookingFieldDuration')}</span>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="u-w-auto">
              {[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{t('bookingMinutes', { n: m })}</option>)}
            </select></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('bookingFieldTimezone')}</span>
            <input value={tz} onChange={(e) => setTz(e.target.value)} aria-describedby="tz-hint" /></label>
        </div>
        <span id="tz-hint" className="u-fs-12 u-text-muted">{t('bookingTimezoneHint')}</span>
        <div className="u-flex u-gap-3 u-flex-wrap">
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('bookingFieldDescription')}</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('bookingFieldLocation')}</span>
            <input value={location} onChange={(e) => setLocation(e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('bookingFieldVideoLink')}</span>
            <input type="url" value={videoLink} onChange={(e) => setVideoLink(e.target.value)} /></label>
        </div>
        <div className="action-bar">
          <Button variant="primary" type="submit" disabled={busy || !title.trim() || days.size === 0}>{editingId ? t('common:save') : t('bookingCreate')}</Button>
          {editingId ? <Button variant="quiet" type="button" onClick={resetForm}>{t('common:cancel')}</Button> : null}
        </div>
      </form>

      {/* Link manager */}
      {links === null ? <Skeleton /> : linksFailed ? (
        <StateCard
          announce
          icon={<CalendarIcon />}
          title={tc('loadFailedTitle')}
          body={tc('loadFailedBody')}
          action={<Button variant="secondary" onClick={() => void load()}>{tc('retry')}</Button>}
        />
      ) : links.length === 0 ? (
        <StateCard icon={<CalendarIcon />} title={t('bookingEmptyTitle')} body={t('bookingEmptyBody')} />
      ) : (
        <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
          {links.map((link) => (
            <li key={link.bookingLinkId} className="surface-card u-p-4 u-grid u-gap-2">
              <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
                <strong className="u-fs-16">{link.title}</strong>
                {statusChip(link.status)}
                <span className="chip chip--muted"><ClockIcon size={13} /> {link.durations.map((d) => t('bookingMinutes', { n: d })).join(', ')}</span>
              </div>
              <div className="u-fs-12 u-text-muted">/book/{link.slug} · {link.timezone}</div>
              <div className="action-bar">
                {link.status !== 'published'
                  ? <Button variant="secondary" onClick={() => void setStatus(link, 'published')}>{t('bookingPublish')}</Button>
                  : <Button variant="secondary" onClick={() => void setStatus(link, 'disabled')}>{t('bookingUnpublish')}</Button>}
                <Button variant="secondary" disabled={link.status !== 'published'} onClick={() => void copyUrl(link.slug)}>
                  <LinkIcon size={14} /> {t('bookingCopyUrl')}
                </Button>
                <Button variant="quiet" onClick={() => beginEdit(link)} aria-label={t('bookingEditLabel', { title: link.title })}>{t('common:edit')}</Button>
                <Button variant="quiet" onClick={() => void openBookings(link)} aria-expanded={openLinkId === link.bookingLinkId}>
                  {openLinkId === link.bookingLinkId ? t('bookingHideBookings') : t('bookingViewBookings')}
                </Button>
                <Button variant="quiet" onClick={() => remove(link)}>{t('common:delete')}</Button>
              </div>
              {openLinkId === link.bookingLinkId ? (
                <DataTable
                  stack
                  rows={bookings ?? []}
                  rowKey={(b) => b.bookingId}
                  columns={bookingColumns}
                  caption={t('bookingBookingsCaption', { title: link.title })}
                  empty={bookings === null
                    ? <SkeletonRows rows={2} columns={[200, 160, 80, 90]} />
                    : bookingsFailed
                      ? <StateCard announce icon={<CalendarIcon />} title={tc('loadFailedTitle')} body={tc('loadFailedBody')} />
                      : <StateCard icon={<CalendarIcon />} title={t('bookingNoBookingsTitle')} body={t('bookingNoBookingsBody')} />}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
