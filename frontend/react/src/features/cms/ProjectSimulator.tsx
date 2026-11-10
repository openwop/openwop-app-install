/**
 * ADR 1080 D16: the decision simulator behind the `scheduleSim` section.
 *
 * Two modes over the same model:
 *   live    a project clock runs; decisions come due on dates worked back from
 *           their lock point and lead time, and an unanswered decision accrues
 *           lateness by the day until someone decides.
 *   what-if scenario presets and per-decision lateness, applied all at once.
 *
 * The model (`runProject`) is pure and fixed arithmetic in days:
 *   decide-by = lock day + slip so far − lead time − approval days, never before day 0
 *   made      = decide-by + own delay, or later while a late prerequisite holds it
 *   late      = made − decide-by
 * A milestone takes its latest decision; float absorbs what it can, and the rest
 * slips it and every milestone after it. A decision whose lead time is unknown
 * gets no date and is never counted late (the site's honesty rule).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';
import { Button } from '../../ui/Button.js';
import { headingSlug } from './headingSlug.js';
import { HeadingText, stripHeadingEmphasis } from './headingEmphasis.js';
import './projectSimulator.css';

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((x): x is Raw => typeof x === 'object' && x !== null) : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const DAY_MS = 86_400_000;
/** Days the approver needs between a decision and the order going out. */
export const APPROVAL_DAYS = 5;

export interface PMilestone { id: string; label: string; startWeek: number; weeks: number; floatDays: number; rework: string; items: string[] }
export interface POption { label: string; delayDays: number }
export interface PDecision {
  id: string; title: string; milestone: string; kind: string; decider: string; note: string; element: string;
  choices: string[]; leadDays: number | null; lockDay: number | null; dependsOn: string[]; risk: string; source: string; options: POption[];
}
export interface PPreset { label: string; description: string; rules: { kind?: string; decider?: string; minLeadDays?: number; delayDays: number }[] }
export interface PDecisionState { decideBy: number; made: number; late: number; blockedBy: string[]; dated: boolean }
export interface PRow { milestone: PMilestone; start: number; end: number; late: number; slip: number }
export interface PResult { rows: PRow[]; decisions: Map<string, PDecisionState>; baseEnd: number; end: number }

export function readProject(d: Raw): { milestones: PMilestone[]; decisions: PDecision[]; presets: PPreset[] } {
  const milestones = list(d.milestones).map((m, i) => ({
    id: str(m.id) || `m${i + 1}`, label: str(m.label), startWeek: num(m.startWeek) ?? 0, weeks: Math.max(num(m.weeks) ?? 1, 1),
    floatDays: num(m.floatDays) ?? 0, rework: str(m.rework), items: strings(m.items),
  }));
  const decisions = list(d.decisions).map((x, i) => {
    const lockWeek = num(x.lockWeek);
    return {
      id: str(x.id) || `d${i + 1}`, title: str(x.title), milestone: str(x.milestone), kind: str(x.kind) || 'selection',
      decider: str(x.decider) || str(x.owner), note: str(x.note), element: str(x.element), choices: strings(x.choices),
      leadDays: x.leadUnknown === true ? null : num(x.leadDays) ?? 0, lockDay: lockWeek === null ? null : lockWeek * 7,
      dependsOn: strings(x.dependsOn), risk: str(x.risk), source: str(x.source),
      options: list(x.options).map((o) => ({ label: str(o.label), delayDays: num(o.delayDays) ?? 0 })).filter((o) => o.label),
    };
  }).filter((x) => x.title && x.milestone);
  const presets = list(d.presets).map((p) => ({
    label: str(p.label), description: str(p.description),
    rules: list(p.rules).map((r) => ({
      delayDays: num(r.delayDays) ?? 0,
      ...(str(r.kind) ? { kind: str(r.kind) } : {}), ...(str(r.decider) ? { decider: str(r.decider) } : {}),
      ...(num(r.minLeadDays) !== null ? { minLeadDays: num(r.minLeadDays) ?? 0 } : {}),
    })),
  })).filter((p) => p.label);
  return { milestones, decisions, presets };
}

