/**
 * Shared CMS sections editor (ADR 0027) — the section list + per-section fields +
 * add/move/remove controls, extracted from CmsPage so BOTH the org-scoped CMS
 * page editor AND the host-level home-page editor (Admin → Content → Front page)
 * use ONE editor. It's a controlled component: give it `sections` + `onChange`.
 */
import { DesignJsonFields, JsonArrayField } from './DesignJsonFields.js';
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { config, fetchOpts, authedHeaders } from '../../client/config.js';
import { formatNumber } from '../../i18n/format.js';
import { ArrowDownIcon, ArrowUpIcon, ImageIcon, PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import { handleTablistKeyDown } from '../../ui/rovingTabs.js';
import { FIELD_NAME_RE, FIELDS_MAX_KEYS } from './fieldsSection.js';
import { HeroArtFields } from './HeroArtFields.js';
import { altCount, fillAltFromLibrary, libraryAltOf, type LibraryAlt } from './altFromLibrary.js';
import { announce } from '../../ui/announce.js';
import { isHeroArtVisual, type HeroArtVisual } from './heroArtSpec.js';
import { SECTION_TYPES, type MediaAssetRef, type Section, type SectionType, type SharedSection, type TranslationStatus } from './cmsClient.js';

/** Name a BCP-47 tag in the reader's language (endonym fallback to the tag). */
export function localeLabel(tag: string): string {
  try {
    return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export function blankSection(type: SectionType): Section {
  const data: Record<string, unknown> =
    type === 'hero' ? { heading: '' }
      : type === 'richText' ? { text: '' }
        : type === 'image' ? { token: '' }
          : type === 'cta' ? { label: '', url: '' }
            : type === 'productGrid' ? { heading: '', storeOrgId: '', productIds: [] }
              : type === 'entityList' ? { heading: '', tenantId: '', typeName: '', titleField: '' }
                : type === 'entityDetail' ? { heading: '', tenantId: '', typeName: '', entityId: '', titleField: '' }
                  : type === 'video' ? { title: '', description: '', src: '', poster: '', length: '' }
                    // ADR 1080 — a design section starts empty; the server asks for what it needs.
                    : type === 'statusTable' ? { columns: [], rows: [] }
                    : type === 'dateCalc' ? { leadWeeks: 10, floatDays: 10, approveDays: 5 }
                    : type === 'conversation' ? { exchanges: [] }
                    : type === 'featureIndex' ? { groups: [] }
                    : type === 'decisionTree' ? { trees: [] }
                    : type === 'scheduleSim' ? { milestones: [], decisions: [] }
                    : type === 'films' ? { films: [] }
                    // ADR 1105 — example figures so the worksheet shows a worked answer at once.
                    : type === 'marginCalc' ? { cost: 4000, markup: 25 }
                    : type === 'allowanceGap' ? { lines: [] }
                    : type === 'partyViews' ? { parties: [] }
                    : type === 'stageChart' ? { stages: [] }
                    : { columns: [{ text: '' }] };
  return { sectionId: `new:${Math.random().toString(36).slice(2)}`, type, data };
}

/** Section `data` is an open bag; coerce reads to string for inputs. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function MediaTokenField({ value, assets, onChange, label, onPickMedia }: {
  value: string;
  assets: MediaAssetRef[];
  onChange: (v: string) => void;
  label: string;
  /** Open the media picker dialog (ADR 0206 B4); resolves the chosen token or
   *  null when dismissed. Absent ⇒ the classic select/input only. */
  onPickMedia?: (() => Promise<string | null>) | undefined;
}): JSX.Element {
  const { t } = useTranslation('cms');
  // Preserve an already-set token absent from the current asset list (deleted /
  // foreign token) — else the <select> blanks and SAVING drops the reference.
  const known = assets.some((a) => (a.serveToken ?? '') === value);
  return (
    <label className="u-grid u-gap-1">
      <span className="u-label-sm">{t('mediaTokenLabel', { label })}</span>
      <span className="u-flex u-gap-1 u-items-center">
        {assets.length > 0 ? (
          <select value={value} onChange={(e) => onChange(e.target.value)} className="u-flex-1">
            <option value="">—</option>
            {!known && value ? <option value={value}>{t('mediaTokenCurrent')}</option> : null}
            {assets.map((a) => <option key={a.assetId} value={a.serveToken ?? ''}>{a.name}</option>)}
          </select>
        ) : (
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('mediaTokenPlaceholder')} className="u-flex-1" />
        )}
        {onPickMedia ? (
          <Button
            variant="quiet" className="u-w-auto"
            onClick={async () => { const token = await onPickMedia(); if (token) onChange(token); }}
          >
            <ImageIcon size={14} /> {t('mediaBrowse')}
          </Button>
        ) : null}
      </span>
    </label>
  );
}

/** The serif display heading, with the `*emphasis*` hint (headingEmphasis.tsx). */
function HeadingField({ d, set }: { d: Record<string, unknown>; set: (k: string, v: unknown) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const hintId = useId();
  return (
    <label className="u-grid u-gap-1">
      <span className="u-label-sm">{t('headingLabel')}</span>
      <input value={str(d.heading)} onChange={(e) => set('heading', e.target.value)} aria-describedby={hintId} />
      <span id={hintId} className="u-label-sm muted">{t('headingEmphasisHint')}</span>
    </label>
  );
}

/** A mono "eyebrow" + serif "heading" shared by marketing-block sections. */
function HeadFields({ d, set }: { d: Record<string, unknown>; set: (k: string, v: unknown) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  return (
    <>
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('eyebrowLabel')}</span><input value={str(d.eyebrow)} onChange={(e) => set('eyebrow', e.target.value)} placeholder={t('eyebrowPlaceholder')} /></label>
      <HeadingField d={d} set={set} />
    </>
  );
}

const fieldText = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

/**
 * ADR 0748 — a `fields` section: flat named text fields, the protocol's open
 * section body. On the base layer every row is a renameable name + value; on a
 * locale overlay the names are the BASE's (read-only) and an empty value means
 * "inherit the base", which is exactly how the per-section merge treats a
 * missing key. Rows are held locally so a half-typed or clashing name stays on
 * screen with its error instead of vanishing on the next render; only valid,
 * unique names reach the saved data.
 */
/** Editor rows for a layer: its own entries on the base; the base's names (plus
 *  any overlay-only ones) on a locale overlay. */
function fieldRows(data: Record<string, unknown>, baseData: Record<string, unknown> | undefined): { name: string; value: unknown }[] {
  return baseData !== undefined
    ? [...new Set([...Object.keys(baseData), ...Object.keys(data)])].map((name) => ({ name, value: data[name] ?? '' }))
    : Object.entries(data).map(([name, value]) => ({ name, value }));
}

type FieldRow = { id: number; name: string; value: unknown };

/** What the editor compares to decide it is looking at a new layer: the data AND
 *  the base's field names (an open overlay whose base was renamed is stale). */
function fieldsLayerKey(data: Record<string, unknown>, baseData: Record<string, unknown> | undefined): string {
  return JSON.stringify([data, baseData === undefined ? null : Object.keys(baseData)]);
}

function FieldsEditor({ data, baseData, onChange }: { data: Record<string, unknown>; baseData?: Record<string, unknown> | undefined; onChange: (data: Record<string, unknown>) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const overlay = baseData !== undefined;
  const idBase = useId();
  // Each row carries a stable id (ADR 0755, WIT-CNT-12): keyed by index, removing
  // row 2 of 5 handed rows 3–5 the removed row's DOM (focus, error id) — an
  // aria-describedby pointing at the wrong row's error.
  const nextRowId = useRef(0);
  const withIds = (list: { name: string; value: unknown }[]): FieldRow[] => list.map((r) => ({ ...r, id: nextRowId.current++ }));
  const [rows, setRows] = useState<FieldRow[]>(() => withIds(fieldRows(data, baseData)));
  // Focus follows the user's action: a new row's name field on Add; the Add
  // button after a Remove (the pressed button has just unmounted).
  const [focusId, setFocusId] = useState<number | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // The layer can change under this editor without a keystroke here — "Copy from
  // base", "Translate", "Clear overlay", or the BASE's names changing under an open
  // overlay. Re-seed from props whenever that is not what this editor last emitted;
  // never on its own echo, or a half-typed name (held only in `rows`) would be
  // wiped on every keystroke.
  const lastEmitted = useRef<string>(fieldsLayerKey(data, baseData));
  useEffect(() => {
    const incoming = fieldsLayerKey(data, baseData);
    if (incoming === lastEmitted.current) return;
    lastEmitted.current = incoming;
    setRows(fieldRows(data, baseData).map((r) => ({ ...r, id: nextRowId.current++ })));
  }, [data, baseData]);
  const nameError = (i: number, list = rows): string | null => {
    const n = list[i]?.name ?? '';
    if (!FIELD_NAME_RE.test(n)) return t('fieldsNameInvalid');
    return list.findIndex((r) => r.name === n) !== i ? t('fieldsNameDuplicate') : null;
  };
  const commit = (next: FieldRow[]): void => {
    setRows(next);
    const out: Record<string, unknown> = {};
    next.forEach((r, i) => {
      if (nameError(i, next) !== null) return;
      if (overlay && fieldText(r.value) === '') return; // empty overlay value = inherit base
      out[r.name] = r.value;
    });
    lastEmitted.current = fieldsLayerKey(out, baseData);
    onChange(out);
  };
  return (
    <div className="u-grid u-gap-3">
      <span className="u-label-sm muted">{overlay ? t('fieldsOverlayHint') : t('fieldsHint')}</span>
      {rows.length === 0 ? <span className="u-label-sm muted">{t('fieldsEmpty')}</span> : null}
      {rows.map((r, i) => {
        const err = overlay ? null : (r.name === '' ? null : nameError(i));
        const errId = `${idBase}-err-${r.id}`;
        return (
          <div key={r.id} className="u-grid u-gap-1 u-grid-2 u-items-start">
            <span className="u-grid u-gap-1">
              <input
                aria-label={t('fieldsNameAria', { n: formatNumber(i + 1) })}
                ref={r.id === focusId ? (el) => { if (el) { el.focus(); setFocusId(null); } } : undefined}
                className="u-mono"
                value={r.name}
                readOnly={overlay}
                onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                placeholder={t('fieldsNamePlaceholder')}
                aria-invalid={err ? true : undefined}
                aria-describedby={err ? errId : undefined}
                spellCheck={false}
              />
              {err ? <span id={errId} className="field-error" role="alert">{err}</span> : null}
            </span>
            <span className="u-flex u-gap-1 u-items-start">
              <textarea
                aria-label={t('fieldsValueAria', { n: formatNumber(i + 1) })}
                rows={1}
                className="u-flex-1"
                value={fieldText(r.value)}
                onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                placeholder={overlay ? fieldText(baseData[r.name]) : t('fieldsValuePlaceholder')}
              />
              {overlay ? null : (
                <Button variant="quiet" className="u-w-auto" onClick={() => { commit(rows.filter((_, j) => j !== i)); addRef.current?.focus(); }} aria-label={t('fieldsRemoveAria', { n: formatNumber(i + 1) })}><TrashIcon /></Button>
              )}
            </span>
          </div>
        );
      })}
      {overlay ? null : rows.length >= FIELDS_MAX_KEYS ? (
        <span className="u-label-sm muted">{t('fieldsMax', { max: formatNumber(FIELDS_MAX_KEYS) })}</span>
      ) : (
        <Button variant="quiet" className="u-w-auto" ref={addRef} onClick={() => { const [row] = withIds([{ name: '', value: '' }]); if (!row) return; setRows([...rows, row]); setFocusId(row.id); }}><PlusIcon /> {t('fieldsAdd')}</Button>
      )}
    </div>
  );
}

/** The section's editor fields. Wrapped in `.cms-section-fields` so its prose
 *  textareas use the SANS register the public page renders them in (the app-wide
 *  `textarea` default is mono, which suits code, not copy — RFCW-UX-10). */
export function SectionFields(props: { section: Section; assets: MediaAssetRef[]; onChange: (data: Record<string, unknown>) => void; onPickMedia?: (() => Promise<string | null>) | undefined; /** ADR 1100 D2 — the library's description of a token, read at call time (the host keeps it current across a pick). Absent ⇒ looked up in `assets`. */ libraryAlt?: LibraryAlt | undefined; /** The base layer, when `section.data` is a locale overlay (ADR 0748 — `fields` needs it). */ baseData?: Record<string, unknown> | undefined }): JSX.Element {
  // ADR 1029 D2 — motion is presentation, kept on the base layer only (the server
  // drops it from an overlay), and never on `fields`, the protocol's open body.
  const showMotion = props.section.type !== 'fields' && props.baseData === undefined;
  // ADR 1050 D5 — the band, on the base layer of each type the validator tones.
  const showTone = (TONED_TYPES as readonly string[]).includes(props.section.type) && props.baseData === undefined;
  // ADR 1100 D2 — a newly placed picture takes the library's alt text when its own
  // is empty. Base layer only (an overlay must not get the base-language text),
  // and never `fields` (the open protocol body). The lookup is read at CALL time
  // through a ref: the media picker's Browse button awaits the dialog and then
  // calls the onChange it captured before, so a memoized map would be stale.
  const { t: tA11y } = useTranslation('a11y');
  const assetsRef = useRef(props.assets);
  assetsRef.current = props.assets;
  const libraryAltRef = useRef(props.libraryAlt);
  libraryAltRef.current = props.libraryAlt;
  const { section, onChange: propsOnChange, baseData } = props;
  const [fillNote, setFillNote] = useState<string | null>(null);
  const onChange = useCallback((next: Record<string, unknown>) => {
    if (baseData !== undefined || section.type === 'fields') { propsOnChange(next); return; }
    const lookup: LibraryAlt = libraryAltRef.current ?? ((token) => libraryAltOf(assetsRef.current, token));
    const filled = fillAltFromLibrary(section.data, next, lookup);
    // Say what happened, aloud and on screen: a filled description, or a
    // carried-over one removed. The note clears on the next edit.
    if (filled !== next) {
      const note = tA11y(altCount(filled) < altCount(next) ? 'altClearedOnSwap' : 'altFilledFromLibrary');
      setFillNote(note);
      announce(note);
    } else setFillNote(null);
    propsOnChange(filled);
  }, [propsOnChange, baseData, section.type, section.data, tA11y]);
  return (
    <div className="cms-section-fields">
      <SectionFieldsBody section={props.section} assets={props.assets} onChange={onChange} onPickMedia={props.onPickMedia} baseData={props.baseData} />
      {fillNote ? <p className="u-label-sm u-text-muted" data-alt-fill-note>{fillNote}</p> : null}
      {showTone ? <ToneField d={props.section.data} onChange={props.onChange} /> : null}
      {showMotion ? <MotionField d={props.section.data} onChange={props.onChange} /> : null}
    </div>
  );
}

/** ADR 0920 D1 / ADR 1050 D5 — the section types whose validator keeps `tone`
 *  (cmsService's `...tone()` cases; pinned by adr1029-mirror-parity). */
const TONED_TYPES = ['richText', 'image', 'cta', 'columns', 'faq', 'quotes', 'video', 'statusTable', 'dateCalc', 'conversation', 'featureIndex', 'decisionTree', 'scheduleSim', 'films', 'marginCalc', 'allowanceGap', 'partyViews', 'stageChart'] as const satisfies readonly SectionType[];

const ACTIVITY_MAX_ROWS = 6; // mirrors the server's MAX.activityItems (ADR 1029 D5)
const FLOW_MAX_STEPS = 6; // mirrors the server's MAX.flowNodes (ADR 1038 D8)

/** ADR 1029 D5 — the hero's activity card: a title and up to six rows, each an
 *  actor, what they did, the status word the visitor reads, and a styling state. */
function ActivityFields({ value, onChange }: { value: unknown; onChange: (v: Record<string, unknown>) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const a = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const rows = (Array.isArray(a.items) ? a.items : []) as Array<Record<string, unknown>>;
  const setRows = (next: Array<Record<string, unknown>>): void => onChange({ ...a, items: next });
  const setRow = (i: number, patch: Record<string, unknown>): void => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="u-grid u-gap-2 u-border-0 u-p-0 u-m-0">
      <legend className="u-label-sm">{t('activityEditorLegend')}</legend>
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('activityTitleLabel')}</span><input value={str(a.title)} onChange={(e) => onChange({ ...a, title: e.target.value })} placeholder={t('activityFigureLabel')} /></label>
      {rows.map((r, i) => {
        const n = formatNumber(i + 1);
        return (
          <div key={i} className="surface-card u-grid u-gap-1 u-p-2">
            <input aria-label={t('activityActorAria', { n })} value={str(r.actor)} onChange={(e) => setRow(i, { actor: e.target.value })} placeholder={t('activityActorPlaceholder')} />
            <input aria-label={t('activityActionAria', { n })} value={str(r.action)} onChange={(e) => setRow(i, { action: e.target.value })} placeholder={t('activityActionPlaceholder')} />
            <div className="u-grid u-gap-1 u-grid-2">
              <input aria-label={t('activityStatusAria', { n })} value={str(r.status)} onChange={(e) => setRow(i, { status: e.target.value })} placeholder={t('activityStatusPlaceholder')} />
              <input aria-label={t('activityMetaAria', { n })} value={str(r.meta)} onChange={(e) => setRow(i, { meta: e.target.value })} placeholder={t('activityMetaPlaceholder')} />
            </div>
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('activityStateLabel')}</span>
              <select value={str(r.state)} onChange={(e) => setRow(i, { state: e.target.value || undefined })}>
                <option value="">{t('activityStateNone')}</option>
                <option value="done">{t('activityStateDone')}</option>
                <option value="waiting">{t('activityStateWaiting')}</option>
                <option value="approved">{t('activityStateApproved')}</option>
                <option value="flagged">{t('activityStateFlagged')}</option>
              </select>
            </label>
            <Button variant="quiet" className="u-w-auto" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={t('activityRemoveRowAria', { n })}><TrashIcon /> {t('removeItem')}</Button>
          </div>
        );
      })}
      {rows.length < ACTIVITY_MAX_ROWS
        ? <Button variant="quiet" className="u-w-auto" onClick={() => setRows([...rows, { actor: '', action: '' }])}><PlusIcon /> {t('activityAddRow')}</Button>
        : null}
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('activityResultLabel')}</span><input value={str(a.result)} onChange={(e) => onChange({ ...a, result: e.target.value })} placeholder={t('activityResultPlaceholder')} /></label>
    </fieldset>
  );
}

