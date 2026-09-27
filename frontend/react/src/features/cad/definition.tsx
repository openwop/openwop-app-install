/**
 * The cad CanvasTypeDefinition (ADR 0310 Phase C) — an ELEMENTS-trait consumer:
 * a `canvas.cad` document is one flat `solids` collection with a closed kind
 * set. Properties-driven editing day-1 (the research doc's ruling); the WebGL
 * viewer stays the recorded Tier-2-shaped follow-up. The working copy is a pure
 * mirror of the artifact schema — positional, no identity fields.
 *
 * `Renderer` vs `InteractivePreview` — CORRECTION (ADR 0388 §Correction). This
 * header used to claim "`CadContentView` is mounted by the editor preview". It
 * is NOT: `CanvasEditorPage` branches `InteractivePreview && elementsDef && doc`
 * BEFORE its `def.Renderer` fallback, and cad supplies both, so the editor
 * centre ALWAYS mounts `InteractiveCad` and this `Renderer` is reached only by
 * the chat artifact card (`registerArtifactRenderer('canvas.cad')`) — there is
 * no `preview:` key here either. The 2D/3D toggle therefore had to be added to
 * `InteractiveCad` to reach the editor at all; both surfaces now mount the SAME
 * `Cad3dView`, so this stays one implementation.
 */
import type { CanvasEditorDefinition } from '../../canvas/CanvasEditorPage.js';
import type { CanvasNode, CanvasPropDef } from '../../canvas/types.js';
import type { FrameBase } from '../../canvas/frameOps.js';
import { RequiredEnumWidget } from '../../canvas/widgets.js';
import { CadContentView } from '../../chat/artifacts/CadPreview.js';
import { InteractiveCad } from './InteractiveCad.js';
import { CAD_MATERIAL_IDS } from './cadMaterials.js';
import { CadMaterialWidget } from './CadMaterialWidget.js';
import { CadAssistExtras } from './CadAssistExtras.js';

export interface CadDoc {
  name: string;
  units?: string;
  solids: Record<string, unknown>[];
  /** ADR 0388 P3 — annotated dimensions (values derived, never stored). */
  dimensions?: Record<string, unknown>[];
  /** ADR 0388 P4 — the 2D sketch sub-document (host-solved only). */
  sketch?: Record<string, unknown>;
}

/** Narrow the canvas state into the editable model (safe fallbacks; a model
 *  always has at least one solid — the schema's minItems). */
export function coerceCad(state: Record<string, unknown>): CadDoc {
  const solids = Array.isArray(state.solids)
    ? state.solids.filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object' && !Array.isArray(s))
    : [];
  const dimensions = Array.isArray(state.dimensions)
    ? state.dimensions.filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === 'object' && !Array.isArray(d))
    : undefined;
  const sketch = state.sketch && typeof state.sketch === 'object' && !Array.isArray(state.sketch)
    ? (state.sketch as Record<string, unknown>) : undefined;
  return {
    ...(sketch ? { sketch } : {}),
    ...(dimensions ? { dimensions } : {}),
    name: typeof state.name === 'string' ? state.name : 'Untitled model',
    // Default the (schema-optional) units so the required-enum widget's
    // display always matches the doc (code-review LOW: a unitless doc showed
    // "mm" without holding it).
    units: typeof state.units === 'string' ? state.units : 'mm',
    solids: solids.length ? solids : [{ kind: 'box', x: 0, y: 0, z: 0, width: 40, height: 30, depth: 20 }],
  };
}

