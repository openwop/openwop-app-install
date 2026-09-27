/**
 * BookingMonthGrid (R2 B-G3 / CRMPUB1-11, UX_UPGRADE-crm-public XP-R2-4) — the
 * month-calendar day picker shared by the public booking page and the manage
 * page's reschedule step.
 *
 * Why a grid: the day-chip row rendered one chip per available day — a 60-day
 * window is a 60-chip wrap wall (the round-1 deferral; the market floor is a
 * month grid). Why it owns the fetching: the server caps a slots query at 62
 * days for CPU-DoS reasons and its docblock says "the client paginates for
 * longer horizons" — this component is that pagination (one clamped query per
 * visible month, cached), so a >62-day link stops silently truncating.
 *
 * Contract: a day is bookable iff the server returned slots for it (the server
 * already applies the from=now floor and the link's horizon, so absence IS the
 * greying — no client-side second guess). When the visible month has no
 * bookable day, the grid auto-advances toward the horizon once per mount until
 * it finds availability ("jump to first availability"), stopping the moment
 * the visitor navigates by hand.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '../../ui/Skeleton.js';
import { ChevronLeftIcon, ChevronRightIcon } from '../../ui/icons/index.js';

const DAY_MS = 86_400_000;
/** Slack around civil-month bounds so any display timezone is covered; the
 *  server clamps to [now, horizon] anyway and stray slots are filtered by key. */
const TZ_SLACK_MS = 36 * 3_600_000;

