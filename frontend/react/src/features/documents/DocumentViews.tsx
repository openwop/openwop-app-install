/**
 * Document Card + Row — the two cells of the §4.5 collection-view canon (rule 11)
 * for the Documents page. The Card fills a `.card-grid`; the Row fills a
 * `.surface-card.list-view`. Both derive their status/kind chips + sub-line from
 * the SAME helpers below, so the grid and list views never diverge (the
 * ProjectViews precedent). Every document + canvas now has its own URL (ADR 0350
 * Phase 1), so the identity is a real `<Link>` — middle-click / ⌘-click / "open
 * in new tab" work natively. A canvas whose editor feature is OFF has no `href`
 * and renders as a non-interactive cell (still deletable via its action-bar).
 * Composed from existing primitives — no bespoke CSS.
 */

import { Button } from '../../ui/Button.js';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FileTextIcon, FolderIcon, TrashIcon } from '../../ui/icons/index.js';
import { formatDateTime } from '../../i18n/format.js';
import type { DocumentRecord, CanvasSourceRow } from './documentsClient.js';

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

function DocumentChips({ doc, projectName }: { doc: DocumentRecord; projectName?: string | undefined }): JSX.Element {
  const { t } = useTranslation('documents');
  return (
    <>
      <span className={`chip ${statusChipClass(doc.status)}`}>{doc.status}</span>
      <span className="chip chip--muted">{doc.kind}</span>
      {/* ADR 0314/0316 — a project-owned document says so, naming the project
          when the page resolved it (falls back to the generic label). */}
      {doc.ownerSubject?.kind === 'project' ? (
        <span className="chip chip--muted"><FolderIcon size={12} aria-hidden /> {projectName ?? t('inProjectChip')}</span>
      ) : null}
    </>
  );
}

// A document Card links via its whole surface, so it carries NO nested delete (an
// interactive control inside an <a> is invalid). Delete lives on the dense Row's
// action-bar, matching the ProjectCard "card = navigate, no actions" precedent.
export function DocumentCard({
  doc,
  href,
  projectName,
}: {
  doc: DocumentRecord;
  /** ADR 0350 — the document's own URL (`/documents/:id?org=`). */
  href: string;
  /** ADR 0316 — the owning project's resolved name for the chip. */
  projectName?: string | undefined;
}): JSX.Element {
  const { t } = useTranslation('documents');
  return (
    <Link
      to={href}
      className="surface-card u-flex u-flex-col u-gap-2 u-text-left"
      title={t('openDocument', { title: doc.title })}
    >
      <span className="u-flex u-items-center u-gap-2">
        <FileTextIcon size={16} aria-hidden /> <strong className="u-fs-14">{doc.title}</strong>
      </span>
      <span className="muted u-fs-13">{documentSubLine(doc, t)}</span>
      <div className="u-flex u-gap-2 u-wrap u-items-center">
        <DocumentChips doc={doc} projectName={projectName} />
      </div>
      <span className="muted u-fs-12">{formatDateTime(doc.updatedAt)}</span>
    </Link>
  );
}

export function DocumentRow({
  doc,
  href,
  onRemove,
  onAssignProject,
  projectName,
}: {
  doc: DocumentRecord;
  /** ADR 0350 — the document's own URL (`/documents/:id?org=`). */
  href: string;
  onRemove: (doc: DocumentRecord) => void;
  /** ADR 0314 — open the Add-to-project dialog; absent (projects off /
   *  read-only caller) = no button. */
  onAssignProject?: (doc: DocumentRecord) => void;
  /** ADR 0316 — the owning project's resolved name for the chip. */
  projectName?: string | undefined;
}): JSX.Element {
  const { t } = useTranslation('documents');
  return (
    <div className="list-row">
      <Link
        to={href}
        className="list-row-id"
        title={t('openDocument', { title: doc.title })}
      >
        <FileTextIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{doc.title}</span>
          </span>
          <span className="list-row-sub">{documentSubLine(doc, t)}</span>
        </span>
      </Link>
      <div className="list-row-meta">
        <DocumentChips doc={doc} projectName={projectName} />
        <span>{formatDateTime(doc.updatedAt)}</span>
      </div>
      <div className="list-row-actions action-bar">
        <Link to={href} className="btn secondary btn-sm">{t('open')}</Link>
        {onAssignProject ? (
          <Button variant="quiet" aria-label={t('addToProject')} title={t('addToProject')} onClick={() => onAssignProject(doc)}><FolderIcon aria-hidden /></Button>
        ) : null}
        <Button variant="quiet" aria-label={t('common:delete')} onClick={() => onRemove(doc)}><TrashIcon aria-hidden /></Button>
      </div>
    </div>
  );
}

