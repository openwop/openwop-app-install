/**
 * Shared CMS sections editor (ADR 0027) — the section list + per-section fields +
 * add/move/remove controls, extracted from CmsPage so BOTH the org-scoped CMS
 * page editor AND the host-level home-page editor (Admin → Content → Front page)
 * use ONE editor. It's a controlled component: give it `sections` + `onChange`.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { config, fetchOpts, authedHeaders } from '../../client/config.js';
import { formatNumber } from '../../i18n/format.js';
import { ArrowDownIcon, ArrowUpIcon, ImageIcon, PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import { handleTablistKeyDown } from '../../ui/rovingTabs.js';
import { FIELD_NAME_RE, FIELDS_MAX_KEYS } from './fieldsSection.js';
import { SECTION_TYPES, type MediaAssetRef, type Section, type SectionType, type SharedSection } from './cmsClient.js';

/** Name a BCP-47 tag in the reader's language (endonym fallback to the tag). */
function localeLabel(tag: string): string {
  try {
    return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

function blankSection(type: SectionType): Section {
  const data: Record<string, unknown> =
    type === 'hero' ? { heading: '' }
      : type === 'richText' ? { text: '' }
        : type === 'image' ? { token: '' }
          : type === 'cta' ? { label: '', url: '' }
            : type === 'productGrid' ? { heading: '', storeOrgId: '', productIds: [] }
              : type === 'entityList' ? { heading: '', tenantId: '', typeName: '', titleField: '' }
                : type === 'entityDetail' ? { heading: '', tenantId: '', typeName: '', entityId: '', titleField: '' }
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

/** A mono "eyebrow" + serif "heading" shared by marketing-block sections. */
function HeadFields({ d, set }: { d: Record<string, unknown>; set: (k: string, v: unknown) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  return (
    <>
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('eyebrowLabel')}</span><input value={str(d.eyebrow)} onChange={(e) => set('eyebrow', e.target.value)} placeholder={t('eyebrowPlaceholder')} /></label>
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('headingLabel')}</span><input value={str(d.heading)} onChange={(e) => set('heading', e.target.value)} /></label>
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
export function SectionFields(props: { section: Section; assets: MediaAssetRef[]; onChange: (data: Record<string, unknown>) => void; onPickMedia?: (() => Promise<string | null>) | undefined; /** The base layer, when `section.data` is a locale overlay (ADR 0748 — `fields` needs it). */ baseData?: Record<string, unknown> | undefined }): JSX.Element {
  return <div className="cms-section-fields"><SectionFieldsBody {...props} /></div>;
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
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('headingLabel')}</span><input value={str(d.heading)} onChange={(e) => set('heading', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('heroSubheadingLabel')}</span><textarea rows={2} value={str(d.subheading)} onChange={(e) => set('subheading', e.target.value)} /></label>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('heroVisualLabel')}</span>
            <select value={str(d.visual) || (str(d.imageToken) ? 'image' : 'workflow')} onChange={(e) => set('visual', e.target.value)}>
              <option value="workflow">{t('heroVisualWorkflow')}</option>
              <option value="journey">{t('heroVisualJourney')}</option>
              <option value="run">{t('heroVisualRun')}</option>
              <option value="image">{t('heroVisualImage')}</option>
              <option value="none">{t('heroVisualNone')}</option>
            </select>
          </label>
          <div className="u-grid u-gap-1 u-grid-2">
            <input aria-label={t('heroPrimaryLabelAria')} value={str(d.ctaLabel)} onChange={(e) => set('ctaLabel', e.target.value)} placeholder={t('heroPrimaryLabelPlaceholder')} />
            <input aria-label={t('heroPrimaryUrlAria')} value={str(d.ctaUrl)} onChange={(e) => set('ctaUrl', e.target.value)} placeholder={t('heroPrimaryUrlPlaceholder')} />
            <input aria-label={t('heroSecondaryLabelAria')} value={str(d.ctaLabel2)} onChange={(e) => set('ctaLabel2', e.target.value)} placeholder={t('heroSecondaryLabelPlaceholder')} />
            <input aria-label={t('heroSecondaryUrlAria')} value={str(d.ctaUrl2)} onChange={(e) => set('ctaUrl2', e.target.value)} placeholder={t('heroSecondaryUrlPlaceholder')} />
          </div>
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
          <MediaTokenField value={str(d.token)} assets={assets} onChange={(v) => set('token', v)} label={t('imageLabel')} onPickMedia={onPickMedia} />
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('altTextLabel')}</span><input value={str(d.alt)} onChange={(e) => set('alt', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('captionLabel')}</span><input value={str(d.caption)} onChange={(e) => set('caption', e.target.value)} /></label>
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
      const cols: { title?: string; text?: string; href?: string; icon?: string }[] = Array.isArray(d.columns) ? d.columns : [];
      const setCol = (i: number, patch: Record<string, string>): void =>
        set('columns', cols.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('layoutLabel')}</span>
            <select value={str(d.layout) || 'cards'} onChange={(e) => set('layout', e.target.value)}>
              <option value="cards">{t('layoutCards')}</option>
              <option value="showcase">{t('layoutShowcase')}</option>
              <option value="steps">{t('layoutSteps')}</option>
              <option value="rows">{t('layoutRows')}</option>
              <option value="stats">{t('layoutStats')}</option>
            </select>
          </label>
          {cols.map((c, i) => (
            <div key={i} className="surface-card u-grid u-gap-1 u-p-2">
              <input aria-label={t('columnTitleAria', { n: formatNumber(i + 1) })} value={c.title ?? ''} onChange={(e) => setCol(i, { title: e.target.value })} placeholder={t('columnTitlePlaceholder', { n: formatNumber(i + 1) })} />
              <textarea aria-label={t('columnTextAria', { n: formatNumber(i + 1) })} rows={2} value={c.text ?? ''} onChange={(e) => setCol(i, { text: e.target.value })} placeholder={t('columnTextPlaceholder')} />
              <label className="u-grid u-gap-1"><span className="u-label-sm">{t('columnLinkLabel')}</span><input value={c.href ?? ''} onChange={(e) => setCol(i, { href: e.target.value })} placeholder={t('columnLinkPlaceholder')} /></label>
              <label className="u-grid u-gap-1"><span className="u-label-sm">{t('columnIconLabel')}</span><input value={c.icon ?? ''} onChange={(e) => setCol(i, { icon: e.target.value })} placeholder={t('columnIconPlaceholder')} /></label>
              <Button variant="quiet" className="u-w-auto" onClick={() => set('columns', cols.filter((_, j) => j !== i))} aria-label={t('removeItem')}><TrashIcon /> {t('removeItem')}</Button>
            </div>
          ))}
          <Button variant="quiet" className="u-w-auto" onClick={() => set('columns', [...cols, { title: '', text: '' }])}><PlusIcon /> {t('addItem')}</Button>
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
    default:
      return <span className="u-label-sm">{t('unknownSection')}</span>;
  }
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
              <ul className="u-grid u-gap-1 u-list-none u-p-0 u-m-0">
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
function LocaleTabs({ section, base, locales, active, onPick, localeState }: {
  section: Section;
  base: string;
  locales: string[];
  active: string;
  onPick: (locale: string) => void;
  /** Per-locale publish state (ADR 0205 D2) — a withheld locale is marked ON
   *  the tab (CMSUX-1), not only in the active tab's overlay row. */
  localeState?: Record<string, 'draft' | 'published'> | undefined;
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
            {authored ? <span className="cms-loc-dot" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function SectionsEditor({ sections, assets, onChange, baseLocale = 'en', locales, onTranslate, onPickMedia, sharedSections, sharedFailed, onSaveShared, localeState, onSetLocaleState, focusRequest, translatorMode }: {
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
  /** ADR 0592 §2 (CMSLU-1) — the translator surface's NARROWED presentation:
   *  base content renders read-only, section structure (add/move/remove/
   *  detach/save-as-shared) is hidden, overlay editing stays for the locales
   *  the parent passed in `locales` (already grant-filtered). Presentation
   *  only — the server's ADR 0205 D1 narrowing remains the authority. */
  translatorMode?: boolean;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const localeList = locales ?? [];
  const localized = localeList.length > 1;
  // Active edit locale per section (default the base).
  const [activeLocale, setActiveLocale] = useState<Record<string, string>>({});
  // `sectionId:locale` currently being AI-translated (disables its button).
  const [translating, setTranslating] = useState<string | null>(null);

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
  const add = (type: SectionType): void => onChange([...sections, blankSection(type)]);

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
                <span className="chip chip--accent">{s.type}</span>
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
                {!translatorMode ? (
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
              <span className="chip chip--accent">{s.type}</span>
              <span className="u-flex-1" />
              {onSaveShared && !translatorMode ? (
                <Button variant="quiet" className="u-w-auto" onClick={() => onSaveShared(s)}>{t('saveAsShared')}</Button>
              ) : null}
              {!translatorMode ? (
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
              />
            ) : null}

            {localized && !onBase ? (
              <div className="u-flex u-gap-1 u-items-center cms-loc-overlay-note">
                <span className="u-label-sm"><Trans t={t} i18nKey="overlayNote" values={{ locale: localeLabel(active) }} components={{ 1: <strong /> }} /></span>
                {localeState?.[active] === 'draft' ? (
                  <span className="chip chip--warning">{t('localeWithheldChip')}</span>
                ) : null}
                {s.aiDrafted?.[active] ? (
                  /* ADR 0592 §3 — machine-drafted, not yet human-edited. §5.3
                     model-provenance chip; editing the overlay clears it. */
                  <span className="chip chip--ai">{t('aiDraftChip')}</span>
                ) : null}
                <span className="u-flex-1" />
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
                baseData={onBase ? undefined : s.data}
              />
            )}
          </div>
        );
      })}
      {translatorMode ? null : (
      <div className="action-bar">
        <select
          aria-label={t('addSectionAria')}
          defaultValue=""
          className="u-w-auto"
          onChange={(e) => {
            const v = e.target.value;
            e.target.value = '';
            if (!v) return;
            if (v.startsWith('shared:')) {
              // ADR 0204 C4 — insert an inherit-by-reference section.
              const sharedSectionId = v.slice('shared:'.length);
              const shared = (sharedSections ?? []).find((sh) => sh.sharedSectionId === sharedSectionId);
              if (!shared) return;
              onChange([...sections, { sectionId: `new:${Math.random().toString(36).slice(2)}`, type: shared.type, data: {}, ref: { sharedSectionId } }]);
              return;
            }
            add(v as SectionType);
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
      </div>
      )}
    </div>
  );
}
