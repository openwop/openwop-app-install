/**
 * ADR 0920 — CMS section styles: the presentation options a section may carry
 * (tone, split head) and the two data-driven pictures (the hero `plan` card and
 * the richText `chat`). Every field is optional; a section that sets none renders
 * exactly as before. Pictures are REAL TEXT (crawler = human, ADR 0593 §C9) and
 * INERT: what looks like a button or a chip is a styled span, never a control.
 */
import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { PauseIcon, PlayIcon } from '../../ui/icons/index.js';
import { countableStat } from './statNumber.js';
import { useLoopToggle } from './loopToggle.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const TONES = ['muted', 'inverse', 'accent'] as const;

/** The modifier classes for a section's `tone` and `head` (D1, D2). Unknown or
 *  absent values add nothing, so a stock section keeps its exact class list. */
export function sectionStyleClass(d: Record<string, unknown>): string {
  const tone = TONES.find((t) => t === d.tone);
  // ADR 1068 D3 — `headSize: 'sm'` is the smaller section-head clamp.
  return `${tone ? ` fp-tone fp-tone--${tone}` : ''}${d.head === 'split' ? ' fp-split' : ''}${d.headSize === 'sm' ? ' fp-head--sm' : ''}`;
}

const MOTIONS = ['none', 'reveal', 'stagger', 'rise', 'slide-start', 'slide-end', 'zoom'] as const;

/** ADR 1029 D2 — the scroll-motion classes for a section's `motion`. Unknown or
 *  absent values add nothing, so the page-load rise stays the default. */
export function sectionMotionClass(d: Record<string, unknown>): string {
  const motion = MOTIONS.find((m) => m === d.motion);
  return motion ? ` fp-motion fp-motion--${motion}` : '';
}

/** The hero's art directions, in the server's order: mirrors `HERO_VISUALS` in
 *  cmsService.ts (pinned by adr1029-mirror-parity, ADR 1050 D4). */
export const HERO_VISUALS = ['workflow', 'journey', 'run', 'film', 'image', 'none', 'plan', 'activity', 'hub', 'flow', 'receipt', 'apps', 'versus', 'fanout', 'phone', 'wall', 'tally', 'log', 'queue'] as const; // ADR 1080 D7: queue
export type HeroVisual = typeof HERO_VISUALS[number];

/** ADR 1038 D2 — mirrors the server's `HERO_EMPHASES` (pinned by adr1029-mirror-parity). */
const HERO_EMPHASES = ['accent', 'strike', 'underline', 'highlight'] as const;

/** ADR 1038 D2 — the hero's emphasis style as a section modifier (' fp-em--strike'),
 *  '' for the default accent, so a hero that never chose keeps its exact markup. */
export function heroEmphasisClass(d: Record<string, unknown>): string {
  const e = HERO_EMPHASES.find((x) => x === d.emphasis);
  return e && e !== 'accent' ? ` fp-em--${e}` : '';
}

