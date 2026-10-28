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
import { buildCreativeBriefsSurface, CREATIVE_BRIEFS_SURFACE_POLICY } from './surface.js';
import { registerRenderMediaCascade } from './render/renderService.js';
import { registerFeatureDataExporter } from '../../host/featureDataExport.js';
import { exportCreativeBriefsData } from './dataExport.js';
import { registerGrantResourceKind } from '../../host/externalCollaborators.js';
import { getBrief, listBriefs } from './creativeBriefsService.js';
import { briefToSharedMarkdown } from './routes.js';

export const creativeBriefsFeature: BackendFeature = {
  id: 'creative-briefs',
  requiredPacks: ['feature.creative-briefs.nodes'], // NP-HOLE-CB-1; 1.1.0 = ADR 0399 render nodes; 1.2.0 = ADR 0411 P3 generate-reel
  registerRoutes: (deps) => {
    registerFeatureDataExporter('creative-briefs', exportCreativeBriefsData); // ADR 0820 §7 — read-only export, served after a plan lapse
    registerCreativeBriefsReelWorkflow(); // ADR 0472 P4 — reel migrated to a chain-backed workflow
    registerCreativeBriefsRoutes(deps);
    registerCreativeBriefsAgentTools(); // XCH-HOLE-7 (round 3) — openwop:creative-briefs.list (ADR 0308 seam)
    registerRenderMediaCascade(); // DATB-1 — prune render rows when their composed PNG is deleted
    // ADR 0958 P2 — an external designer can be granted an APPROVED brief: the same
    // approved-only projection the `creative_brief` share link serves (ADR 0353 P4).
    registerGrantResourceKind('creative-brief', {
      featureId: 'creative-briefs',
      actions: ['view'],
      async exists(tenantId, orgId, id) { return (await getBrief(tenantId, orgId, id)) !== null; },
      async project(tenantId, orgId, id) {
        const b = await getBrief(tenantId, orgId, id);
        if (!b || b.status !== 'approved') return null; // demoted ⇒ dark, like the link
        return { title: b.title, body: { kind: 'creative_brief', markdown: await briefToSharedMarkdown(b) } };
      },
      // Only an approved brief can be shown, so only an approved one is offered.
      async list(tenantId, orgId) {
        return (await listBriefs(tenantId, orgId)).filter((b) => b.status === 'approved').map((b) => ({ id: b.briefId, title: b.title }));
      },
    });
  },
  surface: { id: 'creative-briefs', build: buildCreativeBriefsSurface, orgPolicy: CREATIVE_BRIEFS_SURFACE_POLICY },
  // ADR 0945 — SOFT: product-grounded creative reads the product catalog. With
  // commerce OFF those methods refuse (ADR 0820 G11) and every other brief
  // feature works, so this is a recommendation, not a disable-lock.
  recommends: ['commerce'],
  toggleDefault: {
    id: 'creative-briefs',
    label: 'Creative Briefs',
    description:
      'Structured visual briefs for designers — scene, composition, camera and lighting notes, brand palette, platform specs, and 2–3 creative directions per asset, with version history, review→approve workflow, a mood board auto-assembled from your media library, and approved-only share links so an external designer can execute without an account.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'creative-briefs',
  },
  // ADR 0945 / ADR 0941 D5 — a sub-toggle: no dependsOn; its consumers check
  // `creative-briefs` (the surface seam) AND this id in code.
  extraToggleDefaults: [{
    id: 'creative-briefs.product-grounded',
    label: 'Product-grounded creative',
    description:
      'Ad and social creative built only from your catalog product\'s own photos: the product is cut out and placed on a generated scene, and every result is checked against the original for shape and colour before it can be used. A sub-capability of Creative Briefs, which must be on as well; it also reads your product catalog.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'creative-briefs-product-grounded',
  }],
};