/** The delay a preset gives one decision: the largest matching rule, else none. */
export function presetDelay(preset: PPreset | undefined, dec: PDecision): number {
  if (!preset) return 0;
  return preset.rules.reduce((max, r) => {
    const match = (r.kind === undefined || r.kind === dec.kind)
      && (r.decider === undefined || r.decider === dec.decider)
      && (r.minLeadDays === undefined || (dec.leadDays ?? 0) >= r.minLeadDays);
    return match ? Math.max(max, r.delayDays) : max;
  }, 0);
}

/** The schedule after each decision's own delay. See the header for the arithmetic. */
export function runProject(milestones: PMilestone[], decisions: PDecision[], ownDelay: (dec: PDecision, decideBy: number) => number): PResult {
  const states = new Map<string, PDecisionState>();
  const byId = new Map(decisions.map((x) => [x.id, x]));
  const order = new Map(milestones.map((m, i) => [m.id, i]));
  const rows: PRow[] = [];
  let shift = 0;
  const msIndex = (dec: PDecision): number => order.get(dec.milestone) ?? milestones.length;
  // A prerequisite in a later milestone has no slip yet; it is dated on the slip so far.
  const solve = (dec: PDecision, shiftNow: number, seen: Set<string>): PDecisionState => {
    const done = states.get(dec.id);
    if (done) return done;
    const m = milestones[msIndex(dec)];
    const lockDay = dec.lockDay ?? (m ? m.startWeek * 7 : 0);
    // A lead time longer than the runway puts the date before the project starts;
    // that means "decide at kickoff", never "already late on day one".
    const decideBy = Math.max(0, lockDay + shiftNow - (dec.leadDays ?? 0) - APPROVAL_DAYS);
    const dated = dec.leadDays !== null;
    let made = decideBy + (dated ? Math.max(0, ownDelay(dec, decideBy)) : 0);
    const blockedBy: string[] = [];
    for (const depId of dec.dependsOn) {
      const dep = byId.get(depId);
      if (!dep || seen.has(depId)) continue;
      // Only a late prerequisite blocks, and by no more than its own lateness: authored
      // lock weeks are approximate, so one dated after its dependant must not block
      // on time, and a slip already in the dependant's date is not counted twice.
      const depState = solve(dep, shiftNow, new Set([...seen, dec.id]));
      const until = Math.min(depState.made, decideBy + depState.late);
      if (dated && depState.late > 0 && until > made) { made = until; blockedBy.push(depId); }
    }
    const state = { decideBy, made, late: dated ? Math.max(0, made - decideBy) : 0, blockedBy, dated };
    states.set(dec.id, state);
    return state;
  };
  milestones.forEach((m) => {
    const own = decisions.filter((x) => x.milestone === m.id);
    const late = own.reduce((max, x) => Math.max(max, solve(x, shift, new Set()).late), 0);
    const slip = Math.max(0, late - m.floatDays);
    shift += slip;
    const start = m.startWeek * 7 + shift;
    rows.push({ milestone: m, start, end: start + m.weeks * 7, late, slip });
  });
  const baseEnd = milestones.reduce((max, m) => Math.max(max, (m.startWeek + m.weeks) * 7), 0);
  return { rows, decisions: states, baseEnd, end: baseEnd + shift };
}

type Mode = 'live' | 'whatif';
interface Answer { at: number; choice: string }

