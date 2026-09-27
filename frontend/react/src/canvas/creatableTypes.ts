/**
 * The first-party creatable canvas types (ADR 0314 — the Documents creation
 * gallery). PURE DATA, deliberately duplicated from the feature definitions:
 * the gallery may not import five sibling feature definitions (cross-feature
 * coupling + each definition pulls its Renderer into the importing chunk), and
 * `canvas/` may never import `features/*` (the ADR 0310 layering rule). A
 * drift test (`__tests__/creatableTypes.test.ts`) pins every row against the
 * real definition, so the duplication cannot rot silently.
 *
 * `nameKey`/`hintKey` resolve in the `canvas` i18n namespace (the framework's
 * type-gallery vocabulary — display names for type PICKING; each type's own
 * ns keeps its editor vocabulary per the canvas/types.ts key contract).
 */

import { BoxesIcon, FileTextIcon, LayoutGridIcon, MegaphoneIcon, MonitorIcon, PackageIcon, PencilIcon } from '../ui/icons/index.js';

export interface CreatableCanvasType {
  canvasTypeId: string;
  /** The type's ONE feature toggle (ADR 0319 — generation + editor + creation are a
   *  single feature); the gallery renders a card only when enabled. */
  toggleId: string;
  /** The type's host-ext route root (createCanvasClient basePath). */
  basePath: string;
  /** SPA route prefix — a created canvas opens at `<editorPath>/<canvasId>`. */
  editorPath: string;
  /** `canvas`-ns keys for the gallery card's noun + one-line hint. */
  nameKey: string;
  hintKey: string;
}

export const CREATABLE_CANVAS_TYPES: readonly CreatableCanvasType[] = [
  { canvasTypeId: 'canvas.slides', toggleId: 'slides', basePath: '/host/openwop-app/slides', editorPath: '/slides', nameKey: 'type_slides', hintKey: 'typeHint_slides' },
  { canvasTypeId: 'canvas.drawing', toggleId: 'drawings', basePath: '/host/openwop-app/drawings', editorPath: '/drawings', nameKey: 'type_drawing', hintKey: 'typeHint_drawing' },
  { canvasTypeId: 'canvas.cad', toggleId: 'cad', basePath: '/host/openwop-app/cad', editorPath: '/cad', nameKey: 'type_cad', hintKey: 'typeHint_cad' },
  { canvasTypeId: 'canvas.campaign', toggleId: 'campaign-studio', basePath: '/host/openwop-app/campaign-studio', editorPath: '/campaign-studio', nameKey: 'type_campaign', hintKey: 'typeHint_campaign' },
  { canvasTypeId: 'canvas.app-builder', toggleId: 'app-builder', basePath: '/host/openwop-app/app-builder', editorPath: '/app-builder', nameKey: 'type_app', hintKey: 'typeHint_app' },
  { canvasTypeId: 'canvas.document', toggleId: 'document-editor', basePath: '/host/openwop-app/document-editor', editorPath: '/document-editor', nameKey: 'type_document', hintKey: 'typeHint_document' },
];

/** The `canvas`-ns display-name key for a canvas type id — used by pickers to
 *  label rows of ANY type. Unknown (pack) types return null; callers fall back
 *  to the pack title or the raw id. */
export function canvasTypeNameKey(canvasTypeId: string): string | null {
  return CREATABLE_CANVAS_TYPES.find((t) => t.canvasTypeId === canvasTypeId)?.nameKey ?? null;
}

/** The gallery/browser icon for a canvas type — pack/unknown types get the
 *  generic package glyph. One map so every surface renders types alike. */
const TYPE_ICONS: Record<string, typeof PackageIcon> = {
  'canvas.slides': LayoutGridIcon,
  'canvas.drawing': PencilIcon,
  'canvas.cad': BoxesIcon,
  'canvas.campaign': MegaphoneIcon,
  'canvas.app-builder': MonitorIcon,
  'canvas.document': FileTextIcon,
};
export function canvasTypeIcon(canvasTypeId: string): typeof PackageIcon {
  return TYPE_ICONS[canvasTypeId] ?? PackageIcon;
}
