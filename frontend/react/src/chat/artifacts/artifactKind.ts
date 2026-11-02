/**
 * The human TYPE label for an artifact (ADR 0131 Phase 4), in its own small module so
 * the chat's eager run/turn cards can show it (ADR 1017 grade-ux: they showed the raw
 * `kind · format` machine values) without pulling the Library's views into the entry
 * chunk. `ArtifactViews` re-exports it for the Library table and cards.
 */
import type { TFunction } from 'i18next';
import type { ArtifactProjection } from './artifactClient.js';

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
