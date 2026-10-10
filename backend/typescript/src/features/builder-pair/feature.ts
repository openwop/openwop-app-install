/**
 * Builder Pair Canvas (ADR 0773) — the AI edits the workflow ON the builder
 * sheet, and the user keeps what it drew.
 *
 * The server half of a core-builder surface: the builder (core,
 * `frontend/react/src/builder/pair/`) never imports this package — it probes the
 * toggle via `useFeatureAccess('builder-pair')` and talks to these routes. The
 * Workflow Architect (ADR 0072's agent) reads the canvas and suggests edits
 * through two chat-time tools; the workflow itself changes only through the
 * builder's own store + CAS autosave (ADR 0770 D5).
 *
 * No `ctx.builderPair` workflow surface and no runnable node pack, stated not
 * deferred: pairing is an interactive builder surface, and a run has no canvas
 * to pair with (ADR 0773 matrix rows 3–4).
 *
 * RFC gate: host-extension under /v1/host/openwop-app/builder-pair/*; the tools
 * are chat-time feature tools. NO new RFC (ADR 0773 § RFC verdict).
 *
 * @see docs/adr/0773-builder-pair-canvas.md
 */

import type { BackendFeature } from '../types.js';
import { registerBuilderPairRoutes } from './routes.js';
import { registerBuilderPairAgentTools } from './agentTools.js';
import { BUILDER_PAIR_TOGGLE_ID } from './pairService.js';

export const builderPairFeature: BackendFeature = {
  id: BUILDER_PAIR_TOGGLE_ID,
  registerRoutes: (deps) => {
    registerBuilderPairAgentTools(deps.storage);
    registerBuilderPairRoutes(deps);
  },
  toggleDefault: {
    id: BUILDER_PAIR_TOGGLE_ID,
    label: 'Builder pairing (AI on the canvas)',
    description:
      'Pair with the Workflow Architect inside the workflow builder: a Pair tab beside the Inspector that sees your '
      + 'selection and live draft, draws suggested changes on the canvas as ghosts, and lets you keep or drop each one. '
      + 'The AI never saves the workflow itself. Turning it off removes AI from the builder.',
    category: 'Workflows',
    status: 'on',
    bucketUnit: 'tenant',
    salt: BUILDER_PAIR_TOGGLE_ID,
  },
  // ADR 0194 — the Architect agent and its catalog live in workflow-author
  // (always-on, so this dependency never blocks a disable).
  dependsOn: ['workflow-author'],
};
