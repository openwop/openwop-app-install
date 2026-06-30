/**
 * Shared CMS sections editor (ADR 0027) — the section list + per-section fields +
 * add/move/remove controls, extracted from CmsPage so BOTH the org-scoped CMS
 * page editor AND the host-level home-page editor (Admin → Content → Front page)
 * use ONE editor. It's a controlled component: give it `sections` + `onChange`.
 */
import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import { handleTablistKeyDown } from '../../ui/rovingTabs.js';
import { SECTION_TYPES, type MediaAssetRef, type Section, type SectionType } from './cmsClient.js';

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
            : { columns: [{ text: '' }] };
  return { sectionId: `new:${Math.random().toString(36).slice(2)}`, type, data };
}

/** Section `data` is an open bag; coerce reads to string for inputs. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function MediaTokenField({ value, assets, onChange, label }: { value: string; assets: MediaAssetRef[]; onChange: (v: string) => void; label: string }): JSX.Element {
  const { t } = useTranslation('cms');
  // Preserve an already-set token absent from the current asset list (deleted /
  // foreign token) — else the <select> blanks and SAVING drops the reference.
  const known = assets.some((a) => (a.serveToken ?? '') === value);
  return (
    <label className="u-grid u-gap-1">
      <span className="u-label-sm">{t('mediaTokenLabel', { label })}</span>
      {assets.length > 0 ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {!known && value ? <option value={value}>{t('mediaTokenCurrent')}</option> : null}
          {assets.map((a) => <option key={a.assetId} value={a.serveToken ?? ''}>{a.name}</option>)}
        </select>
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('mediaTokenPlaceholder')} />
      )}
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

function SectionFields({ section, assets, onChange }: { section: Section; assets: MediaAssetRef[]; onChange: (data: Record<string, unknown>) => void }): JSX.Element {
  const { t } = useTranslation('cms');
  const d = section.data;
  const set = (k: string, v: unknown): void => onChange({ ...d, [k]: v });
  switch (section.type) {
    case 'hero':
      return (
        <div className="u-grid u-gap-2">
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('heroEyebrowLabel')}</span><input value={str(d.eyebrow)} onChange={(e) => set('eyebrow', e.target.value)} placeholder={t('heroEyebrowPlaceholder')} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('headingLabel')}</span><input value={str(d.heading)} onChange={(e) => set('heading', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('heroSubheadingLabel')}</span><textarea rows={2} value={str(d.subheading)} onChange={(e) => set('subheading', e.target.value)} /></label>
          <div className="u-grid u-gap-1 u-grid-2">
            <input value={str(d.ctaLabel)} onChange={(e) => set('ctaLabel', e.target.value)} placeholder={t('heroPrimaryLabelPlaceholder')} />
            <input value={str(d.ctaUrl)} onChange={(e) => set('ctaUrl', e.target.value)} placeholder={t('heroPrimaryUrlPlaceholder')} />
            <input value={str(d.ctaLabel2)} onChange={(e) => set('ctaLabel2', e.target.value)} placeholder={t('heroSecondaryLabelPlaceholder')} />
            <input value={str(d.ctaUrl2)} onChange={(e) => set('ctaUrl2', e.target.value)} placeholder={t('heroSecondaryUrlPlaceholder')} />
          </div>
          <MediaTokenField value={str(d.imageToken)} assets={assets} onChange={(v) => set('imageToken', v)} label={t('heroImageLabel')} />
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
          <MediaTokenField value={str(d.token)} assets={assets} onChange={(v) => set('token', v)} label={t('imageLabel')} />
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
      const cols: { title?: string; text?: string }[] = Array.isArray(d.columns) ? d.columns : [];
      const setCol = (i: number, patch: Record<string, string>): void =>
        set('columns', cols.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('layoutLabel')}</span>
            <select value={str(d.layout) || 'cards'} onChange={(e) => set('layout', e.target.value)}>
              <option value="cards">{t('layoutCards')}</option>
              <option value="steps">{t('layoutSteps')}</option>
              <option value="stats">{t('layoutStats')}</option>
            </select>
          </label>
          {cols.map((c, i) => (
            <div key={i} className="surface-card u-grid u-gap-1 u-p-2">
              <input value={c.title ?? ''} onChange={(e) => setCol(i, { title: e.target.value })} placeholder={t('columnTitlePlaceholder', { n: formatNumber(i + 1) })} />
              <textarea rows={2} value={c.text ?? ''} onChange={(e) => setCol(i, { text: e.target.value })} placeholder={t('columnTextPlaceholder')} />
              <button type="button" className="btn-ghost u-w-auto" onClick={() => set('columns', cols.filter((_, j) => j !== i))} aria-label={t('removeItem')}><TrashIcon /> {t('removeItem')}</button>
            </div>
          ))}
          <button type="button" className="btn-ghost u-w-auto" onClick={() => set('columns', [...cols, { title: '', text: '' }])}><PlusIcon /> {t('addItem')}</button>
        </div>
      );
    }
    default:
      return <span className="u-label-sm">{t('unknownSection')}</span>;
  }
}

/**
 * Per-section locale tab strip (ADR 0064). The base tab edits `section.data`;
 * each other tab edits the SPARSE `section.localizations[locale]` overlay. A
 * dot marks a locale that has authored content; the base tag marks the source.
 */
