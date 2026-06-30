/**
 * Document Card + Row — the two cells of the §4.5 collection-view canon (rule 11)
 * for the Documents page. The Card fills a `.card-grid`; the Row fills a
 * `.surface-card.list-view`. Both derive their status/kind chips + sub-line from
 * the SAME helpers below, so the grid and list views never diverge (the
 * ProjectViews precedent). Documents open via an `onOpen` callback (not a Link),
 * so the identity is a `<button>`. Composed from existing primitives — no
 * bespoke CSS.
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FileTextIcon, TrashIcon } from '../../ui/icons/index.js';
import { formatDateTime } from '../../i18n/format.js';
import type { DocumentRecord } from './documentsClient.js';

// Status is a document-lifecycle marker: final/approved read as "done"
// (success tone), everything in-flight stays neutral (muted). Text label +
// tone, so colour is never the sole signal.
function statusChipClass(status: DocumentRecord['status']): string {
  return status === 'final' || status === 'approved' ? 'chip--success' : 'chip--muted';
}

/** The contextual one-liner from REAL fields — the format, else a fallback.
 *  Shared by Card + Row. */
export function documentSubLine(doc: DocumentRecord, t: TFunction): string {
  return doc.format || t('subLine');
}

function DocumentChips({ doc }: { doc: DocumentRecord }): JSX.Element {
  return (
    <>
      <span className={`chip ${statusChipClass(doc.status)}`}>{doc.status}</span>
      <span className="chip chip--muted">{doc.kind}</span>
    </>
  );
}

// A document Card opens via its whole-surface button, so it carries NO nested
// delete (a <button> inside a <button> is invalid). Delete lives on the dense
// Row's action-bar, matching the ProjectCard "card = navigate, no actions"
// precedent.
export function DocumentCard({
  doc,
  onOpen,
}: {
  doc: DocumentRecord;
  onOpen: (doc: DocumentRecord) => void;
}): JSX.Element {
  const { t } = useTranslation('documents');
  return (
    <button
      type="button"
      className="surface-card u-flex u-flex-col u-gap-2 u-text-left"
      title={t('openDocument', { title: doc.title })}
      onClick={() => onOpen(doc)}
    >
      <span className="u-flex u-items-center u-gap-2">
        <FileTextIcon size={16} aria-hidden /> <strong className="u-fs-14">{doc.title}</strong>
      </span>
      <span className="muted u-fs-13">{documentSubLine(doc, t)}</span>
      <div className="u-flex u-gap-2 u-wrap u-items-center">
        <DocumentChips doc={doc} />
      </div>
      <span className="muted u-fs-12">{formatDateTime(doc.updatedAt)}</span>
    </button>
  );
}

export function DocumentRow({
  doc,
  onOpen,
  onRemove,
}: {
  doc: DocumentRecord;
  onOpen: (doc: DocumentRecord) => void;
  onRemove: (doc: DocumentRecord) => void;
}): JSX.Element {
  const { t } = useTranslation('documents');
  return (
    <div className="list-row">
      <button
        type="button"
        className="list-row-id"
        title={t('openDocument', { title: doc.title })}
        onClick={() => onOpen(doc)}
      >
        <FileTextIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{doc.title}</span>
          </span>
          <span className="list-row-sub">{documentSubLine(doc, t)}</span>
        </span>
      </button>
      <div className="list-row-meta">
        <DocumentChips doc={doc} />
        <span>{formatDateTime(doc.updatedAt)}</span>
      </div>
      <div className="list-row-actions action-bar">
        <button type="button" className="secondary btn-sm" onClick={() => onOpen(doc)}>{t('open')}</button>
        <button type="button" className="btn-ghost" aria-label={t('common:delete')} onClick={() => onRemove(doc)}><TrashIcon aria-hidden /></button>
      </div>
    </div>
  );
}
