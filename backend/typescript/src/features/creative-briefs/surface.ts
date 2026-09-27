/**
 * `ctx.features['creative-briefs']` (ADR 0353 P2) — the workflow surface the
 * campaign channel generator composes: when the toggle is ON, generated
 * creative-brief drafts become MANAGED entities (lifecycle/versions/sharing)
 * instead of transient run artifacts. Same toggle + tenant scoping as the
 * routes (the surface gate lives in the feature registration).
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { OpenwopError } from '../../types.js';
import { createBrief, listBriefs, getBrief } from './creativeBriefsService.js';
import { renderForBrief, renderVariantsForBrief, reelPromptForBrief, storeReelRender } from './render/renderService.js';
import { listTemplates } from './render/templates.js';

export function buildCreativeBriefsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    create: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      const brief = await createBrief(tenantId, orgId, str(args.actor) || 'workflow', {
        title: args.title, assetType: args.assetType, sceneDescription: args.sceneDescription,
        composition: args.composition, cameraAngle: args.cameraAngle, lighting: args.lighting,
        brandPalette: args.brandPalette, messagingIntent: args.messagingIntent,
        platformSpec: args.platformSpec, directions: args.directions, moodBoard: args.moodBoard,
        campaignBriefId: args.campaignBriefId,
      });
      return { brief };
    },
    list: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      return { briefs: await listBriefs(tenantId, orgId) };
    },
    get: async (args) => {
      const orgId = str(args.orgId);
      const b = await getBrief(tenantId, orgId, str(args.briefId));
      return { found: !!b, ...(b ? { brief: b } : {}) };
    },
    // ADR 0399 — the layout-template catalog (static geometry; the node's
    // template-id vocabulary comes from HERE, never a prompt hand-copy).
    listRenderTemplates: async () => ({ templates: listTemplates() }),
    // ADR 0399 §2/§3 — deterministic render(s) stored as media assets. Bytes
    // never cross the node result boundary (the ADR 0115 seam precedent): the
    // node gets ids + warnings, the library owns the pixels.
    render: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      const record = await renderForBrief(tenantId, orgId, scope.actingUserId ?? scope.runId ?? 'workflow', {
        briefId: str(args.briefId),
        templateId: str(args.templateId),
        ...(typeof args.directionIndex === 'number' ? { directionIndex: args.directionIndex } : {}),
        ...(args.copy && typeof args.copy === 'object' ? { copy: args.copy as Record<string, unknown> } : {}),
        ...(args.layers && typeof args.layers === 'object' ? { layers: args.layers as Record<string, unknown> } : {}),
        ...(args.overrides !== undefined ? { overrides: args.overrides } : {}),
        ...(args.brandId !== undefined ? { brandId: args.brandId } : {}),
      });
      return { render: record, mediaAssetId: record.mediaAssetId, warnings: record.warnings };
    },
    // ADR 0411 P3 — the reel (video) legs, split so the generate-reel node can
    // gate video generation between them (derive → generate → store).
    reelPrompt: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      const brief = await getBrief(tenantId, orgId, str(args.briefId));
      if (!brief) throw new OpenwopError('not_found', 'Creative brief not found.', 404, { briefId: str(args.briefId) });
      return { prompt: reelPromptForBrief(brief, typeof args.directionIndex === 'number' ? args.directionIndex : undefined) };
    },
    storeReel: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      const record = await storeReelRender({
        tenantId, orgId,
        briefId: str(args.briefId),
        actor: scope.actingUserId ?? scope.runId ?? 'workflow',
        videoAssetId: str(args.videoAssetId),
        prompt: str(args.prompt),
        ...(str(args.renderId) ? { renderId: str(args.renderId) } : {}),
        ...(str(args.aspectRatio) ? { aspectRatio: str(args.aspectRatio) } : {}),
        ...(typeof args.durationSeconds === 'number' ? { durationSeconds: args.durationSeconds } : {}),
        ...(typeof args.directionIndex === 'number' ? { directionIndex: args.directionIndex } : {}),
        ...(str(args.provider) ? { provider: str(args.provider) } : {}),
      });
      return { render: record };
    },
    renderVariants: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      const result = await renderVariantsForBrief(tenantId, orgId, scope.actingUserId ?? scope.runId ?? 'workflow', {
        briefId: str(args.briefId),
        templateIds: args.templateIds,
        ...(typeof args.directionIndex === 'number' ? { directionIndex: args.directionIndex } : {}),
        ...(args.copy && typeof args.copy === 'object' ? { copy: args.copy as Record<string, unknown> } : {}),
        ...(args.layers && typeof args.layers === 'object' ? { layers: args.layers as Record<string, unknown> } : {}),
        ...(args.overrides !== undefined ? { overrides: args.overrides } : {}),
        ...(args.brandId !== undefined ? { brandId: args.brandId } : {}),
      });
      return result;
    },
  };
}
