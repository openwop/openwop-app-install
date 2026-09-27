/**
 * Document Card + Row — the two cells of the §4.5 collection-view canon (rule 11)
 * for the Knowledge Base page's document list. The Card fills a `.card-grid`; the
 * Row fills a `.surface-card.list-view`. Both derive their chips + sub-line from
 * the SAME helpers below, so the grid and list views never diverge (the
 * `subLine`/`primaryAction` precedent on `/agents`, mirrored from Projects'
 * `ProjectViews`). Composed from existing primitives — no bespoke CSS.
 */

import { Button } from '../../ui/Button.js';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FileTextIcon, TrashIcon } from '../../ui/icons/index.js';
import type { KbDocument } from './kbClient.js';

// The document source is a provenance marker, not a run-state — but the §5.3
// chip families read naturally: a media-token import is host-managed content, a
// pasted text doc is author-entered. Text label + tone, so colour is never the
// sole signal.
//
// KB-UX-8 (widened by the 2026-09-03 pass into a RENDERING bug) — this map was
// `Record<'text' | 'media', string>` while the wire union already carried a
// third arm, `{kind:'url'; url}`. A URL-ingested document therefore looked up
// `SOURCE_KEY['url']` = `undefined` and rendered `t(undefined)` in BOTH the
// sub-line and the chip, in BOTH views. Keying the Record off
// `KbDocument['source']['kind']` (rather than a hand-written union) is what
// makes the next wire arm a COMPILE error here instead of a blank label.
const SOURCE_KEY: Record<KbDocument['source']['kind'], string> = {
  text: 'sourceText',
  media: 'sourceMedia',
  url: 'sourceUrl',
};

/** The contextual one-liner from REAL fields — the human source label, plus the
 *  origin host for a URL document (the one source whose provenance a reader
 *  actually needs, and the one the app's own copy calls untrusted). Shared by
 *  Card + Row so the two views can never diverge. */
export function documentSubLine(d: KbDocument, t: TFunction): string {
  const label = t(SOURCE_KEY[d.source.kind]);
  if (d.source.kind !== 'url' || !d.source.url) return label;
  return t('sourceUrlFrom', { label, origin: displayOrigin(d.source.url) });
}

/** The human-readable origin of an ingested URL. A malformed value is shown as
 *  given rather than swallowed — an unparseable source is still provenance. */
function displayOrigin(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function DocumentChips({ d, t }: { d: KbDocument; t: TFunction }): JSX.Element {
  return (
    <>
      <span className="chip" title={t('chunksTooltip')}>{t('chunkCount', { count: d.chunkCount })}</span>
      <span className="chip chip--muted" {...(d.source.kind === 'url' && d.source.url ? { title: d.source.url } : {})}>{t(SOURCE_KEY[d.source.kind])}</span>
    </>
  );
}

export function DocumentCard({
  document: d,
  onRemove,
  onOpen,
  canRemove,
  removeDisabledReason,
}: {
  document: KbDocument;
  onRemove: (documentId: string) => void;
  onOpen: (documentId: string) => void;
  canRemove: boolean;
  /** KBX-5 — when set, Delete stays VISIBLE but disabled and carries this
   *  sentence as its title/description. Hiding the control instead would make
   *  the page look as though deletion were never possible here. */
  removeDisabledReason?: string | undefined;
}): JSX.Element {
  const { t } = useTranslation('kb');
  return (
    <div className="surface-card u-flex u-flex-col u-gap-2">
      <Button variant="primary" className="u-button-bare u-flex u-items-center u-gap-2" onClick={() => onOpen(d.documentId)} title={t('openDocument')}>
        <FileTextIcon size={16} aria-hidden /> <strong className="u-fs-14 inline-link">{d.title}</strong>
      </Button>
      <span className="muted u-fs-13">{documentSubLine(d, t)}</span>
      <div className="u-flex u-gap-2 u-wrap u-items-center">
        <DocumentChips d={d} t={t} />
      </div>
      {canRemove ? (
        <div className="action-bar u-mt-2">
          <Button
            variant="quiet"
            disabled={!!removeDisabledReason}
            title={removeDisabledReason ?? t('deleteDocument')}
            aria-label={removeDisabledReason ? `${t('deleteDocument')} — ${removeDisabledReason}` : t('deleteDocument')}
            onClick={() => onRemove(d.documentId)}
          >
            <TrashIcon aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function DocumentRow({
  document: d,
  onRemove,
  onOpen,
  canRemove,
  removeDisabledReason,
}: {
  document: KbDocument;
  onRemove: (documentId: string) => void;
  onOpen: (documentId: string) => void;
  canRemove: boolean;
  /** KBX-5 — see `DocumentCard`. */
  removeDisabledReason?: string | undefined;
}): JSX.Element {
  const { t } = useTranslation('kb');
  return (
    <div className="list-row">
      <button type="button" className="list-row-id u-button-bare" onClick={() => onOpen(d.documentId)} title={t('openDocument')}>
        <FileTextIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name inline-link">{d.title}</span>
          </span>
          <span className="list-row-sub">{documentSubLine(d, t)}</span>
        </span>
      </button>
      <div className="list-row-meta">
        <DocumentChips d={d} t={t} />
      </div>
      <div className="list-row-actions action-bar">
        {canRemove ? (
          <Button
            variant="quiet"
            disabled={!!removeDisabledReason}
            title={removeDisabledReason ?? t('deleteDocument')}
            aria-label={removeDisabledReason ? `${t('deleteDocument')} — ${removeDisabledReason}` : t('deleteDocument')}
            onClick={() => onRemove(d.documentId)}
          >
            <TrashIcon aria-hidden />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
