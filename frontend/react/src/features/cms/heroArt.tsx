/**
 * ADR 1060 — the illustrated hero visuals. Each is a `<figure>` named by its
 * authored caption (or a stock name), holding REAL, INERT text (crawler =
 * human, ADR 0593 §C9): what looks like a button or a chip is a styled span,
 * never a control. Slots, wires, marks and bars are decoration (`aria-hidden`).
 *
 * Every word comes from the CMS fields (`heroArtSpec.ts`); a visual draws only
 * when it has enough to show, under the same rule the crawler text uses
 * (`backend/…/publishing/heroArtText.ts`). Colours are theme tokens; motion is
 * CSS behind the ADR 1038 guard (no-preference, not `data-reduce-motion`, not
 * section `motion: 'none'`), and the resting state is the finished picture.
 */
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { artCap, artEnum, type HeroArtVisual } from './heroArtSpec.js';
import { useLoopToggle } from './loopToggle.js';

export { isHeroArtVisual } from './heroArtSpec.js';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
/** A list field's items, capped at the spec's cap (an overlay is not re-validated at render). */
const items = (visual: HeroArtVisual, data: Record<string, unknown>, key: string): Record<string, unknown>[] =>
  (Array.isArray(data[key]) ? (data[key] as unknown[]) : []).slice(0, artCap(visual, key)).map(obj);

/** P1 — a receipt printing out of a slot, a stamp landing on it last. The lines
 *  are a description list (what, then how much); a highlighted line only
 *  changes its amount's colour, the words carry the meaning. */
function ReceiptFigure({ data }: { data: Record<string, unknown> }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const lines = items('receipt', data, 'lines').filter((l) => str(l.label) && str(l.amount));
  if (lines.length === 0) return null;
  const totalLabel = str(data.totalLabel);
  const totalAmount = str(data.totalAmount);
  return (
    <figure className="fp-receipt" aria-label={str(data.label) || t('receiptFigureLabel')}>
      <span className="fp-receipt__slot" aria-hidden="true" />
      <div className="fp-receipt__clip">
        <div className="fp-receipt__paper">
          {str(data.title) ? <p className="fp-receipt__title">{str(data.title)}</p> : null}
          {str(data.subtitle) ? <p className="fp-receipt__sub">{str(data.subtitle)}</p> : null}
          <dl className="fp-receipt__lines">
            {lines.map((l, i) => (
              <div key={i} className={`fp-receipt__line${l.state === 'highlight' ? ' fp-receipt__line--highlight' : ''}`}>
                <dt>{str(l.label)}</dt>
                <dd>{str(l.amount)}</dd>
              </div>
            ))}
          </dl>
          {totalLabel || totalAmount ? (
            <p className="fp-receipt__total"><span>{totalLabel}</span><span>{totalAmount}</span></p>
          ) : null}
          {str(data.stamp) ? <p className="fp-receipt__stamp">{str(data.stamp)}</p> : null}
        </div>
      </div>
    </figure>
  );
}

/** A value from the spec's enum at `path`, or undefined (unknown values style nothing). */
const pick = (visual: HeroArtVisual, v: unknown, ...path: string[]): string | undefined => artEnum(visual, ...path).find((x) => x === v);

/** P2 — the same app for each client, one at a time: its own name, address and
 *  accent bar, a heading and up to three rows with a status word. Two or more
 *  cross-fade on the motion path (with a pause button); still, they fan, the
 *  first in front and each later card's bar showing above it (ADR 1066 AGEN-01). */
const ROWS_CAP = 3; // the spec's apps.items.rows cap

