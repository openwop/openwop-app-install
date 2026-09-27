/**
 * Public booking manage page (ADR 0402 §a) — the unauthed /book/manage/:token
 * surface a booking confirmation links to. Shows the current booking and lets
 * the invitee reschedule (re-pick a slot) or cancel. Authorized purely by
 * possession of the capability token (the commerce-quote public-accept precedent).
 *
 * ROUND 2 (UX_UPGRADE-crm-public XP-R2-0/1) — round 1 skipped this page ("no
 * ranked gap"); inspection graded it C+. This pass:
 * - VISITOR-timezone rendering + switcher (CRMPUB2-1 — round 1's headline B1
 *   fix had stopped at that file's boundary; the reschedule grid, of all
 *   places, still made a Tokyo invitee convert a New York host's times).
 * - The rotated manage token lands in the ADDRESS BAR (history.replaceState) —
 *   refresh/bookmark after a successful reschedule used to say "Booking not
 *   found" (CRMPUB2-2); a failed token mint no longer reloads the revoked one.
 * - The payload is RENDERED: duration, invitee name, location, and the
 *   videoLink whose ONLY visitor surface is this page (CRMPUB2-4), plus
 *   add-to-calendar (.ics) on both the view and the reschedule result
 *   (CRMPUB2-5).
 * - Failed reads are DISCRIMINATED (CRMPUB-3): network/5xx get a retryable
 *   load-failed state; only a real 404 claims the link is dead.
 * - Focus management on phase transitions (the B1 pattern), honest cancel
 *   copy, a rebook link on the cancelled state, and the page's FIRST tests.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { SelectField } from '../../ui/Field.js';
import { BookingMonthGrid } from './BookingMonthGrid.js';
import { confirm } from '../../ui/confirm.js';
import { CalendarIcon, CheckIcon, DownloadIcon } from '../../ui/icons/index.js';
import {
  getManageView, getPublicSlots, cancelBooking as apiCancel, rescheduleBooking as apiReschedule,
  type ManageView,
} from './bookingClient.js';

type Phase = 'loading' | 'unavailable' | 'loadFailed' | 'view' | 'rescheduling' | 'cancelled';

/** The visitor's own IANA zone, or '' when the browser won't say (B1's rule). */
function detectVisitorTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

