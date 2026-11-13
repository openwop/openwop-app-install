/**
 * ADR 1080 — public renderers for the design-led site sections, plus the hero
 * `queue` picture and the richText `card` picture. Plain text only: no raw HTML,
 * links through `CtaLink` (the same guard as every other section).
 */
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Section } from './cmsClient.js';
import { assetUrl } from './cmsClient.js';
import { headingSlug } from './headingSlug.js';
import { HeadingText, stripHeadingEmphasis } from './headingEmphasis.js';
import { CtaLink } from './CtaLink.js';
import { useFormat } from '../../i18n/useFormat.js';
import { Button } from '../../ui/Button.js';
import { ProjectSimulator } from './ProjectSimulator.js';
import { computeGaps, computeMargin } from './worksheetMath.js';
import './designSections.css';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);
type Raw = Record<string, unknown>;
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((x): x is Raw => typeof x === 'object' && x !== null) : []);
const TONES = ['ok', 'warn', 'bad', 'muted'] as const;
const toneOf = (v: unknown): string => TONES.find((t) => t === v) ?? 'muted';

const DAY_MS = 86_400_000;

/** A field as a non-negative number, or null when blank or invalid. */
export function parseCount(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * ADR 1080 D2 — work back from the day an item is needed. Lead time plus float
 * sets the order date; approval time before that sets the decision date. Fixed
 * UTC arithmetic. Any missing value gives null: the page shows no date rather
 * than a guess.
 */
export function computeDates(needISO: string, leadWeeks: number | null, floatDays: number | null, approveDays: number | null): { orderBy: Date; decideBy: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(needISO) || leadWeeks === null || floatDays === null || approveDays === null) return null;
  const need = Date.parse(`${needISO}T00:00:00Z`);
  if (Number.isNaN(need)) return null;
  const order = need - (leadWeeks * 7 + floatDays) * DAY_MS;
  return { orderBy: new Date(order), decideBy: new Date(order - approveDays * DAY_MS) };
}

function Head({ d }: { d: Raw }): JSX.Element | null {
  const heading = str(d.heading);
  if (!str(d.eyebrow) && !heading && !str(d.lede)) return null;
  return (
    <header className="fp-head">
      {str(d.eyebrow) ? <p className="fp-eyebrow">{str(d.eyebrow)}</p> : null}
      {heading ? <h2 id={headingSlug(stripHeadingEmphasis(heading))} className="fp-head__title"><HeadingText text={heading} /></h2> : null}
      {str(d.lede) ? <p className="fp-head__lede">{str(d.lede)}</p> : null}
    </header>
  );
}

function Chip({ status, tone }: { status: string; tone: unknown }): JSX.Element {
  return <span className={`fp-status fp-status--${toneOf(tone)}`}>{status}</span>;
}