/** ADR 1038 D8 — a step's status word and styling state, shared by the hero
 *  flow and a `flow` columns item. The state only styles the mark; the status
 *  is the words a visitor reads. */
function FlowStepState({ n, status, state, showState, onChange }: { n: string; status: string; state: string; showState: boolean; onChange: (patch: Record<string, unknown>) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  return (
    <div className="u-grid u-gap-1 u-grid-2">
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('flowStatusLabel')}</span>
        <input aria-label={t('flowStatusAria', { n })} value={status} onChange={(e) => onChange({ status: e.target.value })} placeholder={t('flowStatusPlaceholder')} />
      </label>
      {/* The mark follows the base language (a translation's state is synced
          from it on save, ADR 1038 D8), so a translator edits only the words. */}
      {showState ? <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('flowStateLabel')}</span>
        <select aria-label={t('flowStateAria', { n })} value={state} onChange={(e) => onChange({ state: e.target.value || undefined })}>
          <option value="">{t('flowStateNone')}</option>
          <option value="idle">{t('flowStateIdle')}</option>
          <option value="done">{t('flowStateDone')}</option>
          <option value="waiting">{t('flowStateWaiting')}</option>
        </select>
      </label> : null}
    </div>
  );
}

/** ADR 1038 D8 — the hero's flow picture: a caption and two to six steps. */
function FlowFields({ value, onChange, showState }: { value: unknown; onChange: (v: Record<string, unknown>) => void; showState: boolean }): JSX.Element {
  const { t } = useTranslation('cms');
  const f = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const nodes = (Array.isArray(f.nodes) ? f.nodes : []) as Array<Record<string, unknown>>;
  const setNodes = (next: Array<Record<string, unknown>>): void => onChange({ ...f, nodes: next });
  const setNode = (i: number, patch: Record<string, unknown>): void => setNodes(nodes.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="u-grid u-gap-2 u-border-0 u-p-0 u-m-0">
      <legend className="u-label-sm">{t('flowEditorLegend')}</legend>
      <p className="u-label-sm muted u-m-0">{t('flowEditorHint')}</p>
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('flowCaptionLabel')}</span><input value={str(f.label)} onChange={(e) => onChange({ ...f, label: e.target.value })} /></label>
      {nodes.map((r, i) => {
        const n = formatNumber(i + 1);
        return (
          <div key={i} className="surface-card u-grid u-gap-1 u-p-2">
            <input aria-label={t('flowLabelAria', { n })} value={str(r.label)} onChange={(e) => setNode(i, { label: e.target.value })} placeholder={t('flowLabelPlaceholder')} />
            <input aria-label={t('flowTextAria', { n })} value={str(r.text)} onChange={(e) => setNode(i, { text: e.target.value })} placeholder={t('flowTextPlaceholder')} />
            <FlowStepState n={n} status={str(r.status)} state={str(r.state)} showState={showState} onChange={(patch) => setNode(i, patch)} />
            <Button variant="quiet" className="u-w-auto" disabled={nodes.length <= 2} title={nodes.length <= 2 ? t('flowMinStepsHint') : undefined} onClick={() => setNodes(nodes.filter((_, j) => j !== i))} aria-label={t('flowRemoveAria', { n })}><TrashIcon /> {t('removeItem')}</Button>
          </div>
        );
      })}
      {nodes.filter((r) => str(r.label).trim()).length < 2 ? <p className="u-label-sm u-m-0" role="status">{t('flowNeedsTwoHint')}</p> : null}
      {nodes.length < FLOW_MAX_STEPS
        ? <Button variant="quiet" className="u-w-auto" onClick={() => setNodes([...nodes, { label: '' }])}><PlusIcon /> {t('flowAddStep')}</Button>
        : <p className="u-label-sm muted u-m-0">{t('flowHeroMaxHint')}</p>}
    </fieldset>
  );
}

/** ADR 1038 D2 — how the heading's `*marked*` words look. Presentation, so base
 *  layer only; "Accent" (the default) removes the key. */
function EmphasisField({ d, onChange }: { d: Record<string, unknown>; onChange: (data: Record<string, unknown>) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const hintId = useId();
  const choose = (v: string): void => {
    const { emphasis: _drop, ...rest } = d;
    onChange(v ? { ...rest, emphasis: v } : rest);
  };
  return (
    <div className="u-grid u-gap-1">
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('emphasisLabel')}</span>
        <select value={typeof d.emphasis === 'string' && d.emphasis !== 'accent' ? d.emphasis : ''} onChange={(e) => choose(e.target.value)} aria-describedby={hintId}>
          <option value="">{t('emphasisAccent')}</option>
          <option value="strike">{t('emphasisStrike')}</option>
          <option value="underline">{t('emphasisUnderline')}</option>
          <option value="highlight">{t('emphasisHighlight')}</option>
        </select>
      </label>
      <span id={hintId} className="u-label-sm muted">{t('emphasisHint')}</span>
    </div>
  );
}

/** ADR 1038 D3 — whether a stats band's figures count up. Presentation, so base
 *  layer only; unticking removes the key. */
function CountField({ d, onChange }: { d: Record<string, unknown>; onChange: (data: Record<string, unknown>) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const hintId = useId();
  const choose = (on: boolean): void => {
    const { count: _drop, ...rest } = d;
    onChange(on ? { ...rest, count: true } : rest);
  };
  return (
    <div className="u-grid u-gap-1">
      <label className="u-flex u-gap-2 u-items-center">
        <input type="checkbox" checked={d.count === true} onChange={(e) => choose(e.target.checked)} aria-describedby={hintId} />
        <span>{t('statsCountLabel')}</span>
      </label>
      <span id={hintId} className="u-label-sm muted">{t('statsCountHint')}</span>
    </div>
  );
}

/** ADR 1038 D1 — whether the hero's card plays once on load. Presentation, so
 *  base layer only (the server drops it from an overlay); unticking removes the
 *  key rather than storing `still`. */
function PlayField({ d, onChange }: { d: Record<string, unknown>; onChange: (data: Record<string, unknown>) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const hintId = useId();
  const choose = (on: boolean): void => {
    const { play: _drop, ...rest } = d;
    onChange(on ? { ...rest, play: 'once' } : rest);
  };
  return (
    <div className="u-grid u-gap-1">
      <label className="u-flex u-gap-2 u-items-center">
        <input type="checkbox" checked={d.play === 'once'} onChange={(e) => choose(e.target.checked)} aria-describedby={hintId} />
        <span>{t('activityPlayLabel')}</span>
      </label>
      <span id={hintId} className="u-label-sm muted">{t('activityPlayHint')}</span>
    </div>
  );
}

/** ADR 1047 — the hero's hub picture: the centre (label, optional eyebrow and
 *  picture with alt text) and 2–8 places, each a label, optional index and an
 *  optional icon slug from the column icon set. */
function HubFields({ value, onChange, assets, onPickMedia }: { value: unknown; onChange: (v: Record<string, unknown>) => void; assets: MediaAssetRef[]; onPickMedia?: (() => Promise<string | null>) | undefined }): JSX.Element {
  const { t } = useTranslation('cms');
  const h = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const c = (typeof h.center === 'object' && h.center !== null ? h.center : {}) as Record<string, unknown>;
  const spokes = (Array.isArray(h.spokes) ? h.spokes : []) as Array<Record<string, unknown>>;
  const setCenter = (patch: Record<string, unknown>): void => onChange({ ...h, center: { ...c, ...patch } });
  const setSpokes = (next: Array<Record<string, unknown>>): void => onChange({ ...h, spokes: next });
  const setSpoke = (i: number, patch: Record<string, unknown>): void => setSpokes(spokes.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="u-grid u-gap-2 u-border-0 u-p-0 u-m-0">
      <legend className="u-label-sm">{t('hubEditorLegend')}</legend>
      <div className="u-grid u-gap-1 u-grid-2">
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('hubCenterLabel')}</span><input value={str(c.label)} onChange={(e) => setCenter({ label: e.target.value })} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('hubCenterEyebrowLabel')}</span><input value={str(c.eyebrow)} onChange={(e) => setCenter({ eyebrow: e.target.value || undefined })} /></label>
      </div>
      <MediaTokenField value={str(c.imageToken)} assets={assets} onChange={(v) => setCenter({ imageToken: v || undefined })} label={t('hubCenterImageLabel')} onPickMedia={onPickMedia} />
      {str(c.imageToken) ? (
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('altTextLabel')}</span><input value={str(c.alt)} onChange={(e) => setCenter({ alt: e.target.value })} /></label>
      ) : null}
      {spokes.map((r, i) => {
        const n = formatNumber(i + 1);
        return (
          <div key={i} className="surface-card u-grid u-gap-1 u-p-2">
            <input aria-label={t('hubSpokeLabelAria', { n })} value={str(r.label)} onChange={(e) => setSpoke(i, { label: e.target.value })} />
            <div className="u-grid u-gap-1 u-grid-2">
              <input aria-label={t('hubSpokeIndexAria', { n })} value={str(r.index)} onChange={(e) => setSpoke(i, { index: e.target.value || undefined })} placeholder="01" />
              <input aria-label={t('hubSpokeIconAria', { n })} value={str(r.icon)} onChange={(e) => setSpoke(i, { icon: e.target.value || undefined })} placeholder={t('columnIconPlaceholder')} />
            </div>
            <Button variant="quiet" className="u-w-auto" onClick={() => setSpokes(spokes.filter((_, j) => j !== i))} aria-label={t('hubRemoveSpokeAria', { n })}><TrashIcon /> {t('removeItem')}</Button>
          </div>
        );
      })}
      {spokes.length < 8
        ? <Button variant="quiet" className="u-w-auto" onClick={() => setSpokes([...spokes, { label: '' }])}><PlusIcon /> {t('hubAddSpoke')}</Button>
        : null}
    </fieldset>
  );
}