function fmtTime(ms: number, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}
function fmtFull(ms: number, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

/** Download the booking invite (.ics) — a data: link needs no blob plumbing. */
function icsHref(content: string): string {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(content)}`;
}

export function PublicBookingManagePage({ token: initialToken }: { token: string }): JSX.Element {
  const { t, i18n } = useTranslation('crm');
  const locale = i18n.language;
  const [token, setToken] = useState(initialToken);
  const [phase, setPhase] = useState<Phase>('loading');
  const [view, setView] = useState<ManageView | null>(null);
  const [slotsFailed, setSlotsFailed] = useState(false);
  const [selectedDay, setSelectedDay] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // R3-CP1 — the optional cancellation reason; the label says it is shared.
  const [cancelReason, setCancelReason] = useState('');
  // CRMPUB-6 honesty after a reschedule: undefined = no reschedule yet.
  const [rescheduleEmailed, setRescheduleEmailed] = useState<boolean | undefined>(undefined);
  const [rescheduleIcs, setRescheduleIcs] = useState<string | null>(null);
  // Focus lands on the active step's container per transition (the B1 pattern).
  const stepRef = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    stepRef.current?.focus();
  }, [phase]);

  const loadView = useCallback((tok: string) => {
    setPhase('loading');
    getManageView(tok)
      .then((v) => { setView(v); setPhase(v.status === 'cancelled' ? 'cancelled' : 'view'); })
      .catch((e: Error & { status?: number }) => {
        // CRMPUB-3 — only a REAL 404 claims the link is dead; a network blip or
        // 5xx gets a retryable state instead of "ask for a new link".
        setPhase(e.status === 404 || e.status === 410 ? 'unavailable' : 'loadFailed');
      });
  }, []);

  // Review F6 — a token adopted from a successful reschedule must not trigger
  // a re-read (the success is already on screen); armed once, per adoption.
  const skipReload = useRef(false);
  useEffect(() => {
    if (skipReload.current) { skipReload.current = false; return; }
    loadView(token);
  }, [token, loadView]);

  // CRMPUB2-1 — the visitor's zone by default; the host's zone offered as the
  // alternative (B1's exact contract: a slot is a UTC instant, only its
  // RENDERING changes; the switcher appears only when there is a choice).
  const visitorTz = useMemo(detectVisitorTimezone, []);
  const hostTz = view?.timezone ?? 'UTC';
  const [tz, setTz] = useState('');
  useEffect(() => { setTz(visitorTz || hostTz); }, [visitorTz, hostTz]);
  const effectiveTz = tz || hostTz;
  const tzChoices = useMemo(
    () => [...new Set([visitorTz, hostTz].filter(Boolean))],
    [visitorTz, hostTz],
  );
  const showingHostTz = effectiveTz === hostTz;

  // R2 B-G3 — slot reads live in the month grid (one clamped query per visible
  // month, CRMPUB2-14: the LINK's horizon, paginated — no hardcoded 60, no
  // 62-day truncation). The page keeps the selected day's slots + flags.
  const nowMsRef = useRef(Date.now());
  const [daySlots, setDaySlots] = useState<number[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [gridNonce, setGridNonce] = useState(0);
  const fetchMonth = useCallback(
    async (fromMs: number, toMs: number) => {
      if (!view) return [];
      return (await getPublicSlots(view.slug, fromMs, toMs, view.durationMin)).slots;
    },
    [view],
  );
  const onSelectDay = useCallback((key: string, list: number[]) => { setSelectedDay(key); setDaySlots(list); }, []);
  const onSlotsFailed = useCallback(() => setSlotsFailed(true), []);
  const onExhausted = useCallback(() => setExhausted(true), []);

  const startReschedule = (): void => {
    if (!view) return;
    setPhase('rescheduling');
    setError('');
    setSelectedDay(''); setDaySlots([]); setSlotsFailed(false); setExhausted(false);
    setGridNonce((g) => g + 1); // fresh grid cache + a fresh availability jump
  };

  const doReschedule = async (ms: number): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const res = await apiReschedule(token, ms);
      setRescheduleEmailed(res.confirmationEmailed);
      setRescheduleIcs(res.icsContent ?? null);
      const newTok = res.manageUrl ? /\/([^/?#]+)(?:[?#].*)?$/.exec(res.manageUrl)?.[1] : undefined;
      if (newTok) {
        // CRMPUB2-2 — the rotated token must land in the ADDRESS BAR: the old
        // token is revoked by the reschedule, so a refresh (or the originally
        // emailed link) would otherwise claim the booking doesn't exist.
        try { window.history.replaceState(null, '', window.location.pathname.replace(/[^/]+$/, encodeURIComponent(newTok)) + window.location.search + window.location.hash); } catch { /* best-effort */ }
        // Review F6 — do NOT re-read the fresh token to show the success: a
        // failing read would bury a money-adjacent success under "Booking not
        // found". The response already carries the truth; adopt the token for
        // future actions and render from what we have.
        skipReload.current = true;
        setToken(newTok);
      }
      setView((v) => (v ? { ...v, slotStartUtcMs: ms, ...(res.icsContent ? { icsContent: res.icsContent } : {}) } : v));
      setPhase('view');
    } catch (e) {
      const err = e as Error & { status?: number; reason?: string };
      setError(
        err.reason === 'slot_taken' ? t('bookingPubGenericError')
          : err.reason === 'cancelled_booking' ? t('bookingPubErrCancelled')
          : err.reason === 'same_slot' ? t('bookingPubErrSameSlot')
          : t('bookingPubRescheduleFailed'),
      );
      setPhase('view');
    } finally { setBusy(false); }
  };

  const doCancel = async (): Promise<void> => {
    if (!view) return;
    const ok = await confirm({ title: t('bookingPubCancelConfirm', { title: view.title }), danger: true, confirmLabel: t('bookingPubCancel') });
    if (!ok) return;
    setBusy(true);
    setError('');
    // Additive at EVERY layer: an untouched reason makes this call
    // byte-identical to pre-R3 (one argument), which is what the existing
    // pins assert — they were right, and the first cut broke them by always
    // passing a second ''-argument.
    try { const r = cancelReason.trim(); await (r ? apiCancel(token, r) : apiCancel(token)); setPhase('cancelled'); setView((v) => (v ? { ...v, status: 'cancelled' } : v)); }
    catch { setError(t('bookingPubCancelError')); }
    finally { setBusy(false); }
  };

  const shell = (children: JSX.Element): JSX.Element => (
    <div className="u-mx-auto u-w-full u-p-4 u-maxw-560" ref={stepRef} tabIndex={-1}>{children}</div>
  );

  if (phase === 'loading') return shell(<div className="u-p-2" role="status" aria-live="polite"><Skeleton /></div>);
  if (phase === 'loadFailed') {
    return shell(
      <StateCard
        icon={<CalendarIcon />} title={t('bookingPubLoadFailedTitle')} body={t('bookingPubLoadFailedBody')} announce
        action={<Button variant="secondary" onClick={() => loadView(token)}>{t('common:retry')}</Button>}
      />,
    );
  }
  if (phase === 'unavailable' || !view) {
    return shell(<StateCard icon={<CalendarIcon />} title={t('bookingPubManageNotFoundTitle')} body={t('bookingPubManageNotFoundBody')} />);
  }
  if (phase === 'cancelled') {
    return shell(
      <StateCard
        icon={<CalendarIcon />} title={t('bookingPubCancelledTitle')} body={t('bookingPubCancelledBody', { title: view.title })} announce
        action={<a className="btn secondary" href={`/book/${encodeURIComponent(view.slug)}`}>{t('bookingPubRebook')}</a>}
      />,
    );
  }

  const tzSwitcher = tzChoices.length > 1 ? (
    <SelectField
      label={t('bookingPubTimezoneLabel')}
      help={showingHostTz ? t('bookingPubTimezoneHostNote') : t('bookingPubTimezoneYoursNote')}
      value={effectiveTz}
      onChange={(e) => setTz(e.target.value)}
      className="u-w-auto"
    >
      {tzChoices.map((z) => (
        <option key={z} value={z}>{z === visitorTz ? t('bookingPubTimezoneYours', { tz: z }) : t('bookingPubTimezoneHost', { tz: z })}</option>
      ))}
    </SelectField>
  ) : (
    <p className="u-m-0 u-fs-12 u-text-muted">{t('bookingPubTimezoneNote', { tz: effectiveTz })}</p>
  );

  if (phase === 'rescheduling') {
    return shell(
      <div className="u-grid u-gap-4">
        <header className="u-grid u-gap-1">
          <h1 className="u-fs-16 u-m-0">{t('bookingPubRescheduleTitle', { title: view.title })}</h1>
          {tzSwitcher}
        </header>
        {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
        {slotsFailed ? (
          <StateCard
            icon={<CalendarIcon />} title={t('bookingPubSlotsFailedTitle')} body={t('bookingPubSlotsFailedBody')} announce
            action={<Button variant="secondary" onClick={startReschedule}>{t('common:retry')}</Button>}
          />
        ) : exhausted ? (
          <StateCard icon={<CalendarIcon />} title={t('bookingPubNoSlotsTitle')} body={t('bookingPubNoSlotsBody')} />
        ) : (
          <div className="u-grid u-gap-3">
            <div className="u-grid u-gap-1">
              <span className="u-label-sm" id="resched-day-label">{t('bookingPubPickDay')}</span>
              <BookingMonthGrid
                key={gridNonce}
                tz={effectiveTz} locale={locale} nowMs={nowMsRef.current} maxAdvanceDays={view.maxAdvanceDays ?? 60}
                fetchSlots={fetchMonth} onLoadFailed={onSlotsFailed}
                selectedDay={selectedDay} onSelectDay={onSelectDay} onExhausted={onExhausted}
              />
            </div>
            <div className="u-grid u-gap-1">
              <span className="u-label-sm" id="resched-time-label">{t('bookingPubPickTime')}</span>
              <div className="action-bar u-flex-wrap" role="group" aria-labelledby="resched-time-label">
                {daySlots.map((ms) => (
                  <Button key={ms} variant="secondary" disabled={busy} onClick={() => void doReschedule(ms)}>
                    {fmtTime(ms, effectiveTz, locale)}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}
        <div><Button variant="quiet" onClick={() => setPhase('view')}>{t('bookingPubBack')}</Button></div>
      </div>,
    );
  }

  // phase === 'view'
  const currentIcs = rescheduleIcs ?? view.icsContent ?? null;
  return shell(
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <div className="u-flex u-items-center u-gap-2"><span className="chip chip--success"><CheckIcon size={14} /> {t('bookingPubConfirmedChip')}</span></div>
      <h1 className="u-fs-16 u-m-0">{view.title}</h1>
      <p className="u-m-0"><strong>{fmtFull(view.slotStartUtcMs, effectiveTz, locale)}</strong></p>
      {/* Cross-zone honesty (the B1 contract): when reading YOUR zone, the
          host's rendering of the same instant is stated too. */}
      {!showingHostTz ? <p className="u-m-0 u-fs-12 u-text-muted">{t('bookingPubHostTimeNote', { time: fmtFull(view.slotStartUtcMs, hostTz, locale), tz: hostTz })}</p> : null}
      {tzSwitcher}
      {/* CRMPUB2-4 — the payload, rendered: who/how long/where, and the video
          link whose ONLY visitor surface is this page. */}
      <dl className="u-m-0 u-grid u-gap-1 booking-manage__facts">
        <div><dt className="u-label-sm muted">{t('bookingPubFactName')}</dt><dd className="u-m-0">{view.inviteeName}</dd></div>
        <div><dt className="u-label-sm muted">{t('bookingPubFactDuration')}</dt><dd className="u-m-0">{t('bookingPubFactMinutes', { n: view.durationMin })}</dd></div>
        {view.location ? <div><dt className="u-label-sm muted">{t('bookingPubFactLocation')}</dt><dd className="u-m-0">{view.location}</dd></div> : null}
        {view.videoLink ? (
          <div><dt className="u-label-sm muted">{t('bookingPubFactVideo')}</dt>
            <dd className="u-m-0"><a href={view.videoLink} rel="noopener noreferrer">{view.videoLink}</a></dd></div>
        ) : null}
      </dl>
      {rescheduleEmailed === false ? (
        // CRMPUB-6 — confirmed, but we could NOT email the new invite: say so
        // instead of implying delivery.
        <Notice variant="warning" announce={t('bookingPubRescheduledNoEmail')}>{t('bookingPubRescheduledNoEmail')}</Notice>
      ) : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {/* R3-CP1 — the catalog's manage-page convention: an OPTIONAL free-text
          reason. The label states plainly that it is shared with the host —
          the visitor consents by typing, never by surprise. Empty ⇒ nothing
          rides the wire and the host's note is byte-identical to before. */}
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('bookingPubCancelReasonLabel')}</span>
        <textarea
          rows={2}
          maxLength={500}
          value={cancelReason}
          disabled={busy}
          onChange={(e) => setCancelReason(e.target.value)}
          placeholder={t('bookingPubCancelReasonPlaceholder')}
        />
      </label>
      <div className="action-bar">
        {currentIcs ? (
          <a className="btn secondary" href={icsHref(currentIcs)} download="invite.ics">
            <DownloadIcon size={14} /> {t('bookingPubAddToCalendar')}
          </a>
        ) : null}
        <Button variant="secondary" disabled={busy} onClick={startReschedule}>{t('bookingPubReschedule')}</Button>
        <Button variant="quiet" disabled={busy} onClick={() => void doCancel()}>{t('bookingPubCancel')}</Button>
      </div>
    </div>,
  );
}