export function ProjectSimulator({ d, sx }: { d: Raw; sx: string }): JSX.Element {
  const { t } = useTranslation('cms');
  const fmt = useFormat();
  const { milestones, decisions, presets } = useMemo(() => readProject(d), [d]);
  const [mode, setMode] = useState<Mode>('live');
  // Live mode
  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  // What-if mode
  const [presetIx, setPresetIx] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  // Shared
  const [focus, setFocus] = useState<string>(milestones[0]?.id ?? '');
  const [carry, setCarry] = useState('');
  const [openRisk, setOpenRisk] = useState<string | null>(null);

  const preset = presets[presetIx];
  const result = useMemo(() => runProject(milestones, decisions, (dec, decideBy) => {
    if (mode === 'whatif') return overrides[dec.id] ?? presetDelay(preset, dec);
    const a = answers[dec.id];
    if (a) return a.at - decideBy;
    return clock > decideBy ? clock - decideBy : 0;
  }), [milestones, decisions, mode, overrides, preset, answers, clock]);

  const scale = Math.max(result.end, result.baseEnd, 1);
  const done = mode === 'live' && clock >= result.end;

  useEffect(() => {
    if (!playing || mode !== 'live') return undefined;
    const timer = window.setInterval(() => setClock((c) => c + 3 * speed), 400);
    return () => window.clearInterval(timer);
  }, [playing, speed, mode]);
  useEffect(() => { if (done && playing) setPlaying(false); }, [done, playing]);

  const start = /^\d{4}-\d{2}-\d{2}$/.test(str(d.startDate)) ? Date.parse(`${str(d.startDate)}T00:00:00Z`) : null;
  const dateAt = (day: number): string => (start === null ? t('simWeek', { n: Math.ceil(day / 7) }) : fmt.date(new Date(start + day * DAY_MS), { dateStyle: 'medium', timeZone: 'UTC' }));
  const slipDays = result.end - result.baseEnd;
  const pushed = result.rows.filter((r) => r.slip > 0).length;
  const lateCount = [...result.decisions.values()].filter((x) => x.late > 0).length;
  const carryN = Number(carry);
  const carryCost = carry.trim() !== '' && Number.isFinite(carryN) && carryN > 0 ? fmt.currency(Math.round((slipDays / 7) * carryN), 'USD', { maximumFractionDigits: 0 }) : null;

  // Months along the axis, for orientation.
  const ticks = useMemo(() => {
    if (start === null) return [];
    const out: { day: number; label: string }[] = [];
    const first = new Date(start);
    for (let i = 0; i < 40; i++) {
      const m = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1);
      const day = Math.round((m - start) / DAY_MS);
      if (day > scale) break;
      if (day >= 0) out.push({ day, label: fmt.date(new Date(m), { month: 'short', timeZone: 'UTC', ...(new Date(m).getUTCMonth() === 0 ? { year: 'numeric' } : {}) }) });
    }
    return out;
  }, [start, scale, fmt]);

  const decide = (dec: PDecision, choice: string): void => setAnswers((a) => ({ ...a, [dec.id]: { at: clock, choice } }));
  const resetLive = (): void => { setClock(0); setAnswers({}); setPlaying(false); };
  const statusOf = (dec: PDecision): { word: string; tone: string } => {
    const s = result.decisions.get(dec.id);
    if (!s) return { word: '', tone: 'muted' };
    if (!s.dated) return { word: t('simNoDate'), tone: 'muted' };
    if (mode === 'live' && answers[dec.id]) return s.late > 0 ? { word: t('simDecidedLate', { count: s.late }), tone: 'warn' } : { word: t('simDecided'), tone: 'ok' };
    if (s.blockedBy.length > 0 && s.late > 0) return { word: t('simBlocked', { count: s.late }), tone: 'bad' };
    if (s.late > 0) return { word: t('simLate', { count: s.late }), tone: 'bad' };
    if (mode === 'live') {
      const left = s.decideBy - clock;
      return left <= 14 ? { word: t('simDueIn', { count: Math.max(left, 0) }), tone: 'warn' } : { word: t('simUpcoming'), tone: 'muted' };
    }
    return { word: t('simOnTime'), tone: 'ok' };
  };

  // Live queue: what needs a decision now, most urgent first.
  const queue = decisions
    .filter((x) => !answers[x.id] && (result.decisions.get(x.id)?.dated ?? false))
    .map((x) => ({ x, s: result.decisions.get(x.id) as PDecisionState }))
    .filter(({ s }) => s.decideBy <= clock + 21)
    .sort((a, b) => a.s.decideBy - b.s.decideBy)
    .slice(0, 5);
  const focusRow = result.rows.find((r) => r.milestone.id === focus);
  const focusDecisions = decisions.filter((x) => x.milestone === focus);

  return (
    <section className={`cms-public-section fp-section fp-psim${sx}`}>
      <div className="fp-shell">
        {str(d.eyebrow) || str(d.heading) || str(d.lede) ? (
          <header className="fp-head">
            {str(d.eyebrow) ? <p className="fp-eyebrow">{str(d.eyebrow)}</p> : null}
            {str(d.heading) ? <h2 id={headingSlug(stripHeadingEmphasis(str(d.heading)))} className="fp-head__title"><HeadingText text={str(d.heading)} /></h2> : null}
            {str(d.lede) ? <p className="fp-head__lede">{str(d.lede)}</p> : null}
          </header>
        ) : null}

        <div className="fp-psim__bar" role="group" aria-label={t('simModeLabel')}>
          <div className="fp-psim__modes">
            <Button variant="quiet" className="fp-psim__mode" aria-pressed={mode === 'live'} onClick={() => setMode('live')}>{t('simModeLive')}</Button>
            <Button variant="quiet" className="fp-psim__mode" aria-pressed={mode === 'whatif'} onClick={() => setMode('whatif')}>{t('simModeWhatIf')}</Button>
          </div>
          {mode === 'live' ? (
            <div className="fp-psim__controls">
              <Button variant="quiet" className="fp-psim__ctl fp-psim__ctl--primary" onClick={() => (done ? (resetLive(), setPlaying(true)) : setPlaying((p) => !p))}>
                {playing ? t('simPause') : done ? t('simReplay') : clock > 0 ? t('simResume') : t('simPlay')}
              </Button>
              <Button variant="quiet" className="fp-psim__ctl" onClick={() => setClock((c) => c + 7)} disabled={playing || done}>{t('simStepWeek')}</Button>
              <label className="fp-psim__speed">
                <span>{t('simSpeed')}</span>
                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                  <option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option>
                </select>
              </label>
              <Button variant="quiet" className="fp-psim__ctl" onClick={resetLive}>{t('simRestart')}</Button>
            </div>
          ) : (
            <div className="fp-psim__presets" role="group" aria-label={t('simScenarios')}>
              {presets.map((p, i) => (
                <Button key={p.label} variant="quiet" className="fp-psim__preset" aria-pressed={i === presetIx} title={p.description} onClick={() => { setPresetIx(i); setOverrides({}); }}>{p.label}</Button>
              ))}
            </div>
          )}
          <label className="fp-psim__carry">
            <span>{t('simCarryLabel')}</span>
            <input type="number" min={0} inputMode="numeric" placeholder="0" value={carry} onChange={(e) => setCarry(e.target.value)} />
          </label>
        </div>
        {mode === 'whatif' && preset?.description ? <p className="fp-psim__hint">{preset.description}</p> : null}

        <div className="fp-psim__summary" aria-live="polite">
          {mode === 'live' ? <div><p className="fp-psim__k">{t('simToday')}</p><p className="fp-psim__v">{dateAt(Math.min(clock, scale))}</p></div> : null}
          <div><p className="fp-psim__k">{str(d.finishLabel) || t('simFinish')}</p><p className="fp-psim__v">{dateAt(result.end)}</p></div>
          <div><p className="fp-psim__k">{t('simChange')}</p><p className={`fp-psim__v${slipDays > 0 ? ' fp-psim__v--late' : ''}`}>{slipDays > 0 ? t('simDaysLater', { count: slipDays }) : t('simOnSchedule')}</p></div>
          <div><p className="fp-psim__k">{t('simPushedLabel')}</p><p className="fp-psim__v">{t('simPushedValue', { n: pushed, late: lateCount })}</p></div>
          <div><p className="fp-psim__k">{t('simCostLabel')}</p><p className="fp-psim__v">{carryCost ?? <span className="fp-psim__muted">{t('simCostEmpty')}</span>}</p></div>
        </div>

        <div className="fp-psim__grid">
          <div className="fp-psim__side">
            {mode === 'live' ? (
              <>
                <h3 className="fp-psim__title">{t('simQueueTitle')}</h3>
                {queue.length === 0 ? <p className="fp-psim__muted">{done ? t('simQueueDone') : t('simQueueEmpty')}</p> : null}
                <ul className="fp-psim__queue">
                  {queue.map(({ x, s }) => {
                    const st = statusOf(x);
                    return (
                      <li key={x.id} className={`fp-psim__card${s.late > 0 ? ' fp-psim__card--late' : ''}`}>
                        <div className="fp-psim__cardhead">
                          <span className="fp-psim__id">{x.kind === 'selection' ? x.id : t(`simKind_${x.kind}`)}</span>
                          <span className={`fp-psim__chip fp-psim__chip--${st.tone}`}>{st.word}</span>
                        </div>
                        {x.element ? <p className="fp-psim__element">{x.element}</p> : null}
                        <p className="fp-psim__q">{x.title}</p>
                        <p className="fp-psim__meta">{[x.decider, t('simDecideBy', { date: dateAt(s.decideBy) }), x.leadDays ? t('simLead', { n: Math.round(x.leadDays / 7) }) : null].filter(Boolean).join(' · ')}</p>
                        {s.blockedBy.length > 0 ? <p className="fp-psim__blocked">{t('simWaitingOn', { ids: s.blockedBy.join(', ') })}</p> : null}
                        <div className="fp-psim__choices">
                          {(x.choices.length > 0 ? x.choices : [x.kind === 'payment' ? t('simPayNow') : x.kind === 'response' ? t('simAnswerNow') : t('simDecideNow')]).map((c) => (
                            <Button key={c} variant="quiet" className="fp-psim__choice" onClick={() => decide(x, c)}>{c}</Button>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <p className="fp-psim__muted">{t('simLiveHint')}</p>
              </>
            ) : (
              <>
                <h3 className="fp-psim__title">{t('simAdjustTitle', { name: focusRow?.milestone.label ?? '' })}</h3>
                <p className="fp-psim__muted">{t('simAdjustHint')}</p>
              </>
            )}
          </div>

          <div className="fp-psim__chart">
            <div className="fp-psim__axis" aria-hidden="true">
              <span />
              <span className="fp-psim__ticks">
                {ticks.map((tk) => <span key={tk.day} className="fp-psim__tick" style={{ insetInlineStart: `${(tk.day / scale) * 100}%` }}>{tk.label}</span>)}
              </span>
              <span />
            </div>
            <ol className="fp-psim__gantt" aria-label={t('simTimeline')}>
              {result.rows.map((r) => {
                const state = r.slip > 0 ? 'late' : r.late > 0 ? 'absorbed' : 'ok';
                const past = mode === 'live' && clock >= r.end;
                return (
                  <li key={r.milestone.id} className={`fp-psim__row fp-psim__row--${state}${focus === r.milestone.id ? ' fp-psim__row--focus' : ''}${past ? ' fp-psim__row--past' : ''}`}>
                    <Button variant="quiet" className="fp-psim__rowbtn" aria-pressed={focus === r.milestone.id} onClick={() => setFocus(r.milestone.id)}>
                      <span className="fp-psim__label">{r.milestone.label}</span>
                      <span className="fp-psim__track" aria-hidden="true">
                        <span className="fp-psim__ghost" style={{ insetInlineStart: `${(r.milestone.startWeek * 7 / scale) * 100}%`, inlineSize: `${(r.milestone.weeks * 7 / scale) * 100}%` }} />
                        <span className="fp-psim__barfill" style={{ insetInlineStart: `${(r.start / scale) * 100}%`, inlineSize: `${((r.end - r.start) / scale) * 100}%` }} />
                        {mode === 'live' ? <span className="fp-psim__now" style={{ insetInlineStart: `${(Math.min(clock, scale) / scale) * 100}%` }} /> : null}
                      </span>
                      <span className="fp-psim__when">{dateAt(r.start)}{r.slip > 0 ? <span className="fp-psim__chip fp-psim__chip--bad">+{r.slip}d</span> : r.late > 0 ? <span className="fp-psim__chip fp-psim__chip--warn">{t('simAbsorbed')}</span> : null}</span>
                    </Button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        {focusRow ? (
          <div className="fp-psim__detail" aria-live="polite">
            <div className="fp-psim__detailhead">
              <h3 className="fp-psim__title">{focusRow.milestone.label}</h3>
              <p className="fp-psim__muted">{t('simDetailDates', { start: dateAt(focusRow.start), end: dateAt(focusRow.end), float: focusRow.milestone.floatDays })}</p>
            </div>
            {focusRow.milestone.items.length > 0 ? (
              <p className="fp-psim__locks"><strong>{t('simMustLock')}</strong> {focusRow.milestone.items.join(' · ')}</p>
            ) : null}
            {focusRow.milestone.rework ? <p className={`fp-psim__rework${focusRow.slip > 0 ? ' fp-psim__rework--hit' : ''}`}><strong>{t('simIfLate')}</strong> {focusRow.milestone.rework}</p> : null}
            <ul className="fp-psim__decisions">
              {focusDecisions.map((x) => {
                const s = result.decisions.get(x.id);
                const st = statusOf(x);
                return (
                  <li key={x.id} className="fp-psim__decision">
                    <div className="fp-psim__decmain">
                      <p className="fp-psim__q">{x.element ? <span className="fp-psim__element">{x.element}. </span> : null}{x.title}</p>
                      <p className="fp-psim__meta">
                        {[x.decider, s?.dated ? t('simDecideBy', { date: dateAt(s.decideBy) }) : t('simNoDateLong'), x.leadDays ? t('simLead', { n: Math.round(x.leadDays / 7) }) : null, x.dependsOn.length > 0 ? t('simDependsOn', { ids: x.dependsOn.join(', ') }) : null, x.source || null].filter(Boolean).join(' · ')}
                      </p>
                      {mode === 'live' && answers[x.id]?.choice ? <p className="fp-psim__picked">{t('simPicked', { choice: answers[x.id]?.choice ?? '' })}</p> : null}
                      {x.risk ? (
                        <>
                          <Button variant="quiet" className="fp-psim__risktoggle" aria-expanded={openRisk === x.id} onClick={() => setOpenRisk((o) => (o === x.id ? null : x.id))}>{t('simRisk')}</Button>
                          {openRisk === x.id ? <p className="fp-psim__risk">{x.risk}</p> : null}
                        </>
                      ) : null}
                    </div>
                    <div className="fp-psim__decside">
                      <span className={`fp-psim__chip fp-psim__chip--${st.tone}`}>{st.word}</span>
                      {mode === 'whatif' && s?.dated ? (
                        <select aria-label={t('simLatenessFor', { name: x.element || x.title })} value={overrides[x.id] ?? presetDelay(preset, x)} onChange={(e) => setOverrides((o) => ({ ...o, [x.id]: Number(e.target.value) }))}>
                          {[...new Set([0, presetDelay(preset, x), ...x.options.map((o) => o.delayDays)])].sort((a, b) => a - b).map((days) => (
                            <option key={days} value={days}>{x.options.find((o) => o.delayDays === days)?.label ?? t('simLateDays', { count: days })}</option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {str(d.note) ? <p className="fp-psim__muted fp-psim__foot">{str(d.note)}</p> : null}
      </div>
    </section>
  );
}