/** ADR 1047 — a feature card's callout, status pills and folded disclosure. */
function FeatureItemFields({ c, setCol, i }: { c: Record<string, unknown>; setCol: (i: number, patch: Record<string, unknown>) => void; i: number }): JSX.Element {
  const { t } = useTranslation('cms');
  const co = (typeof c.callout === 'object' && c.callout !== null ? c.callout : {}) as Record<string, unknown>;
  const mo = (typeof c.more === 'object' && c.more !== null ? c.more : {}) as Record<string, unknown>;
  const tags = (Array.isArray(c.tags) ? c.tags : []) as Array<Record<string, unknown>>;
  const setTags = (next: Array<Record<string, unknown>>): void => setCol(i, { tags: next.length > 0 ? next : undefined });
  return (
    <div className="u-grid u-gap-1">
      <div className="u-grid u-gap-1 u-grid-2">
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('featureCalloutLabelLabel')}</span><input value={str(co.label)} onChange={(e) => setCol(i, { callout: { ...co, label: e.target.value || undefined } })} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('featureCalloutTextLabel')}</span><input value={str(co.text)} onChange={(e) => setCol(i, { callout: { ...co, text: e.target.value } })} /></label>
      </div>
      {tags.map((tg, j) => {
        const n = formatNumber(j + 1);
        return (
          <div key={j} className="u-grid u-gap-1 u-grid-2">
            <input aria-label={t('featureTagLabelAria', { n })} value={str(tg.label)} onChange={(e) => setTags(tags.map((x, k) => (k === j ? { ...x, label: e.target.value } : x)))} />
            <div className="u-flex u-gap-1 u-items-center">
              <select aria-label={t('featureTagStateLabel')} value={str(tg.state)} onChange={(e) => setTags(tags.map((x, k) => (k === j ? { ...x, state: e.target.value || undefined } : x)))}>
                <option value="">{t('featureTagStateNone')}</option>
                <option value="now">{t('featureTagStateNow')}</option>
                <option value="soon">{t('featureTagStateSoon')}</option>
              </select>
              <Button variant="quiet" className="u-w-auto" onClick={() => setTags(tags.filter((_, k) => k !== j))} aria-label={t('featureRemoveTagAria', { n })}><TrashIcon /></Button>
            </div>
          </div>
        );
      })}
      {tags.length < 6 ? <Button variant="quiet" className="u-w-auto" onClick={() => setTags([...tags, { label: '' }])}><PlusIcon /> {t('featureAddTag')}</Button> : null}
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('featureMoreLabelLabel')}</span><input value={str(mo.label)} onChange={(e) => setCol(i, { more: { ...mo, label: e.target.value || undefined } })} /></label>
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('featureMoreTextLabel')}</span><textarea rows={3} value={str(mo.text)} onChange={(e) => setCol(i, { more: { ...mo, text: e.target.value } })} /></label>
    </div>
  );
}

/** ADR 0920 D1 / ADR 1050 D5 — the section's band. "Default" removes the key, so
 *  a section that never chose keeps its exact markup. */
