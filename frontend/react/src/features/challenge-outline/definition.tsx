/**
 * The `challenge-outline` CanvasTypeDefinition (ADR 0458 §2.3) — the structured
 * editing surface a creator opens between chat turns to refine a candidate's
 * challenge plan. Frames+tree traits: the single 'outline' frame holds the
 * ordered `day` nodes (drag-reorder via the chassis OutlineTree), each `day`
 * carrying its `alternative` substitutions as children. Doc-level meta/outcomes/
 * achievements edit through dedicated widgets when nothing is selected.
 *
 * Working-draft semantics (architect CRITICAL-1): this canvas is NOT a second
 * plan store. The candidate's validated plan revision stays the only truth; the
 * candidate workspace's "Apply outline" runs the plan validator and persists a
 * new revision through the candidate owner (draft → validate → persist).
 *
 * No creation-gallery row: an outline canvas is created per-candidate by the
 * backend ensure route, never from the generic "new canvas" gallery — so this
 * type is deliberately absent from `creatableTypes`.
 */
import type { FramesTreeDefinition } from '../../canvas/CanvasEditorPage.js';
import type { CanvasPropDef } from '../../canvas/types.js';
import { OutlineRenderer } from './OutlineRenderer.js';
import { OutlineMetaWidget, OutlineOutcomesWidget, OutlineAchievementsWidget } from './widgets.js';
import { coerceOutlineDoc, outlineFrameOps, outlineTreeOps, type OutlineDoc, type OutlineFrame, type OutlineNode } from './types.js';

const docPropDefs: CanvasPropDef[] = [
  { name: 'meta', type: 'outline-meta', label: 'Challenge details' },
  { name: 'outcomes', type: 'outline-outcomes', label: 'Outcomes' },
  { name: 'achievements', type: 'outline-achievements', label: 'Achievements' },
];

export const challengeOutlineDefinition: FramesTreeDefinition<OutlineDoc, OutlineFrame, OutlineNode> = {
  canvasTypeId: 'canvas.challenge-outline',
  touchSupport: 'light-edit', // outline reorder rides list semantics
  // Rides the existing kicktodo-creator toggle (ADR 0458 §2.3, a stated
  // deviation from the ADR 0319 per-type toggle: the outline is meaningless
  // without the factory, and KickTodo already carries nine toggles).
  toggleId: 'kicktodo-creator',
  clientBasePath: '/host/openwop-app/challenge-outline',
  editorPath: '/challenge-outline',
  i18nNamespace: 'challenge-outline',
  Renderer: OutlineRenderer,
  coerceDoc: coerceOutlineDoc,
  // The toolbar name field edits the working-draft label (see OutlineDoc.name).
  docNameKey: 'name',
  // ADR 0359 — collab via the chassis element binding; MUST mirror the backend
  // registerCanvasEditorRoutes `collab: true` registration (drift-pinned in
  // canvas/__tests__/collabTypes.test.ts).
  collab: 'elements',
  frames: {
    ops: outlineFrameOps,
    key: 'frames',
    // One ordered day list ⇒ a single frame, no home flag.
    max: 1,
  },
  tree: {
    ops: outlineTreeOps,
    rootKey: 'days',
    childrenKey: 'children',
    // The bar's quick cluster over the SERVED catalog props (booleans/enums/
    // numbers only — quickDefs filters the rest). Evidence parity between an
    // alternative and its parent day is validated server-side; surfacing the
    // policy here is a hint, not silent enforcement.
    quickPropsByType: {
      day: ['evidencePolicy', 'isRecovery', 'estimatedMinutes'],
      alternative: ['evidencePolicy'],
    },
  },
  docPropDefs,
  propertyWidgets: {
    'outline-meta': OutlineMetaWidget,
    'outline-outcomes': OutlineOutcomesWidget,
    'outline-achievements': OutlineAchievementsWidget,
  },
};
