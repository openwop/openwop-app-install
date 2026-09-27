/**
 * Plan (ADR 0443 R3 / ADR 0436 §5.5 / ADR 0496) — the cross-challenge plan in
 * three views over the ONE bounded `getPlan` read: Week (default), Calendar
 * (month), Challenge (per-enrollment lanes). Honest by construction: past/today
 * completion is real check-in truth; future rows are the derived plan.
 *
 * ADR 0496 D1/D2/D4 — move-within-window, keyboard/touch-FIRST (WCAG 2.2
 * §2.5.7: the single-pointer equivalent IS the mechanism; no drag). A future,
 * incomplete day offers "Move…" → a bounded date choice → the PURE preview
 * (same validator + guards as apply — it can never paint a move the server
 * would bounce) → the §5.5 compare → confirm. Refusals render the server's
 * verbatim message.
 *
 * ADR 0496 D5 — the external-calendar disclosure renders ONLY store-backed
 * states (transport + the caller's calendar consents): connected / revoked /
 * status-unavailable. A status failure NEVER hides plan actions.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { CalendarIcon } from '../../ui/icons/index.js';
import {
  applyRevision,
  getPlan,
  listChallengesForLocale,
  previewRevision,
  RevisionRefusedError,
  type PlanChange,
  type PlanItem,
} from '../../client/kicktodoClient.js';
import { getCalendarStatus, getConsents } from '../../client/kicktodoIntegrationsClient.js';
import { formatDate } from '../../i18n/format.js';

/** LOCAL calendar date (YYYY-MM-DD) `days` days from today. Rows carry the
 *  participant-local `dateLocal`, so the window + today MUST be local too — a
 *  UTC slice put "today" one day off for anyone west of UTC in the evening
 *  (grade-ux fix). CALENDAR arithmetic (`setDate`), never ms-addition: adding
 *  86 400 000·n across a DST transition lands an hour short/long, which
 *  repeats or skips a local date — a duplicated week cell (grade-code fix). */
const isoDaysFromToday = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const isoOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** First/last LOCAL date of the month `offset` months from this one. */
const monthWindow = (offset: number): { from: string; to: string } => {
  const now = new Date();
  return {
    from: isoOf(new Date(now.getFullYear(), now.getMonth() + offset, 1)),
    to: isoOf(new Date(now.getFullYear(), now.getMonth() + offset + 1, 0)),
  };
};

type PlanView = 'week' | 'calendar' | 'challenge';

/** The move-in-progress selection (ADR 0496 D4). */
interface MoveDraft {
  enrollmentId: string;
  day: number;
  title: string;
  fromDate: string;
}

/** §5.5 disclosure states this deployment can actually back (ADR 0496 D5):
 *  the full syncing/stale lifecycle needs sync-run records the host doesn't
 *  keep yet — disclosed honestly as connected/revoked/unavailable only. */
type CalendarDisclosure = 'connected' | 'revoked' | 'unavailable' | null;