function ToneField({ d, onChange }: { d: Record<string, unknown>; onChange: (data: Record<string, unknown>) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const value = typeof d.tone === 'string' && d.tone !== 'default' ? d.tone : '';
  const choose = (v: string): void => {
    if (v) { onChange({ ...d, tone: v }); return; }
    const { tone: _drop, ...rest } = d;
    onChange(rest);
  };
  return (
    <label className="u-grid u-gap-1 u-mt-2">
      <span className="u-label-sm">{t('toneLabel')}</span>
      <select value={value} onChange={(e) => choose(e.target.value)}>
        <option value="">{t('toneDefault')}</option>
        <option value="muted">{t('toneMuted')}</option>
        <option value="inverse">{t('toneInverse')}</option>
        <option value="accent">{t('toneAccent')}</option>
      </select>
    </label>
  );
}

/** ADR 1029 D2 — how the section moves as it scrolls into view. "Page default"
 *  removes the key, so a section that never chose keeps the page-load rise. */
function MotionField({ d, onChange }: { d: Record<string, unknown>; onChange: (data: Record<string, unknown>) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const hintId = useId();
  const value = typeof d.motion === 'string' ? d.motion : '';
  const choose = (v: string): void => {
    if (v) { onChange({ ...d, motion: v }); return; }
    const { motion: _drop, ...rest } = d;
    onChange(rest);
  };
  return (
    <div className="u-grid u-gap-1 u-mt-2">
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('motionLabel')}</span>
        <select value={value} onChange={(e) => choose(e.target.value)} aria-describedby={hintId}>
          <option value="">{t('motionDefault')}</option>
          <option value="none">{t('motionNone')}</option>
          <option value="reveal">{t('motionReveal')}</option>
          <option value="stagger">{t('motionStagger')}</option>
          <option value="rise">{t('motionRise')}</option>
          <option value="slide-start">{t('motionSlideStart')}</option>
          <option value="slide-end">{t('motionSlideEnd')}</option>
          <option value="zoom">{t('motionZoom')}</option>
        </select>
      </label>
      <span id={hintId} className="u-label-sm muted">{t('motionHint')}</span>
    </div>
  );
}

function SectionFieldsBody({ section, assets, onChange, onPickMedia, baseData }: { section: Section; assets: MediaAssetRef[]; onChange: (data: Record<string, unknown>) => void; onPickMedia?: (() => Promise<string | null>) | undefined; /** The base layer, when `section.data` is a locale overlay (ADR 0748 — `fields` needs it). */ baseData?: Record<string, unknown> | undefined }): JSX.Element {
  const { t } = useTranslation('cms');
  const d = section.data;
  const set = (k: string, v: unknown): void => onChange({ ...d, [k]: v });
  switch (section.type) {
    case 'fields':
      return <FieldsEditor data={d} baseData={baseData} onChange={onChange} />;
    case 'hero':
      return (
        <div className="u-grid u-gap-2">
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('heroEyebrowLabel')}</span><input value={str(d.eyebrow)} onChange={(e) => set('eyebrow', e.target.value)} placeholder={t('heroEyebrowPlaceholder')} /></label>
          <HeadingField d={d} set={set} />
          {baseData === undefined ? <EmphasisField d={d} onChange={onChange} /> : null}
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('heroSubheadingLabel')}</span><textarea rows={2} value={str(d.subheading)} onChange={(e) => set('subheading', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('heroBodyLabel')}</span><textarea rows={2} value={str(d.body)} onChange={(e) => set('body', e.target.value || undefined)} /></label>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('heroVisualLabel')}</span>
            <select
              value={str(d.visual) || (str(d.imageToken) ? 'image' : 'workflow')}
              onChange={(e) => {
                // ADR 1038 D8 — a flow needs two steps to show, so start with two.
                const flowNodes = (d.flow as { nodes?: unknown } | undefined)?.nodes;
                if (e.target.value === 'flow' && !(Array.isArray(flowNodes) && flowNodes.length > 0)) onChange({ ...d, visual: 'flow', flow: { ...(d.flow as object | undefined), nodes: [{ label: '' }, { label: '' }] } });
                else set('visual', e.target.value);
              }}
            >
              <option value="workflow">{t('heroVisualWorkflow')}</option>
              <option value="journey">{t('heroVisualJourney')}</option>
              <option value="run">{t('heroVisualRun')}</option>
              <option value="film">{t('heroVisualFilm')}</option>
              <option value="image">{t('heroVisualImage')}</option>
              <option value="plan">{t('heroVisualPlan')}</option>
              <option value="activity">{t('heroVisualActivity')}</option>
              <option value="hub">{t('heroVisualHub')}</option>
              <option value="flow">{t('heroVisualFlow')}</option>
              <option value="receipt">{t('heroVisualReceipt')}</option>
              <option value="apps">{t('heroVisualApps')}</option>
              <option value="versus">{t('heroVisualVersus')}</option>
              <option value="fanout">{t('heroVisualFanout')}</option>
              <option value="phone">{t('heroVisualPhone')}</option>
              <option value="wall">{t('heroVisualWall')}</option>
              <option value="tally">{t('heroVisualTally')}</option>
              <option value="log">{t('heroVisualLog')}</option>
              <option value="none">{t('heroVisualNone')}</option>
            </select>
          </label>
          {/* ADR 1066 D1 — presentation, so the base layer only (like `tone`). */}
          {baseData === undefined && (str(d.visual) === 'flow' || isHeroArtVisual(str(d.visual))) ? (
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('heroPlacementLabel')}</span>
              <select value={str(d.placement)} onChange={(e) => set('placement', e.target.value || undefined)}>
                <option value="">{t('heroPlacementSide')}</option>
                <option value="below">{t('heroPlacementBelow')}</option>
              </select>
            </label>
          ) : null}
          <div className="u-grid u-gap-1 u-grid-2">
            <input aria-label={t('heroPrimaryLabelAria')} value={str(d.ctaLabel)} onChange={(e) => set('ctaLabel', e.target.value)} placeholder={t('heroPrimaryLabelPlaceholder')} />
            <input aria-label={t('heroPrimaryUrlAria')} value={str(d.ctaUrl)} onChange={(e) => set('ctaUrl', e.target.value)} placeholder={t('heroPrimaryUrlPlaceholder')} />
            <input aria-label={t('heroSecondaryLabelAria')} value={str(d.ctaLabel2)} onChange={(e) => set('ctaLabel2', e.target.value)} placeholder={t('heroSecondaryLabelPlaceholder')} />
            <input aria-label={t('heroSecondaryUrlAria')} value={str(d.ctaUrl2)} onChange={(e) => set('ctaUrl2', e.target.value)} placeholder={t('heroSecondaryUrlPlaceholder')} />
          </div>
          {str(d.visual) === 'activity' ? <ActivityFields value={d.activity} onChange={(v) => set('activity', v)} /> : null}
          {str(d.visual) === 'activity' && baseData === undefined ? <PlayField d={d} onChange={onChange} /> : null}
          {str(d.visual) === 'flow' ? <FlowFields value={d.flow} onChange={(v) => set('flow', v)} showState={baseData === undefined} /> : null}
          {isHeroArtVisual(str(d.visual)) ? <HeroArtFields visual={str(d.visual) as HeroArtVisual} value={d[str(d.visual)]} onChange={(v) => set(str(d.visual), Object.keys(v).length > 0 ? v : undefined)} showState={baseData === undefined} /> : null}
          {str(d.visual) === 'hub' ? <HubFields value={d.hub} onChange={(v) => set('hub', v)} assets={assets} onPickMedia={onPickMedia} /> : null}
          <MediaTokenField value={str(d.imageToken)} assets={assets} onChange={(v) => set('imageToken', v)} label={t('heroImageLabel')} onPickMedia={onPickMedia} />
          {str(d.imageToken) ? (
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('altTextLabel')}</span><input value={str(d.alt)} onChange={(e) => set('alt', e.target.value)} /></label>
          ) : null}
        </div>
      );
    case 'richText':
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('richTextLabel')}</span><textarea rows={5} value={str(d.text)} onChange={(e) => set('text', e.target.value)} /></label>
        </div>
      );
    case 'image':
      return (
        <div className="u-grid u-gap-2">
          {/* ADR 1032 — an optional head, and a browser frame for screenshots. */}
          <HeadFields d={d} set={set} />
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('videoLedeLabel')}</span><input value={str(d.lede)} onChange={(e) => set('lede', e.target.value)} /></label>
          <MediaTokenField value={str(d.token)} assets={assets} onChange={(v) => set('token', v)} label={t('imageLabel')} onPickMedia={onPickMedia} />
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('altTextLabel')}</span><input value={str(d.alt)} onChange={(e) => set('alt', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('captionLabel')}</span><input value={str(d.caption)} onChange={(e) => set('caption', e.target.value)} /></label>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('imageFrameLabel')}</span>
            <select value={str(d.frame)} onChange={(e) => set('frame', e.target.value || undefined)}>
              <option value="">{t('imageFrameNone')}</option>
              <option value="browser">{t('imageFrameBrowser')}</option>
            </select>
          </label>
          {str(d.frame) === 'browser' ? (
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('imageFrameUrlLabel')}</span><input value={str(d.frameUrl)} onChange={(e) => set('frameUrl', e.target.value)} placeholder="example.com/dashboard" /></label>
          ) : null}
        </div>
      );
    case 'cta':
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('ctaSubheadingLabel')}</span><input value={str(d.subheading)} onChange={(e) => set('subheading', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('ctaButtonLabelLabel')}</span><input value={str(d.label)} onChange={(e) => set('label', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('ctaButtonUrlLabel')}</span><input value={str(d.url)} onChange={(e) => set('url', e.target.value)} placeholder={t('ctaButtonUrlPlaceholder')} /></label>
        </div>
      );
    case 'columns': {
      const cols: { status?: string; state?: string; title?: string; text?: string; href?: string; icon?: string; eyebrow?: string; wide?: boolean; tall?: boolean; items?: { label?: string; meta?: string }[]; imageToken?: string; alt?: string; frameUrl?: string; highlight?: boolean; callout?: unknown; tags?: unknown; more?: unknown; unit?: string; ctaLabel?: string; ctaUrl?: string }[] = Array.isArray(d.columns) ? d.columns : [];
      const setCol = (i: number, patch: Record<string, unknown>): void =>
        set('columns', cols.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      const layout = str(d.layout) || 'cards';
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('layoutLabel')}</span>
            <select value={layout} onChange={(e) => set('layout', e.target.value)}>
              <option value="cards">{t('layoutCards')}</option>
              <option value="showcase">{t('layoutShowcase')}</option>
              <option value="steps">{t('layoutSteps')}</option>
              <option value="rows">{t('layoutRows')}</option>
              <option value="stats">{t('layoutStats')}</option>
              <option value="prompts">{t('layoutPrompts')}</option>
              <option value="dives">{t('layoutDives')}</option>
              {/* ADR 0920 D4 — listed so editing a section never overwrites a stored layout. */}
              <option value="ruled">{t('layoutRuled')}</option>
              <option value="panels">{t('layoutPanels')}</option>
              <option value="progress">{t('layoutProgress')}</option>
              <option value="tiles">{t('layoutTiles')}</option>
              <option value="list">{t('layoutList')}</option>
              {/* ADR 1029 D5 */}
              <option value="timeline">{t('layoutTimeline')}</option>
              <option value="incidents">{t('layoutIncidents')}</option>
              <option value="board">{t('layoutBoard')}</option>
              <option value="gallery">{t('layoutGallery')}</option>
              <option value="bento">{t('layoutBento')}</option>
              <option value="marquee">{t('layoutMarquee')}</option>
              {/* ADR 1047 */}
              <option value="features">{t('layoutFeatures')}</option>
              <option value="flow">{t('layoutFlow')}</option>
            </select>
          </label>
          {layout === 'features' ? (
            // ADR 1047 — the words each pill state means, shown as a legend.
            <div className="u-grid u-gap-1 u-grid-2">
              <label className="u-grid u-gap-1"><span className="u-label-sm">{t('featureLegendNowLabel')}</span><input value={str((d.tagLegend as Record<string, unknown> | undefined)?.now)} onChange={(e) => set('tagLegend', { ...(d.tagLegend as Record<string, unknown> | undefined), now: e.target.value || undefined })} /></label>
              <label className="u-grid u-gap-1"><span className="u-label-sm">{t('featureLegendSoonLabel')}</span><input value={str((d.tagLegend as Record<string, unknown> | undefined)?.soon)} onChange={(e) => set('tagLegend', { ...(d.tagLegend as Record<string, unknown> | undefined), soon: e.target.value || undefined })} /></label>
            </div>
          ) : null}
          {/* ADR 1029 D5 — the marquee shows only names; say so, so no one fills
              in text, links or icons that never appear. */}
          {layout === 'marquee' ? <p className="u-label-sm muted u-m-0">{t('layoutMarqueeHint')}</p> : null}
          {layout === 'stats' && baseData === undefined ? <CountField d={d} onChange={onChange} /> : null}
          {cols.map((c, i) => (
            <div key={i} className="surface-card u-grid u-gap-1 u-p-2">
              <input aria-label={t('columnTitleAria', { n: formatNumber(i + 1) })} value={c.title ?? ''} onChange={(e) => setCol(i, { title: e.target.value })} placeholder={t('columnTitlePlaceholder', { n: formatNumber(i + 1) })} />
              <textarea aria-label={t('columnTextAria', { n: formatNumber(i + 1) })} rows={2} value={c.text ?? ''} onChange={(e) => setCol(i, { text: e.target.value })} placeholder={t('columnTextPlaceholder')} />
              {/* ADR 1029 D5 — a marquee shows names only, so its items have no link
                  or icon to fill in (stored values are kept, just not offered). */}
              {layout !== 'marquee' && layout !== 'flow' ? (
                <>
                  <label className="u-grid u-gap-1"><span className="u-label-sm">{t('columnLinkLabel')}</span><input value={c.href ?? ''} onChange={(e) => setCol(i, { href: e.target.value })} placeholder={t('columnLinkPlaceholder')} /></label>
                  <label className="u-grid u-gap-1"><span className="u-label-sm">{t('columnIconLabel')}</span><input value={c.icon ?? ''} onChange={(e) => setCol(i, { icon: e.target.value })} placeholder={t('columnIconPlaceholder')} /></label>
                </>
              ) : null}
              {layout === 'timeline' || layout === 'incidents' || layout === 'bento' || layout === 'features' || layout === 'list' ? (
                <label className="u-grid u-gap-1"><span className="u-label-sm">{t(layout === 'timeline' || layout === 'incidents' ? 'columnWhenLabel' : 'columnEyebrowLabel')}</span><input value={c.eyebrow ?? ''} onChange={(e) => setCol(i, { eyebrow: e.target.value })} /></label>
              ) : null}
              {layout === 'list' ? (
                // ADR 1069 D1 — a plan card's price unit and its own button.
                <div className="u-grid u-gap-1 u-grid-2">
                  <label className="u-grid u-gap-1"><span className="u-label-sm">{t('columnUnitLabel')}</span><input value={c.unit ?? ''} onChange={(e) => setCol(i, { unit: e.target.value || undefined })} /></label>
                  <span />
                  <label className="u-grid u-gap-1"><span className="u-label-sm">{t('columnCtaLabelLabel')}</span><input value={c.ctaLabel ?? ''} onChange={(e) => setCol(i, { ctaLabel: e.target.value || undefined })} /></label>
                  <label className="u-grid u-gap-1"><span className="u-label-sm">{t('columnCtaUrlLabel')}</span><input value={c.ctaUrl ?? ''} onChange={(e) => setCol(i, { ctaUrl: e.target.value || undefined })} /></label>
                </div>
              ) : null}
              {layout === 'flow' ? (
                <FlowStepState n={formatNumber(i + 1)} status={c.status ?? ''} state={c.state ?? ''} showState={baseData === undefined} onChange={(patch) => setCol(i, patch)} />
              ) : null}
              {layout === 'bento' ? (
                <label className="u-flex u-gap-1 u-items-center"><input type="checkbox" checked={c.wide === true} onChange={(e) => setCol(i, { wide: e.target.checked ? true : undefined })} /><span className="u-label-sm">{t('columnWideLabel')}</span></label>
              ) : null}
              {layout === 'bento' ? (
                // ADR 1070 D1 — a tile two rows tall.
                <label className="u-flex u-gap-1 u-items-center"><input type="checkbox" checked={c.tall === true} onChange={(e) => setCol(i, { tall: e.target.checked ? true : undefined })} /><span className="u-label-sm">{t('columnTallLabel')}</span></label>
              ) : null}
              {layout === 'bento' ? (
                // ADR 1032 — the tile's inset card (its first item).
                <div className="u-grid u-gap-1 u-grid-2">
                  <label className="u-grid u-gap-1"><span className="u-label-sm">{t('bentoInsetTitleLabel')}</span><input value={c.items?.[0]?.label ?? ''} onChange={(e) => setCol(i, { items: e.target.value ? [{ label: e.target.value, ...(c.items?.[0]?.meta ? { meta: c.items[0].meta } : {}) }] : undefined })} /></label>
                  <label className="u-grid u-gap-1"><span className="u-label-sm">{t('bentoInsetMetaLabel')}</span><input value={c.items?.[0]?.meta ?? ''} onChange={(e) => setCol(i, { items: [{ label: c.items?.[0]?.label ?? '', ...(e.target.value ? { meta: e.target.value } : {}) }] })} /></label>
                </div>
              ) : null}
              {layout === 'bento' || layout === 'marquee' || layout === 'features' ? (
                // ADR 1037 — the item's picture, its alt text and an optional
                // browser-frame address.
                <>
                  <MediaTokenField value={c.imageToken ?? ''} assets={assets} onChange={(v) => setCol(i, { imageToken: v || undefined })} label={t('columnImageLabel')} onPickMedia={onPickMedia} />
                  {c.imageToken ? (
                    <div className="u-grid u-gap-1 u-grid-2">
                      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('altTextLabel')}</span><input value={c.alt ?? ''} onChange={(e) => setCol(i, { alt: e.target.value })} /></label>
                      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('imageFrameUrlLabel')}</span><input value={c.frameUrl ?? ''} onChange={(e) => setCol(i, { frameUrl: e.target.value || undefined })} placeholder="example.com" /></label>
                    </div>
                  ) : null}
                </>
              ) : null}
              {layout === 'bento' || layout === 'list' ? (
                <label className="u-flex u-gap-1 u-items-center"><input type="checkbox" checked={c.highlight === true} onChange={(e) => setCol(i, { highlight: e.target.checked ? true : undefined })} /><span className="u-label-sm">{t('columnHighlightLabel')}</span></label>
              ) : null}
              {layout === 'features' ? <FeatureItemFields c={c as Record<string, unknown>} setCol={setCol} i={i} /> : null}
              <Button variant="quiet" className="u-w-auto" onClick={() => set('columns', cols.filter((_, j) => j !== i))} aria-label={t('removeItem')}><TrashIcon /> {t('removeItem')}</Button>
            </div>
          ))}
          {layout === 'flow' && cols.length > FLOW_MAX_STEPS
            ? <p className="u-label-sm u-m-0" role="status">{t('flowTooManyHint', { n: formatNumber(cols.length) })}</p>
            : layout === 'flow' && cols.length === FLOW_MAX_STEPS
            ? <p className="u-label-sm muted u-m-0">{t('flowMaxHint')}</p>
            : <Button variant="quiet" className="u-w-auto" onClick={() => set('columns', [...cols, { title: '', text: '' }])}><PlusIcon /> {t('addItem')}</Button>}
          {layout === 'rows' ? <ToggleFields value={d.toggles} onChange={(v) => set('toggles', v)} /> : null}
          {layout === 'rows' ? <DiagramFields value={d.diagram} onChange={(v) => set('diagram', v)} /> : null}
        </div>
      );
    }
    case 'productGrid': {
      // DEF-9 (ADR 0240): a store dropdown + product multiselect (replacing the raw org-id
      // text input + product-id textarea) — the picker fetches the operator's orgs and the
      // chosen store's public products (the SectionRenderer data path — no cross-feature
      // client import).
      const ids: string[] = Array.isArray(d.productIds) ? d.productIds.filter((x): x is string => typeof x === 'string') : [];
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          {/* One onChange per event — consecutive set() calls each spread the
              STALE data closure, so the earlier key silently vanishes (the
              ADR 0407 review found store changes losing their product reset). */}
          <ProductGridEditor storeOrgId={str(d.storeOrgId)} productIds={ids} onStore={(v) => onChange({ ...d, storeOrgId: v, productIds: [] })} onProducts={(v) => set('productIds', v)} />
        </div>
      );
    }
    case 'form': {
      // ADR 0331 §D2 — a form REFERENCE ({ formId }; orgId kept as editor
      // convenience only). Mirrors the ProductGridEditor picker: authed orgs
      // list → the org's PUBLISHED forms (the forms feature owns the data; the
      // renderer resolves the public read path live).
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          {/* One onChange per event (see the productGrid note above). */}
          <FormSectionEditor orgId={str(d.orgId)} formId={str(d.formId)} onOrg={(v) => onChange({ ...d, orgId: v, formId: '' })} onForm={(v) => set('formId', v)} />
        </div>
      );
    }
    case 'entityList':
    case 'entityDetail': {
      // ADR 0407 D1 — entity-backed sections. The picker fetches the workspace's
      // entity types (authed, same-tenant — the type row carries the tenantId the
      // anonymous renderer needs) and offers field keys from the chosen type's
      // OWN schema (SSoT — never free-typed field names). Only publicRead types
      // resolve publicly; the hint says so.
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          <EntitySectionEditor
            mode={section.type === 'entityList' ? 'list' : 'detail'}
            d={d}
            set={set}
            setMany={(patch) => onChange({ ...d, ...patch })}
          />
        </div>
      );
    }
    case 'pricing': {
      // ADR 0391 §b — the pricing section carries marketing copy + WHICH tiers to
      // show (by their billing tier key); prices are NEVER authored here (the
      // renderer reads them live from the public billing config). Empty tier set
      // ⇒ the renderer shows every configured tier in order.
      const shown: string[] = Array.isArray(d.tiers) ? d.tiers.filter((x): x is string => typeof x === 'string') : [];
      const toggle = (key: string): void => set('tiers', shown.includes(key) ? shown.filter((k) => k !== key) : [...shown, key]);
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('pricingBlurbLabel')}</span><textarea rows={2} value={str(d.blurb)} onChange={(e) => set('blurb', e.target.value)} placeholder={t('pricingBlurbPlaceholder')} /></label>
          <fieldset className="u-grid u-gap-1">
            <legend className="u-label-sm">{t('pricingTiersLabel')}</legend>
            <div className="action-bar u-gap-2 u-flex-wrap">
              {KNOWN_PRICING_TIERS.map((key) => (
                <label key={key} className="action-bar u-gap-1 u-items-center">
                  <input type="checkbox" checked={shown.includes(key)} onChange={() => toggle(key)} />
                  <span className="u-label-sm">{key}</span>
                </label>
              ))}
            </div>
            <span className="u-label-sm muted">{t('pricingTiersHint')}</span>
          </fieldset>
          <div className="u-grid u-gap-1 u-grid-2">
            <input aria-label={t('pricingCtaLabelAria')} value={str(d.ctaLabel)} onChange={(e) => set('ctaLabel', e.target.value)} placeholder={t('pricingCtaLabelPlaceholder')} />
            <input aria-label={t('pricingCtaUrlAria')} value={str(d.ctaUrl)} onChange={(e) => set('ctaUrl', e.target.value)} placeholder={t('pricingCtaUrlPlaceholder')} />
          </div>
          <input aria-label={t('pricingContactUrlAria')} value={str(d.contactUrl)} onChange={(e) => set('contactUrl', e.target.value)} placeholder={t('pricingContactUrlPlaceholder')} />
          {/* ADR 1069 D4 — authored plans replace the billing tiers when set. */}
          <JsonArrayField field="plans" value={d.plans} set={set} label={t('pricingPlansLabel')} hint={t('pricingPlansHint')} />
        </div>
      );
    }
    case 'faq': {
      // R2-G10 — Q/A pairs (the renderer uses native <details>/<summary>; the
      // crawler prerender additionally emits FAQPage JSON-LD from this data).
      const items: { q?: string; a?: string }[] = Array.isArray(d.items) ? d.items : [];
      const setItem = (i: number, patch: Record<string, string>): void =>
        set('items', items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          {items.map((it, i) => (
            <div key={i} className="surface-card u-grid u-gap-1 u-p-2">
              <input aria-label={t('faqQuestionAria', { n: formatNumber(i + 1) })} value={it.q ?? ''} onChange={(e) => setItem(i, { q: e.target.value })} placeholder={t('faqQuestionPlaceholder')} />
              <textarea aria-label={t('faqAnswerAria', { n: formatNumber(i + 1) })} rows={3} value={it.a ?? ''} onChange={(e) => setItem(i, { a: e.target.value })} placeholder={t('faqAnswerPlaceholder')} />
              <Button variant="quiet" className="u-w-auto" onClick={() => set('items', items.filter((_, j) => j !== i))} aria-label={t('removeItem')}><TrashIcon /> {t('removeItem')}</Button>
            </div>
          ))}
          <Button variant="quiet" className="u-w-auto" onClick={() => set('items', [...items, { q: '', a: '' }])}><PlusIcon /> {t('addItem')}</Button>
        </div>
      );
    }
    case 'quotes': {
      // R2-G10 — attributed testimonials. Name/role are optional: an
      // unattributed quote renders without a byline, never an invented one.
      const items: { quote?: string; name?: string; role?: string }[] = Array.isArray(d.items) ? d.items : [];
      const setItem = (i: number, patch: Record<string, string>): void =>
        set('items', items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          {items.map((it, i) => (
            <div key={i} className="surface-card u-grid u-gap-1 u-p-2">
              <textarea aria-label={t('quoteTextAria', { n: formatNumber(i + 1) })} rows={2} value={it.quote ?? ''} onChange={(e) => setItem(i, { quote: e.target.value })} placeholder={t('quoteTextPlaceholder')} />
              <div className="u-grid u-gap-1 u-grid-2">
                <input aria-label={t('quoteNameAria', { n: formatNumber(i + 1) })} value={it.name ?? ''} onChange={(e) => setItem(i, { name: e.target.value })} placeholder={t('quoteNamePlaceholder')} />
                <input aria-label={t('quoteRoleAria', { n: formatNumber(i + 1) })} value={it.role ?? ''} onChange={(e) => setItem(i, { role: e.target.value })} placeholder={t('quoteRolePlaceholder')} />
              </div>
              <Button variant="quiet" className="u-w-auto" onClick={() => set('items', items.filter((_, j) => j !== i))} aria-label={t('removeItem')}><TrashIcon /> {t('removeItem')}</Button>
            </div>
          ))}
          <Button variant="quiet" className="u-w-auto" onClick={() => set('items', [...items, { quote: '', name: '', role: '' }])}><PlusIcon /> {t('addItem')}</Button>
        </div>
      );
    }
    case 'video':
      return <VideoSectionFields d={d} set={set} />;
    // ADR 1080 — the design section types edit as JSON.
    case 'statusTable': case 'dateCalc': case 'conversation': case 'featureIndex': case 'decisionTree': case 'scheduleSim': case 'films': case 'marginCalc': case 'allowanceGap': case 'partyViews': case 'stageChart':
      return <DesignJsonFields d={d} set={set} head={<HeadFields d={d} set={set} />} />;
    default:
      return <span className="u-label-sm">{t('unknownSection')}</span>;
  }
}

