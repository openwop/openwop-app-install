/**
 * The add-section picker (ADR 0828 phase 2): every section type as a card with
 * a sketch of its layout and one line on what it is for, filtered by category
 * or search, plus the org's shared sections. Choosing one adds it and closes.
 *
 * The sketches are drawn in CSS from the type alone, so the picker needs no
 * sample content and makes no requests (product grids, forms and entity
 * sections read live data that a preview here could not have).
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Modal } from '../../ui/Modal.js';
import { SearchIcon } from '../../ui/icons/index.js';
import { blankSection } from './SectionsEditor.js';
import { SECTION_TYPES, type Section, type SectionType, type SharedSection } from './cmsClient.js';

type Category = 'all' | 'text' | 'media' | 'data' | 'shared';

const CATEGORY_OF: Record<string, Exclude<Category, 'all' | 'shared'>> = {
  hero: 'text', richText: 'text', cta: 'text', columns: 'text', faq: 'text', quotes: 'text',
  image: 'media', video: 'media',
  productGrid: 'data', pricing: 'data', form: 'data', entityList: 'data', entityDetail: 'data',
};

export function SectionPicker({ sharedSections, onPick, onClose }: {
  sharedSections?: SharedSection[] | undefined;
  onPick: (section: Section) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const [category, setCategory] = useState<Category>('all');
  const [q, setQ] = useState('');
  const shared = sharedSections ?? [];
  const query = q.trim().toLowerCase();

  const types = useMemo(() => SECTION_TYPES.filter((type) => {
    if (category === 'shared') return false;
    if (category !== 'all' && CATEGORY_OF[type] !== category) return false;
    if (!query) return true;
    const hay = `${t(`sectionType_${type}`, { defaultValue: type })} ${t(`sectionPickerDesc_${type}`, { defaultValue: '' })}`.toLowerCase();
    return hay.includes(query);
  }), [category, query, t]);
  const sharedShown = (category === 'all' || category === 'shared')
    ? shared.filter((sh) => !query || sh.name.toLowerCase().includes(query))
    : [];

  const categories: Array<{ id: Category; label: string }> = [
    { id: 'all', label: t('sectionPickerAll') },
    { id: 'text', label: t('sectionPickerText') },
    { id: 'media', label: t('sectionPickerMedia') },
    { id: 'data', label: t('sectionPickerData') },
    ...(shared.length > 0 ? [{ id: 'shared' as const, label: t('sectionPickerShared', { count: shared.length }) }] : []),
  ];

  return (
    <Modal onClose={onClose} label={t('sectionPickerTitle')} className="hire-modal cms-picker" showClose>
      <div className="u-grid u-gap-3">
        <h2 className="u-fs-16 u-m-0">{t('sectionPickerTitle')}</h2>
        <div className="u-flex u-gap-2 u-items-center u-wrap">
          <label className="cms-picker-search">
            <SearchIcon size={14} aria-hidden />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('sectionPickerSearch')}
              aria-label={t('sectionPickerSearch')}
            />
          </label>
          <div className="segmented" role="group" aria-label={t('sectionPickerCategories')}>
            {categories.map((c) => (
              <Button key={c.id} variant="primary" size="sm" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{c.label}</Button>
            ))}
          </div>
        </div>
        {types.length === 0 && sharedShown.length === 0 ? (
          <p className="u-label-sm u-m-0">{t('sectionPickerNone')}</p>
        ) : (
          <ul className="cms-picker-grid">
            {types.map((type) => (
              <li key={type}>
                <Button variant="quiet" className="cms-picker-card" onClick={() => { onPick(blankSection(type)); onClose(); }}>
                  <SectionSketch type={type} />
                  <span className="cms-picker-name">{t(`sectionType_${type}`, { defaultValue: type })}</span>
                  <span className="cms-picker-desc">{t(`sectionPickerDesc_${type}`, { defaultValue: '' })}</span>
                </Button>
              </li>
            ))}
            {sharedShown.map((sh) => (
              <li key={sh.sharedSectionId}>
                <Button
                  variant="quiet"
                  className="cms-picker-card"
                  onClick={() => {
                    onPick({ sectionId: `new:${Math.random().toString(36).slice(2)}`, type: sh.type, data: {}, ref: { sharedSectionId: sh.sharedSectionId } });
                    onClose();
                  }}
                >
                  <SectionSketch type={sh.type} />
                  <span className="cms-picker-name">{sh.name}</span>
                  <span className="cms-picker-desc">{t('sectionPickerSharedDesc', { type: t(`sectionType_${sh.type}`, { defaultValue: sh.type }) })}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/** A small wireframe of a section type's layout, drawn from spans. */
function SectionSketch({ type }: { type: SectionType }): JSX.Element {
  const line = (w: string, key: string, kind = ''): JSX.Element => <span key={key} className={`cms-sk-line${kind ? ` cms-sk-line--${kind}` : ''}`} data-w={w} />;
  const box = (key: string, kind = ''): JSX.Element => <span key={key} className={`cms-sk-box${kind ? ` cms-sk-box--${kind}` : ''}`} />;
  const parts: Record<string, JSX.Element[]> = {
    hero: [line('60', 'h', 'head'), line('80', 'a'), line('50', 'b'), box('btn', 'btn')],
    richText: [line('45', 'h', 'head'), line('100', 'a'), line('95', 'b'), line('90', 'c'), line('70', 'd')],
    image: [box('img', 'img'), line('40', 'cap')],
    video: [line('45', 'h', 'head'), box('img', 'img'), line('60', 'cap')],
    cta: [line('55', 'h', 'head'), line('70', 'a'), box('btn', 'btn')],
    columns: [<span key="row" className="cms-sk-row">{box('a', 'col')}{box('b', 'col')}{box('c', 'col')}</span>],
    faq: [line('80', 'a', 'q'), line('80', 'b', 'q'), line('80', 'c', 'q')],
    quotes: [<span key="row" className="cms-sk-row">{box('a', 'quote')}{box('b', 'quote')}</span>],
    pricing: [<span key="row" className="cms-sk-row">{box('a', 'tier')}{box('b', 'tier')}{box('c', 'tier')}</span>],
    productGrid: [<span key="row" className="cms-sk-row">{box('a', 'tile')}{box('b', 'tile')}{box('c', 'tile')}{box('d', 'tile')}</span>],
    form: [box('a', 'field'), box('b', 'field'), box('btn', 'btn')],
    entityList: [line('100', 'a', 'item'), line('100', 'b', 'item'), line('100', 'c', 'item')],
    entityDetail: [<span key="row" className="cms-sk-row">{box('img', 'thumb')}<span className="cms-sk-stack">{line('70', 'h', 'head')}{line('90', 'a')}{line('60', 'b')}</span></span>],
  };
  return <span className="cms-sk" aria-hidden="true">{parts[type] ?? [box('x', 'img')]}</span>;
}