// ── Canvas-as-document cells (ADR 0319) ──────────────────────────────────────
// A canvas (slide deck, CAD model, drawing, campaign plan, app design, pack type)
// is just a document in this list. Same Card/Row canon as documents; the type
// (e.g. "Slide deck") takes the sub-line slot documents use for `format`. Opening
// links into the type's editor (`href` absent = its feature toggle is off ⇒ the
// row shows "Off" and isn't openable, but stays deletable — ADR 0316 DATA-CV-3).

/** Chips shared by the canvas Card + Row: a project chip when owned + resolved,
 *  and an "Off" chip when the type's editor feature is disabled. */
function CanvasChips({ canvas, canOpen, projectName }: { canvas: CanvasSourceRow; canOpen: boolean; projectName?: string | undefined }): JSX.Element {
  const { t } = useTranslation('documents');
  return (
    <>
      {canvas.projectId && projectName ? (
        <span className="chip chip--muted"><FolderIcon size={12} aria-hidden /> {projectName}</span>
      ) : null}
      {!canOpen ? <span className="chip chip--muted">{t('editorOff')}</span> : null}
    </>
  );
}

export function CanvasDocCard({ canvas, typeName, Icon, href, projectName }: {
  canvas: CanvasSourceRow;
  /** Localized type name, e.g. "Slide deck" — the sub-line. */
  typeName: string;
  /** The type's glyph (`canvasTypeIcon`). */
  Icon: typeof FileTextIcon;
  /** The editor URL; absent = the type's feature is off (not openable). */
  href?: string | undefined;
  projectName?: string | undefined;
}): JSX.Element {
  const { t } = useTranslation('documents');
  const name = canvas.name || t('untitledCanvas');
  const body = (
    <>
      <span className="u-flex u-items-center u-gap-2">
        <Icon size={16} aria-hidden /> <strong className="u-fs-14">{name}</strong>
      </span>
      <span className="muted u-fs-13">{typeName}</span>
      <div className="u-flex u-gap-2 u-wrap u-items-center">
        <CanvasChips canvas={canvas} canOpen={Boolean(href)} projectName={projectName} />
      </div>
      <span className="muted u-fs-12">{formatDateTime(canvas.updatedAt)}</span>
    </>
  );
  return href ? (
    <Link to={href} className="surface-card u-flex u-flex-col u-gap-2 u-text-left" title={t('openDocument', { title: name })}>
      {body}
    </Link>
  ) : (
    <div className="surface-card u-flex u-flex-col u-gap-2">{body}</div>
  );
}

export function CanvasDocRow({ canvas, typeName, Icon, href, onRemove, projectName }: {
  canvas: CanvasSourceRow;
  typeName: string;
  Icon: typeof FileTextIcon;
  href?: string | undefined;
  onRemove: (canvas: CanvasSourceRow) => void;
  projectName?: string | undefined;
}): JSX.Element {
  const { t } = useTranslation('documents');
  const name = canvas.name || t('untitledCanvas');
  const idInner = (
    <>
      <Icon size={18} aria-hidden />
      <span className="list-row-name-wrap">
        <span className="list-row-name-line"><span className="list-row-name">{name}</span></span>
        <span className="list-row-sub">{typeName}</span>
      </span>
    </>
  );
  return (
    <div className="list-row">
      {href ? (
        <Link to={href} className="list-row-id" title={t('openDocument', { title: name })}>{idInner}</Link>
      ) : (
        <span className="list-row-id">{idInner}</span>
      )}
      <div className="list-row-meta">
        <CanvasChips canvas={canvas} canOpen={Boolean(href)} projectName={projectName} />
        <span>{formatDateTime(canvas.updatedAt)}</span>
      </div>
      <div className="list-row-actions action-bar">
        {href ? <Link to={href} className="btn secondary btn-sm">{t('open')}</Link> : null}
        <Button variant="quiet" aria-label={t('common:delete')} onClick={() => onRemove(canvas)}><TrashIcon aria-hidden /></Button>
      </div>
    </div>
  );
}
