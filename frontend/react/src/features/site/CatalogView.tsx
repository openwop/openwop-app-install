/**
 * Client-side filter for a large CMS feature catalog (ADR 0027 Features page).
 * The published page is a long run of `columns/cards` sections; a visitor who
 * already knows what they're after shouldn't have to scroll 40+ cards. This adds
 * ONE search field that live-filters every catalog card by name + description,
 * hides groups with no match, and announces the result count — reusing the
 * shared SectionRenderer for the actual cards (no rendering fork).
 *
 * Purely additive + presentational: it filters already-fetched sections, touches
 * no network, and leaves non-card sections (hero / how-it-works / stats / cta)
 * exactly as the renderer draws them. The FIRST card grid is treated as an
 * always-shown lead-in (the "Start here" essentials); the search sits before the
 * comprehensive grids and filters only those.
 *
 * Activates only for a LARGE catalog (>= 4 card sections, via {@link hasLargeCatalog})
 * so ordinary CMS pages — including the home page — render through the plain
 * renderer untouched.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RenderSection } from '../cms/SectionRenderer.js';
import type { Section } from '../cms/cmsClient.js';
import { SearchIcon, XIcon } from '../../ui/icons/index.js';

interface Card { title?: string; text?: string; href?: string; icon?: string; optional?: boolean }

const isCardsSection = (s: Section): boolean =>
  s.type === 'columns' && (s.data as { layout?: string }).layout === 'cards';
const cardsOf = (s: Section): Card[] => {
  const cols = (s.data as { columns?: unknown }).columns;
  return Array.isArray(cols) ? (cols as Card[]) : [];
};
const norm = (s: string): string => s.toLowerCase();
const matches = (c: Card, q: string): boolean => norm(`${c.title ?? ''} ${c.text ?? ''}`).includes(q);

/** Whether a page is a large feature catalog worth its own search field. */
export function hasLargeCatalog(sections: Section[]): boolean {
  return sections.filter(isCardsSection).length >= 4;
}

export function CatalogView({ sections }: { sections: Section[] }): JSX.Element {
  const { t } = useTranslation('site');
  const [query, setQuery] = useState('');
  const q = norm(query.trim());

  // Card-grid indices. The first grid is the always-shown lead-in; the search
  // bar goes before the second, and only grids from there on are filterable.
  const cardIdxs = useMemo(
    () => sections.map((s, i) => (isCardsSection(s) ? i : -1)).filter((i) => i >= 0),
    [sections],
  );
  const searchAt = cardIdxs[1] ?? cardIdxs[0] ?? -1;
  const filterable = (i: number): boolean => i >= searchAt && isCardsSection(sections[i]!);

  const totalCards = useMemo(
    () => sections.reduce((n, s, i) => (filterable(i) ? n + cardsOf(s).length : n), 0),
    [sections, searchAt],
  );
  const matchCount = useMemo(
    () => (!q ? totalCards : sections.reduce(
      (n, s, i) => (filterable(i) ? n + cardsOf(s).filter((c) => matches(c, q)).length : n), 0,
    )),
    [sections, q, totalCards, searchAt],
  );

  const searchBar = (
    <section className="cms-public-section fp-section fp-search-band" key="catalog-search">
      <div className="fp-shell">
        <form role="search" className="fp-search" onSubmit={(e) => e.preventDefault()}>
          <SearchIcon size={18} />
          <input
            type="text"
            inputMode="search"
            className="fp-search__input"
            placeholder={t('catalogSearchPlaceholder', { count: totalCards })}
            aria-label={t('catalogSearchLabel')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          />
          {query ? (
            <button type="button" className="fp-search__clear" onClick={() => setQuery('')} aria-label={t('catalogSearchClear')}>
              <XIcon size={16} />
            </button>
          ) : null}
        </form>
        <p className="fp-search__status" aria-live="polite">
          {q ? t('catalogSearchStatus', { count: matchCount, total: totalCards }) : ''}
        </p>
      </div>
    </section>
  );

  const emptyNotice = (
    <section className="cms-public-section fp-section" key="catalog-empty">
      <div className="fp-shell">
        <p className="fp-search__empty">{t('catalogSearchEmpty', { query: query.trim() })}</p>
        <button type="button" className="fp-btn fp-btn--ghost" onClick={() => setQuery('')}>{t('catalogSearchClear')}</button>
      </div>
    </section>
  );

  const out: JSX.Element[] = [];
  sections.forEach((s, i) => {
    if (i === searchAt) out.push(searchBar);
    if (filterable(i) && q) {
      const cols = cardsOf(s).filter((c) => matches(c, q));
      if (cols.length === 0) return; // hide a group with no matches
      out.push(<RenderSection key={s.sectionId} section={{ ...s, data: { ...s.data, columns: cols } }} mode="public" />);
    } else {
      out.push(<RenderSection key={s.sectionId} section={s} mode="public" />);
    }
  });
  if (q && matchCount === 0) {
    const at = out.findIndex((el) => el.key === 'catalog-search');
    out.splice(at + 1, 0, emptyNotice);
  }

  return <>{out}</>;
}