/** ADR 0843 — a `video` section: the film's URLs (https only — the server
 *  refuses anything else on save), its title, play-button length and the
 *  screen-reader description that also feeds the page's VideoObject. */
/** ADR 1032 — a `rows` section's try-it switches: a title and up to six
 *  labelled switches with their starting position. */
function ToggleFields({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const v = (typeof value === 'object' && value !== null ? value : {}) as { title?: string; items?: { label?: string; on?: boolean }[] };
  const items = Array.isArray(v.items) ? v.items : [];
  const put = (next: { title?: string; items: { label?: string; on?: boolean }[] }): void =>
    onChange(next.items.length === 0 && !next.title ? undefined : next);
  return (
    <fieldset className="surface-card u-grid u-gap-1 u-p-2">
      <legend className="u-label-sm">{t('togglesLegend')}</legend>
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('togglesTitleLabel')}</span><input value={v.title ?? ''} onChange={(e) => put({ ...(e.target.value ? { title: e.target.value } : {}), items })} /></label>
      {items.map((it, i) => (
        <div key={i} className="u-flex u-gap-1 u-items-center">
          <input aria-label={t('toggleLabelAria', { n: formatNumber(i + 1) })} value={it.label ?? ''} onChange={(e) => put({ ...v, items: items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
          <label className="u-flex u-gap-1 u-items-center"><input type="checkbox" checked={it.on === true} onChange={(e) => put({ ...v, items: items.map((x, j) => (j === i ? { label: x.label ?? '', ...(e.target.checked ? { on: true } : {}) } : x)) })} /><span className="u-label-sm">{t('toggleOnLabel')}</span></label>
          <Button variant="quiet" className="u-w-auto" onClick={() => put({ ...v, items: items.filter((_, j) => j !== i) })} aria-label={t('removeItem')}><TrashIcon /></Button>
        </div>
      ))}
      {items.length < 6 ? <Button variant="quiet" className="u-w-auto" onClick={() => put({ ...v, items: [...items, { label: '' }] })}><PlusIcon /> {t('addToggle')}</Button> : null}
    </fieldset>
  );
}

/** ADR 1068 D2 — a `rows` section's workflow diagram: up to eight boxes (a
 *  short mono label, one line of text), one of which may wait for a person, and
 *  a caption. Fewer than two boxes saves as no diagram. */
function DiagramFields({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const v = (typeof value === 'object' && value !== null ? value : {}) as { caption?: string; nodes?: { label?: string; text?: string; waiting?: boolean }[] };
  const nodes = Array.isArray(v.nodes) ? v.nodes : [];
  const put = (next: { caption?: string; nodes: { label?: string; text?: string; waiting?: boolean }[] }): void =>
    onChange(next.nodes.length === 0 && !next.caption ? undefined : next);
  const setNode = (i: number, patch: Partial<{ label: string; text: string; waiting: boolean }>): void =>
    put({ ...v, nodes: nodes.map((x, j) => (j === i ? { ...x, ...patch } : patch.waiting ? { ...x, waiting: false } : x)) });
  return (
    <fieldset className="surface-card u-grid u-gap-1 u-p-2">
      <legend className="u-label-sm">{t('diagramLegend')}</legend>
      {nodes.map((n, i) => (
        <div key={i} className="u-flex u-gap-1 u-items-center">
          <input aria-label={t('diagramLabelAria', { n: formatNumber(i + 1) })} value={n.label ?? ''} onChange={(e) => setNode(i, { label: e.target.value })} />
          <input aria-label={t('diagramTextAria', { n: formatNumber(i + 1) })} value={n.text ?? ''} onChange={(e) => setNode(i, { text: e.target.value })} />
          <label className="u-flex u-gap-1 u-items-center"><input type="checkbox" checked={n.waiting === true} onChange={(e) => setNode(i, { waiting: e.target.checked })} /><span className="u-label-sm">{t('diagramWaitingLabel')}</span></label>
          <Button variant="quiet" className="u-w-auto" onClick={() => put({ ...v, nodes: nodes.filter((_, j) => j !== i) })} aria-label={t('removeItem')}><TrashIcon /></Button>
        </div>
      ))}
      {nodes.length < 8 ? <Button variant="quiet" className="u-w-auto" onClick={() => put({ ...v, nodes: [...nodes, { label: '' }] })}><PlusIcon /> {t('addDiagramNode')}</Button> : null}
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('diagramCaptionLabel')}</span><input value={v.caption ?? ''} onChange={(e) => put({ ...(e.target.value ? { caption: e.target.value } : {}), nodes })} /></label>
    </fieldset>
  );
}

function VideoSectionFields({ d, set }: { d: Record<string, unknown>; set: (k: string, v: unknown) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const urlHintId = useId();
  const descHintId = useId();
  const url = (k: 'src' | 'poster' | 'captions' | 'youtubeUrl', label: string, placeholder: string): JSX.Element => (
    <label className="u-grid u-gap-1">
      <span className="u-label-sm">{label}</span>
      <input type="url" inputMode="url" value={str(d[k])} onChange={(e) => set(k, e.target.value)} placeholder={placeholder} aria-describedby={urlHintId} />
    </label>
  );
  return (
    <div className="u-grid u-gap-2">
      <HeadFields d={d} set={set} />
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('videoLedeLabel')}</span><input value={str(d.lede)} onChange={(e) => set('lede', e.target.value)} /></label>
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('videoTitleLabel')}</span><input value={str(d.title)} onChange={(e) => set('title', e.target.value)} /></label>
      {/* ADR 1068 D1 — the play chip's words (empty: the title) and a visible caption. */}
      <div className="u-grid u-gap-1 u-grid-2">
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('videoChipLabelLabel')}</span><input value={str(d.chipLabel)} onChange={(e) => set('chipLabel', e.target.value)} placeholder={str(d.title)} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('videoCaptionLabel')}</span><input value={str(d.caption)} onChange={(e) => set('caption', e.target.value)} /></label>
      </div>
      {url('src', t('videoSrcLabel'), 'https://…/film.mp4')}
      {url('poster', t('videoPosterLabel'), 'https://…/poster.jpg')}
      {url('captions', t('videoCaptionsLabel'), 'https://…/film.en.vtt')}
      {url('youtubeUrl', t('videoYoutubeLabel'), 'https://www.youtube.com/watch?v=…')}
      <span id={urlHintId} className="u-label-sm muted">{t('videoUrlHint')}</span>
      <div className="u-grid u-gap-1 u-grid-2">
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('videoLengthLabel')}</span><input value={str(d.length)} onChange={(e) => set('length', e.target.value)} placeholder="1:57" /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('videoUploadDateLabel')}</span><input type="date" value={str(d.uploadDate)} onChange={(e) => set('uploadDate', e.target.value)} /></label>
      </div>
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('videoDescriptionLabel')}</span>
        <textarea rows={4} value={str(d.description)} onChange={(e) => set('description', e.target.value)} aria-describedby={descHintId} />
        <span id={descHintId} className="u-label-sm muted">{t('videoDescriptionHint')}</span>
      </label>
      {/* ADR 1032 — a second film beside the first, and a footnote under both. */}
      <SecondFilmFields value={d.film2} onChange={(v) => set('film2', v)} />
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('videoNoteLabel')}</span><input value={str(d.note)} onChange={(e) => set('note', e.target.value)} /></label>
    </div>
  );
}

