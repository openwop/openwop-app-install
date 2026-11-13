/**
 * ADR 1080 D16, ADR 1112: the decision simulator behind the `scheduleSim` section.
 *
 * A visitor sets how late each decision comes in (a scenario, or one decision at a time)
 * and sees what the schedule does. A replay then crosses the result at a readable pace and
 * stops at the finish. Nothing accrues while the visitor reads: the finish is a fixed date
 * once the settings are fixed (ADR 1112 D3, which removed the live "answer against the
 * clock" mode: it could not be played and never ended).
 *
 * The model (`runSchedule`, from CasaVoga's `runDecisions`) is pure arithmetic in days:
 *   decide-by  the decision's lock day plus the slip so far. Where the lock is the day the
 *              item is needed on site (`back`), the lead time and the approval days are
 *              counted back from it. Never before day 0.
 *   made       decide-by plus its own delay. A late prerequisite holds it, by no more than
 *              the prerequisite's own lateness. A loop in the links holds nothing.
 *   late       made − decide-by.
 * A milestone waits for its latest decision. Float absorbs what it can; the rest slips that
 * milestone and every one after it. A decision whose lead time is unknown is dated to its
 * lock and labelled, never left out (ADR 1112 D1).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';
import { useLiveRegion } from '../../ui/announce.js';
import { Button } from '../../ui/Button.js';
import { prefersReducedMotion } from '../../ui/motion.js';
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
/** The replay: one week of the schedule per tick. */
export const REPLAY_TICK_MS = 600;
const REPLAY_STEP_DAYS = 7;
/** The lateness a visitor can set on a role, a cell, or a decision without its own options. */
export const SIM_DELAYS = [0, 7, 14, 21, 42] as const;
/** A list of decisions shows this many, then "Show all" (ADR 1112 D5: the DOM stays small). */
export const LIST_FIRST = 12;

export interface PMilestone { id: string; label: string; startWeek: number; weeks: number; floatDays: number; rework: string; items: string[] }
export interface POption { label: string; delayDays: number }
export interface PDecision {
  id: string; title: string; milestone: string; kind: string; decider: string; note: string; element: string;
  /** null when the lead time is not known (`leadUnknown`). */
  leadDays: number | null; lockDay: number | null; back: boolean; dependsOn: string[]; risk: string; source: string; options: POption[];
  /** ADR 1112 D2 grouping keys; '' when the section is not grouped. */
  phase: string; category: string; role: string;
}
export interface PKeyed { key: string; label: string }
export interface PRule { kind?: string; decider?: string; role?: string; phase?: string; category?: string; minLeadDays?: number; delayDays: number }
export interface PPreset { label: string; description: string; rules: PRule[] }
/** What the visitor has set: per role, per cell (`phase|category`), per decision. */
export interface PSettings { roles: Record<string, number>; cells: Record<string, number>; one: Record<string, number> }
export interface PDecisionState { decideBy: number; made: number; late: number; blockedBy: string[] }
/** `driver` is the decision that held the milestone longest (null when none was late). */
export interface PRow { milestone: PMilestone; start: number; end: number; late: number; slip: number; lateCount: number; driver: string | null }
/** `lateOrders` counts the late decisions that order something (a lead time above zero). */
export interface PResult { rows: PRow[]; decisions: Map<string, PDecisionState>; baseEnd: number; end: number; lateCount: number; lateOrders: number }

/** A page saved before ADR 1112's id rules can repeat an id (kept as stored, ADR 1112 D8). For
 *  display only, a later repeat gets its own id, so each decision or milestone keeps its own row,
 *  key and lookups; references to the id go to the first. */
function distinct<T extends { id: string }>(xs: T[]): T[] {
  const taken = new Set(xs.map((x) => x.id));
  const seen = new Set<string>();
  return xs.map((x) => {
    if (!seen.has(x.id)) { seen.add(x.id); return x; }
    let n = 2;
    while (taken.has(`${x.id}~${n}`)) n += 1;
    const id = `${x.id}~${n}`;
    taken.add(id);
    return { ...x, id };
  });
}

