/**
 * Public booking page (ADR 0402 §a) — the unauthed visitor surface at /book/:slug.
 * A live-computed slot picker (day column → time grid), a details form, and a
 * confirmation with an "Add to calendar (.ics)" download + a manage link. Built
 * on the ui/ design system + tokens only (no color literals), theme-aware,
 * mirroring PublicFormRenderer's unauthed-fetch + state-machine shape.
 *
 * Signature: a persistent timezone anchor ("All times shown in <zone>") so the
 * visitor always trusts what they're picking, and a calm single-column flow that
 * commits one decision at a time (pick → details → booked).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { BookingMonthGrid } from './BookingMonthGrid.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { CalendarIcon, ClockIcon, CheckIcon, MapPinIcon } from '../../ui/icons/index.js';
import { TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { getPublicLink, getPublicSlots, claimSlot, type PublicLinkView, type ClaimResult } from './bookingClient.js';

/** The visitor's own IANA zone, or '' when the browser won't say. */
function detectVisitorTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

type Phase = 'loading' | 'unavailable' | 'loadFailed' | 'picking' | 'submitting' | 'done';
function idempotencyKey(): string {
  try { return crypto.randomUUID(); } catch { return `k-${Date.now()}-${Math.floor(Math.random() * 1e9)}`; }
}