/** ADR 1032 — the second film of a `video` section. Off ⇒ no `film2` at all. */
function SecondFilmFields({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const f = (typeof value === 'object' && value !== null ? value : null) as Record<string, unknown> | null;
  const put = (k: string, v: string): void => onChange({ ...(f ?? {}), [k]: v });
  const field = (k: string, label: string, type: 'url' | 'text' = 'text', placeholder?: string): JSX.Element => (
    <label className="u-grid u-gap-1"><span className="u-label-sm">{label}</span><input type={type} value={str(f?.[k])} onChange={(e) => put(k, e.target.value)} placeholder={placeholder} /></label>
  );
  return (
    <fieldset className="surface-card u-grid u-gap-1 u-p-2">
      <legend className="u-label-sm">{t('videoSecondFilmLegend')}</legend>
      <label className="u-flex u-gap-1 u-items-center"><input type="checkbox" checked={f !== null} onChange={(e) => onChange(e.target.checked ? { title: '', description: '', src: '', poster: '', length: '' } : undefined)} /><span className="u-label-sm">{t('videoSecondFilmToggle')}</span></label>
      {f ? (
        <>
          {field('title', t('videoTitleLabel'))}
          {field('chipLabel', t('videoChipLabelLabel'))}
          {field('caption', t('videoCaptionLabel'))}
          {field('src', t('videoSrcLabel'), 'url', 'https://…/film.mp4')}
          {field('poster', t('videoPosterLabel'), 'url', 'https://…/poster.jpg')}
          {field('captions', t('videoCaptionsLabel'), 'url', 'https://…/film.en.vtt')}
          {field('youtubeUrl', t('videoYoutubeLabel'), 'url', 'https://www.youtube.com/watch?v=…')}
          {field('length', t('videoLengthLabel'), 'text', '1:57')}
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('videoDescriptionLabel')}</span><textarea rows={3} value={str(f.description)} onChange={(e) => put('description', e.target.value)} /></label>
        </>
      ) : null}
    </fieldset>
  );
}

/** The built-in billing tier keys (ADR 0176) offered as pricing-section
 *  checkboxes. Kept in lockstep with the billing `PlanTier` set; an operator
 *  who leaves all unchecked shows every configured tier. */
const KNOWN_PRICING_TIERS = ['free', 'pro', 'team', 'enterprise'] as const;

interface PickerOrg { orgId: string; name: string }
interface PickerProduct { productId: string; name: string }
interface PickerForm { formId: string; title: string; status: string }

/** ADR 0331 — org picker + published-form picker for the `form` section. Same
 *  resilience contract as ProductGridEditor: designed loading/error states and
 *  an already-set form id stays selectable even if a list fails to load. */
function FormSectionEditor({ orgId, formId, onOrg, onForm }: { orgId: string; formId: string; onOrg: (v: string) => void; onForm: (v: string) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const [orgs, setOrgs] = useState<PickerOrg[] | null>(null);
  const [orgsError, setOrgsError] = useState(false);
  const [forms, setForms] = useState<PickerForm[] | null>(null);
  const [formsError, setFormsError] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { orgs: PickerOrg[] }; })
      .then((r) => { if (active) setOrgs(r.orgs); })
      .catch(() => { if (active) { setOrgs([]); setOrgsError(true); } });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!orgId) { setForms([]); setFormsError(false); return; }
    let active = true; setForms(null); setFormsError(false);
    void fetch(`${config.baseUrl}/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms`, fetchOpts({ headers: authedHeaders() }))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { forms: PickerForm[] }; })
      .then((r) => { if (active) setForms(r.forms.filter((f) => f.status === 'published')); })
      .catch(() => { if (active) { setForms([]); setFormsError(true); } });
    return () => { active = false; };
  }, [orgId]);
  const orgOptions = orgs ?? [];
  const showOrgFallback = orgId !== '' && !orgOptions.some((o) => o.orgId === orgId);
  const formOptions = forms ?? [];
  const showFormFallback = formId !== '' && !formOptions.some((f) => f.formId === formId);
  return (
    <>
      <label className="u-grid u-gap-1">
        {/* HG-4 — was a local `formSectionOrgLabel: 'Workspace organization'`,
            two nouns for one collection in one label. Every org picker in the
            app reads the ONE `ui` key. */}
        <span className="u-label-sm">{t('ui:orgPickerLabel')}</span>
        <select value={orgId} onChange={(e) => onOrg(e.target.value)}>
          <option value="">{t('formSectionOrgPlaceholder')}</option>
          {showOrgFallback ? <option value={orgId}>{orgId}</option> : null}
          {orgOptions.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </select>
        {orgsError ? <span className="u-label-sm muted">{t('formSectionOrgsError')}</span> : null}
      </label>
      {orgId ? (
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('formSectionFormLabel')}</span>
          <select value={formId} onChange={(e) => onForm(e.target.value)}>
            <option value="">{t('formSectionFormPlaceholder')}</option>
            {showFormFallback ? <option value={formId}>{formId}</option> : null}
            {formOptions.map((f) => <option key={f.formId} value={f.formId}>{f.title}</option>)}
          </select>
          {forms === null ? <span className="u-label-sm muted">{t('formSectionLoading')}</span>
            : formsError ? <span className="u-label-sm muted">{t('formSectionFormsError')}</span>
            : formOptions.length === 0 && !showFormFallback ? <span className="u-label-sm muted">{t('formSectionNoForms')}</span> : null}
        </label>
      ) : null}
    </>
  );
}
/** DEF-9 — store picker + product multiselect for the productGrid section. Fetches the
 *  operator's orgs (authed) and the chosen store's public products (the SectionRenderer
 *  read path). Each fetch has a designed loading/error state, and an already-set store id
 *  always stays selectable even if the orgs list fails to load, so authoring is never
 *  blocked by a transient error. */
function ProductGridEditor({ storeOrgId, productIds, onStore, onProducts }: { storeOrgId: string; productIds: string[]; onStore: (v: string) => void; onProducts: (v: string[]) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const [orgs, setOrgs] = useState<PickerOrg[] | null>(null);
  const [orgsError, setOrgsError] = useState(false);
  const [products, setProducts] = useState<PickerProduct[] | null>(null);
  const [productsError, setProductsError] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { orgs: PickerOrg[] }; })
      .then((r) => { if (active) setOrgs(r.orgs); })
      .catch(() => { if (active) { setOrgs([]); setOrgsError(true); } });
    return () => { active = false; };
  }, []);
  // Keep an already-configured store selectable even if it's not in the loaded list (or the
  // list failed to load) — never silently blank an existing value.
  const orgOptions = orgs ?? [];
  const showFallbackOption = storeOrgId !== '' && !orgOptions.some((o) => o.orgId === storeOrgId);
  useEffect(() => {
    if (!storeOrgId) { setProducts([]); setProductsError(false); return; }
    let active = true; setProducts(null); setProductsError(false);
    void fetch(`${config.baseUrl}/host/openwop-app/public-store/${encodeURIComponent(storeOrgId)}/products`, fetchOpts({}))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { products: PickerProduct[] }; })
      .then((r) => { if (active) setProducts(r.products); })
      .catch(() => { if (active) { setProducts([]); setProductsError(true); } });
    return () => { active = false; };
  }, [storeOrgId]);
  const toggle = (id: string): void => onProducts(productIds.includes(id) ? productIds.filter((x) => x !== id) : [...productIds, id]);
  return (
    <>
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('productGridStoreLabel')}</span>
        <select value={storeOrgId} onChange={(e) => onStore(e.target.value)}>
          <option value="">{t('productGridStorePlaceholder')}</option>
          {showFallbackOption ? <option value={storeOrgId}>{storeOrgId}</option> : null}
          {orgOptions.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </select>
        {orgsError ? <span className="u-label-sm muted">{t('productGridStoresError')}</span> : null}
      </label>
      {storeOrgId ? (
        <div className="u-grid u-gap-1">
          <span className="u-label-sm">{t('productGridIdsLabel')}</span>
          {products === null ? <span className="u-label-sm muted">{t('productGridLoading')}</span>
            : productsError ? <span className="u-label-sm muted">{t('productGridLoadError')}</span>
            : products.length === 0 ? <span className="u-label-sm muted">{t('productGridNoProducts')}</span>
            : (
              <ul role="list" className="u-grid u-gap-1 u-list-none u-p-0 u-m-0">
                {products.map((p) => (
                  <li key={p.productId}>
                    <label className="action-bar u-gap-1 u-items-center">
                      <input type="checkbox" checked={productIds.includes(p.productId)} onChange={() => toggle(p.productId)} />
                      <span className="u-text-sm">{p.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
        </div>
      ) : null}
      <span className="u-label-sm muted">{t('productGridHint')}</span>
    </>
  );
}

/** The workspace entity-type shape the picker needs (ADR 0407 — the authed
 *  entities read; the row carries the tenantId the anonymous renderer stores). */
interface PickerEntityType {
  name: string;
  displayName: string;
  tenantId: string;
  status: 'draft' | 'published';
  publicRead?: boolean;
  fields: Array<{ key: string; label: string; type: string }>;
}
interface PickerEntityRow { entityId: string; values: Record<string, unknown> }
interface PickerTaxonomy { name: string; displayName: string }
interface PickerTerm { termId: string; slug: string; label: string }

/**
 * ADR 0407 D1 — type picker + SSoT field pickers for the entity-backed
 * sections (the ProductGridEditor model: authed list for authoring, the
 * anonymous read at render). Selecting a type stamps BOTH typeName and
 * tenantId; field selects offer the chosen type's own field keys. `detail`
 * mode adds an entity picker over the authed first page (fallback: the id
 * stays selectable if the list fails — authoring is never blocked).
 */
function EntitySectionEditor({ mode, d, set, setMany }: { mode: 'list' | 'detail'; d: Record<string, unknown>; set: (k: string, v: unknown) => void; setMany: (patch: Record<string, unknown>) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const [types, setTypes] = useState<PickerEntityType[] | null>(null);
  const [typesError, setTypesError] = useState(false);
  const [rows, setRows] = useState<PickerEntityRow[] | null>(null);
  const [rowsError, setRowsError] = useState(false);
  const typeName = str(d.typeName);
  const entityId = str(d.entityId);
  useEffect(() => {
    let active = true;
    void fetch(`${config.baseUrl}/host/openwop-app/entities/types`, fetchOpts({ headers: authedHeaders() }))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { types: PickerEntityType[] }; })
      .then((r) => { if (active) setTypes(r.types); })
      .catch(() => { if (active) { setTypes([]); setTypesError(true); } });
    return () => { active = false; };
  }, []);
  const chosen = (types ?? []).find((ty) => ty.name === typeName);
  const showTypeFallback = typeName !== '' && !chosen;
  useEffect(() => {
    if (mode !== 'detail' || !typeName) { setRows([]); setRowsError(false); return; }
    let active = true; setRows(null); setRowsError(false);
    void fetch(`${config.baseUrl}/host/openwop-app/entities/types/${encodeURIComponent(typeName)}/entities?limit=50`, fetchOpts({ headers: authedHeaders() }))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { entities: PickerEntityRow[] }; })
      .then((r) => { if (active) setRows(r.entities); })
      .catch(() => { if (active) { setRows([]); setRowsError(true); } });
    return () => { active = false; };
  }, [mode, typeName]);
  const fieldOptions = chosen?.fields ?? [];
  const fieldSelect = (key: 'titleField' | 'bodyField', label: string, allowNone: boolean): JSX.Element => (
    <label className="u-grid u-gap-1">
      <span className="u-label-sm">{label}</span>
      <select value={str(d[key])} onChange={(e) => set(key, e.target.value)}>
        {allowNone ? <option value="">{t('entityFieldNone')}</option> : null}
        {str(d[key]) !== '' && !fieldOptions.some((f) => f.key === str(d[key])) ? <option value={str(d[key])}>{str(d[key])}</option> : null}
        {!allowNone && str(d[key]) === '' ? <option value="">{t('entityFieldPlaceholder')}</option> : null}
        {fieldOptions.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      </select>
    </label>
  );
  const rowTitle = (row: PickerEntityRow): string => {
    const v = row.values[str(d.titleField)];
    return v === undefined || v === null || v === '' ? row.entityId : String(v);
  };
  return (
    <>
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('entityTypeLabel')}</span>
        <select
          value={typeName}
          onChange={(e) => {
            // ONE patch per event — sequential set() calls clobber each other
            // (each spreads the stale pre-event data).
            const next = (types ?? []).find((ty) => ty.name === e.target.value);
            setMany({
              typeName: e.target.value,
              ...(next ? { tenantId: next.tenantId } : {}),
              titleField: '',
              bodyField: '',
              ...(mode === 'detail' ? { entityId: '' } : {}),
            });
          }}
        >
          <option value="">{t('entityTypePlaceholder')}</option>
          {showTypeFallback ? <option value={typeName}>{typeName}</option> : null}
          {(types ?? []).map((ty) => (
            <option key={ty.name} value={ty.name}>
              {ty.displayName}{ty.status === 'published' && ty.publicRead ? '' : ` — ${t('entityTypeNotPublic')}`}
            </option>
          ))}
        </select>
        {typesError ? <span className="u-label-sm muted">{t('entityTypesError')}</span> : null}
      </label>
      {typeName ? (
        <>
          {fieldSelect('titleField', t('entityTitleFieldLabel'), false)}
          {fieldSelect('bodyField', t('entityBodyFieldLabel'), true)}
        </>
      ) : null}
      {mode === 'list' && typeName ? (
        <>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('entityLimitLabel')}</span>
            <input
              type="number" min={1} max={24}
              value={typeof d.limit === 'number' ? d.limit : 6}
              onChange={(e) => { const n = Number(e.target.value); set('limit', Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 24) : 6); }}
            />
          </label>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('entitySortKeyLabel')}</span>
            <select value={str(d.sortKey)} onChange={(e) => setMany({ sortKey: e.target.value, ...(e.target.value ? {} : { sortDir: '' }) })}>
              <option value="">{t('entitySortNone')}</option>
              <option value="createdAt">{t('entitySortCreated')}</option>
              <option value="updatedAt">{t('entitySortUpdated')}</option>
              {fieldOptions.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </label>
          {str(d.sortKey) ? (
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('entitySortDirLabel')}</span>
              <select value={str(d.sortDir) || 'desc'} onChange={(e) => set('sortDir', e.target.value)}>
                <option value="desc">{t('entitySortDirDesc')}</option>
                <option value="asc">{t('entitySortDirAsc')}</option>
              </select>
            </label>
          ) : null}
          <EntityTermPicker termId={str(d.termId)} onTerm={(v) => set('termId', v)} />
          {/* ADR 0408 Phase D — one bounded equality filter (e.g. kind = post). */}
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('entityFilterFieldLabel')}</span>
            <select value={str(d.filterKey)} onChange={(e) => setMany({ filterKey: e.target.value, ...(e.target.value ? {} : { filterValue: '' }) })}>
              <option value="">{t('entityFilterNone')}</option>
              {str(d.filterKey) !== '' && !fieldOptions.some((f) => f.key === str(d.filterKey)) ? <option value={str(d.filterKey)}>{str(d.filterKey)}</option> : null}
              {fieldOptions.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </label>
          {str(d.filterKey) ? (
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('entityFilterValueLabel')}</span>
              <input value={str(d.filterValue)} onChange={(e) => set('filterValue', e.target.value)} placeholder={t('entityFilterValuePh')} />
            </label>
          ) : null}
        </>
      ) : null}
      {mode === 'detail' && typeName ? (
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('entityIdLabel')}</span>
          {rows === null ? <span className="u-label-sm muted">{t('entityLoading')}</span> : (
            <select value={entityId} onChange={(e) => set('entityId', e.target.value)}>
              <option value="">{t('entityIdPlaceholder')}</option>
              {entityId !== '' && !(rows ?? []).some((r) => r.entityId === entityId) ? <option value={entityId}>{entityId}</option> : null}
              {(rows ?? []).map((r) => <option key={r.entityId} value={r.entityId}>{rowTitle(r)}</option>)}
            </select>
          )}
          {rowsError ? <span className="u-label-sm muted">{t('entityEntitiesError')}</span> : null}
        </label>
      ) : null}
      <span className="u-label-sm muted">{mode === 'list' ? t('entityListHint') : t('entityDetailHint')}</span>
    </>
  );
}