export function readProject(d: Raw): { milestones: PMilestone[]; decisions: PDecision[]; presets: PPreset[]; phases: PKeyed[]; categories: PKeyed[]; roles: PKeyed[] } {
  const keyed = (v: unknown): PKeyed[] => list(v).map((x) => ({ key: str(x.key), label: str(x.label) })).filter((x) => x.key && x.label);
  const milestones = distinct(list(d.milestones).map((m, i) => ({
    id: str(m.id) || `m${i + 1}`, label: str(m.label), startWeek: num(m.startWeek) ?? 0, weeks: Math.max(num(m.weeks) ?? 1, 1),
    floatDays: num(m.floatDays) ?? 0, rework: str(m.rework), items: strings(m.items),
  })));
  // A saved decision always has an id (the validator mints one); an unsaved preview's
  // missing ids are minted here the same way, never colliding with an authored one.
  const authored = new Set(list(d.decisions).map((x) => str(x.id)).filter(Boolean));
  let minted = 0;
  const mint = (): string => { do minted += 1; while (authored.has(`d${minted}`)); return `d${minted}`; };
  const decisions = distinct(list(d.decisions).map((x) => {
    const lockWeek = num(x.lockWeek);
    return {
      id: str(x.id) || mint(), title: str(x.title), milestone: str(x.milestone), kind: str(x.kind) || 'selection',
      decider: str(x.decider) || str(x.owner), note: str(x.note), element: str(x.element),
      leadDays: x.leadUnknown === true ? null : num(x.leadDays) ?? 0, lockDay: lockWeek === null ? null : lockWeek * 7, back: x.back === true,
      dependsOn: strings(x.dependsOn), risk: str(x.risk), source: str(x.source),
      options: list(x.options).map((o) => ({ label: str(o.label), delayDays: num(o.delayDays) ?? 0 })).filter((o) => o.label),
      phase: str(x.phase), category: str(x.category), role: str(x.role),
    };
  }).filter((x) => x.title && x.milestone));
  const presets = list(d.presets).map((p) => ({
    label: str(p.label), description: str(p.description),
    rules: list(p.rules).map((r) => ({
      delayDays: num(r.delayDays) ?? 0,
      ...(str(r.kind) ? { kind: str(r.kind) } : {}), ...(str(r.decider) ? { decider: str(r.decider) } : {}),
      ...(str(r.role) ? { role: str(r.role) } : {}), ...(str(r.phase) ? { phase: str(r.phase) } : {}), ...(str(r.category) ? { category: str(r.category) } : {}),
      ...(num(r.minLeadDays) !== null ? { minLeadDays: num(r.minLeadDays) ?? 0 } : {}),
    })),
  })).filter((p) => p.label);
  return { milestones, decisions, presets, phases: keyed(d.phases), categories: keyed(d.categories), roles: keyed(d.roles) };
}

/** A rule that names only a role is shown on that role's control (ADR 1112 D2); any other rule stays with the scenario. */
const roleOnly = (r: PRule): boolean => r.role !== undefined && r.kind === undefined && r.decider === undefined
  && r.phase === undefined && r.category === undefined && r.minLeadDays === undefined;
/** The role controls a scenario sets. */
export const presetRoles = (preset: PPreset | undefined): Record<string, number> => {
  const out: Record<string, number> = {};
  // Two rules for one role: the larger wins, as everywhere else in the scenario's rules.
  for (const r of (preset?.rules ?? []).filter(roleOnly)) out[r.role as string] = Math.max(out[r.role as string] ?? 0, r.delayDays);
  return out;
};
const ruleDelay = (rules: PRule[], dec: PDecision): number => rules.reduce((max, r) => {
  const match = (r.kind === undefined || r.kind === dec.kind)
    && (r.decider === undefined || r.decider === dec.decider)
    && (r.role === undefined || r.role === dec.role)
    && (r.phase === undefined || r.phase === dec.phase)
    && (r.category === undefined || r.category === dec.category)
    && (r.minLeadDays === undefined || (dec.leadDays ?? 0) >= r.minLeadDays);
  return match ? Math.max(max, r.delayDays) : max;
}, 0);

/** The delay a preset gives one decision on its own: the largest matching rule, else none. */
export function presetDelay(preset: PPreset | undefined, dec: PDecision): number {
  return ruleDelay(preset?.rules ?? [], dec);
}

export const cellKey = (phase: string, category: string): string => `${phase}|${category}`;

/** The settings a scenario starts from: its role-only rules on the role controls, nothing else set. */
export const freshSettings = (preset: PPreset | undefined): PSettings => ({ roles: presetRoles(preset), cells: {}, one: {} });

/**
 * One decision's own delay (ADR 1112 D2, CasaVoga's `delayFor`): its own setting, else its
 * cell's, else the larger of its role's and the scenario's other rules. The role controls
 * start at the scenario's role-only rules.
 */
export function delayFor(dec: PDecision, preset: PPreset | undefined, s: PSettings): number {
  const one = s.one[dec.id];
  if (one !== undefined) return one;
  const cell = dec.phase && dec.category ? s.cells[cellKey(dec.phase, dec.category)] : undefined;
  if (cell !== undefined) return cell;
  return Math.max(s.roles[dec.role] ?? 0, ruleDelay((preset?.rules ?? []).filter((r) => !roleOnly(r)), dec));
}