const num = (name: string, label: string): CanvasPropDef => ({ name, type: 'number', label });
/** Override the derived `prop_<name>` i18n key for one context (SL-G7). */
const keyed = (def: CanvasPropDef, labelKey: string | undefined): CanvasPropDef => (labelKey ? { ...def, labelKey } : def);
const str = (name: string, label: string): CanvasPropDef => ({ name, type: 'string', label });
const POSE: CanvasPropDef[] = [num('x', 'X'), num('y', 'Y'), num('z', 'Z')];
// ADR 0317 follow-up: in-plane rotation (degrees). A sphere's footprint is a
// circle, so rotation is a no-op there — omit it from the sphere's fields.
const ROT: CanvasPropDef = num('rotation', 'Rotation (°)');
// ADR 0310 Phase-C follow-up: approximate metallic/roughness material (0–1),
// rendered as shading in the 3D viewer. glTF-aligned data; bounded 0..1 to match
// the schema (an out-of-range value would 422 on save).
const unit = (name: string, label: string): CanvasPropDef => ({ name, type: 'number', label, min: 0, max: 1, step: 0.1 });
const META: CanvasPropDef[] = [
  // ADR 0388 P5 — library material (closed-world; resolves over inline paint).
  // CAD-G1/CAD-G3 — `cad-material`, not a plain `enum`: the ids are kebab wire
  // tokens ('plastic-red', 'wood-oak') that a plain enum renders raw, and a
  // material is a VISUAL choice that a text list cannot convey.
  { name: 'materialId', type: 'cad-material', label: 'Material', options: [...CAD_MATERIAL_IDS] },
  { name: 'color', type: 'color' as const, label: 'Color' }, unit('metallic', 'Metallic (0–1)'), unit('roughness', 'Roughness (0–1)'),
  { name: 'emissive', type: 'color' as const, label: 'Emissive' }, str('label', 'Label'),
];

/** Per-kind fields — mirrors exactly what the projection consumes. `kind` is
 *  fixed at add time (delete+add to change). */
function solidPropDefs(el: Record<string, unknown>): CanvasPropDef[] {
  switch (el.kind) {
    case 'box':
      return [...POSE, num('width', 'Width'), num('height', 'Height'), num('depth', 'Depth'), ROT, ...META];
    case 'sphere':
      return [...POSE, num('radius', 'Radius'), ...META];
    case 'cylinder':
    case 'cone':
      return [...POSE, num('radius', 'Radius'), num('length', 'Length'), ROT, ...META];
    // ADR 0388 P1 — an imported mesh: pose + uniform scale + material. The
    // assetRef is import-managed (content address), deliberately not editable.
    case 'mesh':
      return [...POSE, num('scale', 'Scale'), ROT, ...META];
    default:
      return [...POSE, ...META];
  }
}

