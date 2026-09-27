/**
 * Artifact Card + shared source helpers for the Library (ADR 0131 Phase 4).
 * `/library` is a `<DataTable>` operate-surface, so per the canon's scoping rule
 * the table stays the default "list" view and this Card is the opt-in Grid
 * presentation ALONGSIDE it — never a replacement. The Card and the table's
 * columns share `sourceIcon`/`sourceLabel` so the two views never diverge.
 * Composed from existing primitives — no bespoke CSS.
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FileTextIcon, ImageIcon, BoxesIcon } from '../../ui/icons/index.js';
import { formatDate } from '../../i18n/format.js';
import type { ArtifactProjection } from './artifactClient.js';

/** The source/kind glyph — shared by the table column AND the card. */
export function sourceIcon(a: ArtifactProjection): JSX.Element {
  if (a.kind === 'image') return <ImageIcon size={14} aria-hidden />;
  if (a.source === 'run-event') return <BoxesIcon size={14} aria-hidden />;
  return <FileTextIcon size={14} aria-hidden />;
}

/** The human source label — shared by the table column AND the card. */
export function sourceLabel(s: ArtifactProjection['source'], t: TFunction): string {
  return s === 'run-event' ? t('librarySourceRun') : s === 'media' ? t('librarySourceMedia') : t('librarySourceDocument');
}

/** Coarse asset category for the TYPE badge — derived from the registered
 *  artifactTypeId first (a slide deck / CAD / design), else the media/doc kind. */
function assetCategory(a: ArtifactProjection): string {
  const id = a.artifactTypeId ?? '';
  if (id.startsWith('canvas.slides')) return 'slides';
  if (id.startsWith('canvas.cad')) return 'cad';
  if (id.startsWith('canvas.campaign')) return 'campaign';
  if (id.startsWith('canvas.app-builder')) return 'appDesign';
  if (id.startsWith('canvas.drawing')) return 'drawing';
  if (id.startsWith('brand.')) return 'brandKit';
  if (id.startsWith('production.')) return 'productionPlan';
  if (id.startsWith('code.')) return 'code';
  if (id.startsWith('interactive.chart')) return 'chart';
  if (id.startsWith('interactive.mermaid')) return 'diagram';
  if (id.startsWith('interactive.')) return 'interactive';
  if (id.startsWith('doc.')) return 'document';
  const k = a.kind;
  if (k === 'image') return 'image';
  if (k === 'video') return 'video';
  if (k === 'audio') return 'audio';
  if (k === 'pdf') return 'pdf';
  if (k === 'file') return 'file';
  if (k === 'markdown' || k === 'text') return 'document';
  return 'document';
}

/** Prettify a raw id/kind for the long tail (strip the `canvas.`/`doc.` prefix,
 *  turn separators into spaces, capitalize) — the i18n `defaultValue` fallback. */
function prettifyKind(raw: string): string {
  const base = raw.includes('.') ? raw.slice(raw.indexOf('.') + 1) : raw;
  const spaced = base.replace(/[-_.]/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : raw;
}

/** The human TYPE label for a library asset — shared by the table column AND the
 *  card, so a typed slide deck reads "Slides" instead of the raw `data`/id. */
export function artifactKindLabel(a: ArtifactProjection, t: TFunction): string {
  // `||` (not `??`) so an empty-string artifactTypeId falls through to `kind`.
  return t(`libraryType_${assetCategory(a)}`, { defaultValue: prettifyKind(a.artifactTypeId || a.kind || 'document') });
}

export function ArtifactCard({ artifact: a, onOpen }: { artifact: ArtifactProjection; onOpen: () => void }): JSX.Element {
  const { t } = useTranslation('chat');
  return (
    <button type="button" className="surface-card u-text-left u-flex u-flex-col u-gap-2" onClick={onOpen} title={a.title}>
      <span className="u-flex u-items-center u-gap-2 u-minw-0">
        {sourceIcon(a)} <strong className="u-fs-14">{a.title}</strong>
      </span>
      <span className="muted u-fs-12">{sourceLabel(a.source, t)}</span>
      <div className="u-flex u-gap-2 u-wrap u-items-center">
        <span className="chip chip--muted">{artifactKindLabel(a, t)}</span>
        {a.format ? <span className="chip chip--muted">{a.format}</span> : null}
      </div>
      <span className="muted u-fs-12">{formatDate(a.createdAt)}</span>
    </button>
  );
}