/** A 0..1 fraction from authored data, or null when absent or not a number. */
export function fraction(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

/** ADR 1038 D8 — a flow step's styling state (mirrors the validator's
 *  FLOW_STATES; pinned by adr1029-mirror-parity). The words are the step's own
 *  `status`; the state picks the mark's shape: done is filled, waiting is a ring
 *  with a dot, idle is dashed. */
export const FLOW_STATES = ['idle', 'done', 'waiting'] as const;

export interface FlowStep { label: string; text?: ReactNode | undefined; status?: string | undefined; state?: string | undefined }

/** ADR 1038 D8 — a short process as an ordered list: each step's mark, label,
 *  status word and line of text, joined by a connector. The list is the real
 *  content; marks and connectors are decoration. `pulse` gives a waiting step
 *  the D5 attention ring (the hero only: it is timed from page load, so a flow
 *  further down would finish pulsing before anyone saw it). */
export function FlowSteps({ steps, pulse, numbered = false }: { steps: FlowStep[]; pulse: boolean; numbered?: boolean }): JSX.Element {
  const { t } = useTranslation('cms');
  // A step with a state but no status word still tells a screen reader its
  // state (the mark is aria-hidden, so it would otherwise be shape alone).
  const word: Record<string, string> = { idle: t('flowStateWordIdle'), done: t('flowStateWordDone'), waiting: t('flowStateWordWaiting') };
  return (
    <ol role="list" className="fp-flow__steps">
      {steps.map((st, i) => {
        const state = (FLOW_STATES as readonly string[]).includes(st.state ?? '') ? st.state : undefined;
        return (
          <li key={i} className={`fp-flow__step${state ? ` fp-flow__step--${state}` : ''}`} style={{ '--i': i } as CSSProperties}>
            {/* ADR 1064 P3c — a numbered rail puts the step number in its mark
                (decoration: the list is already ordered for assistive tech). */}
            <span className={`fp-flow__mark${pulse && state === 'waiting' ? ' fp-attention' : ''}`} aria-hidden="true">{numbered ? String(i + 1).padStart(2, '0') : null}</span>
            <span className="fp-flow__body">
              <strong className="fp-flow__label">{st.label}</strong>
              {st.status ? <span className="fp-flow__status">{st.status}</span> : state ? <span className="sr-only">{word[state]}</span> : null}
              {st.text ? <span className="fp-flow__text">{st.text}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * ADR 1064 P3c — the flow as a rail: numbered marks and, with `run`, each mark
 * lighting in turn on a 7 s loop. The loop is >5 s, so it carries the shared
 * pause control (WCAG 2.2.2), and hover or focus inside pauses it. It animates
 * a ring only, never opacity, so with reduced motion (no animation) every step
 * is fully shown. Without either option this is exactly the ADR 1038 D8 flow.
 */
export function FlowRail({ steps, pulse, numbered, run, className }: { steps: FlowStep[]; pulse: boolean; numbered: boolean; run: boolean; className: string }): JSX.Element {
  const loop = useLoopToggle();
  const cls = `${className}${numbered ? ' fp-flow--numbered' : ''}${run ? ' fp-flow--run' : ''}${run && loop.paused ? ' is-paused' : ''}`;
  return (
    <div className={cls}>
      <FlowSteps steps={steps} pulse={pulse} numbered={numbered} />
      {run ? loop.toggle : null}
    </div>
  );
}

/** ADR 1038 D8 — the hero's flow picture: an optional caption, then the steps.
 *  Null unless two labelled steps survive (the validator's rule). */
export function FlowFigure({ flow, row = false }: { flow: unknown; row?: boolean }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const f = obj(flow);
  const steps = list(f.nodes).map(obj)
    .map((n) => ({ label: str(n.label), text: str(n.text) || undefined, status: str(n.status) || undefined, state: str(n.state) || undefined }))
    .filter((n) => n.label);
  const captionId = useId();
  if (steps.length < 2) return null;
  return (
    <figure className={`fp-flow fp-flow--hero${row ? ' fp-flow--open' : ''}`} aria-labelledby={str(f.label) ? captionId : undefined} aria-label={str(f.label) ? undefined : t('flowFigureLabel')}>
      {str(f.label) ? <figcaption id={captionId} className="fp-flow__caption">{str(f.label)}</figcaption> : null}
      {/* ADR 1066 D1 — below the copy, the steps run in one row (the columns `flow` row). */}
      <FlowRail steps={steps} pulse numbered={f.numbered === true} run={f.run === true} className={row ? 'fp-flow__rail fp-flow--row' : 'fp-flow__rail'} />
    </figure>
  );
}

/** ADR 1038 D3 — a stat figure that counts up. Only a whole-number title counts;
 *  the real digits stay in the DOM, and the counting overlay is CSS (empty alt
 *  text), so a reader or a copy never meets a mid-count number. */
export function StatValue({ title }: { title: string }): JSX.Element {
  const n = countableStat(title);
  if (!n) return <>{title}</>;
  return <>{n.prefix}<span className="fp-count" style={{ '--to': n.value } as CSSProperties}>{n.value}</span>{n.suffix}</>;
}

/** A thin progress bar. Decorative: the adjacent text always states the
 *  progress, so colour is never the only signal (D3). */
export function ProgressBar({ value }: { value: number }): JSX.Element {
  return (
    <span className="fp-progress" aria-hidden="true">
      <span className="fp-progress__fill" style={{ inlineSize: `${Math.round(value * 100)}%` }} />
    </span>
  );
}

/** D3 — the hero's example plan card. A `figure` named "Example plan", with the
 *  friend's note folded into the name so a screen reader hears it once, in order. */
export function PlanCard({ plan }: { plan: unknown }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const p = obj(plan);
  const title = str(p.title);
  if (!title) return null;
  const progress = fraction(p.progress);
  const lines = list(p.lines).map((l) => ({ label: str(obj(l).label), text: str(obj(l).text) })).filter((l) => l.text);
  const chips = list(p.chips).map(str).filter(Boolean);
  const bubble = str(p.bubble);
  const label = bubble ? t('planFigureLabelWithNote', { note: bubble }) : t('planFigureLabel');
  return (
    <figure className="fp-plan" aria-label={label}>
      {/* The note is already in the figure's name; hidden here so it is heard once. */}
      {bubble ? <p className="fp-plan__bubble" aria-hidden="true">{bubble}</p> : null}
      <div className="fp-plan__card">
        {str(p.eyebrow) ? <p className="fp-plan__eyebrow">{str(p.eyebrow)}</p> : null}
        <div className="fp-plan__head">
          <p className="fp-plan__title">{title}</p>
          {str(p.meta) ? <p className="fp-plan__meta">{str(p.meta)}</p> : null}
        </div>
        {progress !== null ? <ProgressBar value={progress} /> : null}
        {str(p.progressNote) ? <p className="fp-plan__note">{str(p.progressNote)}</p> : null}
        {str(p.stepTitle) ? (
          <div className="fp-plan__step">
            {str(p.stepEyebrow) ? <p className="fp-plan__step-eyebrow">{str(p.stepEyebrow)}</p> : null}
            <p className="fp-plan__step-title">{str(p.stepTitle)}</p>
            {lines.map((l, i) => (
              <p key={i} className="fp-plan__line">{l.label ? <strong>{l.label} </strong> : null}{l.text}</p>
            ))}
            {str(p.action) || chips.length > 0 ? (
              <p className="fp-plan__actions">
                {str(p.action) ? <span className="fp-plan__action">{str(p.action)}</span> : null}
                {chips.length > 0 ? <span className="fp-plan__chips">{chips.join(' · ')}</span> : null}
              </p>
            ) : null}
          </div>
        ) : null}
        {str(p.note) ? (
          <p className="fp-plan__footer">
            {str(p.initial) ? <span className="fp-plan__avatar" aria-hidden="true">{str(p.initial).slice(0, 1)}</span> : null}
            {str(p.note)}
          </p>
        ) : null}
      </div>
    </figure>
  );
}

const ACTIVITY_STATES = ['done', 'waiting', 'approved', 'flagged'] as const;

/** ADR 1029 D5 — the hero's activity (approval) card: an ordered list of what
 *  happened, in a figure named by its title. Every row is real, inert text; a
 *  row's `status` is the author's own word (never colour alone) and its `state`
 *  only styles it. The rows rise in once on load, never on scroll, never looped.
 *
 *  ADR 1038 D1 — with `play: 'once'` (the hero's base-layer field) each row's mark
 *  and status pop in turn (`--i`), then a "4 of 5 done" count and a bar land and
 *  the `result` line last. The count's digit is real text; while the card plays
 *  the CSS draws it transparent and counts a `::after` overlay (empty alt text,
 *  so out of the accessibility tree) up to it; no reader and no no-motion path
 *  ever meets a mid-count number. */
export function ActivityCard({ activity, play, iconFor }: { activity: unknown; play?: unknown; iconFor?: (slug: string) => ReactNode }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const a = obj(activity);
  const items = list(a.items).map(obj).filter((i) => str(i.action));
  if (items.length === 0) return null;
  const title = str(a.title);
  const result = str(a.result);
  const playing = play === 'once';
  // ADR 1067 D3 — the checklist look: a browser bar, the count and bar on top, an icon per row.
  const checklist = a.style === 'checklist';
  const barLabel = checklist ? str(a.barLabel) : '';
  const settled = items.filter((i) => i.state === 'done' || i.state === 'approved').length;
  // The digit is spliced into the translated sentence so the overlay sits on it alone.
  // A translation that drops `{{done}}` falls back to the plain sentence (no overlay).
  const parts = t('activityCount', { done: '\u0000', total: items.length }).split('\u0000');
  const countText = parts.length === 2
    ? <>{parts[0]}<span className="fp-activity__n" style={{ '--to': settled } as CSSProperties}>{settled}</span>{parts[1]}</>
    : t('activityCount', { done: settled, total: items.length });
  const tally = (
    <div className="fp-activity__tally">
      <p className="fp-activity__count">{countText}</p>
      <ProgressBar value={settled / items.length} />
    </div>
  );
  return (
    <figure className={`fp-activity${playing ? ' fp-activity--play' : ''}${checklist ? ' fp-activity--checklist' : ''}`} aria-label={title || t('activityFigureLabel')} style={playing ? { '--rows': items.length } as CSSProperties : undefined}>
      {barLabel ? (
        <p className="fp-activity__bar">
          <span className="fp-activity__dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="fp-activity__address">{barLabel}</span>
        </p>
      ) : null}
      {checklist ? (
        <div className="fp-activity__head">
          {title ? <p className="fp-activity__title" aria-hidden="true">{title}</p> : null}
          {tally}
        </div>
      ) : title ? <p className="fp-activity__title" aria-hidden="true">{title}</p> : null}
      <ol role="list" className="fp-activity__list">
        {items.map((i, n) => {
          const state = ACTIVITY_STATES.find((x) => x === i.state);
          return (
            <li key={n} className={`fp-activity__row${state ? ` fp-activity__row--${state}` : ''}`} style={playing ? { '--i': n } as CSSProperties : undefined}>
              {checklist && str(i.icon) && iconFor?.(str(i.icon))
                ? <span className="fp-activity__icon" aria-hidden="true">{iconFor(str(i.icon))}</span>
                : <span className="fp-activity__mark" aria-hidden="true" />}
              <span className="fp-activity__body">
                <span className="fp-activity__line">
                  {str(i.actor) ? <strong className="fp-activity__actor">{str(i.actor)}</strong> : null}
                  {str(i.actor) ? ' ' : null}
                  <span className="fp-activity__action">{str(i.action)}</span>
                </span>
                {str(i.meta) ? <span className="fp-activity__meta">{str(i.meta)}</span> : null}
              </span>
              {str(i.status) ? <span className="fp-activity__status">{str(i.status)}</span> : null}
            </li>
          );
        })}
      </ol>
      {playing && !checklist ? tally : null}
      {result ? <p className="fp-activity__result">{result}</p> : null}
    </figure>
  );
}

/** ADR 1029 D5 — a strip of names (tools, logos as words) that drifts sideways.
 *  The first list is the real, readable one; the second is a visual copy for a
 *  seamless loop, hidden from assistive tech and from focus. A visible button
 *  pauses it (WCAG 2.2.2), as do hover and keyboard focus; with reduced motion
 *  the copy is not drawn and the list wraps, still. */
export function Marquee({ items, cards }: { items: string[]; cards?: ReactNode[] }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const [paused, setPaused] = useState(false);
  const copyRef = useRef<HTMLUListElement>(null);
  // React 18 has no `inert` prop (the MermaidDiagram precedent): set it before paint.
  useLayoutEffect(() => { copyRef.current?.setAttribute('inert', ''); });
  if (items.length === 0 && !(cards && cards.length > 0)) return null;
  const row = (copy: boolean): JSX.Element => (
    <ul role="list" className="fp-marquee__list" {...(copy ? { 'aria-hidden': true, ref: copyRef } : {})}>
      {cards && cards.length > 0
        // ADR 1037 — app cards (picture + name + line) in place of bare names.
        ? cards.map((card, i) => <li key={i} className="fp-marquee__item fp-marquee__item--card">{card}</li>)
        : items.map((x, i) => <li key={i} className="fp-marquee__item">{x}</li>)}
    </ul>
  );
  return (
    <div className={`fp-marquee${paused ? ' is-paused' : ''}`}>
      {/* ADR 1068 D1 — a card strip at rest is one row that scrolls sideways, so the
          scroller is a named, focusable region (keyboard users can scroll it). */}
      <div
        className="fp-marquee__viewport"
        {...(cards && cards.length > 0 ? { role: 'region', tabIndex: 0, 'aria-label': t('marqueeRegion') } : {})}
      >
        <div className="fp-marquee__track">
          {row(false)}
          {row(true)}
        </div>
      </div>
      {/* The label says what the button will do; no aria-pressed as well, which
          would announce a pressed "Play" (ARIA APG: change the label OR the state). */}
      <Button variant="quiet" size="sm" className="fp-marquee__toggle" onClick={() => setPaused((p) => !p)}>
        {paused ? <PlayIcon size={14} aria-hidden /> : <PauseIcon size={14} aria-hidden />}
        {paused ? t('marqueePlay') : t('marqueePause')}
      </Button>
    </div>
  );
}

/** D5 — a conversation picture beside a richText section's copy. */
export function ChatCard({ chat }: { chat: unknown }): JSX.Element | null {
  const c = obj(chat);
  const title = str(c.title);
  const messages = list(c.messages)
    .map((m) => ({ from: obj(m).from === 'person' ? 'person' : 'guide', text: str(obj(m).text) }))
    .filter((m) => m.text);
  if (!title || messages.length === 0) return null;
  const proposal = obj(c.proposal);
  const hasProposal = Boolean(str(proposal.text));
  return (
    <figure className="fp-chat" aria-label={title}>
      <div className="fp-chat__head">
        <span className="fp-chat__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <span className="fp-chat__who">
          <span className="fp-chat__title">{title}</span>
          {str(c.subtitle) ? <span className="fp-chat__subtitle">{str(c.subtitle)}</span> : null}
        </span>
        {str(c.badge) ? <span className="fp-chat__badge">{str(c.badge)}</span> : null}
      </div>
      <div className="fp-chat__body">
        {messages.map((m, i) => {
          const last = i === messages.length - 1;
          return (
            <div key={i} className={`fp-chat__msg fp-chat__msg--${m.from}`}>
              <p>{m.text}</p>
              {last && m.from === 'guide' && hasProposal ? <Proposal p={proposal} /> : null}
            </div>
          );
        })}
      </div>
      {str(c.placeholder) ? <p className="fp-chat__input">{str(c.placeholder)}</p> : null}
    </figure>
  );
}

function Proposal({ p }: { p: Record<string, unknown> }): JSX.Element {
  return (
    <div className="fp-chat__proposal">
      {str(p.label) ? <p className="fp-chat__proposal-label">{str(p.label)}</p> : null}
      <p className="fp-chat__proposal-text">{str(p.text)}</p>
      {str(p.accept) || str(p.decline) ? (
        <p className="fp-chat__proposal-actions">
          {str(p.accept) ? <span className="fp-chat__accept">{str(p.accept)}</span> : null}
          {str(p.decline) ? <span className="fp-chat__decline">{str(p.decline)}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/** D4 — the small drawings a `panels` item may carry (closed set). Decorative. */
export function PanelArt({ kind }: { kind: string }): JSX.Element | null {
  if (kind === 'full-week') {
    return (
      <svg className="fp-panel__art" viewBox="0 0 220 18" aria-hidden="true" focusable="false">
        {[0, 44, 82, 132, 170].map((x, i) => <rect key={i} x={x} y="1" width={[40, 34, 46, 34, 40][i]} height="16" rx="2" className="fp-art-block" />)}
        <rect x="212" y="1" width="8" height="16" rx="2" className="fp-art-accent" />
      </svg>
    );
  }
  if (kind === 'feed') {
    return (
      <svg className="fp-panel__art" viewBox="0 0 120 30" aria-hidden="true" focusable="false">
        <circle cx="12" cy="18" r="2.5" className="fp-art-dot" /><circle cx="20" cy="10" r="3" className="fp-art-dot" />
        <rect x="34" y="3" width="44" height="24" rx="5" className="fp-art-frame" />
        <circle cx="88" cy="8" r="3.5" className="fp-art-dot" /><circle cx="100" cy="14" r="2.5" className="fp-art-dot" />
      </svg>
    );
  }
  if (kind === 'solo') {
    return (
      <svg className="fp-panel__art" viewBox="0 0 120 30" aria-hidden="true" focusable="false">
        <circle cx="30" cy="15" r="7" className="fp-art-ghost" />
        <circle cx="60" cy="15" r="9" className="fp-art-block" />
        <circle cx="90" cy="15" r="7" className="fp-art-ghost" />
      </svg>
    );
  }
  return null;
}