export function PlanPage(): JSX.Element {
  const { t, i18n } = useTranslation('kicktodo');
  const [view, setView] = useState<PlanView>('week');
  // Week window (offset 0 = the week starting today) + month window for Calendar.
  const [offset, setOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [items, setItems] = useState<PlanItem[] | null>(null);
  const [error, setError] = useState(false);
  // Challenge-view labels — best-effort catalog titles (the ProgressPage posture).
  const [titleOf, setTitleOf] = useState<Map<string, string>>(new Map());
  // ADR 0496 D4 — the move flow.
  const [move, setMove] = useState<MoveDraft | null>(null);
  const [toDate, setToDate] = useState('');
  const [preview, setPreview] = useState<PlanChange[] | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  // ADR 0496 D5 — the disclosure chip.
  const [calState, setCalState] = useState<CalendarDisclosure>(null);
  // The move panel opens away from its trigger — focus must follow (WCAG 2.4.3).
  const moveDateRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (move) moveDateRef.current?.focus(); }, [move]);

  const { from, to } = view === 'calendar'
    ? monthWindow(monthOffset)
    : { from: isoDaysFromToday(offset * 7), to: isoDaysFromToday(offset * 7 + 6) };

  const reload = useCallback(async () => {
    // Screen-polish: clear before fetching — the OLD window's rows must never
    // render under the NEW date-range label during navigation.
    setItems(null);
    try { setError(false); setItems(await getPlan(from, to)); }
    catch { setError(true); }
  }, [from, to]);
  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    void listChallengesForLocale(i18n.language)
      .then((c) => setTitleOf(new Map(c.map((n) => [n.challenge.id, n.challenge.title]))))
      .catch(() => setTitleOf(new Map()));
  }, [i18n.language]);

  useEffect(() => {
    // D5 — disclose only what the server backs; a failed read is stated, and
    // absent transport/consent renders NOTHING (disclosure, not an ad).
    void (async () => {
      try {
        const status = await getCalendarStatus();
        if (!status.transportConfigured) { setCalState(null); return; }
        const cal = (await getConsents()).filter((c) => c.kind === 'calendar-project' || c.kind === 'calendar-write');
        if (cal.length === 0) { setCalState(null); return; }
        setCalState(cal.some((c) => !c.revokedAt) ? 'connected' : 'revoked');
      } catch {
        setCalState('unavailable');
      }
    })();
  }, []);

  const today = isoDaysFromToday(0);

  const startMove = (it: PlanItem): void => {
    setMove({ enrollmentId: it.enrollmentId, day: it.day, title: it.title, fromDate: it.dateLocal });
    setToDate('');
    setPreview(null);
    setMoveError(null);
  };
  const cancelMove = (): void => { setMove(null); setPreview(null); setMoveError(null); };

  const onPreview = async (): Promise<void> => {
    if (!move || !toDate) return;
    setMoveBusy(true);
    setMoveError(null);
    try {
      setPreview(await previewRevision(move.enrollmentId, [{ lane: 'move', day: move.day, toDate }]));
    } catch (err) {
      setPreview(null);
      setMoveError(err instanceof RevisionRefusedError ? err.message : t('planMoveError'));
    } finally {
      setMoveBusy(false);
    }
  };

  const onConfirm = async (): Promise<void> => {
    if (!move || !toDate) return;
    setMoveBusy(true);
    setMoveError(null);
    try {
      await applyRevision(move.enrollmentId, [{ lane: 'move', day: move.day, toDate }]);
      cancelMove();
      await reload();
    } catch (err) {
      setMoveError(err instanceof RevisionRefusedError ? err.message : t('planMoveError'));
    } finally {
      setMoveBusy(false);
    }
  };

  /** One plan item row; a future+incomplete row carries the Move affordance. */
  const ItemRow = ({ it, showDate }: { it: PlanItem; showDate?: boolean }): JSX.Element => (
    <li className={it.completed ? 'kt-week__item kt-week__item--done' : 'kt-week__item'}>
      <span className={it.completed ? 'kt-struck' : undefined}>{it.title}</span>
      <span className="muted u-fs-13"> · {t('planDayN', { day: it.day })}</span>
      {showDate && <span className="muted u-fs-13"> · {formatDate(it.dateLocal, { dateStyle: 'medium' })}</span>}
      {!it.completed && it.dateLocal > today && (
        <Button variant="quiet" size="sm"
          aria-label={t('planMoveAria', { title: it.title, day: it.day })}
          onClick={() => startMove(it)}>
          {t('planMove')}
        </Button>
      )}
    </li>
  );

  const byDate = (items ?? []).reduce<Record<string, PlanItem[]>>((acc, it) => {
    (acc[it.dateLocal] ??= []).push(it);
    return acc;
  }, {});
  const byEnrollment = (items ?? []).reduce<Record<string, PlanItem[]>>((acc, it) => {
    (acc[it.enrollmentId] ??= []).push(it);
    return acc;
  }, {});

  return (
    <div className="page" data-walkthrough="kicktodo-plan.page">
      <PageHeader
        title={t('planTitle')}
        lede={t('planLede')}
        actions={items && items.length > 0 ? (
          <>
            {/* The §5.5 view switch — Week default; all three views re-project
                the SAME bounded read (no new fetch shape). */}
            <div className="segmented" role="group" aria-label={t('planViewLabel')}>
              {(['week', 'calendar', 'challenge'] as const).map((v) => (
                <Button variant="primary" key={v} aria-pressed={view === v} onClick={() => setView(v)}>
                  {t(`planView_${v}`)}
                </Button>
              ))}
            </div>
            {view === 'calendar' ? (
              <>
                <Button variant="quiet" size="sm" onClick={() => setMonthOffset(monthOffset - 1)}>{t('planPrevMonth')}</Button>
                <span className="u-fs-13 muted">{formatDate(from, { month: 'long', year: 'numeric' })}</span>
                <Button variant="quiet" size="sm" onClick={() => setMonthOffset(monthOffset + 1)}>{t('planNextMonth')}</Button>
                {monthOffset !== 0 && (
                  <Button variant="quiet" size="sm" onClick={() => setMonthOffset(0)}>{t('planThisMonth')}</Button>
                )}
              </>
            ) : (
              <>
                <Button variant="quiet" size="sm" onClick={() => setOffset(offset - 1)}>{t('planPrevWeek')}</Button>
                <span className="u-fs-13 muted">{formatDate(from, { dateStyle: 'medium' })} – {formatDate(to, { dateStyle: 'medium' })}</span>
                <Button variant="quiet" size="sm" onClick={() => setOffset(offset + 1)}>{t('planNextWeek')}</Button>
                {offset !== 0 && (
                  <Button variant="quiet" size="sm" onClick={() => setOffset(0)}>{t('planThisWeek')}</Button>
                )}
              </>
            )}
          </>
        ) : undefined}
      />

      {/* D5 — the external-calendar disclosure (store-backed states only; a
          failed status read is stated and never hides plan actions). */}
      {calState && (
        <p className="muted u-fs-13">
          <span className={calState === 'connected' ? 'chip chip--success' : 'chip chip--muted'}>
            {t(`planCalendar_${calState}`)}
          </span>{' '}
          {t('planCalendarSot')}
        </p>
      )}

      {error && (
        <Notice variant="error">
          {t('planError')}{' '}
          <Button variant="quiet" size="sm" onClick={() => void reload()}>{t('common:retry')}</Button>
        </Notice>
      )}
      {!items && !error && <StateCard loading title={t('planTitle')} />}
      {items && items.length === 0 && !error && (
        <section className="kt-plan-empty" aria-labelledby="plan-empty-heading">
          <div className="kt-plan-empty__copy">
            <span className="kt-plan-empty__icon" aria-hidden><CalendarIcon size={24} /></span>
            <p className="kt-plan-empty__eyebrow">{t('planEmptyEyebrow')}</p>
            <h2 id="plan-empty-heading">{t('planEmptyTitle')}</h2>
            <p>{t('planEmptyBody')}</p>
            <Link className="btn-accent-solid" to="/discover">{t('planFindChallenge')}</Link>
          </div>
          <div className="kt-plan-sample" role="img" aria-label={t('planSampleWeekLabel')}>
            <p>{t('planSampleWeekHeading')}</p>
            <div className="kt-plan-sample__day kt-plan-sample__day--focus"><span>{t('planSampleDayOne')}</span><i /></div>
            <div className="kt-plan-sample__day"><span>{t('planSampleDayTwo')}</span><i /></div>
            <div className="kt-plan-sample__day kt-plan-sample__day--focus"><span>{t('planSampleDayThree')}</span><i /></div>
          </div>
        </section>
      )}

      {/* ADR 0496 D4 — the move panel: ONE calm place above the grid,
          keyboard/touch-native date input, preview-compare BEFORE confirm. */}
      {move && (
        <section className="surface-card" aria-label={t('planMovePanelLabel')}>
          <h2 className="kt-eyebrow">{t('planMovePanelLabel')}</h2>
          <p className="u-m-0">
            {t('planMoveWhat', { title: move.title, day: move.day })}{' '}
            <span className="muted">{formatDate(move.fromDate, { dateStyle: 'medium' })}</span>
          </p>
          <form className="kt-inline-form" onSubmit={(e) => { e.preventDefault(); void onPreview(); }}>
            <label className="u-fs-13" htmlFor="kt-move-date">{t('planMoveToLabel')}</label>
            <input id="kt-move-date" ref={moveDateRef} type="date" value={toDate} min={today}
              onChange={(e) => { setToDate(e.target.value); setPreview(null); }} required />
            {moveError && <Notice variant="error">{moveError}</Notice>}
            {/* The §5.5 compare — the server's dry-run rows, lines verbatim. */}
            {preview && (
              <ul role="list" className="list-plain">
                {preview.map((c, i) => (
                  <li key={i} className="list-row">
                    <span>{c.line}</span>
                    {c.fromDate && c.toDate && (
                      <span className="muted u-fs-13">
                        {formatDate(c.fromDate, { dateStyle: 'medium' })} → {formatDate(c.toDate, { dateStyle: 'medium' })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="action-bar">
              {!preview && (
                <Button type="submit" variant="accent-solid" size="sm" disabled={moveBusy || !toDate} aria-busy={moveBusy}>
                  {t('planMovePreview')}
                </Button>
              )}
              {preview && (
                <Button variant="accent-solid" size="sm" disabled={moveBusy} aria-busy={moveBusy} onClick={() => void onConfirm()}>
                  {t('planMoveConfirm')}
                </Button>
              )}
              <Button variant="quiet" size="sm" onClick={cancelMove}>{t('common:cancel')}</Button>
            </div>
          </form>
        </section>
      )}

      {/* ── Week (default): the fixed 7-cell grid ── */}
      {items && items.length > 0 && view === 'week' && (
        <div className="kt-week" role="list" aria-label={t('planWeekLabel')}>
          {Array.from({ length: 7 }, (_, i) => isoDaysFromToday(offset * 7 + i)).map((d) => {
            const dayItems = byDate[d] ?? [];
            const isToday = d === today;
            return (
              <section key={d} role="listitem"
                className={[
                  'kt-week__day',
                  isToday ? 'kt-week__day--today' : '',
                  dayItems.length === 0 ? 'kt-week__day--empty' : '',
                ].filter(Boolean).join(' ')}
                aria-label={formatDate(d, { dateStyle: 'full' })}>
                <h2 className="kt-week__label">
                  {formatDate(d, { weekday: 'short', day: 'numeric' })}
                  {isToday && <span className="kt-week__today-badge"> · {t('planTodayBadge')}</span>}
                </h2>
                {dayItems.length === 0 ? (
                  <p className="kt-week__empty">{t('planNothingScheduled')}<br />{t('planNeverMissed')}</p>
                ) : (
                  <ul role="list" className="list-plain">
                    {dayItems.map((it) => <ItemRow key={`${it.enrollmentId}:${it.stableActivityId}`} it={it} />)}
                  </ul>
                )}
                {/* ONE navigation affordance per cell (WCAG 2.4.4). */}
                {dayItems.some((it) => !it.completed) && d <= today && (
                  <Link className="btn-ghost btn-sm" to="/today">{t('planOpenToday')}</Link>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* ── Calendar (month): weekday-columned grid over the month window.
          Hidden when the window is empty — the global empty StateCard above is
          the one honest empty (a wall of bare date cells adds nothing).
          List semantics, not ARIA grid: a real grid role requires row wrappers
          the flat CSS grid doesn't have (the kt-week precedent — valid and
          consistent beats aspirational grid semantics). ── */}
      {items && items.length > 0 && view === 'calendar' && (
        <div className="kt-month" role="list" aria-label={formatDate(from, { month: 'long', year: 'numeric' })}>
          {Array.from({ length: 7 }, (_, i) => {
            const ref = new Date(2026, 10, 1 + i); // 2026-11-01 is a Sunday — a stable Sun..Sat header week
            return <div key={`h${i}`} aria-hidden className="kt-month__head">{formatDate(ref, { weekday: 'short' })}</div>;
          })}
          {(() => {
            const first = new Date(`${from}T00:00:00`);
            const lead = first.getDay();
            const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
            const cells: Array<string | null> = [
              ...Array.from({ length: lead }, () => null),
              ...Array.from({ length: daysInMonth }, (_, i) => isoOf(new Date(first.getFullYear(), first.getMonth(), i + 1))),
            ];
            return cells.map((d, i) => d === null
              ? <div key={`pad${i}`} aria-hidden className="kt-month__cell kt-month__cell--pad" />
              : (
                <section key={d} role="listitem"
                  className={['kt-month__cell', d === today ? 'kt-month__cell--today' : ''].filter(Boolean).join(' ')}
                  aria-label={formatDate(d, { dateStyle: 'full' })}>
                  <span className="kt-month__date">{Number(d.slice(8, 10))}</span>
                  {(byDate[d] ?? []).length > 0 && (
                    <ul role="list" className="list-plain">
                      {(byDate[d] ?? []).map((it) => <ItemRow key={`${it.enrollmentId}:${it.stableActivityId}`} it={it} />)}
                    </ul>
                  )}
                </section>
              ));
          })()}
        </div>
      )}

      {/* ── Challenge: the same window grouped per enrollment ── */}
      {items && items.length > 0 && view === 'challenge' && (
        <>
          {Object.entries(byEnrollment).map(([enrollmentId, rows]) => (
            <section key={enrollmentId} className="surface-card" aria-label={titleOf.get(rows[0]!.challengeId) ?? rows[0]!.challengeId}>
              <h2 className="kt-progress-title">{titleOf.get(rows[0]!.challengeId) ?? rows[0]!.challengeId}</h2>
              <ul role="list" className="list-plain">
                {[...rows].sort((a, b) => a.dateLocal.localeCompare(b.dateLocal)).map((it) => (
                  <ItemRow key={`${it.enrollmentId}:${it.stableActivityId}`} it={it} showDate />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