function fmtTime(ms: number, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}
function fmtFull(ms: number, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

export function PublicBookingPage({ slug }: { slug: string }): JSX.Element {
  const { t, i18n } = useTranslation('crm');
  const locale = i18n.language;
  const [phase, setPhase] = useState<Phase>('loading');
  const [link, setLink] = useState<PublicLinkView | null>(null);
  const [duration, setDuration] = useState(0);
  const [slotsFailed, setSlotsFailed] = useState(false);
  // Honeypot (server contract `_hp_ref`, forms posture): bots fill it, people
  // never see it; a non-empty value gets a silent 200 and no booking.
  const [honeypot, setHoneypot] = useState('');
  const [selectedDay, setSelectedDay] = useState('');
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState('');
  const [result, setResult] = useState<ClaimResult | null>(null);
  const [idemKey] = useState(idempotencyKey);
  // B-G1 — show times in the VISITOR's zone by default (Calendly's behaviour:
  // detect from the browser and present slots adjusted to the viewer's region),
  // with an explicit switcher back to the host's zone. The slot itself is a UTC
  // instant either way — only the rendering changes — so this can't mis-book.
  const [visitorTz] = useState(detectVisitorTimezone);
  const [tzChoice, setTzChoice] = useState<string>('');
  // Per-field errors, so "check your details" can name WHICH detail.
  const [nameError, setNameError] = useState('');
  const [emailError, setEmailError] = useState('');

  // Move focus to the current step on each transition so keyboard / screen-reader
  // users don't lose their place when the single-page flow swaps content.
  const stepRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) stepRef.current?.focus();
    else mounted.current = true;
  }, [phase, selectedSlot]);

  // Load the link.
  useEffect(() => {
    let live = true;
    getPublicLink(slug)
      .then((l) => { if (!live) return; setLink(l); setDuration(l.durations[0] ?? 30); setPhase('picking'); })
      .catch((e: Error & { status?: number }) => {
        // R2 CRMPUB-3 — only a real 404 claims the link is gone; a network
        // blip or 5xx gets a retryable state instead of "Link not found".
        if (live) setPhase(e.status === 404 || e.status === 410 ? 'unavailable' : 'loadFailed');
      });
    return () => { live = false; };
  }, [slug]);

  // R2 B-G3 — slot reads live in the month grid (one clamped query per visible
  // month), which kills the 62-day truncation: the grid paginates the horizon
  // the way the server's own docblock says the client should. The page keeps
  // only the SELECTED day's slots plus the failure/exhausted flags the grid
  // reports.
  const nowMsRef = useRef(Date.now());
  const [daySlots, setDaySlots] = useState<number[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [gridNonce, setGridNonce] = useState(0);
  const fetchMonth = useCallback(
    async (fromMs: number, toMs: number) => (await getPublicSlots(slug, fromMs, toMs, duration)).slots,
    [slug, duration],
  );
  const onSelectDay = useCallback((key: string, list: number[]) => { setSelectedDay(key); setDaySlots(list); }, []);
  const onSlotsFailed = useCallback(() => setSlotsFailed(true), []);
  const onExhausted = useCallback(() => setExhausted(true), []);
  const resetPicker = (): void => {
    setSelectedDay(''); setDaySlots([]); setSelectedSlot(null); setSlotsFailed(false); setExhausted(false);
    setGridNonce((g) => g + 1); // remounts the grid → fresh cache + a fresh availability jump
  };

  const hostTz = link?.timezone ?? 'UTC';
  // Zones offered: the visitor's (when known and different) and the host's.
  const tzOptions = visitorTz && visitorTz !== hostTz ? [visitorTz, hostTz] : [hostTz];
  const tz = tzChoice && tzOptions.includes(tzChoice) ? tzChoice : tzOptions[0]!;
  const showingHostTz = tz === hostTz;

  const confirm = async (): Promise<void> => {
    if (!link || selectedSlot === null) return;
    setFormError('');
    // B-G2 — say WHICH detail is wrong. One combined "check your details" makes
    // the visitor hunt. The form carries `noValidate` so THESE messages are
    // authoritative: the native constraint bubble fires first otherwise, and it
    // is neither localized to the app's locale nor associated with the field for
    // a screen reader. Same posture as the shared PublicFormRenderer.
    const nErr = name.trim() ? '' : t('bookingPubNameError');
    const eErr = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) ? '' : t('bookingPubEmailError');
    setNameError(nErr);
    setEmailError(eErr);
    if (nErr || eErr) return;
    setPhase('submitting');
    try {
      const res = await claimSlot(slug, { slotStartUtcMs: selectedSlot, durationMin: duration, inviteeName: name.trim(), inviteeEmail: email.trim(), ...(note.trim() ? { inviteeNote: note.trim() } : {}), idempotencyKey: idemKey, _hp_ref: honeypot });
      // Review F9 — a response without the instant (the honeypot's silent 200,
      // reachable by a real human via extension autofill) must not crash the
      // done screen's date formatting; the client knows which slot it asked for.
      setResult({ ...res, slotStartUtcMs: res.slotStartUtcMs ?? selectedSlot });
      setPhase('done');
    } catch (e) {
      // A slot that was just taken → re-fetch availability, back to picking.
      setPhase('picking');
      setSelectedSlot(null);
      const err = e as Error & { status?: number; reason?: string };
      // Review F8 — typed reasons (and any 409) map to LOCALIZED copy; raw
      // server English must not reach a non-English invitee.
      setFormError(err.reason === 'slot_taken' || err.status === 409 ? t('bookingPubGenericError') : t('bookingPubClaimFailed'));
      resetPicker(); // the slot was just taken — re-read availability
    }
  };

  const icsHref = (ics: string): string => `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;

  // ── render ──
  const shell = (children: JSX.Element): JSX.Element => (
    <div ref={stepRef} tabIndex={-1} className="u-mx-auto u-w-full u-p-4 u-maxw-640">{children}</div>
  );

  if (phase === 'loading') return shell(<div className="u-p-2" role="status" aria-live="polite"><Skeleton /></div>);
  if (phase === 'loadFailed') {
    // R2 CRMPUB-3 — a failed read is not a missing link: don't tell the visitor
    // this booking page doesn't exist when our server just hiccuped.
    return shell(
      <StateCard
        icon={<CalendarIcon />}
        announce
        title={t('bookingPubLinkFailedTitle')}
        body={t('bookingPubLinkFailedBody')}
        action={<Button variant="secondary" onClick={() => window.location.reload()}>{t('retry')}</Button>}
      />,
    );
  }
  if (phase === 'unavailable' || !link) {
    return shell(<StateCard icon={<CalendarIcon />} title={t('bookingPubNotFoundTitle')} body={t('bookingPubNotFoundBody')} />);
  }

  if (phase === 'done' && result) {
    return shell(
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <div className="u-flex u-items-center u-gap-2"><span className="chip chip--success"><CheckIcon size={14} /> {t('bookingPubDoneChip')}</span></div>
        <h1 className="u-fs-16 u-m-0">{t('bookingPubDoneTitle', { title: link.title })}</h1>
        <p className="u-m-0"><strong>{fmtFull(result.slotStartUtcMs, tz, locale)}</strong></p>
        <p className="u-m-0 u-fs-12 u-text-muted">{t('bookingPubTimezoneNote', { tz })}</p>
        {result.confirmationEmailed === false ? (
          // R2 CRMPUB2-8 — booked, but the confirmation email could NOT be
          // sent: say so instead of letting the invitee wait for an inbox
          // entry that will never arrive.
          <Notice variant="warning" announce={t('bookingPubConfirmedNoEmail')}>{t('bookingPubConfirmedNoEmail')}</Notice>
        ) : null}
        {/* Booking across zones is where confusion lives: when the visitor is
            reading their OWN zone, also state the host's, so both parties can
            check they mean the same instant. */}
        {!showingHostTz ? (
          <p className="u-m-0 u-fs-12 u-text-muted">{t('bookingPubHostTimeNote', { time: fmtFull(result.slotStartUtcMs, hostTz, locale), tz: hostTz })}</p>
        ) : null}
        <div className="action-bar">
          <a className="btn" href={icsHref(result.icsContent)} download="invite.ics"><CalendarIcon size={14} /> {t('bookingPubAddToCalendar')}</a>
          {result.manageUrl ? <a className="btn secondary" href={result.manageUrl}>{t('bookingPubManage')}</a> : null}
        </div>
      </div>,
    );
  }

  return shell(
    <div className="u-grid u-gap-4">
      <header className="u-grid u-gap-1">
        <h1 className="u-fs-16 u-m-0">{link.title}</h1>
        {link.hostName ? <p className="u-m-0 u-fs-12 u-text-muted">{t('bookingPubHostLine', { name: link.hostName })}</p> : null}
        {link.description ? <p className="u-m-0 u-text-muted">{link.description}</p> : null}
        <div className="action-bar">
          <span className="chip chip--muted"><ClockIcon size={13} /> {t('bookingMinutes', { n: duration })}</span>
          {link.location ? <span className="chip chip--muted"><MapPinIcon size={13} /> {link.location}</span> : null}
          {link.durations.length > 1 ? (
            <select value={duration} onChange={(e) => { setDuration(Number(e.target.value)); resetPicker(); }} className="u-w-auto" aria-label={t('bookingFieldDuration')}>
              {link.durations.map((d) => <option key={d} value={d}>{t('bookingMinutes', { n: d })}</option>)}
            </select>
          ) : null}
        </div>
        {tzOptions.length > 1 ? (
          <SelectField
            label={t('bookingPubTimezoneLabel')}
            help={showingHostTz ? t('bookingPubTimezoneHostNote') : t('bookingPubTimezoneYoursNote')}
            value={tz}
            onChange={(e) => setTzChoice(e.target.value)}
            className="u-w-auto"
          >
            {tzOptions.map((z) => (
              <option key={z} value={z}>{z === visitorTz ? t('bookingPubTimezoneYours', { tz: z }) : t('bookingPubTimezoneHost', { tz: z })}</option>
            ))}
          </SelectField>
        ) : (
          <p className="u-m-0 u-fs-12 u-text-muted">{t('bookingPubTimezoneNote', { tz })}</p>
        )}
      </header>

      {selectedSlot === null ? (
        <>
          {slotsFailed ? (
            <StateCard
              icon={<CalendarIcon />}
              announce
              title={t('bookingPubSlotsFailedTitle')}
              body={t('bookingPubSlotsFailedBody')}
              action={<Button variant="secondary" onClick={resetPicker}>{t('retry')}</Button>}
            />
          ) : exhausted ? (
            <StateCard icon={<CalendarIcon />} title={t('bookingPubNoSlotsTitle')} body={t('bookingPubNoSlotsBody')} />
          ) : (
            <div className="u-grid u-gap-3">
              {/* Day selector — the month grid (R2 B-G3) */}
              <div className="u-grid u-gap-1">
                <span className="u-label-sm" id="book-day-label">{t('bookingPubPickDay')}</span>
                <BookingMonthGrid
                  key={`${duration}:${gridNonce}`}
                  tz={tz} locale={locale} nowMs={nowMsRef.current} maxAdvanceDays={link.maxAdvanceDays}
                  fetchSlots={fetchMonth} onLoadFailed={onSlotsFailed}
                  selectedDay={selectedDay} onSelectDay={onSelectDay} onExhausted={onExhausted}
                />
              </div>
              {/* Time grid */}
              <div className="u-grid u-gap-1">
                <span className="u-label-sm" id="book-time-label">{t('bookingPubPickTime')}</span>
                <div className="action-bar u-flex-wrap" role="group" aria-labelledby="book-time-label">
                  {daySlots.map((ms) => (
                    <Button key={ms} variant="secondary" onClick={() => { setSelectedSlot(ms); setFormError(''); }}>
                      {fmtTime(ms, tz, locale)}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {formError ? <Notice variant="error">{formError}</Notice> : null}
        </>
      ) : (
        <form className="surface-card u-p-4 surface-form u-grid u-gap-3" noValidate onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
          <div className="u-flex u-items-center u-gap-2"><CalendarIcon size={15} /><strong>{fmtFull(selectedSlot, tz, locale)}</strong></div>
          {/* Honeypot — named by the server, invisible to people (forms ADR 0017 posture). */}
          <div className="visually-hidden" aria-hidden="true">
            <input tabIndex={-1} autoComplete="off" name="_hp_ref" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </div>
          <TextField
            label={t('bookingPubName')} required autoComplete="name" value={name}
            onChange={(e) => { setName(e.target.value); if (nameError) setNameError(''); }}
            {...(nameError ? { error: nameError } : {})}
          />
          <TextField
            label={t('bookingPubEmail')} type="email" required autoComplete="email" value={email}
            onChange={(e) => { setEmail(e.target.value); if (emailError) setEmailError(''); }}
            {...(emailError ? { error: emailError } : {})}
          />
          <TextareaField label={t('bookingPubNote')} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          {formError ? <Notice variant="error">{formError}</Notice> : null}
          <div className="action-bar">
            <Button variant="primary" type="submit" disabled={phase === 'submitting'}>{phase === 'submitting' ? t('bookingPubConfirming') : t('bookingPubConfirm')}</Button>
            <Button variant="quiet" onClick={() => { setSelectedSlot(null); setFormError(''); }}>{t('bookingPubBack')}</Button>
          </div>
        </form>
      )}
    </div>,
  );
}