export const cadDefinition: CanvasEditorDefinition<CadDoc, FrameBase, CanvasNode> = {
  canvasTypeId: 'canvas.cad',
  touchSupport: 'view', // precision solids — honest view-only on touch
  toggleId: 'cad',
  clientBasePath: '/host/openwop-app/cad',
  editorPath: '/cad',
  i18nNamespace: 'cad',
  Renderer: CadContentView,
  // ADR 0310 Phase C follow-up: direct manipulation — drag a solid's footprint
  // to move it (X/Y); dimensions stay in the property panel.
  InteractivePreview: InteractiveCad,
  coerceDoc: coerceCad,
  // ADR 0359 Phase 5 — collab via the chassis element binding (mirrors the
  // backend registerCanvasEditorRoutes `collab: true` registration).
  collab: 'elements',
  docNameKey: 'name',
  elements: [{
    key: 'solids',
    max: 200,
    min: 1,
    adders: [
      { id: 'box', make: () => ({ kind: 'box', x: 0, y: 0, z: 0, width: 40, height: 30, depth: 20 }) },
      { id: 'cylinder', make: () => ({ kind: 'cylinder', x: 0, y: 0, z: 0, radius: 15, length: 40 }) },
      { id: 'sphere', make: () => ({ kind: 'sphere', x: 0, y: 0, z: 0, radius: 20 }) },
      { id: 'cone', make: () => ({ kind: 'cone', x: 0, y: 0, z: 0, radius: 15, length: 35 }) },
    ],
    labelFor: (el, t) => (typeof el.label === 'string' && el.label ? el.label : t(`kind_${typeof el.kind === 'string' ? el.kind : 'solid'}`)),
    propDefs: solidPropDefs,
  }, {
    // ADR 0388 P3 — annotated dimensions (a second element collection; the
    // validator enforces the closed tolerance grammar + index refs at save).
    key: 'dimensions',
    max: 100,
    min: 0,
    adders: [
      { id: 'dim-linear', make: () => ({ kind: 'linear', solid: 0, axis: 'x' }) },
      { id: 'dim-diameter', make: () => ({ kind: 'diameter', solid: 0 }) },
      { id: 'dim-radial', make: () => ({ kind: 'radial', solid: 0 }) },
      { id: 'dim-angular', make: () => ({ kind: 'angular', solid: 0 }) },
    ],
    labelFor: (el, t) => (typeof el.label === 'string' && el.label ? el.label : t(`dim_${typeof el.kind === 'string' ? el.kind : 'linear'}`)),
    propDefs: (el) => [
      num('solid', 'Solid #'),
      // CAD-G2 — `enum-required`: the validator REQUIRES an axis on a
      // linear/ordinate dimension ("linear/ordinate dimensions require axis
      // x|y|z"), so offering the plain enum's empty option let the panel clear a
      // field whose absence the server refuses — a save failure the user only
      // met later, from a panel that had invited the change.
      ...(el.kind === 'linear' || el.kind === 'ordinate' ? [{ name: 'axis', type: 'enum-required', label: 'Axis', options: ['x', 'y', 'z'] } as CanvasPropDef] : []),
      { name: 'tolType', type: 'enum', label: 'Tolerance', options: ['symmetric', 'asymmetric', 'limit'] } as CanvasPropDef,
      // CAD-G4 — the tolerance fields are DEPENDENT, the same way `axis` depends
      // on `kind` above: tolA is required once a tolType is set, and tolB only
      // for asymmetric/limit. Showing all three unconditionally invited two
      // save-time rejections ("tolA/tolB require a tolType" and "tolB must be a
      // non-negative number"), so the panel now shows only the fields the chosen
      // tolerance actually takes.
      // A `limit` tolerance's pair are ABSOLUTE limits, not ± offsets, so they
      // need different labels for the same stored fields — the SL-G7 `labelKey`
      // case (a `prop_tolA` key derived from the name cannot serve both, and
      // would silently win over any code label).
      ...(typeof el.tolType === 'string' && el.tolType
        ? [
          keyed(num('tolA', 'Tol A (+)'), el.tolType === 'limit' ? 'prop_tolUpper' : undefined),
          ...(el.tolType === 'asymmetric' || el.tolType === 'limit'
            ? [keyed(num('tolB', 'Tol B (−)'), el.tolType === 'limit' ? 'prop_tolLower' : undefined)]
            : []),
        ]
        : []),
      str('label', 'Label'),
    ],
    // CAD-G4 — keep the stored tolerance fields in step with the type the panel
    // now shows. Clearing the type drops both; symmetric drops the (unused,
    // validator-rejected) tolB. Without this the hidden values would survive and
    // the save would fail with an error whose field is no longer on screen.
    transformOnPropChange: (el, name, value) => {
      if (name !== 'tolType') return undefined;
      const next = { ...el };
      if (!value) { delete next.tolType; delete next.tolA; delete next.tolB; return next; }
      next.tolType = value;
      if (value === 'symmetric') delete next.tolB;
      return next;
    },
  }],
  docPropDefs: [{ name: 'units', type: 'enum-required', label: 'Units', options: ['mm', 'cm', 'm', 'in'] }],
  propertyWidgets: { 'enum-required': RequiredEnumWidget, 'cad-material': CadMaterialWidget },
  // ADR 0515 — the in-editor entry to the CAD Modeler (the chassis's existing
  // self-gating slot; the panel embeds the ONE shared chat, never a new one).
  ToolbarExtras: CadAssistExtras,
};