/** The schedule after each decision's own delay. See the header for the arithmetic. */
export function runSchedule(milestones: PMilestone[], decisions: PDecision[], ownDelay: (dec: PDecision) => number): PResult {
  const states = new Map<string, PDecisionState>();
  const byId = new Map(decisions.map((x) => [x.id, x]));
  const byMilestone = new Map<string, PDecision[]>();
  for (const x of decisions) { const own = byMilestone.get(x.milestone); if (own) own.push(x); else byMilestone.set(x.milestone, [x]); }
  const startOf = new Map(milestones.map((m) => [m.id, m.startWeek * 7]));
  const indexOf = new Map(milestones.map((m, i) => [m.id, i]));
  const open = new Set<string>();
  let shift = 0;
  // The milestone being settled, and the decisions solved before their own milestone was
  // reached (a prerequisite in a later milestone). Those are dated on the slip so far for
  // the dependant asking, and kept only for that pass: their own date comes when their
  // milestone is settled, so two decisions on one lock never show two dates.
  let current = -1;
  let ahead = new Map<string, PDecisionState>();
  const solve = (dec: PDecision): PDecisionState => {
    const done = states.get(dec.id) ?? ahead.get(dec.id);
    if (done) return done;
    const early = (indexOf.get(dec.milestone) ?? milestones.length) > current;
    open.add(dec.id);
    // No lock week: the decision is due when its milestone starts.
    const lockDay = dec.lockDay ?? startOf.get(dec.milestone) ?? 0;
    // A lead time longer than the runway puts the date before the project starts;
    // that means "decide at kickoff", never "already late on day one".
    const back = dec.back && dec.leadDays ? dec.leadDays + APPROVAL_DAYS : 0;
    const decideBy = Math.max(0, lockDay + shift - back);
    let made = decideBy + Math.max(0, ownDelay(dec));
    const blockedBy: string[] = [];
    for (const depId of dec.dependsOn) {
      const dep = byId.get(depId);
      if (!dep || open.has(depId)) continue; // a loop in the links holds nothing up
      // Only a late prerequisite blocks, and by no more than its own lateness: authored
      // lock weeks are approximate, so one dated after its dependant must not block
      // on time, and a slip already in the dependant's date is not counted twice.
      const depState = solve(dep);
      const until = Math.min(depState.made, decideBy + depState.late);
      if (depState.late > 0 && until > made) { made = until; blockedBy.push(depId); }
    }
    open.delete(dec.id);
    const state = { decideBy, made, late: made - decideBy, blockedBy };
    (early ? ahead : states).set(dec.id, state);
    return state;
  };
  const rows: PRow[] = milestones.map((m, i) => {
    current = i;
    ahead = new Map();
    let late = 0; let lateCount = 0; let driver: string | null = null;
    for (const x of byMilestone.get(m.id) ?? []) {
      const s = solve(x);
      if (s.late > 0) lateCount++;
      if (s.late > late) { late = s.late; driver = x.id; }
    }
    const slip = Math.max(0, late - m.floatDays);
    shift += slip;
    const start = m.startWeek * 7 + shift;
    return { milestone: m, start, end: start + m.weeks * 7, late, slip, lateCount, driver };
  });
  // A decision on no listed milestone is still dated, on the final slip.
  current = milestones.length;
  ahead = new Map();
  for (const x of decisions) solve(x);
  const baseEnd = milestones.reduce((max, m) => Math.max(max, (m.startWeek + m.weeks) * 7), 0);
  // The finish is the latest milestone's end, so milestones authored out of start order
  // still finish where their bars do.
  const end = rows.reduce((max, r) => Math.max(max, r.end), baseEnd);
  let lateCount = 0; let lateOrders = 0;
  for (const x of decisions) { const s = states.get(x.id); if (s && s.late > 0) { lateCount++; if ((x.leadDays ?? 0) > 0) lateOrders++; } }
  return { rows, decisions: states, baseEnd, end, lateCount, lateOrders };
}

/** ADR 1112 D4: open on the first milestone that owns a decision, never on an empty one. */
export function openingFocus(milestones: PMilestone[], decisions: PDecision[]): string {
  const owned = new Set(decisions.map((x) => x.milestone));
  return (milestones.find((m) => owned.has(m.id)) ?? milestones[0])?.id ?? '';
}

/** The most month labels the axis shows; past this, every k-th month is labelled. */
export const MAX_AXIS_LABELS = 12;

/**
 * #5779 B6 — the month ticks along the axis, as pure data. One tick per month
 * start inside the plan; when there are more than MAX_AXIS_LABELS months, every
 * k-th month is labelled, counted from the first January so the year is always
 * labelled and the spacing stays even. The year is its own field (drawn on a
 * second line), so January is never wider than its neighbours: on a 59-week plan
 * at 1280px "Jan 2028" used to run into February and March.
 */
export function monthTicks(start: number, scale: number): { day: number; month: number; year?: number }[] {
  const months: { day: number; month: number; year: number }[] = [];
  const first = new Date(start);
  for (let i = 0; i < 240; i++) {
    const m = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1);
    const day = Math.round((m - start) / DAY_MS);
    if (day > scale) break;
    if (day >= 0) { const d = new Date(m); months.push({ day, month: d.getUTCMonth(), year: d.getUTCFullYear() }); }
  }
  const step = Math.max(1, Math.ceil(months.length / MAX_AXIS_LABELS));
  const jan = months.findIndex((m) => m.month === 0);
  const anchor = jan >= 0 ? jan : 0;
  return months
    .filter((_, i) => (((i - anchor) % step) + step) % step === 0)
    .map((m) => (m.month === 0 ? { day: m.day, month: m.month, year: m.year } : { day: m.day, month: m.month }));
}