function AppsFigure({ data }: { data: Record<string, unknown> }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const loop = useLoopToggle();
  const apps = items('apps', data, 'items').filter((a) => str(a.name));
  if (apps.length === 0) return null;
  const looping = apps.length > 1;
  return (
    <figure
      className={`fp-apps${looping ? ' fp-apps--loop' : ''}${loop.paused ? ' is-paused' : ''}`}
      aria-label={str(data.label) || t('appsFigureLabel')}
      style={{ '--n': apps.length } as CSSProperties}
    >
      <ul className="fp-apps__stack">
        {apps.map((a, i) => {
          const accent = pick('apps', a.accent, 'items', 'accent') ?? 'accent';
          const rows = (Array.isArray(a.rows) ? a.rows : []).slice(0, ROWS_CAP).map(obj).filter((r) => str(r.text));
          return (
            <li key={i} className={`fp-apps__app fp-apps__app--${accent}`} style={{ '--i': i } as CSSProperties}>
              <p className="fp-apps__bar">
                <span className="fp-apps__mark" aria-hidden="true" />
                <span className="fp-apps__name">{str(a.name)}</span>
                {str(a.address) ? <span className="fp-apps__address">{str(a.address)}</span> : null}
              </p>
              <div className="fp-apps__body">
                <span className="fp-apps__side" aria-hidden="true"><i /><i /><i /><i /></span>
                <div className="fp-apps__main">
                  {str(a.heading) ? <p className="fp-apps__heading">{str(a.heading)}</p> : null}
                  {rows.length > 0 ? (
                    <ul className="fp-apps__rows">
                      {rows.map((r, j) => {
                        const state = pick('apps', r.state, 'items', 'rows', 'state');
                        return (
                          <li key={j} className={`fp-apps__row${state ? ` fp-apps__row--${state}` : ''}`}>
                            <span>{str(r.text)}</span>
                            {str(r.status) ? <span className="fp-apps__pill">{str(r.status)}</span> : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {str(data.chip) ? <p className="fp-apps__chip">{str(data.chip)}</p> : null}
      {looping ? loop.toggle : null}
    </figure>
  );
}

/** P3 — before and after: the "before" pane's items scattered as loose chips over
 *  tangled wires (one failing), the "after" pane's items snapped into tiles, the
 *  divider between. Both sides are real lists; the wires are decoration. The
 *  chips jitter and the wires crawl on the motion path, looping, with a pause
 *  button; still, the chips sit at their places. */
function VersusFigure({ data }: { data: Record<string, unknown> }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const loop = useLoopToggle();
  const side = (key: 'before' | 'after'): { label: string; items: string[] } => {
    const s = obj(data[key]);
    return { label: str(s.label), items: (Array.isArray(s.items) ? s.items : []).slice(0, SIDE_CAP).map(obj).map((i) => str(i.label)).filter(Boolean) };
  };
  const before = side('before');
  const after = side('after');
  if (before.items.length === 0 || after.items.length === 0) return null;
  return (
    <figure className={`fp-versus fp-versus--loop${loop.paused ? ' is-paused' : ''}`} aria-label={str(data.label) || t('versusFigureLabel')}>
      <div className="fp-versus__panes">
        <div className="fp-versus__pane fp-versus__pane--before">
          <svg className="fp-versus__wires" viewBox="0 0 400 312" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <path className="fp-versus__wire" d="M70 50 C 200 0, 120 200, 300 70 S 120 250, 90 250" />
            <path className="fp-versus__wire" d="M310 70 C 260 180, 380 200, 300 250 S 60 160, 90 250" />
            <path className="fp-versus__wire fp-versus__wire--broken" d="M70 50 C 40 150, 260 140, 200 160" />
            <path className="fp-versus__wire" d="M200 160 C 300 120, 340 250, 300 250" />
          </svg>
          <ul className="fp-versus__chips">
            {before.items.map((x, i) => <li key={i} className="fp-versus__chip">{x}</li>)}
          </ul>
          {before.label ? <p className="fp-versus__label">{before.label}</p> : null}
        </div>
        {str(data.divider) ? <p className="fp-versus__vs">{str(data.divider)}</p> : <span className="fp-versus__vs" aria-hidden="true" />}
        <div className="fp-versus__pane fp-versus__pane--after">
          <ul className="fp-versus__tiles">
            {after.items.map((x, i) => <li key={i} className="fp-versus__tile" style={{ '--i': i } as CSSProperties}>{x}</li>)}
          </ul>
          {after.label ? <p className="fp-versus__label fp-versus__label--after">{after.label}</p> : null}
        </div>
      </div>
      {loop.toggle}
    </figure>
  );
}

const SIDE_CAP = 6; // the spec's versus.before.items / after.items cap

/** P4 — a source document, a dashed connector, and up to three outputs fanning
 *  in from it, each with a check (a word and a meter) and a status word. An
 *  output in `waiting` gets a scan sweep and its status in the attention colour;
 *  `done` fills its meter. The words are real text; lines, meters and the sweep
 *  are decoration. The outputs fan in on a loop (with a pause button). */
function FanoutFigure({ data }: { data: Record<string, unknown> }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const loop = useLoopToggle();
  const outputs = items('fanout', data, 'outputs').filter((o) => str(o.title));
  if (!str(data.source) || outputs.length === 0) return null;
  return (
    <figure className={`fp-fanout fp-fanout--loop${loop.paused ? ' is-paused' : ''}`} aria-label={str(data.label) || t('fanoutFigureLabel')}>
      <div className="fp-fanout__stage">
        <div className="fp-fanout__doc fp-fanout__source">
          <p className="fp-fanout__title">{str(data.source)}</p>
          <span className="fp-fanout__lines" aria-hidden="true"><b /><i /><i /><i /><i /><i /></span>
        </div>
        <span className="fp-fanout__wire" aria-hidden="true" />
        <ul className="fp-fanout__outputs">
          {outputs.map((o, i) => {
            const state = pick('fanout', o.state, 'outputs', 'state');
            return (
              <li key={i} className={`fp-fanout__doc fp-fanout__output${state ? ` fp-fanout__output--${state}` : ''}`} style={{ '--i': i } as CSSProperties}>
                {state === 'waiting' ? <span className="fp-fanout__scan" aria-hidden="true" /> : null}
                <p className="fp-fanout__head">
                  <span className="fp-fanout__title">{str(o.title)}</span>
                  {str(o.status) ? <span className="fp-fanout__status">{str(o.status)}</span> : null}
                </p>
                <span className="fp-fanout__lines" aria-hidden="true"><b /><i /><i /></span>
                {str(o.check) ? (
                  <p className="fp-fanout__check">{str(o.check)}<span className="fp-fanout__meter" aria-hidden="true"><span /></span></p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      {loop.toggle}
    </figure>
  );
}

/** P5 — a phone's lock screen: the time and day, notifications arriving one by
 *  one, and a last one that waits for you with two inert choices. An ordered
 *  list of real text; the phone itself is the frame. The notifications arrive
 *  on a 12s loop (with a pause button); still, they all show. */
function PhoneFigure({ data }: { data: Record<string, unknown> }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const loop = useLoopToggle();
  const notes = items('phone', data, 'notes').filter((n) => str(n.text));
  const reply = obj(data.reply);
  const hasReply = Boolean(str(reply.text));
  if (notes.length === 0 && !hasReply) return null;
  const head = (n: Record<string, unknown>): JSX.Element | null => (str(n.title) || str(n.time)
    ? <p className="fp-phone__head"><span>{str(n.title)}</span>{str(n.time) ? <span>{str(n.time)}</span> : null}</p>
    : null);
  return (
    <figure className={`fp-phone fp-phone--loop${loop.paused ? ' is-paused' : ''}`} aria-label={str(data.label) || t('phoneFigureLabel')}>
      <div className="fp-phone__body">
        <div className="fp-phone__screen">
          {str(data.time) ? <p className="fp-phone__clock">{str(data.time)}</p> : null}
          {str(data.day) ? <p className="fp-phone__day">{str(data.day)}</p> : null}
          <ol className="fp-phone__notes">
            {notes.map((n, i) => (
              <li key={i} className="fp-phone__note" style={{ '--i': i } as CSSProperties}>
                {head(n)}
                <p className="fp-phone__text">{str(n.text)}</p>
              </li>
            ))}
            {hasReply ? (
              <li className="fp-phone__note fp-phone__note--reply" style={{ '--i': notes.length } as CSSProperties}>
                {head(reply)}
                <p className="fp-phone__text">{str(reply.text)}</p>
                {str(reply.primary) || str(reply.secondary) ? (
                  <p className="fp-phone__actions">
                    {str(reply.primary) ? <span className="fp-phone__primary">{str(reply.primary)}</span> : null}
                    {str(reply.secondary) ? <span className="fp-phone__secondary">{str(reply.secondary)}</span> : null}
                  </p>
                ) : null}
              </li>
            ) : null}
          </ol>
        </div>
      </div>
      {loop.toggle}
    </figure>
  );
}

/** P6 — two workspaces side by side, each a title, a row of member dots and its
 *  documents, with a striped wall and a lock between them and a document that
 *  bounces off the wall (on a loop, pausable). The titles and documents are real
 *  lists; members, wall, lock and the bouncing document are decoration. */
function WallFigure({ data }: { data: Record<string, unknown> }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const loop = useLoopToggle();
  const spaces = items('wall', data, 'spaces').filter((s) => str(s.title));
  if (spaces.length < 2) return null;
  return (
    <figure className={`fp-wall fp-wall--loop${loop.paused ? ' is-paused' : ''}`} aria-label={str(data.label) || t('wallFigureLabel')}>
      <div className="fp-wall__stage">
        <ul className="fp-wall__spaces">
          {spaces.map((s, i) => {
            const members = typeof s.members === 'number' ? Math.min(MEMBERS_MAX, Math.max(0, Math.floor(s.members))) : 0;
            const docs = (Array.isArray(s.docs) ? s.docs : []).slice(0, DOCS_CAP).map(obj).map((d) => str(d.label)).filter(Boolean);
            return (
              <li key={i} className="fp-wall__space">
                <p className="fp-wall__title">{str(s.title)}</p>
                {members > 0 ? <span className="fp-wall__who" aria-hidden="true">{Array.from({ length: members }, (_, j) => <i key={j} />)}</span> : null}
                {docs.length > 0 ? <ul className="fp-wall__docs">{docs.map((d, j) => <li key={j} className="fp-wall__doc">{d}</li>)}</ul> : null}
              </li>
            );
          })}
        </ul>
        <span className="fp-wall__wall" aria-hidden="true" />
        <span className="fp-wall__bounce" aria-hidden="true" />
        <span className="fp-wall__lock" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" focusable="false"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
        </span>
      </div>
      {loop.toggle}
    </figure>
  );
}

const MEMBERS_MAX = 6; // the spec's wall.spaces.members max
const DOCS_CAP = 4; // the spec's wall.spaces.docs cap

/** P7 — up to four big numbers, each with what it counts and a bar. The number
 *  and its label are real text; the bar is decoration (its fill, 0–1, defaults
 *  to full) and grows once on load; the state only colours the label and bar. */
function TallyFigure({ data }: { data: Record<string, unknown> }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const cards = items('tally', data, 'items').filter((c) => str(c.value) && str(c.label));
  if (cards.length === 0) return null;
  return (
    <figure className="fp-tally" aria-label={str(data.label) || t('tallyFigureLabel')}>
      <ul className="fp-tally__cards">
        {cards.map((c, i) => {
          const state = pick('tally', c.state, 'items', 'state');
          const fill = typeof c.fill === 'number' && Number.isFinite(c.fill) ? Math.min(1, Math.max(0, c.fill)) : 1;
          return (
            <li key={i} className={`fp-tally__card${state ? ` fp-tally__card--${state}` : ''}`} style={{ '--i': i } as CSSProperties}>
              <p className="fp-tally__value">{str(c.value)}</p>
              <p className="fp-tally__label">{str(c.label)}</p>
              <span className="fp-tally__bar" aria-hidden="true"><span style={{ inlineSize: `${Math.round(fill * 100)}%` }} /></span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

/** ADR 1064 P3d — a recorded run's log: a title bar, then one line per event
 *  (time, event, detail) as real text, coloured by state (done green, waiting
 *  amber). On the motion path the lines arrive once, in order, and a cursor
 *  blinks four times (under the WCAG 2.2.2 five seconds); without motion every
 *  line is simply there. Nothing loops, so there is no pause control. */
function LogFigure({ data }: { data: Record<string, unknown> }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const lines = items('log', data, 'lines').filter((l) => str(l.event));
  if (lines.length === 0) return null;
  return (
    <figure className="fp-log" aria-label={str(data.label) || t('heroVisualLog')}>
      <div className="fp-log__bar" aria-hidden="true">
        <span className="fp-log__dot" /><span className="fp-log__dot" /><span className="fp-log__dot" />
        {str(data.title) ? <span className="fp-log__title">{str(data.title)}</span> : null}
      </div>
      <ol className="fp-log__lines">
        {lines.map((l, i) => {
          const state = pick('log', l.state, 'lines', 'state');
          return (
            <li key={i} className={`fp-log__line${state ? ` fp-log__line--${state}` : ''}`} style={{ '--i': i } as CSSProperties}>
              {str(l.time) ? <span className="fp-log__time">{str(l.time)}</span> : null}
              <span className="fp-log__event">{str(l.event)}</span>
              {str(l.detail) ? <span className="fp-log__detail">{str(l.detail)}</span> : null}
              {i === lines.length - 1 ? <span className="fp-log__cursor" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </figure>
  );
}

/** The hero's illustrated visual for `visual`, from its data, or null. */
export function HeroArtFigure({ visual, data }: { visual: HeroArtVisual; data: unknown }): JSX.Element | null {
  const d = obj(data);
  switch (visual) {
    case 'receipt': return <ReceiptFigure data={d} />;
    case 'apps': return <AppsFigure data={d} />;
    case 'versus': return <VersusFigure data={d} />;
    case 'fanout': return <FanoutFigure data={d} />;
    case 'phone': return <PhoneFigure data={d} />;
    case 'wall': return <WallFigure data={d} />;
    case 'tally': return <TallyFigure data={d} />;
    case 'log': return <LogFigure data={d} />;
  }
}
