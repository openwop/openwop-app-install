/**
 * TemplateGallery — the ONE "start from a template" surface (DESIGN.md §4.5
 * rule 14).
 *
 * WHY THIS EXISTS. Template pickers were being rendered as an inline strip of
 * buttons next to the create field ("Or start from a template: Contact us ·
 * Event RSVP · Job application · Product feedback"). That reads fine at four and
 * is unusable at forty: the strip wraps into a wall, there is nothing to search,
 * nothing to filter, and no room to say what a template actually contains. A
 * template catalog is pack-sourced (ADR 0516) — an operator or a third party can
 * ship their own — so "there will only ever be a handful" was never a safe
 * assumption to build the UI on.
 *
 * THE SHAPE, and why it is a dialog rather than a page. A template picker is a
 * self-contained detour inside a creation flow: you are on the surface you are
 * creating into, you pick, and you come straight back. That is the case overlays
 * are for — they preserve the context you are creating in, where a full page
 * would make you navigate away and back for a five-second decision. (It is also
 * what Notion, Figma and Canva ship for the same job.) A full page earns its
 * keep when the browsing IS the task — the workflow-chain gallery on the builder
 * dashboard is that, and stays a page.
 *
 * TWO EXPORTS, because a picker is not always launched from a plain surface:
 *   - `TemplateGalleryDialog` — Modal + body. The default: any surface with a
 *     "start from a template" affordance opens this.
 *   - `TemplateGalleryBody` — the body alone, for a picker that is already a
 *     STEP inside an existing modal (the Documents new-document flow). A modal
 *     inside a modal is never the answer.
 *
 * A feature supplies its own items + an `onUse`; it does NOT supply search,
 * filtering, grid chrome, or empty states. `renderPreview` is the one escape
 * hatch — the canvas gallery renders each template through its real Renderer,
 * and that stays possible without forking the component.
 */
import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal.js';
import { Button } from './Button.js';
import { StateCard } from './StateCard.js';
import { Skeleton } from './Skeleton.js';
import { LayoutGridIcon } from './icons/index.js';

/** The shape every template catalog can project onto. Features map their own
 *  row type to this — the gallery never learns a feature's vocabulary. */
export interface TemplateItem {
  id: string;
  label: string;
  description?: string;
  /** Groups the facet filter. Omit and the facet does not render. */
  category?: string;
  /** Extra scannable facts (field count, step count) — rendered as chips. */
  meta?: string[];
}

export interface TemplateGalleryProps {
  items: readonly TemplateItem[] | null;
  /** The catalog read FAILED — distinct from `null` (loading) and `[]` (none). */
  failed?: boolean;
  onUse: (id: string) => void;
  busy?: boolean;
  /** Optional live preview per template (the canvas gallery's real Renderer). */
  renderPreview?: (item: TemplateItem) => ReactNode;
  /** Feature-supplied copy for the empty state, which is feature-specific
   *  ("no form templates installed" vs "no canvas templates"). */
  emptyTitle?: string;
  emptyBody?: string;
}

/** Search + facet gate: below this many templates, filtering is noise. */
const FILTER_FLOOR = 6;

export function TemplateGalleryBody({
  items, failed = false, onUse, busy = false, renderPreview, emptyTitle, emptyBody,
}: TemplateGalleryProps): JSX.Element {
  const { t } = useTranslation('common');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');

  const categories = useMemo(
    () => [...new Set((items ?? []).map((i) => i.category).filter((c): c is string => Boolean(c)))].sort(),
    [items],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((i) =>
      (!category || i.category === category)
      && (!q || i.label.toLowerCase().includes(q) || (i.description?.toLowerCase().includes(q) ?? false)));
  }, [items, query, category]);

  // Gated on the UNFILTERED total so the controls can't vanish mid-search and
  // strand the user in a filtered list (§4.5 rule 13).
  const showFilters = (items?.length ?? 0) >= FILTER_FLOOR;

  if (failed) {
    return <StateCard announce icon={<LayoutGridIcon size={20} />} title={t('loadFailedTitle')} body={t('loadFailedBody')} />;
  }
  if (items === null) return <Skeleton />;
  if (items.length === 0) {
    return (
      <StateCard
        icon={<LayoutGridIcon size={20} />}
        title={emptyTitle ?? t('templatesEmptyTitle')}
        body={emptyBody ?? t('templatesEmptyBody')}
      />
    );
  }

  return (
    <div className="u-grid u-gap-3">
      {showFilters ? (
        <div className="filterbar" role="group" aria-label={t('templatesFilterGroup')}>
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('templatesSearchPlaceholder')}
            aria-label={t('templatesSearchAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {categories.length > 1 ? (
            <select
              className="ui-input filterbar-select"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label={t('templatesCategoryAria')}
            >
              <option value="">{t('templatesAllCategories')}</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : null}
        </div>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">{t('templatesResultCount', { count: visible.length })}</p>

      {visible.length === 0 ? (
        <StateCard
          icon={<LayoutGridIcon size={20} />}
          title={t('templatesNoMatchTitle')}
          body={t('templatesNoMatchBody')}
          action={<Button variant="secondary" onClick={() => { setQuery(''); setCategory(''); }}>{t('templatesClearFilters')}</Button>}
        />
      ) : (
        <div className="tpl-gallery__grid">
          {visible.map((item) => (
            <article key={item.id} className="surface-card tpl-gallery__card">
              <div className="u-flex u-flex-col u-gap-1">
                <strong className="u-fs-14">{item.label}</strong>
                {item.description ? <p className="muted u-fs-12 u-m-0">{item.description}</p> : null}
              </div>
              {renderPreview ? (
                <div className="tpl-gallery__preview" aria-hidden>
                  <div className="tpl-gallery__preview-scale">{renderPreview(item)}</div>
                </div>
              ) : null}
              {item.category || item.meta?.length ? (
                <div className="u-flex u-gap-1 u-wrap u-items-center">
                  {item.category ? <span className="chip chip--muted">{item.category}</span> : null}
                  {item.meta?.map((m) => <span key={m} className="chip chip--muted">{m}</span>)}
                </div>
              ) : null}
              <div className="action-bar u-justify-end u-mt-auto">
                <Button
                  variant="accent"
                  size="sm"
                  disabled={busy}
                  aria-label={t('templatesUseNamed', { name: item.label })}
                  onClick={() => onUse(item.id)}
                >
                  {t('templatesUse')}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function TemplateGalleryDialog({ onClose, title, ...body }: TemplateGalleryProps & {
  onClose: () => void;
  /** The dialog's accessible name + visible heading, in the feature's words
   *  ("Start a form from a template"). */
  title: string;
}): JSX.Element {
  return (
    <Modal label={title} onClose={onClose} className="surface-card tpl-gallery" showClose>
      <h2 className="u-fs-16 u-m-0">{title}</h2>
      <TemplateGalleryBody {...body} />
    </Modal>
  );
}