function LocaleTabs({ section, base, locales, active, onPick }: {
  section: Section;
  base: string;
  locales: string[];
  active: string;
  onPick: (locale: string) => void;
}): JSX.Element {
  const { t } = useTranslation('cms');
  return (
    <div className="cms-loc-tabs" role="tablist" aria-label={t('sectionLocalesAria')} onKeyDown={handleTablistKeyDown}>
      {locales.map((loc) => {
        const authored = loc === base
          ? Object.keys(section.data).length > 0
          : section.localizations?.[loc] !== undefined;
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
                : authored ? t('localeTabTranslated', { locale: localeLabel(loc) }) : t('localeTabNotTranslated', { locale: localeLabel(loc) })
            }
            className={active === loc ? 'cms-loc-tab is-active' : 'cms-loc-tab'}
            onClick={() => onPick(loc)}
          >
            {localeLabel(loc)}
            {loc === base ? <span className="cms-loc-base">{t('localeBaseTag')}</span> : null}
            {authored ? <span className="cms-loc-dot" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function SectionsEditor({ sections, assets, onChange, baseLocale = 'en', locales, onTranslate }: {
  sections: Section[];
  assets: MediaAssetRef[];
  onChange: (sections: Section[]) => void;
  /** Content base locale (ADR 0064) — the base tab edits `data`. */
  baseLocale?: string;
  /** Full tab order `[base, ...supported]`. Absent / single-entry ⇒ NO locale
   *  tabs (the home-page editor stays single-locale, unchanged). */
  locales?: string[];
  /** AI "translate from base" (ADR 0064 Phase 3). Returns the draft overlay, or
   *  null when unavailable (the caller toasts). Absent ⇒ no translate button. */
  onTranslate?: (sectionType: SectionType, data: Record<string, unknown>, targetLocale: string) => Promise<Record<string, unknown> | null>;
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
  const patchOverlay = (i: number, locale: string, overlay: Record<string, unknown>): void =>
    onChange(sections.map((s, j) => {
      if (j !== i) return s;
      const loc = { ...(s.localizations ?? {}) };
      const hasContent = Object.values(overlay).some((v) => v !== '' && v !== undefined && !(Array.isArray(v) && v.length === 0));
      if (hasContent) loc[locale] = overlay; else delete loc[locale];
      const next: Section = { ...s, ...(Object.keys(loc).length > 0 ? { localizations: loc } : {}) };
      if (Object.keys(loc).length === 0) delete next.localizations;
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

  return (
    <div className="u-grid u-gap-2">
      {sections.map((s, i) => {
        const active = localized ? (activeLocale[s.sectionId] ?? baseLocale) : baseLocale;
        const onBase = active === baseLocale;
        // The layer SectionFields edits: base `data`, or the locale overlay.
        const layer = onBase ? s.data : (s.localizations?.[active] ?? {});
        return (
          <div key={s.sectionId} className="surface-card u-gap-2 u-p-3">
            <div className="u-flex u-gap-1 u-items-center">
              <span className="chip chip--accent">{s.type}</span>
              <span className="u-flex-1" />
              <button type="button" className="btn-ghost" onClick={() => move(i, -1)} aria-label={t('moveUp')}><ArrowUpIcon /></button>
              <button type="button" className="btn-ghost" onClick={() => move(i, 1)} aria-label={t('moveDown')}><ArrowDownIcon /></button>
              <button type="button" className="btn-ghost" onClick={() => remove(i)} aria-label={t('removeSection')}><TrashIcon /></button>
            </div>

            {localized ? (
              <LocaleTabs
                section={s}
                base={baseLocale}
                locales={localeList}
                active={active}
                onPick={(loc) => setActiveLocale((m) => ({ ...m, [s.sectionId]: loc }))}
              />
            ) : null}

            {localized && !onBase ? (
              <div className="u-flex u-gap-1 u-items-center cms-loc-overlay-note">
                <span className="u-label-sm"><Trans t={t} i18nKey="overlayNote" values={{ locale: localeLabel(active) }} components={{ 1: <strong /> }} /></span>
                <span className="u-flex-1" />
                <button type="button" className="btn-ghost u-w-auto" onClick={() => patchOverlay(i, active, { ...s.data })}>{t('copyFromBase')}</button>
                {onTranslate ? (
                  <button
                    type="button"
                    className="btn-ghost u-w-auto"
                    disabled={translating === `${s.sectionId}:${active}` || Object.keys(s.data).length === 0}
                    title={Object.keys(s.data).length === 0 ? t('addBaseContentFirst') : undefined}
                    onClick={async () => {
                      const key = `${s.sectionId}:${active}`;
                      setTranslating(key);
                      try {
                        const overlay = await onTranslate(s.type, s.data, active);
                        if (overlay) patchOverlay(i, active, overlay);
                      } finally {
                        setTranslating((k) => (k === key ? null : k));
                      }
                    }}
                  >{translating === `${s.sectionId}:${active}` ? t('translatingLabel') : t('translateFromBase')}</button>
                ) : null}
                {s.localizations?.[active] !== undefined
                  ? <button type="button" className="btn-ghost u-w-auto" onClick={() => patchOverlay(i, active, {})}>{t('clearOverlay')}</button>
                  : null}
              </div>
            ) : null}

            <SectionFields
              key={active}
              section={{ ...s, data: layer }}
              assets={assets}
              onChange={(data) => (onBase ? patchData(i, data) : patchOverlay(i, active, data))}
            />
          </div>
        );
      })}
      <div className="action-bar">
        <select aria-label={t('addSectionAria')} defaultValue="" onChange={(e) => { if (e.target.value) { add(e.target.value as SectionType); e.target.value = ''; } }} className="u-w-auto">
          <option value="">{t('addSectionPlaceholder')}</option>
          {SECTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
    </div>
  );
}