/** ADR 1080 D1. */
function StatusTable({ d, sx }: { d: Raw; sx: string }): JSX.Element {
  const { t } = useTranslation('cms');
  const columns = strings(d.columns);
  const body = rows(d.rows);
  const hasStatus = body.some((r) => str(r.status));
  // #5765 — a ruled list under the head; with `head: 'split'` the head and the
  // list take the first column and the table the second. Unset, the markup is
  // unchanged (a fragment around the head alone).
  const points = strings(d.points);
  const intro = (
    <>
      <Head d={d} />
      {points.length > 0 ? <ul role="list" className="fp-stable__points">{points.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
    </>
  );
  return (
    <section className={`cms-public-section fp-section fp-stable${sx}`}>
      <div className="fp-shell">
        {d.head === 'split' ? <div className="fp-stable__intro">{intro}</div> : intro}
        <div className="fp-stable__frame">
          {str(d.label) ? <p className="fp-stable__label">{str(d.label)}</p> : null}
          <div className="fp-stable__scroll" tabIndex={0} role="region" aria-label={str(d.heading) || str(d.label) || t('sectionType_statusTable')}>
            <table className="fp-stable__table">
              <thead><tr>
                {columns.map((c, i) => <th key={i} scope="col">{c}</th>)}
                {hasStatus ? <th scope="col">{t('designStatusColumn')}</th> : null}
              </tr></thead>
              <tbody>
                {body.map((r, i) => (
                  <tr key={i}>
                    {columns.map((_, j) => <td key={j}>{strings(r.cells)[j] ?? ''}</td>)}
                    {hasStatus ? <td>{str(r.status) ? <Chip status={str(r.status)} tone={r.tone} /> : null}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return <label className="fp-calc__field"><span>{label}</span>{children}</label>;
}

/** ADR 1080 D2. */
function DateCalc({ d, sx }: { d: Raw; sx: string }): JSX.Element {
  const { t } = useTranslation('cms');
  const fmt = useFormat();
  const initial = (v: unknown): string => (typeof v === 'number' ? String(v) : '');
  const [need, setNeed] = useState(str(d.needDate));
  const [lead, setLead] = useState(initial(d.leadWeeks));
  const [float, setFloat] = useState(initial(d.floatDays));
  const [approve, setApprove] = useState(initial(d.approveDays));
  const leadN = parseCount(lead);
  const floatN = parseCount(float);
  const approveN = parseCount(approve);
  const result = computeDates(need, leadN, floatN, approveN);
  const show = (date: Date | undefined): string => (date ? fmt.date(date, { dateStyle: 'medium', timeZone: 'UTC' }) : t('designDateNone'));
  const label = (key: string, fallback: string): string => str(d[key]) || t(fallback);
  return (
    <section className={`cms-public-section fp-section fp-calc${sx}`}>
      <div className="fp-shell">
        <Head d={d} />
        <div className="fp-calc__grid">
          <div className="fp-calc__inputs">
            <Field label={label('needLabel', 'designDateNeed')}><input type="date" value={need} onChange={(e) => setNeed(e.target.value)} /></Field>
            <Field label={label('leadLabel', 'designDateLead')}><input type="number" min={0} inputMode="numeric" placeholder={t('designDateUnknownShort')} value={lead} onChange={(e) => setLead(e.target.value)} /></Field>
            <Field label={label('floatLabel', 'designDateFloat')}><input type="number" min={0} inputMode="numeric" value={float} onChange={(e) => setFloat(e.target.value)} /></Field>
            <Field label={label('approveLabel', 'designDateApprove')}><input type="number" min={0} inputMode="numeric" value={approve} onChange={(e) => setApprove(e.target.value)} /></Field>
          </div>
          <div className="fp-calc__result" aria-live="polite">
            <div className="fp-calc__dates">
              <div><p className="fp-calc__k">{label('decideLabel', 'designDateDecide')}</p><p className="fp-calc__v">{show(result?.decideBy)}</p></div>
              <div><p className="fp-calc__k">{label('orderLabel', 'designDateOrder')}</p><p className="fp-calc__v">{show(result?.orderBy)}</p></div>
            </div>
            <p className="fp-calc__why">
              {result && leadN !== null && floatN !== null && approveN !== null
                ? t('designDateExplain', { lead: leadN * 7, float: floatN, approve: approveN })
                : label('unknownText', 'designDateUnknown')}
            </p>
            {str(d.note) ? <p className="fp-calc__note">{str(d.note)}</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

/** ADR 1105 — a worksheet figure: money in the section's currency, else a plain number. */
function useFigure(currency: string): (v: number | undefined) => string {
  const { t } = useTranslation('cms');
  const fmt = useFormat();
  return (v) => (v === undefined ? t('designFigureNone') : currency ? fmt.currency(v, currency) : fmt.number(v, { maximumFractionDigits: 2 }));
}

/** ADR 1105 D3 — cost and markup to client price and gross margin, and the markup a target margin needs. */
function MarginCalc({ d, sx }: { d: Raw; sx: string }): JSX.Element {
  const { t } = useTranslation('cms');
  const fmt = useFormat();
  const initial = (v: unknown): string => (typeof v === 'number' ? String(v) : '');
  const [cost, setCost] = useState(initial(d.cost));
  const [markup, setMarkup] = useState(initial(d.markup));
  const [target, setTarget] = useState(initial(d.target));
  const n = (v: string): number | undefined => parseCount(v) ?? undefined;
  const targetN = n(target);
  const r = computeMargin({ cost: n(cost), markup: n(markup), target: targetN !== undefined && targetN < 100 ? targetN : undefined });
  const money = useFigure(str(d.currency));
  const pct = (v: number | undefined): string => (v === undefined ? t('designFigureNone') : fmt.percent(v / 100, { maximumFractionDigits: 1 }));
  const label = (key: string, fallback: string): string => str(d[key]) || t(fallback);
  return (
    <section className={`cms-public-section fp-section fp-calc fp-calc--margin${sx}`}>
      <div className="fp-shell">
        <Head d={d} />
        <div className="fp-calc__grid">
          <div className="fp-calc__inputs">
            <Field label={label('costLabel', 'designMarginCost')}><input type="number" min={0} step="any" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
            <Field label={label('markupLabel', 'designMarginMarkup')}><input type="number" min={0} step="any" inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)} /></Field>
            <Field label={label('targetLabel', 'designMarginTarget')}><input type="number" min={0} max={99} step="any" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
          </div>
          <div className="fp-calc__result" aria-live="polite">
            <div className="fp-calc__dates">
              <div><p className="fp-calc__k">{t('designMarginPrice')}</p><p className="fp-calc__v">{money(r.price)}</p></div>
              <div><p className="fp-calc__k">{t('designMarginMargin')}</p><p className="fp-calc__v">{pct(r.margin)}</p></div>
              <div><p className="fp-calc__k">{t('designMarginForTarget')}</p><p className="fp-calc__v">{pct(r.markupForTarget)}</p></div>
            </div>
            {/* UXG-1105-3 — say why a target of 100% or more has no markup. */}
            {targetN !== undefined && targetN >= 100 ? <p className="fp-calc__why">{t('designMarginTargetTooHigh')}</p> : null}
            <p className="fp-calc__why">{t('designMarginExplain')}</p>
            {str(d.note) ? <p className="fp-calc__note">{str(d.note)}</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

/** ADR 1105 D4 — an allowance beside the expected spend, line by line; overruns are never netted. */
function AllowanceGap({ d, sx }: { d: Raw; sx: string }): JSX.Element {
  const { t } = useTranslation('cms');
  const initial = (v: unknown): string => (typeof v === 'number' ? String(v) : '');
  const authored = rows(d.lines).filter((l) => str(l.name));
  const [values, setValues] = useState(() => authored.map((l) => ({ allowance: initial(l.allowance), specified: initial(l.specified) })));
  const money = useFigure(str(d.currency));
  const n = (v: string | undefined): number | undefined => (v === undefined ? undefined : parseCount(v) ?? undefined);
  const g = computeGaps(authored.map((l, i) => ({ name: str(l.name), allowance: n(values[i]?.allowance), specified: n(values[i]?.specified) })));
  const set = (i: number, k: 'allowance' | 'specified', v: string): void => setValues((prev) => prev.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const col = { line: str(d.label) || t('designGapLine'), allowance: str(d.allowanceLabel) || t('designGapAllowance'), specified: str(d.specifiedLabel) || t('designGapSpecified') };
  return (
    <section className={`cms-public-section fp-section fp-calc fp-calc--gap${sx}`}>
      <div className="fp-shell">
        <Head d={d} />
        <div className="fp-gap">
          {/* Explicit roles: below 640px the cells are restyled as grids, and WebKit then drops native table semantics (DESIGN.md §11). */}
          <table className="fp-gap__table" role="table">
            <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">{col.line}</th><th scope="col" role="columnheader">{col.allowance}</th><th scope="col" role="columnheader">{col.specified}</th><th scope="col" role="columnheader">{t('designGapOver')}</th></tr></thead>
            <tbody role="rowgroup">
              {g.rows.map((r, i) => (
                <tr key={i} role="row">
                  <th scope="row" role="rowheader">{r.name}</th>
                  <td role="cell" data-label={col.allowance}><input type="number" min={0} step="any" inputMode="decimal" aria-label={`${r.name}: ${col.allowance}`} value={values[i]?.allowance ?? ''} onChange={(e) => set(i, 'allowance', e.target.value)} /></td>
                  <td role="cell" data-label={col.specified}><input type="number" min={0} step="any" inputMode="decimal" aria-label={`${r.name}: ${col.specified}`} value={values[i]?.specified ?? ''} onChange={(e) => set(i, 'specified', e.target.value)} /></td>
                  <td role="cell" data-label={t('designGapOver')} className={r.over !== undefined && r.over > 0 ? 'fp-gap__over fp-gap__over--late' : 'fp-gap__over'}>
                    {r.over === undefined ? t('designFigureNone') : r.over > 0 ? money(r.over) : t('designGapWithin')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="fp-calc__result" aria-live="polite">
            <div><p className="fp-calc__k">{t('designGapTotal')}</p><p className="fp-calc__v">{money(g.totalOver)}</p></div>
            <p className="fp-calc__why">{t('designGapExplain', { count: g.linesOver, total: g.rows.length })}{g.linesMissing > 0 ? ` ${t('designGapMissing', { count: g.linesMissing })}` : ''}</p>
            {str(d.note) ? <p className="fp-calc__note">{str(d.note)}</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

/** ADR 1080 D3. */
function Conversation({ d, sx }: { d: Raw; sx: string }): JSX.Element {
  const { t } = useTranslation('cms');
  const groupId = useId();
  const exchanges = rows(d.exchanges).filter((x) => str(x.q) && str(x.a));
  const [picked, setPicked] = useState(0);
  const current = exchanges[Math.min(picked, Math.max(exchanges.length - 1, 0))];
  return (
    <section className={`cms-public-section fp-section fp-convo${sx}`}>
      <div className="fp-shell">
        <Head d={d} />
        <div className="fp-convo__grid">
          <div className="fp-convo__asks" role="group" aria-labelledby={groupId}>
            <p id={groupId} className="fp-convo__hint">{t('designConvChoose')}</p>
            {exchanges.map((x, i) => (
              <Button key={i} variant="quiet" className="fp-convo__ask" aria-pressed={i === picked} onClick={() => setPicked(i)}>{str(x.q)}</Button>
            ))}
          </div>
          {current ? (
            <div className="fp-convo__panel" aria-live="polite">
              {str(d.title) || str(d.subtitle) ? (
                <p className="fp-convo__bar"><strong>{str(d.title)}</strong>{str(d.subtitle) ? <span>{str(d.subtitle)}</span> : null}</p>
              ) : null}
              <div className="fp-convo__body">
                <p className="fp-convo__q">{str(current.q)}</p>
                <p className="fp-convo__a">{str(current.a)}</p>
                {strings(current.refs).length > 0 ? (
                  <p className="fp-convo__refs"><span>{t('designConvCited')}</span>{strings(current.refs).map((r) => <code key={r}>{r}</code>)}</p>
                ) : null}
                {str(current.gate) ? <p className="fp-convo__gate">{str(current.gate)}</p> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** ADR 1080 D4 — every group is in the DOM (the panel swaps what shows), so search and no-JS readers get it all. */
function FeatureIndex({ d, sx }: { d: Raw; sx: string }): JSX.Element {
  const groups = rows(d.groups).filter((g) => str(g.name) && rows(g.items).length > 0);
  const start = typeof d.initial === 'number' && d.initial >= 0 && d.initial < groups.length ? d.initial : 0;
  const [picked, setPicked] = useState(start);
  const panelId = useId();
  return (
    <section className={`cms-public-section fp-section fp-findex${sx}`}>
      <div className="fp-shell">
        <Head d={d} />
        <div className="fp-findex__grid">
          <div className="fp-findex__list" role="group" aria-label={str(d.label) || str(d.heading) || undefined}>
            {groups.map((g, i) => (
              <Button key={i} variant="quiet" className="fp-findex__pick" aria-pressed={i === picked} aria-controls={`${panelId}-${i}`} onClick={() => setPicked(i)}>
                {str(g.key) ? <span className="fp-findex__key" aria-hidden="true">{str(g.key)}</span> : null}
                <span className="fp-findex__name">{str(g.name)}</span>
                <span className="fp-findex__count">{rows(g.items).length}</span>
              </Button>
            ))}
          </div>
          <div className="fp-findex__panels">
            {groups.map((g, i) => (
              <div key={i} id={`${panelId}-${i}`} className="fp-findex__panel" hidden={i !== picked}>
                {str(g.key) ? <p className="fp-eyebrow">{str(g.key)}</p> : null}
                <h3 className="fp-findex__title">{str(g.name)}</h3>
                {str(g.lede) ? <p className="fp-findex__lede">{str(g.lede)}</p> : null}
                <ul className="fp-findex__items">
                  {rows(g.items).map((it, j) => (
                    <li key={j}>{str(it.id) ? <span className="fp-findex__id">{str(it.id)}</span> : null}<span>{str(it.label)}</span></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** ADR 1105 D1/D9 — a project's parties. The ADR 1080 D4 picker: a labelled
 *  group of pressed buttons, every panel in the DOM and the others hidden, so a
 *  crawler and a no-JS reader get them all. Each party's sample view reuses the
 *  hero queue card (the same rows-with-a-status shape). */
function PartyViews({ d, sx }: { d: Raw; sx: string }): JSX.Element {
  const { t } = useTranslation('cms');
  const parties = rows(d.parties).filter((p) => str(p.label));
  const start = typeof d.initial === 'number' && d.initial >= 0 && d.initial < parties.length ? d.initial : 0;
  const [picked, setPicked] = useState(start);
  const id = useId();
  return (
    <section className={`cms-public-section fp-section fp-parties${sx}`}>
      <div className="fp-shell">
        <Head d={d} />
        <div className="fp-parties__pick" role="group" aria-label={str(d.label) || str(d.heading) || t('designPartiesPick')}>
          {parties.map((p, i) => (
            <Button key={i} variant="quiet" className="fp-parties__btn" aria-pressed={i === picked} aria-controls={`${id}-${i}`} onClick={() => setPicked(i)}>{str(p.label)}</Button>
          ))}
        </div>
        {parties.map((p, i) => {
          const needs = strings(p.needs).filter(Boolean);
          const view = rows(p.rows).filter((r) => str(r.title));
          return (
            <div key={i} id={`${id}-${i}`} className="fp-parties__panel" hidden={i !== picked}>
              {needs.length > 0 ? (
                <div className="fp-parties__needs">
                  <p className="fp-eyebrow">{str(p.needsLabel) || t('designPartiesNeeds')}</p>
                  <ul role="list" className="fp-parties__list">{needs.map((n, j) => <li key={j}>{n}</li>)}</ul>
                </div>
              ) : null}
              {view.length > 0 ? <HeroQueue queue={{ title: str(p.viewTitle) || t('designPartiesView', { party: str(p.label) }), label: str(p.viewLabel), rows: view, note: str(p.note) }} /> : null}
              {view.length === 0 && str(p.note) ? <p className="fp-parties__note">{str(p.note)}</p> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** ADR 1105 D2/D8 — counts by stage. A labelled list first: each stage's label
 *  and count are text, drawn as bars below 900px and columns above. Groups show
 *  in the legend with their totals, and by pattern as well as color. */
function StageChart({ d, sx }: { d: Raw; sx: string }): JSX.Element {
  const fmt = useFormat();
  const groups = rows(d.groups).filter((g) => str(g.key) && str(g.label));
  const stages = rows(d.stages).filter((x) => str(x.label) && typeof x.count === 'number');
  const max = Math.max(1, ...stages.map((x) => x.count as number));
  const unit = str(d.unit);
  const count = (v: number): string => (unit ? `${fmt.number(v)} ${unit}` : fmt.number(v));
  // In a column the unit is visually hidden (the legend carries it); it stays in the accessible text.
  const countCell = (v: number): JSX.Element => <>{fmt.number(v)}{unit ? <span className="fp-schart__unit">{` ${unit}`}</span> : null}</>;
  const totals = groups
    .map((g, gi) => ({ gi, label: str(g.label), total: stages.filter((x) => x.group === g.key).reduce((sum, x) => sum + (x.count as number), 0) }))
    .filter((g) => g.total > 0);
  return (
    <section className={`cms-public-section fp-section fp-schart${sx}`}>
      <div className="fp-shell">
        <Head d={d} />
        <ol role="list" className="fp-schart__bars">
          {stages.map((x, i) => {
            const gi = groups.findIndex((g) => g.key === x.group);
            return (
              // The bar's length is geometry (the ADR 1080 scheduleSim tick precedent).
              <li key={i} className={`fp-schart__stage${gi >= 0 ? ` fp-schart--g${gi}` : ''}`} style={{ '--v': String((x.count as number) / max) } as CSSProperties}>
                <span className="fp-schart__count">{countCell(x.count as number)}</span>
                <span className="fp-schart__bar" aria-hidden="true" />
                <span className="fp-schart__label">{str(x.label)}{gi >= 0 ? <span className="sr-only">{` (${str(groups[gi]!.label)})`}</span> : null}</span>
              </li>
            );
          })}
        </ol>
        {totals.length > 0 ? (
          <ul role="list" className="fp-schart__legend">
            {totals.map((g) => (
              <li key={g.gi} className={`fp-schart__key fp-schart--g${g.gi}`}><span className="fp-schart__swatch" aria-hidden="true" />{g.label}{' '}<strong>{count(g.total)}</strong></li>
            ))}
          </ul>
        ) : null}
        {str(d.note) ? <p className="fp-schart__note">{str(d.note)}</p> : null}
      </div>
    </section>
  );
}

// `films` (ADR 1082) is listed here for the editor preview and the type lists;
// it renders in SectionRenderer beside `video`, whose player it reuses.
export const DESIGN_SECTION_TYPES = ['statusTable', 'dateCalc', 'conversation', 'featureIndex', 'decisionTree', 'scheduleSim', 'films', 'marginCalc', 'allowanceGap', 'partyViews', 'stageChart'] as const;

export function isDesignSection(type: string): boolean {
  return (DESIGN_SECTION_TYPES as readonly string[]).includes(type);
}

export function DesignSection({ section, sx }: { section: Section; sx: string }): JSX.Element | null {
  const d = section.data;
  switch (section.type) {
    case 'statusTable': return <StatusTable d={d} sx={sx} />;
    // CG-1105-1 — keyed on the authored values like the worksheets, so an author's
    // edit in the Page Builder preview reaches the reader's seeded inputs.
    case 'dateCalc': return <DateCalc key={JSON.stringify([d.needDate, d.leadWeeks, d.floatDays, d.approveDays])} d={d} sx={sx} />;
    case 'conversation': return <Conversation d={d} sx={sx} />;
    case 'featureIndex': return <FeatureIndex d={d} sx={sx} />;
    case 'decisionTree': return <DecisionTree d={d} sx={sx} />;
    case 'scheduleSim': return <ProjectSimulator d={d} sx={sx} />;
    // Keyed on the authored figures: the reader's edits are local state seeded
    // from them, so an author's change in the Page Builder preview remounts it.
    case 'marginCalc': return <MarginCalc key={JSON.stringify([d.cost, d.markup, d.target])} d={d} sx={sx} />;
    case 'allowanceGap': return <AllowanceGap key={JSON.stringify(d.lines ?? null)} d={d} sx={sx} />;
    case 'partyViews': return <PartyViews d={d} sx={sx} />;
    case 'stageChart': return <StageChart d={d} sx={sx} />;
    default: return null;
  }
}

/** ADR 1080 D7 — the hero's queue picture. */
export function HeroQueue({ queue }: { queue: unknown }): JSX.Element | null {
  const q = typeof queue === 'object' && queue !== null ? queue as Raw : {};
  const list = rows(q.rows).filter((r) => str(r.title));
  if (!str(q.title) || list.length === 0) return null;
  return (
    <figure className="fp-queue" aria-label={str(q.title)}>
      <div className="fp-queue__bar"><span className="fp-queue__title">{str(q.title)}</span>{str(q.label) ? <span className="fp-queue__label">{str(q.label)}</span> : null}</div>
      <ul className="fp-queue__rows">
        {list.map((r, i) => (
          <li key={i} className="fp-queue__row">
            <span className="fp-queue__id">{str(r.id)}</span>
            <span className="fp-queue__what"><strong>{str(r.title)}</strong>{str(r.meta) ? <span>{str(r.meta)}</span> : null}</span>
            {str(r.status) ? <Chip status={str(r.status)} tone={r.tone} /> : <span />}
          </li>
        ))}
      </ul>
      {str(q.note) ? <figcaption className="fp-queue__note">{str(q.note)}</figcaption> : null}
    </figure>
  );
}

/** ADR 1080 D8 — the richText card picture. */
export function RichTextCard({ card }: { card: unknown }): JSX.Element | null {
  const c = typeof card === 'object' && card !== null ? card as Raw : {};
  if (!str(c.title)) return null;
  const actions = rows(c.actions).filter((a) => str(a.label));
  return (
    <article className="fp-rtcard">
      {str(c.imageToken) ? <img className="fp-rtcard__img" src={assetUrl(str(c.imageToken))} alt={str(c.alt)} loading="lazy" /> : null}
      <div className="fp-rtcard__body">
        {str(c.eyebrow) ? <p className="fp-eyebrow">{str(c.eyebrow)}</p> : null}
        <h3 className="fp-rtcard__title">{str(c.title)}</h3>
        {str(c.body) ? <p className="fp-rtcard__text">{str(c.body)}</p> : null}
        {str(c.note) ? <p className="fp-rtcard__note">{str(c.note)}</p> : null}
        {actions.length > 0 ? (
          <div className="fp-rtcard__actions">
            {actions.map((a, i) => <CtaLink key={i} label={str(a.label)} url={str(a.url)} primary={a.primary === true} />)}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** ADR 1080 D15 — one step of a tree: the next node, or the outcome it ends on. */
export function treeStep(tree: Raw, option: Raw): { next: string | null; outcome: string | null } {
  const next = str(option.next) && rows(tree.nodes).some((n) => str(n.id) === str(option.next)) ? str(option.next) : null;
  return { next, outcome: next ? null : (str(option.outcome) || null) };
}

/** ADR 1080 D15 — click through a decision tree to its outcome. */
function DecisionTree({ d, sx }: { d: Raw; sx: string }): JSX.Element {
  const { t } = useTranslation('cms');
  const trees = rows(d.trees).filter((tr) => str(tr.title) && rows(tr.nodes).length > 0);
  const [treeIx, setTreeIx] = useState(0);
  const tree = trees[Math.min(treeIx, Math.max(trees.length - 1, 0))] ?? {};
  const nodes = rows(tree.nodes);
  const [path, setPath] = useState<{ node: string; choice: string }[]>([]);
  const [outcome, setOutcome] = useState<string | null>(null);
  const nodeId = path.length === 0 ? str(nodes[0]?.id) : '';
  const [current, setCurrent] = useState<string>('');
  const at = nodes.find((n) => str(n.id) === (current || nodeId)) ?? nodes[0];
  const restart = (ix = treeIx): void => { setTreeIx(ix); setPath([]); setOutcome(null); setCurrent(''); };
  const choose = (o: Raw): void => {
    const step = treeStep(tree, o);
    setPath((p) => [...p, { node: str(at?.text), choice: str(o.label) }]);
    if (step.next) setCurrent(step.next); else setOutcome(step.outcome ?? '');
  };
  const back = (): void => {
    if (path.length === 0) return;
    // Rebuild from the start: the path is short and replaying keeps it exact.
    const kept = path.slice(0, -1);
    let node = str(nodes[0]?.id);
    for (const step of kept) {
      const n = nodes.find((x) => str(x.id) === node);
      const o = rows(n?.options).find((x) => str(x.label) === step.choice);
      node = o ? treeStep(tree, o).next ?? node : node;
    }
    setPath(kept); setOutcome(null); setCurrent(node);
  };
  return (
    <section className={`cms-public-section fp-section fp-dtree${sx}`}>
      <div className="fp-shell">
        <Head d={d} />
        <div className="fp-dtree__grid">
          <div className="fp-dtree__trees" role="group" aria-label={t('designTreeChoose')}>
            {trees.map((tr, i) => (
              <Button key={i} variant="quiet" className="fp-dtree__tree" aria-pressed={i === treeIx} onClick={() => restart(i)}>{str(tr.title)}</Button>
            ))}
          </div>
          <div className="fp-dtree__stage">
            {str(tree.question) ? <p className="fp-eyebrow">{str(tree.question)}</p> : null}
            {path.length > 0 ? (
              <ol className="fp-dtree__path">
                {path.map((p, i) => <li key={i}><span>{p.node}</span><strong>{p.choice}</strong></li>)}
              </ol>
            ) : null}
            <div key={`${treeIx}-${path.length}-${outcome === null ? 'q' : 'o'}`} className="fp-dtree__card" aria-live="polite">
              {outcome !== null ? (
                <>
                  <p className="fp-dtree__k">{t('designTreeOutcome')}</p>
                  <p className="fp-dtree__outcome">{outcome || t('designTreeNoOutcome')}</p>
                </>
              ) : at ? (
                <>
                  <p className="fp-dtree__k">{t('designTreeStep', { n: path.length + 1 })}</p>
                  <p className="fp-dtree__q">{str(at.text)}</p>
                  <div className="fp-dtree__options">
                    {rows(at.options).map((o, i) => <Button key={i} variant="quiet" className="fp-dtree__option" onClick={() => choose(o)}>{str(o.label)}</Button>)}
                  </div>
                </>
              ) : null}
            </div>
            <div className="fp-dtree__controls">
              <Button variant="quiet" onClick={back} disabled={path.length === 0}>{t('designTreeBack')}</Button>
              <Button variant="quiet" onClick={() => restart()} disabled={path.length === 0}>{t('designTreeRestart')}</Button>
            </div>
            {str(tree.evidence) ? <p className="fp-dtree__evidence">{str(tree.evidence)}</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