function dayKeyOf(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** The civil {year, month} of an instant in a zone (month 1–12). */
function civilMonthOf(ms: number, tz: string): { y: number; m: number } {
  const [y, m] = dayKeyOf(ms, tz).split('-').map(Number);
  return { y: y!, m: m! };
}

interface Props {
  tz: string;
  locale: string;
  nowMs: number;
  maxAdvanceDays: number;
  /** One clamped month-window read; rejections surface via onLoadFailed. */
  fetchSlots: (fromMs: number, toMs: number) => Promise<number[]>;
  onLoadFailed: () => void;
  selectedDay: string;
  /** Fired with the day's slots whenever a day is picked (or auto-picked). */
  onSelectDay: (key: string, slots: number[]) => void;
  /** Fired when the availability jump reached the horizon with nothing —
   *  i.e. the link genuinely has no bookable time at all right now. */
  onExhausted?: () => void;
}

export function BookingMonthGrid({ tz, locale, nowMs, maxAdvanceDays, fetchSlots, onLoadFailed, selectedDay, onSelectDay, onExhausted }: Props): JSX.Element {
  const { t } = useTranslation('crm');
  const horizonMs = nowMs + (maxAdvanceDays + 1) * DAY_MS;
  const [cursor, setCursor] = useState(() => civilMonthOf(nowMs, tz));
  // The month tag prevents a stale-data render from driving the availability
  // jump: after a cursor advance, the OLD month's slots briefly coexist with
  // the NEW monthKey — untagged, an empty old month reads as "this month is
  // empty too" and the jump runs away to the horizon before any load lands.
  const [rawSlots, setRawSlots] = useState<{ month: string; slots: number[] } | null>(null);
  // Cache RAW instants per month — day grouping happens per render tz, so a
  // timezone switch regroups instead of serving stale-keyed days.
  const cache = useRef(new Map<string, number[]>());
  const autoJumping = useRef(true);

  const monthKey = `${cursor.y}-${String(cursor.m).padStart(2, '0')}`;
  const firstMonth = civilMonthOf(nowMs, tz);
  const lastMonth = civilMonthOf(horizonMs, tz);
  const atFirst = cursor.y === firstMonth.y && cursor.m === firstMonth.m;
  const atLast = cursor.y === lastMonth.y && cursor.m === lastMonth.m;

  const move = (delta: 1 | -1): void => {
    autoJumping.current = false; // manual navigation ends the availability jump
    setCursor((c) => {
      const m0 = c.m - 1 + delta;
      return { y: c.y + Math.floor(m0 / 12), m: ((m0 % 12) + 12) % 12 + 1 };
    });
  };

  const monthKeyRef = useRef(monthKey);
  monthKeyRef.current = monthKey;
  const load = useCallback(async (): Promise<void> => {
    const cached = cache.current.get(monthKey);
    if (cached) { setRawSlots({ month: monthKey, slots: cached }); return; }
    setRawSlots(null);
    // Civil-month bounds with slack, clamped to the server's real window.
    const from = Math.max(Date.UTC(cursor.y, cursor.m - 1, 1) - TZ_SLACK_MS, nowMs);
    const to = Math.min(Date.UTC(cursor.y, cursor.m, 1) + TZ_SLACK_MS, horizonMs);
    try {
      const slots = from < to ? await fetchSlots(from, to) : [];
      cache.current.set(monthKey, slots);
      // Review F4 — a fetch that resolves AFTER the visitor navigated away
      // must be dropped, not written: writing it would null the memo on the
      // month-tag mismatch and leave a permanent skeleton over cached data.
      if (monthKeyRef.current === monthKey) setRawSlots({ month: monthKey, slots });
    } catch { if (monthKeyRef.current === monthKey) onLoadFailed(); }
  }, [monthKey, cursor, nowMs, horizonMs, fetchSlots, onLoadFailed]);

  useEffect(() => { void load(); }, [load]);

  const monthSlots = useMemo(() => {
    if (rawSlots === null || rawSlots.month !== monthKey) return null;
    const byDay = new Map<string, number[]>();
    for (const ms of rawSlots.slots) {
      const k = dayKeyOf(ms, tz);
      if (k.startsWith(monthKey)) (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(ms);
    }
    return byDay;
  }, [rawSlots, tz, monthKey]);

  // Jump to first availability: an empty month auto-advances until slots or
  // horizon; hitting the horizon empty means the link has no time at all.
  useEffect(() => {
    if (!monthSlots) return;
    if (monthSlots.size === 0 && autoJumping.current) {
      if (atLast) { autoJumping.current = false; onExhausted?.(); return; }
      setCursor((c) => {
        const m0 = c.m; // +1 month
        return { y: c.y + Math.floor(m0 / 12), m: (m0 % 12) + 1 };
      });
    }
    if (monthSlots.size > 0) autoJumping.current = false;
  }, [monthSlots, atLast, onExhausted]);

  // Keep a valid selection — and keep the PARENT's copy of the day's slots in
  // sync with the current grouping (review F5: after a timezone switch the
  // regrouped day keys can keep the same selectedDay while its times moved to
  // a different civil day; re-emitting on every regroup repairs the desync).
  useEffect(() => {
    if (!monthSlots || monthSlots.size === 0) return;
    if (monthSlots.has(selectedDay)) { onSelectDay(selectedDay, monthSlots.get(selectedDay)!); return; }
    const first = [...monthSlots.keys()].sort()[0]!;
    onSelectDay(first, monthSlots.get(first)!);
  }, [monthSlots, selectedDay, onSelectDay]);

  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'long' }).format(new Date(Date.UTC(cursor.y, cursor.m - 1, 15))),
    [locale, cursor],
  );
  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'narrow' });
    // 2026-08-02 is a Sunday; a fixed Sun-first week header.
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2026, 7, 2 + i))));
  }, [locale]);
  const dayFmt = useMemo(() => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }), [locale]);

  const daysInMonth = new Date(Date.UTC(cursor.y, cursor.m, 0)).getUTCDate();
  const leadBlanks = new Date(Date.UTC(cursor.y, cursor.m - 1, 1)).getUTCDay();

  return (
    <div className="booking-month u-grid u-gap-1">
      <div className="u-flex u-items-center u-gap-2">
        <button type="button" className="chip" onClick={() => move(-1)} disabled={atFirst} aria-label={t('bookingPubMonthPrev')}><ChevronLeftIcon size={14} /></button>
        <span className="u-label-sm u-flex-1 u-text-center" aria-live="polite">{monthLabel}</span>
        <button type="button" className="chip" onClick={() => move(1)} disabled={atLast} aria-label={t('bookingPubMonthNext')}><ChevronRightIcon size={14} /></button>
      </div>
      {monthSlots === null ? <Skeleton /> : (
        <div className="booking-month__grid" role="group" aria-label={monthLabel}>
          {weekdayLabels.map((w, i) => <span key={`w${i}`} className="booking-month__head" aria-hidden="true">{w}</span>)}
          {Array.from({ length: leadBlanks }, (_, i) => <span key={`b${i}`} aria-hidden="true" />)}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const d = i + 1;
            const key = `${monthKey}-${String(d).padStart(2, '0')}`;
            const daySlots = monthSlots.get(key);
            if (!daySlots) return <span key={key} aria-hidden="true" className="booking-month__day booking-month__day--off">{d}</span>;
            return (
              <button
                key={key} type="button"
                className={key === selectedDay ? 'booking-month__day booking-month__day--on chip--accent' : 'booking-month__day booking-month__day--on'}
                aria-pressed={key === selectedDay}
                aria-label={dayFmt.format(new Date(Date.UTC(cursor.y, cursor.m - 1, d)))}
                onClick={() => onSelectDay(key, daySlots)}
              >{d}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}
