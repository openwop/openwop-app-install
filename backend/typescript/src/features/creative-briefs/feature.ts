/**
 * Creative Briefs feature (ADR 0353) — the managed visual-brief entity closing
 * the messaging→production handoff (CS-005): scene/composition/camera/lighting/
 * palette/platform-spec + 2–3 creative-direction variants, lifecycle
 * draft→review→approved, versions w/ field diffs, a mood board assembled from
 * the media library's deterministic weighted selection (ADR 0352), comments,
 * approved-only share links for external designers, and PDF export via the
 * ADR 0057 renderer. Ports (and retires) the deterministic build modes of the
 * unwired `vendor.myndhyve.ads-studio-core` pilot pack.
 *
 * @see docs/adr/0353-creative-briefs-feature.md
 */
import type { BackendFeature } from '../types.js';
import { registerCreativeBriefsRoutes } from './routes.js';
import { registerCreativeBriefsReelWorkflow } from './reelWorkflow.js';
import { registerCreativeBriefsAgentTools } from './agentTools.js';
import { buildCreativeBriefsSurface } from './surface.js';
import { registerRenderMediaCascade } from './render/renderService.js';

export const creativeBriefsFeature: BackendFeature = {
  id: 'creative-briefs',
  requiredPacks: [{ name: 'feature.creative-briefs.nodes', version: '1.2.0' }], // NP-HOLE-CB-1; 1.1.0 = ADR 0399 render nodes; 1.2.0 = ADR 0411 P3 generate-reel
  registerRoutes: (deps) => {
    registerCreativeBriefsReelWorkflow(); // ADR 0472 P4 — reel migrated to a chain-backed workflow
    registerCreativeBriefsRoutes(deps);
    registerCreativeBriefsAgentTools(); // XCH-HOLE-7 (round 3) — openwop:creative-briefs.list (ADR 0308 seam)
    registerRenderMediaCascade(); // DATB-1 — prune render rows when their composed PNG is deleted
  },
  surface: { id: 'creative-briefs', build: buildCreativeBriefsSurface },
  toggleDefault: {
    id: 'creative-briefs',
    label: 'Creative Briefs',
    description:
      'Structured visual briefs for designers — scene, composition, camera and lighting notes, brand palette, platform specs, and 2–3 creative directions per asset, with version history, review→approve workflow, a mood board auto-assembled from your media library, and approved-only share links so an external designer can execute without an account. OFF by default.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'creative-briefs',
  },
};
