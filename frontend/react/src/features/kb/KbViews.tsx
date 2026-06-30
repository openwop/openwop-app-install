/**
 * Document Card + Row — the two cells of the §4.5 collection-view canon (rule 11)
 * for the Knowledge Base page's document list. The Card fills a `.card-grid`; the
 * Row fills a `.surface-card.list-view`. Both derive their chips + sub-line from
 * the SAME helpers below, so the grid and list views never diverge (the
 * `subLine`/`primaryAction` precedent on `/agents`, mirrored from Projects'
 * `ProjectViews`). Composed from existing primitives — no bespoke CSS.
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FileTextIcon, TrashIcon } from '../../ui/icons/index.js';
import type { KbDocument } from './kbClient.js';

// The document source is a provenance marker, not a run-state — but the §5.3
// chip families read naturally: a media-token import is host-managed content, a
// pasted text doc is author-entered. Text label + tone, so colour is never the
// sole signal.
const SOURCE_KEY: Record<KbDocument['source']['kind'], string> = {
  text: 'sourceText',
  media: 'sourceMedia',
};

/** The contextual one-liner from REAL fields — the human source label. Shared by
 *  Card + Row. */
export function documentSubLine(d: KbDocument, t: TFunction): string {
  return t(SOURCE_KEY[d.source.kind]);
}

function DocumentChips({ d, t }: { d: KbDocument; t: TFunction }): JSX.Element {
  return (
    <>
      <span className="chip" title={t('chunksTooltip')}>{t('chunkCount', { count: d.chunkCount })}</span>
      <span className="chip chip--muted">{t(SOURCE_KEY[d.source.kind])}</span>
    </>
  );
}

export function DocumentCard({
  document: d,
  onRemove,
  canRemove,
}: {
  document: KbDocument;
  onRemove: (documentId: string) => void;
  canRemove: boolean;
}): JSX.Element {
  const { t } = useTranslation('kb');
  return (
    <div className="surface-card u-flex u-flex-col u-gap-2">
      <span className="u-flex u-items-center u-gap-2">
        <FileTextIcon size={16} aria-hidden /> <strong className="u-fs-14">{d.title}</strong>
      </span>
      <span className="muted u-fs-13">{documentSubLine(d, t)}</span>
      <div className="u-flex u-gap-2 u-wrap u-items-center">
        <DocumentChips d={d} t={t} />
      </div>
      {canRemove ? (
        <div className="action-bar u-mt-2">
          <button
            type="button"
            className="btn-ghost"
            title={t('deleteDocument')}
            aria-label={t('deleteDocument')}
            onClick={() => onRemove(d.documentId)}
          >
            <TrashIcon aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function DocumentRow({
  document: d,
  onRemove,
  canRemove,
}: {
  document: KbDocument;
  onRemove: (documentId: string) => void;
  canRemove: boolean;
}): JSX.Element {
  const { t } = useTranslation('kb');
  return (
    <div className="list-row">
      <span className="list-row-id">
        <FileTextIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{d.title}</span>
          </span>
          <span className="list-row-sub">{documentSubLine(d, t)}</span>
        </span>
      </span>
      <div className="list-row-meta">
        <DocumentChips d={d} t={t} />
      </div>
      <div className="list-row-actions action-bar">
        {canRemove ? (
          <button
            type="button"
            className="btn-ghost"
            title={t('deleteDocument')}
            aria-label={t('deleteDocument')}
            onClick={() => onRemove(d.documentId)}
          >
            <TrashIcon aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}
