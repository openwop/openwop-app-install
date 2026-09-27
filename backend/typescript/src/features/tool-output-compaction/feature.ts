/**
 * ADR 0099 — Tool-output compaction. Cut BYOK token spend on verbose tool
 * outputs by compacting them at the typed tool-result boundary before they
 * re-enter the model context.
 *
 * This feature is NOT purely feature-local (ADR 0099 §G1/G2): it registers into
 * two new generic core IoC seams — `toolResultTransform` (the kernel) and
 * `runStartContext` (the per-run decision) — at boot. It owns no REST routes
 * (G3: `registerRoutes` is the boot hook used only to wire those seams). Core
 * never imports this feature; the feature registers into core. Toggle OFF by
 * default, tenant-bucketed (workspace-wide infra behavior, ADR 0015).
 */

import type { BackendFeature } from '../types.js';
import { registerToolResultTransform } from '../../host/toolResultTransform.js';
import { registerRunStartContributor } from '../../host/runStartContext.js';
import { compactToolOutput } from './compact.js';
import { resolveCompactionDecision, TOGGLE_ID } from './decision.js';
import { buildToolOutputCompactionSurface } from './surface.js';

let wired = false;

/** Idempotent boot wiring — safe across repeated `registerBackendFeatures` (tests). */
function wireSeams(): void {
  if (wired) return;
  wired = true;
  // applyToolResultTransform already guards (decision present + mode != 'off')
  // and fail-opens on throw; the explicit guard here keeps the kernel call total
  // without a non-null assertion.
  registerToolResultTransform((content, ctx) =>
    ctx.decision ? compactToolOutput(content, ctx.decision) : content,
  );
  registerRunStartContributor(resolveCompactionDecision);
}

export const toolOutputCompactionFeature: BackendFeature = {
  id: TOGGLE_ID,
  registerRoutes: () => wireSeams(),
  // Phase 3 (ADR 0014) — `ctx.features['tool-output-compaction'].compact`, the
  // explicit mid-graph compaction surface the node pack delegates to.
  surface: { id: TOGGLE_ID, build: buildToolOutputCompactionSurface },
  requiredPacks: [{ name: 'feature.tool-output-compaction.nodes', version: '1.2.0' }],
  toggleDefault: {
    id: TOGGLE_ID,
    label: 'Tool-output compaction',
    // ADR 0604 — the description an operator reads before flipping this on. It
    // used to promise "structure-preserving (drops empty fields, minifies)",
    // which advertised the DEFECT as the feature: dropping an empty field is
    // not structure-preserving, and it was the only thing producing savings.
    // The honest version says what the default mode does and where the savings
    // actually are, because an operator who enables this on the old copy would
    // be buying token savings with silently-altered tool output.
    description:
      'Compact verbose JSON tool outputs before they reach the model. The default mode only DELETES '
      + 'INSIGNIFICANT WHITESPACE and changes no other byte — on already-minified tool output that saves '
      + 'little. Real savings need the '
      + 'per-agent lossy opt-in, which elides long arrays and drops empty fields, each disclosed in the payload. '
      + 'Deterministic and replay-safe: the mode is frozen when a run is created and never re-resolved on :fork.',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'tool-output-compaction',
  },
};