/** ADR 0407 Phase 3 — optional taxonomy-term narrowing for entityList. The
 *  picker is taxonomy → term (authed reads); the config stores only the
 *  termId. A stored termId stays selectable even before its taxonomy is
 *  re-chosen (or if the lists fail) — authoring is never blocked. */
function EntityTermPicker({ termId, onTerm }: { termId: string; onTerm: (v: string) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const [taxonomies, setTaxonomies] = useState<PickerTaxonomy[] | null>(null);
  const [taxonomy, setTaxonomy] = useState('');
  const [terms, setTerms] = useState<PickerTerm[] | null>(null);
  const [termsError, setTermsError] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch(`${config.baseUrl}/host/openwop-app/entities/taxonomies`, fetchOpts({ headers: authedHeaders() }))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { taxonomies: PickerTaxonomy[] }; })
      .then((r) => { if (active) setTaxonomies(r.taxonomies); })
      .catch(() => { if (active) setTaxonomies([]); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!taxonomy) { setTerms([]); setTermsError(false); return; }
    let active = true; setTerms(null); setTermsError(false);
    void fetch(`${config.baseUrl}/host/openwop-app/entities/taxonomies/${encodeURIComponent(taxonomy)}/terms`, fetchOpts({ headers: authedHeaders() }))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { terms: PickerTerm[] }; })
      .then((r) => { if (active) setTerms(r.terms); })
      .catch(() => { if (active) { setTerms([]); setTermsError(true); } });
    return () => { active = false; };
  }, [taxonomy]);
  const termOptions = terms ?? [];
  const showTermFallback = termId !== '' && !termOptions.some((x) => x.termId === termId);
  return (
    <>
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('entityTaxonomyLabel')}</span>
        <select value={taxonomy} onChange={(e) => setTaxonomy(e.target.value)}>
          <option value="">{t('entityTaxonomyNone')}</option>
          {(taxonomies ?? []).map((tx) => <option key={tx.name} value={tx.name}>{tx.displayName}</option>)}
        </select>
      </label>
      {taxonomy || termId ? (
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('entityTermLabel')}</span>
          {taxonomy && terms === null ? <span className="u-label-sm muted">{t('entityLoading')}</span> : (
            <select value={termId} onChange={(e) => onTerm(e.target.value)}>
              <option value="">{t('entityTermAll')}</option>
              {showTermFallback ? <option value={termId}>{termId}</option> : null}
              {termOptions.map((x) => <option key={x.termId} value={x.termId}>{x.label}</option>)}
            </select>
          )}
          {termsError ? <span className="u-label-sm muted">{t('entityEntitiesError')}</span> : null}
        </label>
      ) : null}
    </>
  );
}

/**
 * Per-section locale tab strip (ADR 0064). The base tab edits `section.data`;
 * each other tab edits the SPARSE `section.localizations[locale]` overlay. A
 * dot marks a locale that has authored content; the base tag marks the source.
 */