export function ProjectSimulator({ d, sx }: { d: Raw; sx: string }): JSX.Element {
  const { t } = useTranslation('cms');
  const fmt = useFormat();
  const { milestones, decisions, presets, phases, categories, roles } = useMemo(() => readProject(d), [d]);
  const [presetIx, setPresetIx] = useState(0);
  const [settings, setSettings] = useState<PSettings>(() => freshSettings(presets[0]));
  // The grouped view (ADR 1112 D2): the phase × category cell open below the grid, and which lists show every row.
  const [cell, setCell] = useState('');
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  // Keyboard: the grid is one tab stop moved by the arrow keys; opening a cell moves focus
  // to its panel; "Show all" moves focus to the first row it added.
  const [gridAt, setGridAt] = useState('');
  const cellRef = useRef<HTMLHeadingElement>(null);
  const openedCell = useRef(false);
  const revealed = useRef<string | null>(null);
  // The replay: a clock that only shows the result. No decision reads it.
  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(false);
  const still = prefersReducedMotion(); // read each render: the in-app setting can change
  // Reduced motion switched on mid-replay hides Pause, so the replay stops with it.
  if (still && playing) setPlaying(false);
  const [picked, setPicked] = useState('');
  const [carry, setCarry] = useState('');
  const [openRisk, setOpenRisk] = useState<string | null>(null);
  // One quiet status line for screen readers: said on pause, finish and each step, never per tick.
  const [said, setSaid] = useLiveRegion();
  const playRef = useRef<HTMLButtonElement>(null);
  const gridId = `psim-${useId().replace(/:/g, '')}`;
  const stepRef = useRef<HTMLButtonElement>(null);
  const restartRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLHeadingElement>(null);
  const jump = useRef(false);
  const rootRef = useRef<HTMLElement>(null);
  // A control to focus once the render that enables it has happened.
  const focusNext = useRef<HTMLButtonElement | null>(null);

  // An author editing the section in the Page Builder changes `d` under a mounted
  // simulator: a new set of milestones or decisions starts it over.
  const shape = useMemo(() => `${milestones.map((m) => m.id).join('|')}#${decisions.map((x) => x.id).join('|')}#${presets.length}#${roles.map((r) => r.key).join('|')}`, [milestones, decisions, presets, roles]);
  // The first scenario's role settings, read through a ref: `presets` is rebuilt whenever
  // `d` is, and only a change of shape should start the simulator over.
  const firstPreset = useRef(presets[0]);
  firstPreset.current = presets[0];
  useEffect(() => {
    setSettings(freshSettings(firstPreset.current)); setPresetIx(0); setClock(0); setPlaying(false); setPicked(''); setCell(''); setShowAll({});
  }, [shape]);
  // The milestone shown: the one picked, while it exists, else the opening one (ADR 1112 D4).
  const focus = milestones.some((m) => m.id === picked) ? picked : openingFocus(milestones, decisions);
  const setFocus = (id: string): void => setPicked(id);

  const preset = presets[presetIx];
  const delayOf = (dec: PDecision): number => delayFor(dec, preset, settings);
  const result = useMemo(() => runSchedule(milestones, decisions, (dec) => delayFor(dec, preset, settings)), [milestones, decisions, settings, preset]);
  const grouped = phases.length > 0 && categories.length > 0;
  // Counts per cell, for the grid: how many decisions it holds and how many are late.
  const counts = useMemo(() => {
    const out = new Map<string, { n: number; late: number }>();
    for (const x of decisions) {
      if (!x.phase || !x.category) continue;
      const k = cellKey(x.phase, x.category);
      const c = out.get(k) ?? { n: 0, late: 0 };
      c.n += 1;
      if ((result.decisions.get(x.id)?.late ?? 0) > 0) c.late += 1;
      out.set(k, c);
    }
    return out;
  }, [decisions, result]);
  const setOne = (id: string, days: number): void => setSettings((v) => ({ ...v, one: { ...v.one, [id]: days } }));
  const setRole = (key: string, days: number): void => setSettings((v) => ({ ...v, roles: { ...v.roles, [key]: days } }));
  const setCellDelay = (key: string, days: number | null): void => setSettings((v) => {
    const cells = { ...v.cells };
    if (days === null) delete cells[key]; else cells[key] = days;
    return { ...v, cells };
  });
  const byId = useMemo(() => new Map(decisions.map((x) => [x.id, x])), [decisions]);

  const scale = Math.max(result.end, result.baseEnd, 1);
  const finished = clock >= result.end;
  const shown = Math.min(clock, result.end);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => setClock((c) => c + REPLAY_STEP_DAYS), REPLAY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [playing]);
  useEffect(() => {
    const el = focusNext.current;
    focusNext.current = null;
    el?.focus();
  }, [clock]);
  // A cell opened from the grid: its panel takes focus. "Show all": the first added row does.
  useEffect(() => {
    if (openedCell.current && cell) cellRef.current?.focus();
    openedCell.current = false;
  }, [cell]);
  useEffect(() => {
    const id = revealed.current;
    if (!id) return;
    revealed.current = null;
    const list = [...(rootRef.current?.querySelectorAll<HTMLUListElement>('ul[data-list]') ?? [])].find((ul) => ul.dataset.list === id);
    list?.children[LIST_FIRST]?.querySelector('select')?.focus();
  }, [showAll]);
  // A milestone picked from the missed list: bring its decisions into view.
  useEffect(() => {
    if (!jump.current) return;
    jump.current = false;
    detailRef.current?.focus();
    detailRef.current?.scrollIntoView?.({ block: 'start', behavior: still ? 'auto' : 'smooth' });
  }, [focus, still]);

  const start = /^\d{4}-\d{2}-\d{2}$/.test(str(d.startDate)) ? Date.parse(`${str(d.startDate)}T00:00:00Z`) : null;
  const dateAt = (day: number): string => (start === null ? t('simWeek', { n: Math.ceil(day / 7) }) : fmt.date(new Date(start + day * DAY_MS), { dateStyle: 'medium', timeZone: 'UTC' }));
  const finishText = dateAt(result.end);
  // The finish is fixed for fixed settings, so the replay always ends.
  useEffect(() => {
    if (!playing || !finished) return;
    setPlaying(false);
    setSaid(t('simSaidFinish', { date: finishText }));
  }, [playing, finished, finishText, t, setSaid]);
  const slipDays = result.end - result.baseEnd;
  const missed = result.rows.filter((r) => r.slip > 0);
  // UXG-1112-7 — the section's currency (ISO 4217, checked on save), else USD as before.
  const cur = str(d.currency) || 'USD';
  const curSymbol = fmt.currency(0, cur, { currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 }).replace(/[\d\s.,\u00a0\u202f]/g, '');
  const carryN = Number(carry);
  const carryCost = carry.trim() !== '' && Number.isFinite(carryN) && carryN > 0 ? fmt.currency(Math.round((slipDays / 7) * carryN), cur, { maximumFractionDigits: 0 }) : null;

  // Months along the axis, for orientation (#5779 B6: thinned, year on its own line).
  const ticks = useMemo(() => (start === null ? [] : monthTicks(start, scale).map((tk) => ({
    day: tk.day,
    label: fmt.date(new Date(start + tk.day * DAY_MS), { month: 'short', timeZone: 'UTC' }),
    ...(tk.year !== undefined ? { year: fmt.date(new Date(start + tk.day * DAY_MS), { year: 'numeric', timeZone: 'UTC' }) } : {}),
  }))), [start, scale, fmt]);

  const play = (): void => {
    if (playing) { setPlaying(false); setSaid(t('simSaidPaused', { date: dateAt(shown) })); return; }
    if (finished) setClock(0);
    setSaid('');
    setPlaying(true);
  };
  // The step that replaces the animation under reduced motion: on to the next missed lock
  // (the earliest one still ahead), else the finish.
  const ahead = missed.filter((r) => r.start > clock).sort((a, b) => a.start - b.start)[0];
  const step = (): void => {
    if (ahead) {
      setClock(ahead.start);
      setFocus(ahead.milestone.id);
      setSaid(t('simSaidMissed', { name: ahead.milestone.label, date: dateAt(ahead.start), count: ahead.slip }));
      return;
    }
    setClock(result.end);
    setSaid(t('simSaidFinish', { date: dateAt(result.end) }));
    focusNext.current = restartRef.current; // the step is disabled at the finish; Restart is enabled by this render
  };
  const restart = (): void => {
    setPlaying(false);
    setClock(0);
    setSaid('');
    focusNext.current = (still ? stepRef : playRef).current; // Restart is disabled at the start
  };
  const pickMissed = (id: string): void => { jump.current = true; setFocus(id); };
  const statusOf = (dec: PDecision): { word: string; tone: string } => {
    const s = result.decisions.get(dec.id);
    if (!s) return { word: '', tone: 'muted' };
    if (clock > 0 && s.made <= shown) return s.late > 0 ? { word: t('simDecidedLate', { count: s.late }), tone: 'warn' } : { word: t('simDecided'), tone: 'ok' };
    if (s.blockedBy.length > 0 && s.late > 0) return { word: t('simBlocked', { count: s.late }), tone: 'bad' };
    if (s.late > 0) return { word: t('simLate', { count: s.late }), tone: 'bad' };
    return { word: t('simOnTime'), tone: 'ok' };
  };
  // A lead time in weeks from a week up, in days below; and whether it is counted back from the lock.
  const leadText = (x: PDecision): string | null => {
    if (x.leadDays === null) return t('simLeadUnknown');
    if (!x.leadDays) return null;
    const lead = x.leadDays >= 7 ? t('simLeadWeeks', { count: Math.round(x.leadDays / 7) }) : t('simLeadDaysShort', { count: x.leadDays });
    return x.back ? t('simLeadBack', { lead }) : lead;
  };
  const nameOf = (id: string | null): string => {
    const x = id ? byId.get(id) : undefined;
    return x ? x.element || x.title : '';
  };

  const focusRow = result.rows.find((r) => r.milestone.id === focus);
  const focusDecisions = decisions.filter((x) => x.milestone === focus);
  const labelOf = (rows: PKeyed[], key: string): string => rows.find((k) => k.key === key)?.label ?? key;
  const labelOfMilestone = (id: string): string => milestones.find((m) => m.id === id)?.label ?? id;
  const [openPhase = '', openCategory = ''] = cell.split('|');
  const cellDecisions = cell ? decisions.filter((x) => x.phase === openPhase && x.category === openCategory) : [];
  const delayChoices = (extra: number[]): number[] => [...new Set([...SIM_DELAYS, ...extra])].sort((a, b) => a - b);
  const delayLabel = (n: number): string => (n === 0 ? t('simOnTime') : t('simLateDays', { count: n }));

  // One decision's row: what it is, when it falls due, its status, and how late it comes in.
  // `inCell`: a row in the grouped cell panel names its milestone, the panel the same decision also shows in (UXG-1112-8).
  const decisionRow = (x: PDecision, inCell = false): JSX.Element => {
    const s = result.decisions.get(x.id);
    const st = statusOf(x);
    const days = delayOf(x);
    const who = x.role ? labelOf(roles, x.role) : x.decider;
    const choices = x.options.length > 0 ? [...new Set([0, presetDelay(preset, x), days, ...x.options.map((o) => o.delayDays)])].sort((a, b) => a - b) : delayChoices([days]);
    return (
      <li key={x.id} className="fp-psim__decision">
        <div className="fp-psim__decmain">
          <p className="fp-psim__q">{x.element ? <span className="fp-psim__element">{x.element}. </span> : null}{x.title}</p>
          <p className="fp-psim__meta">
            {[inCell ? t('simForMilestone', { name: labelOfMilestone(x.milestone) }) : null, who, s ? t('simDecideBy', { date: dateAt(s.decideBy) }) : null, leadText(x), x.dependsOn.length > 0 ? t('simDependsOn', { ids: x.dependsOn.join(', ') }) : null, x.source || null].filter(Boolean).join(' · ')}
          </p>
          {s && s.blockedBy.length > 0 && s.late > 0 ? <p className="fp-psim__blocked">{t('simWaitingOn', { ids: s.blockedBy.map(nameOf).join(', ') })}</p> : null}
          {x.risk ? (
            <>
              <Button variant="quiet" className="fp-psim__risktoggle" aria-expanded={openRisk === x.id} onClick={() => setOpenRisk((o) => (o === x.id ? null : x.id))}>{t('simRisk')}</Button>
              {openRisk === x.id ? <p className="fp-psim__risk">{x.risk}</p> : null}
            </>
          ) : null}
        </div>
        <div className="fp-psim__decside">
          <span className={`fp-psim__chip fp-psim__chip--${st.tone}`}>{st.word}</span>
          <select aria-label={t('simLatenessFor', { name: x.element || x.title })} value={days} onChange={(e) => setOne(x.id, Number(e.target.value))}>
            {choices.map((n) => (
              <option key={n} value={n}>{x.options.find((o) => o.delayDays === n)?.label ?? delayLabel(n)}</option>
            ))}
          </select>
        </div>
      </li>
    );
  };
  // A list of decisions: the first LIST_FIRST, then "Show all".
  const decisionList = (id: string, rows: PDecision[]): JSX.Element => (
    <>
      <ul className="fp-psim__decisions" data-list={id}>{(showAll[id] ? rows : rows.slice(0, LIST_FIRST)).map((x) => decisionRow(x, id.startsWith('cell:')))}</ul>
      {rows.length > LIST_FIRST && !showAll[id] ? (
        <Button variant="quiet" className="fp-psim__ctl fp-psim__more" onClick={() => { revealed.current = id; setShowAll((v) => ({ ...v, [id]: true })); }}>{t('simShowAll', { count: rows.length })}</Button>
      ) : null}
    </>
  );
  // The cells with decisions, in reading order, for the arrow keys.
  const cellOrder = grouped ? phases.flatMap((p) => categories.map((c) => cellKey(p.key, c.key)).filter((k) => counts.has(k))) : [];
  const tabCell = cellOrder.includes(gridAt) ? gridAt : cellOrder.includes(cell) ? cell : cellOrder[0] ?? '';
  const onCellKey = (from: string, e: KeyboardEvent<HTMLButtonElement>): void => {
    const [p = '', c = ''] = from.split('|');
    const pi = phases.findIndex((x) => x.key === p);
    const ci = categories.findIndex((x) => x.key === c);
    // Left/right walk the row, up/down the column; each stops at the nearest cell with decisions.
    const seek = (dp: number, dc: number): string | undefined => {
      for (let i = pi + dp, j = ci + dc; i >= 0 && i < phases.length && j >= 0 && j < categories.length; i += dp, j += dc) {
        const k = cellKey(phases[i]?.key ?? '', categories[j]?.key ?? '');
        if (counts.has(k)) return k;
      }
      return undefined;
    };
    const next = e.key === 'ArrowRight' ? seek(0, 1) : e.key === 'ArrowLeft' ? seek(0, -1) : e.key === 'ArrowDown' ? seek(1, 0) : e.key === 'ArrowUp' ? seek(-1, 0)
      : e.key === 'Home' ? cellOrder[0] : e.key === 'End' ? cellOrder[cellOrder.length - 1] : undefined;
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    if (!next) return;
    setGridAt(next);
    const table = e.currentTarget.closest('table');
    [...(table?.querySelectorAll<HTMLButtonElement>('button[data-cell]') ?? [])].find((b) => b.dataset.cell === next)?.focus();
  };
  const openCell = (k: string): void => {
    setGridAt(k);
    setCell((v) => (v === k ? '' : k));
    openedCell.current = true;
  };

  return (
    <section ref={rootRef} className={`cms-public-section fp-section fp-psim${sx}`}>
      <div className="fp-shell">
        {str(d.eyebrow) || str(d.heading) || str(d.lede) ? (
          <header className="fp-head">
            {str(d.eyebrow) ? <p className="fp-eyebrow">{str(d.eyebrow)}</p> : null}
            {str(d.heading) ? <h2 id={headingSlug(stripHeadingEmphasis(str(d.heading)))} className="fp-head__title"><HeadingText text={str(d.heading)} /></h2> : null}
            {str(d.lede) ? <p className="fp-head__lede">{str(d.lede)}</p> : null}
          </header>
        ) : null}

        <div className="fp-psim__bar">
          {presets.length > 0 ? (
            <div className="fp-psim__presets" role="group" aria-label={t('simScenarios')}>
              {presets.map((p, i) => (
                <Button key={`${i}:${p.label}`} variant="quiet" className="fp-psim__preset" aria-pressed={i === presetIx} title={p.description} onClick={() => { setPresetIx(i); setSettings(freshSettings(p)); }}>{p.label}</Button>
              ))}
            </div>
          ) : null}
          <div className="fp-psim__controls" role="group" aria-label={t('simReplayLabel')}>
            {still ? null : (
              <Button ref={playRef} variant="quiet" className="fp-psim__ctl fp-psim__ctl--primary" onClick={play}>
                {playing ? t('simPause') : finished && clock > 0 ? t('simReplay') : clock > 0 ? t('simResume') : t('simPlay')}
              </Button>
            )}
            <Button ref={stepRef} variant="quiet" className={`fp-psim__ctl${still ? ' fp-psim__ctl--primary' : ''}`} onClick={step} disabled={playing || finished}>{ahead ? t('simNextMissed') : t('simToFinish')}</Button>
            <Button ref={restartRef} variant="quiet" className="fp-psim__ctl" onClick={restart} disabled={clock === 0}>{t('simRestart')}</Button>
          </div>
          <p className="sr-only" role="status">{said}</p>
          <label className="fp-psim__carry">
            <span>{t('simCarryLabel', { symbol: curSymbol })}</span>
            <input type="number" min={0} inputMode="numeric" placeholder="0" value={carry} onChange={(e) => setCarry(e.target.value)} />
          </label>
        </div>
        {preset?.description ? <p className="fp-psim__hint">{preset.description}</p> : null}
        {roles.length > 0 ? (
          <fieldset className="fp-psim__roles">
            <legend className="fp-psim__k">{t('simRolesTitle')}</legend>
            {roles.map((r) => (
              <label key={r.key} className="fp-psim__role">
                <span>{r.label}</span>
                <select value={settings.roles[r.key] ?? 0} onChange={(e) => setRole(r.key, Number(e.target.value))}>
                  {delayChoices([settings.roles[r.key] ?? 0]).map((n) => <option key={n} value={n}>{delayLabel(n)}</option>)}
                </select>
              </label>
            ))}
          </fieldset>
        ) : null}

        <div className={`fp-psim__summary${d.stickySummary === true ? ' fp-psim__summary--sticky' : ''}`}>
          {clock > 0 ? <div><p className="fp-psim__k">{t('simToday')}</p><p className="fp-psim__v">{dateAt(shown)}</p></div> : null}
          <div><p className="fp-psim__k">{str(d.finishLabel) || t('simFinish')}</p><p className="fp-psim__v">{dateAt(result.end)}</p></div>
          <div><p className="fp-psim__k">{t('simChange')}</p><p className={`fp-psim__v${slipDays > 0 ? ' fp-psim__v--late' : ''}`}>{slipDays > 0 ? t('simDaysLater', { count: slipDays }) : t('simOnSchedule')}</p></div>
          <div><p className="fp-psim__k">{t('simMissedLabel')}</p><p className="fp-psim__v">{missed.length}</p></div>
          <div><p className="fp-psim__k">{t('simLateLabel')}</p><p className="fp-psim__v">{t('simLateDecisions', { count: result.lateCount })} · {t('simLateOrders', { count: result.lateOrders })}</p></div>
          <div><p className="fp-psim__k">{t('simCostLabel')}</p><p className="fp-psim__v">{carryCost ?? <span className="fp-psim__muted">{t('simCostEmpty')}</span>}</p></div>
        </div>

        <div className="fp-psim__grid">
          <div className="fp-psim__side">
            <h3 className="fp-psim__title">{t('simMissedTitle')}</h3>
            {missed.length === 0 ? <p className="fp-psim__muted">{t('simMissedNone')}</p> : (
              <ul className="fp-psim__missed">
                {missed.map((r) => (
                  <li key={r.milestone.id} className="fp-psim__card fp-psim__card--late">
                    <div className="fp-psim__cardhead">
                      <Button variant="quiet" className="fp-psim__jump" onClick={() => pickMissed(r.milestone.id)}>{r.milestone.label}</Button>
                      <span className="fp-psim__chip fp-psim__chip--bad">{t('simDaysLater', { count: r.slip })}</span>
                    </div>
                    {r.driver ? <p className="fp-psim__meta">{t('simHeldBy', { name: nameOf(r.driver) })}</p> : null}
                    {r.milestone.rework ? <p className="fp-psim__rework fp-psim__rework--hit"><strong>{t('simIfLate')}</strong> {r.milestone.rework}</p> : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="fp-psim__muted">{t('simAdjustHint')}</p>
          </div>

          <div className="fp-psim__chart">
            <div className="fp-psim__axis" aria-hidden="true">
              <span />
              <span className="fp-psim__ticks">
                {ticks.map((tk) => <span key={tk.day} className="fp-psim__tick" style={{ insetInlineStart: `${(tk.day / scale) * 100}%` }}>{tk.label}{tk.year ? <span className="fp-psim__tick-year">{tk.year}</span> : null}</span>)}
              </span>
              <span />
            </div>
            <ol className="fp-psim__gantt" aria-label={t('simTimeline')}>
              {result.rows.map((r) => {
                const state = r.slip > 0 ? 'late' : r.late > 0 ? 'absorbed' : 'ok';
                const past = clock > 0 && shown >= r.end;
                return (
                  <li key={r.milestone.id} className={`fp-psim__row fp-psim__row--${state}${focus === r.milestone.id ? ' fp-psim__row--focus' : ''}${past ? ' fp-psim__row--past' : ''}`}>
                    <Button variant="quiet" className="fp-psim__rowbtn" aria-pressed={focus === r.milestone.id} onClick={() => setFocus(r.milestone.id)}>
                      <span className="fp-psim__label">{r.milestone.label}</span>
                      <span className="fp-psim__track" aria-hidden="true">
                        <span className="fp-psim__ghost" style={{ insetInlineStart: `${(r.milestone.startWeek * 7 / scale) * 100}%`, inlineSize: `${(r.milestone.weeks * 7 / scale) * 100}%` }} />
                        <span className="fp-psim__barfill" style={{ insetInlineStart: `${(r.start / scale) * 100}%`, inlineSize: `${((r.end - r.start) / scale) * 100}%` }} />
                        {clock > 0 ? <span className="fp-psim__now" style={{ insetInlineStart: `${(shown / scale) * 100}%` }} /> : null}
                      </span>
                      <span className="fp-psim__when">{dateAt(r.start)}{r.slip > 0 ? <span className="fp-psim__chip fp-psim__chip--bad"><span aria-hidden="true">{t('simSlipShort', { count: r.slip })}</span><span className="sr-only">{t('simDaysLater', { count: r.slip })}</span></span> : r.late > 0 ? <span className="fp-psim__chip fp-psim__chip--warn">{t('simAbsorbed')}</span> : null}</span>
                    </Button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        {grouped ? (
          <div className="fp-psim__cells">
            <h3 id={`${gridId}-h`} className="fp-psim__title">{t('simGridTitle')}</h3>
            <div className="fp-psim__gridwrap">
              <table className="fp-psim__table" aria-labelledby={`${gridId}-h`}>
                <thead>
                  <tr><td />{categories.map((c) => <th key={c.key} scope="col">{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {phases.map((p) => (
                    <tr key={p.key}>
                      <th scope="row">{p.label}</th>
                      {categories.map((c) => {
                        const k = cellKey(p.key, c.key);
                        const n = counts.get(k);
                        if (!n) return <td key={c.key} className="fp-psim__cell fp-psim__cell--empty"><span aria-hidden="true">·</span><span className="sr-only">{t('simCellNone')}</span></td>;
                        return (
                          <td key={c.key} className="fp-psim__cell">
                            <Button variant="quiet" className="fp-psim__cellbtn" data-cell={k} tabIndex={k === tabCell ? 0 : -1} aria-expanded={cell === k} aria-controls={`${gridId}-cell`} aria-label={t('simCellLabel', { phase: p.label, category: c.label, count: n.n, late: n.late })} onClick={() => openCell(k)} onKeyDown={(e) => onCellKey(k, e)}>
                              <span>{n.n}</span>{n.late > 0 ? <span className="fp-psim__chip fp-psim__chip--bad">{t('simCellLate', { count: n.late })}</span> : null}
                            </Button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cell ? (
              <div className="fp-psim__detail" id={`${gridId}-cell`}>
                <div className="fp-psim__detailhead">
                  <h3 ref={cellRef} tabIndex={-1} className="fp-psim__title">{t('simCellTitle', { phase: labelOf(phases, openPhase), category: labelOf(categories, openCategory) })}</h3>
                  <label className="fp-psim__role">
                    <span>{t('simCellLateness')}</span>
                    <select value={settings.cells[cell] ?? ''} onChange={(e) => setCellDelay(cell, e.target.value === '' ? null : Number(e.target.value))}>
                      <option value="">{t('simCellFollow')}</option>
                      {delayChoices(settings.cells[cell] !== undefined ? [settings.cells[cell] ?? 0] : []).map((n) => <option key={n} value={n}>{delayLabel(n)}</option>)}
                    </select>
                  </label>
                </div>
                {decisionList(`cell:${cell}`, cellDecisions)}
              </div>
            ) : <p className="fp-psim__muted">{t('simGridHint')}</p>}
          </div>
        ) : null}

        {focusRow ? (
          <div className="fp-psim__detail">
            <div className="fp-psim__detailhead">
              <h3 ref={detailRef} tabIndex={-1} className="fp-psim__title">{focusRow.milestone.label}</h3>
              <p className="fp-psim__muted">{t('simDetailDates', { start: dateAt(focusRow.start), end: dateAt(focusRow.end), count: focusRow.milestone.floatDays })}</p>
            </div>
            {focusRow.milestone.items.length > 0 ? (
              <p className="fp-psim__locks"><strong>{t('simMustLock')}</strong> {focusRow.milestone.items.join(' · ')}</p>
            ) : null}
            {focusRow.milestone.rework ? <p className={`fp-psim__rework${focusRow.slip > 0 ? ' fp-psim__rework--hit' : ''}`}><strong>{t('simIfLate')}</strong> {focusRow.milestone.rework}</p> : null}
            {focusDecisions.length === 0 ? <p className="fp-psim__muted">{t('simNoDecisions')}</p> : decisionList(`milestone:${focus}`, focusDecisions)}
          </div>
        ) : null}
        {str(d.note) ? <p className="fp-psim__muted fp-psim__foot">{str(d.note)}</p> : null}
      </div>
    </section>
  );
}