function LocaleTabs({ section, base, locales, active, onPick, localeState, status }: {
  section: Section;
  base: string;
  locales: string[];
  active: string;
  onPick: (locale: string) => void;
  /** Per-locale publish state (ADR 0205 D2) — a withheld locale is marked ON
   *  the tab (CMSUX-1), not only in the active tab's overlay row. */
  localeState?: Record<string, 'draft' | 'published'> | undefined;
  /** ADR 0861 D6 — this section's per-locale translation status (saved state). */
  status?: Record<string, TranslationStatus> | undefined;
}): JSX.Element {
  const { t } = useTranslation('cms');
  return (
    <div className="cms-loc-tabs" role="tablist" aria-label={t('sectionLocalesAria')} onKeyDown={handleTablistKeyDown}>
      {locales.map((loc) => {
        const authored = loc === base
          ? Object.keys(section.data).length > 0
          : section.localizations?.[loc] !== undefined;
        const withheld = loc !== base && localeState?.[loc] === 'draft';
        // ADR 0592 §3 — machine-drafted + not yet human-edited (withheld wins
        // the accessible-name arm; the visible AI tag still renders).
        const aiDraft = loc !== base && authored && !!section.aiDrafted?.[loc];
        const outdated = loc !== base && authored && status?.[loc] === 'outdated';
        return (
          <button
            key={loc}
            type="button"
            role="tab"
            aria-selected={active === loc}
            tabIndex={active === loc ? 0 : -1}
            // Carry the base/translated state in the accessible name so the
            // colored "authored" dot isn't the only signal (DESIGN.md §5.3 —
            // status never by color alone).
            aria-label={
              loc === base
                ? t('localeTabBase', { locale: localeLabel(loc) })
                : withheld
                  ? t('localeTabWithheld', { locale: localeLabel(loc) })
                  : outdated
                    ? t('localeTabOutdated', { locale: localeLabel(loc) })
                  : aiDraft
                    ? t('localeTabAiDraft', { locale: localeLabel(loc) })
                    : authored ? t('localeTabTranslated', { locale: localeLabel(loc) }) : t('localeTabNotTranslated', { locale: localeLabel(loc) })
            }
            className={active === loc ? 'cms-loc-tab is-active' : 'cms-loc-tab'}
            onClick={() => onPick(loc)}
          >
            {localeLabel(loc)}
            {loc === base ? <span className="cms-loc-base">{t('localeBaseTag')}</span> : null}
            {withheld ? <span className="cms-loc-base">{t('localeWithheldTag')}</span> : null}
            {aiDraft ? <span className="cms-loc-base">{t('aiDraftTag')}</span> : null}
            {outdated ? <span className="cms-loc-base">{t('localeOutdatedTag')}</span> : null}
            {authored ? <span className="cms-loc-dot" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** The add-section picker: every section type, plus the org's shared sections
 *  as inherit-by-reference inserts (ADR 0204 C4). Used by the section editor
 *  and by the page workspace's section list. */
export function AddSectionControl({ sharedSections, onAdd }: {
  sharedSections?: SharedSection[] | undefined;
  onAdd: (section: Section) => void;
}): JSX.Element {
  const { t } = useTranslation('cms');
  return (
    <select
      aria-label={t('addSectionAria')}
      defaultValue=""
      className="u-w-auto"
      onChange={(e) => {
        const v = e.target.value;
        e.target.value = '';
        if (!v) return;
        if (v.startsWith('shared:')) {
          const sharedSectionId = v.slice('shared:'.length);
          const shared = (sharedSections ?? []).find((sh) => sh.sharedSectionId === sharedSectionId);
          if (!shared) return;
          onAdd({ sectionId: `new:${Math.random().toString(36).slice(2)}`, type: shared.type, data: {}, ref: { sharedSectionId } });
          return;
        }
        onAdd(blankSection(v as SectionType));
      }}
    >
      <option value="">{t('addSectionPlaceholder')}</option>
      {SECTION_TYPES.map((st) => <option key={st} value={st}>{t(`sectionType_${st}`, { defaultValue: st })}</option>)}
      {(sharedSections ?? []).length > 0 ? (
        <optgroup label={t('addSharedGroup')}>
          {(sharedSections ?? []).map((sh) => <option key={sh.sharedSectionId} value={`shared:${sh.sharedSectionId}`}>{sh.name}</option>)}
        </optgroup>
      ) : null}
    </select>
  );
}

export function SectionsEditor({ sections, assets, onChange, baseLocale = 'en', locales, onTranslate, onPickMedia, libraryAlt, sharedSections, sharedFailed, onSaveShared, localeState, onSetLocaleState, translationStatus, onConfirmSource, focusRequest, translatorMode, structureElsewhere = false }: {
  sections: Section[];
  assets: MediaAssetRef[];
  onChange: (sections: Section[]) => void;
  /** CMS-R2-1 preview→editor click-through: scroll to + focus this section's
   *  card. The nonce makes repeat requests for the SAME section re-fire. */
  focusRequest?: { sectionId: string; nonce: number } | undefined;
  /** Content base locale (ADR 0064) — the base tab edits `data`. */
  baseLocale?: string;
  /** Full tab order `[base, ...supported]`. Absent / single-entry ⇒ NO locale
   *  tabs (the home-page editor stays single-locale, unchanged). */
  locales?: string[];
  /** AI "translate from base" (ADR 0064 Phase 3). Returns the draft overlay, or
   *  null when unavailable (the caller toasts). Absent ⇒ no translate button. */
  onTranslate?: (sectionType: SectionType, data: Record<string, unknown>, targetLocale: string) => Promise<Record<string, unknown> | null>;
  /** Open the media picker (ADR 0206 B4) — resolves the chosen serve token or
   *  null. Absent ⇒ the classic select/input only (home-page editor unchanged). */
  onPickMedia?: () => Promise<string | null>;
  /** ADR 1100 D2 — the library's description of a token, read at call time. */
  libraryAlt?: LibraryAlt;
  /** Org shared sections (ADR 0204 C4) — offered in the add-section dropdown as
   *  inherit-by-reference inserts. Absent ⇒ no shared UI (home-page editor). */
  sharedSections?: SharedSection[];
  /** CMS2-B5 — the shared-section LIST READ failed, so an unresolved `ref` means
   *  "we don't know", not "it was deleted". Without this the editor asserts the
   *  section is gone and offers Remove as the only way forward. */
  sharedFailed?: boolean;
  /** "Save as shared section" (ADR 0204 C4) — absent hides the affordance. */
  onSaveShared?: (section: Section) => void;
  /** Per-locale publish state (ADR 0205 D2) — 'draft' = withheld from delivery. */
  localeState?: Record<string, 'draft' | 'published'>;
  /** Flip a locale live/withheld (admin — the server enforces authority). */
  onSetLocaleState?: (locale: string, state: 'published' | 'draft') => void;
  /** ADR 0861 D6 — per-section, per-locale translation status of the SAVED page
   *  (sectionId → locale → status). Absent ⇒ no status UI. */
  translationStatus?: Record<string, Record<string, TranslationStatus>> | undefined;
  /** ADR 0861 D6 — "Mark up to date": re-stamp an outdated overlay's source. */
  onConfirmSource?: ((sectionId: string, locale: string) => Promise<boolean>) | undefined;
  /** ADR 0592 §2 (CMSLU-1) — the translator surface's NARROWED presentation:
   *  base content renders read-only, section structure (add/move/remove/
   *  detach/save-as-shared) is hidden, overlay editing stays for the locales
   *  the parent passed in `locales` (already grant-filtered). Presentation
   *  only — the server's ADR 0205 D1 narrowing remains the authority. */
  translatorMode?: boolean;
  /** The page workspace's section list owns order, removal and adding, so the
   *  cards hide their move/remove buttons and the add control. */
  structureElsewhere?: boolean;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const localeList = locales ?? [];
  const showStructure = !translatorMode && !structureElsewhere;
  const localized = localeList.length > 1;
  // Active edit locale per section (default the base).
  const [activeLocale, setActiveLocale] = useState<Record<string, string>>({});
  // `sectionId:locale` currently being AI-translated (disables its button).
  const [translating, setTranslating] = useState<string | null>(null);
  // ADR 0861 D6 (CMSL2UX-3) — `sectionId:locale` being confirmed: disables the
  // button (no double write) and, on success, focus returns to the locale tab
  // instead of dropping to <body> when the button unmounts.
  const [confirming, setConfirming] = useState<string | null>(null);

  // Write the BASE data for section i.
  const patchData = (i: number, data: Record<string, unknown>): void =>
    onChange(sections.map((s, j) => (j === i ? { ...s, data } : s)));

  // Write a locale OVERLAY for section i. An empty overlay removes the key (and
  // an empty map drops `localizations` entirely) so we never persist `{}`.
  // `origin: 'ai'` (ADR 0592 §3) stamps machine provenance; any HUMAN write —
  // typing, copy-from-base, clearing — clears the stamp for that locale, so an
  // edited AI draft reads as human-reviewed content.
  const patchOverlay = (i: number, locale: string, overlay: Record<string, unknown>, origin?: 'ai'): void =>
    onChange(sections.map((s, j) => {
      if (j !== i) return s;
      const loc = { ...(s.localizations ?? {}) };
      const hasContent = Object.values(overlay).some((v) => v !== '' && v !== undefined && !(Array.isArray(v) && v.length === 0));
      if (hasContent) loc[locale] = overlay; else delete loc[locale];
      const ai = { ...(s.aiDrafted ?? {}) };
      if (hasContent && origin === 'ai') ai[locale] = new Date().toISOString();
      else delete ai[locale];
      const next: Section = {
        ...s,
        ...(Object.keys(loc).length > 0 ? { localizations: loc } : {}),
        ...(Object.keys(ai).length > 0 ? { aiDrafted: ai } : {}),
      };
      if (Object.keys(loc).length === 0) delete next.localizations;
      if (Object.keys(ai).length === 0) delete next.aiDrafted;
      return next;
    }));

  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const a = sections[i];
    const b = sections[j];
    if (!a || !b) return;
    const next = [...sections];
    next[i] = b;
    next[j] = a;
    onChange(next);
  };
  const remove = (i: number): void => onChange(sections.filter((_, j) => j !== i));

  // Land a preview click-through (CMS-R2-1): scroll the requested card into
  // view, move focus to it (SR context + keyboard continuation), and flash it.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusRequest) return;
    // Attribute COMPARISON, not selector interpolation — no escaping concern
    // (and `CSS.escape` is missing from some DOM environments).
    const el = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-section-id]') ?? [])
      .find((n) => n.getAttribute('data-section-id') === focusRequest.sectionId);
    if (!el) return;
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
    if (!reduced) {
      // Restart the flash on a REPEAT request: drop the class and force a
      // reflow so the browser treats the re-add as a fresh animation.
      el.classList.remove('cms-sec-flash');
      void el.offsetWidth;
      el.classList.add('cms-sec-flash');
      const done = (): void => el.classList.remove('cms-sec-flash');
      el.addEventListener('animationend', done, { once: true });
      return () => { el.removeEventListener('animationend', done); done(); };
    }
    return undefined;
  }, [focusRequest]);

  return (
    <div className="u-grid u-gap-2" ref={rootRef}>
      {sections.map((s, i) => {
        const active = localized ? (activeLocale[s.sectionId] ?? baseLocale) : baseLocale;
        const onBase = active === baseLocale;
        // The layer SectionFields edits: base `data`, or the locale overlay.
        const layer = onBase ? s.data : (s.localizations?.[active] ?? {});
        // ADR 0204 C4 — an inherit-by-reference section renders LOCKED: its
        // content lives in the shared section; Detach copies it in and drops
        // the ref (then it edits like any inline section).
        const shared = s.ref ? (sharedSections ?? []).find((sh) => sh.sharedSectionId === s.ref?.sharedSectionId) : undefined;
        if (s.ref) {
          return (
            <div key={s.sectionId} className="surface-card u-gap-2 u-p-3" data-section-id={s.sectionId} tabIndex={-1}>
              <div className="u-flex u-gap-1 u-items-center u-wrap">
                <span className="chip chip--accent">{t(`sectionType_${s.type}`, { defaultValue: s.type })}</span>
                <span className="chip">{t('sharedChip')}</span>
                <span className="u-label-sm">{shared ? shared.name : sharedFailed ? t('sharedUnavailable') : t('sharedMissing')}</span>
                <span className="u-flex-1" />
                {shared && !translatorMode ? (
                  <Button
                    variant="quiet" className="u-w-auto"
                    onClick={() => onChange(sections.map((x, j) => (j === i
                      ? { sectionId: x.sectionId, type: shared.type, data: { ...shared.data }, ...(shared.localizations ? { localizations: shared.localizations } : {}) }
                      : x)))}
                  >{t('sharedDetach')}</Button>
                ) : null}
                {showStructure ? (
                  <>
                    <Button variant="quiet" onClick={() => move(i, -1)} aria-label={t('moveUp')}><ArrowUpIcon /></Button>
                    <Button variant="quiet" onClick={() => move(i, 1)} aria-label={t('moveDown')}><ArrowDownIcon /></Button>
                    <Button variant="quiet" onClick={() => remove(i)} aria-label={t('removeSection')}><TrashIcon /></Button>
                  </>
                ) : null}
              </div>
              {/* CMS2-B5 — when the read failed, say so INSTEAD of the inherit
                  note, and warn before Remove destroys a ref used org-wide. */}
              <span className="u-label-sm">{!shared && sharedFailed ? t('sharedUnavailableNote') : t('sharedInheritNote')}</span>
            </div>
          );
        }
        return (
          <div key={s.sectionId} className="surface-card u-gap-2 u-p-3" data-section-id={s.sectionId} tabIndex={-1}>
            <div className="u-flex u-gap-1 u-items-center">
              <span className="chip chip--accent">{t(`sectionType_${s.type}`, { defaultValue: s.type })}</span>
              <span className="u-flex-1" />
              {onSaveShared && !translatorMode ? (
                <Button variant="quiet" className="u-w-auto" onClick={() => onSaveShared(s)}>{t('saveAsShared')}</Button>
              ) : null}
              {showStructure ? (
                <>
                  <Button variant="quiet" onClick={() => move(i, -1)} aria-label={t('moveUp')}><ArrowUpIcon /></Button>
                  <Button variant="quiet" onClick={() => move(i, 1)} aria-label={t('moveDown')}><ArrowDownIcon /></Button>
                  <Button variant="quiet" onClick={() => remove(i)} aria-label={t('removeSection')}><TrashIcon /></Button>
                </>
              ) : null}
            </div>

            {localized ? (
              <LocaleTabs
                section={s}
                base={baseLocale}
                locales={localeList}
                active={active}
                onPick={(loc) => setActiveLocale((m) => ({ ...m, [s.sectionId]: loc }))}
                localeState={localeState}
                status={translationStatus?.[s.sectionId]}
              />
            ) : null}

            {localized && !onBase ? (
              <div className="u-flex u-gap-1 u-items-center cms-loc-overlay-note">
                <span className="u-label-sm"><Trans t={t} i18nKey="overlayNote" values={{ locale: localeLabel(active) }} components={[<></>, <strong />]} /></span>
                {localeState?.[active] === 'draft' ? (
                  <span className="chip chip--warning">{t('localeWithheldChip')}</span>
                ) : null}
                {s.aiDrafted?.[active] ? (
                  /* ADR 0592 §3 — machine-drafted, not yet human-edited. §5.3
                     model-provenance chip; editing the overlay clears it. */
                  <span className="chip chip--ai">{t('aiDraftChip')}</span>
                ) : null}
                {translationStatus?.[s.sectionId]?.[active] === 'outdated' && s.localizations?.[active] !== undefined ? (
                  /* ADR 0861 D6 — the base text this overlay translates changed
                     after it was written. Status as a word, never colour alone. */
                  <span className="chip chip--warning" title={t('translationOutdatedHint')}>{t('translationOutdatedChip')}</span>
                ) : null}
                {translationStatus?.[s.sectionId]?.[active] === 'unknown' && s.localizations?.[active] !== undefined ? (
                  /* ADR 0861 D6 addendum — no evidence this overlay translates the
                     current base: a "Copy from base" (never stamped) or a legacy
                     row. The hint is real text for assistive tech, not a tooltip. */
                  <span className="chip" title={t('translationUnknownHint')}>
                    {t('translationUnknownChip')}
                    <span className="sr-only"> — {t('translationUnknownHint')}</span>
                  </span>
                ) : null}
                <span className="u-flex-1" />
                {onConfirmSource && (translationStatus?.[s.sectionId]?.[active] === 'outdated' || translationStatus?.[s.sectionId]?.[active] === 'unknown') && s.localizations?.[active] !== undefined ? (
                  <Button
                    variant="quiet" className="u-w-auto"
                    disabled={confirming === `${s.sectionId}:${active}`}
                    aria-label={t('confirmSourceActionAria', { locale: localeLabel(active) })}
                    onClick={async (e) => {
                      const key = `${s.sectionId}:${active}`;
                      const card = (e.currentTarget as HTMLElement).closest('.cms-loc-overlay-note')?.parentElement;
                      setConfirming(key);
                      try {
                        if (await onConfirmSource(s.sectionId, active)) {
                          card?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
                        }
                      } finally {
                        setConfirming((k) => (k === key ? null : k));
                      }
                    }}
                  >{confirming === `${s.sectionId}:${active}` ? t('confirmSourcePending') : t('confirmSourceAction')}</Button>
                ) : null}
                {onSetLocaleState ? (
                  localeState?.[active] === 'draft' ? (
                    <Button variant="quiet" className="u-w-auto" onClick={() => onSetLocaleState(active, 'published')}>{t('localePublishAction')}</Button>
                  ) : (
                    <Button variant="quiet" className="u-w-auto" onClick={() => onSetLocaleState(active, 'draft')}>{t('localeWithholdAction')}</Button>
                  )
                ) : null}
                <Button variant="quiet" className="u-w-auto" onClick={() => patchOverlay(i, active, { ...s.data })}>{t('copyFromBase')}</Button>
                {onTranslate ? (
                  <Button
                    variant="quiet" className="u-w-auto"
                    disabled={translating === `${s.sectionId}:${active}` || Object.keys(s.data).length === 0}
                    title={Object.keys(s.data).length === 0 ? t('addBaseContentFirst') : undefined}
                    onClick={async () => {
                      const key = `${s.sectionId}:${active}`;
                      setTranslating(key);
                      try {
                        const overlay = await onTranslate(s.type, s.data, active);
                        if (overlay) patchOverlay(i, active, overlay, 'ai');
                      } finally {
                        setTranslating((k) => (k === key ? null : k));
                      }
                    }}
                  >{translating === `${s.sectionId}:${active}` ? t('translatingLabel') : t('translateFromBase')}</Button>
                ) : null}
                {s.localizations?.[active] !== undefined
                  ? <Button variant="quiet" className="u-w-auto" onClick={() => patchOverlay(i, active, {})}>{t('clearOverlay')}</Button>
                  : null}
                {/* ADR 1112 P3 — a large schedule is translated in parts and can take up to a minute. */}
                {s.type === 'scheduleSim' && translating === `${s.sectionId}:${active}`
                  ? <span className="u-label-sm muted">{t('translatingLongHint')}</span>
                  : null}
              </div>
            ) : null}

            {translatorMode && onBase ? (
              // Translator surface: base content is READ-ONLY under the grant —
              // say so, and disable the fields (fieldset disables everything
              // inside; the server 403s a base change regardless).
              <>
                <span className="u-label-sm">{t('translatorBaseReadOnly')}</span>
                <fieldset disabled className="u-border-0 u-p-0 u-m-0">
                  <SectionFields
                    key={active}
                    section={{ ...s, data: layer }}
                    assets={assets}
                    onChange={() => undefined}
                    onPickMedia={onPickMedia}
                  />
                </fieldset>
              </>
            ) : (
              <SectionFields
                key={active}
                section={{ ...s, data: layer }}
                assets={assets}
                onChange={(data) => (onBase ? patchData(i, data) : patchOverlay(i, active, data))}
                onPickMedia={onPickMedia}
                libraryAlt={libraryAlt}
                baseData={onBase ? undefined : s.data}
              />
            )}
          </div>
        );
      })}
      {showStructure ? (
        <div className="action-bar">
          <AddSectionControl sharedSections={sharedSections} onAdd={(sec) => onChange([...sections, sec])} />
        </div>
      ) : null}
    </div>
  );
}
