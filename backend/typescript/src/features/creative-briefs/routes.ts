/**
 * Creative Briefs routes (ADR 0353) — org-scoped, toggle+RBAC gated:
 *   read  (list/get/versions/diff/pdf)      → workspace:read
 *   write (create/update/transition/delete/build/moodboard) → workspace:write
 * Approval (`review → approved`) is privileged (`host:members:manage`) — an
 * approved brief is externally shareable (the documents-status precedent).
 * PDF export composes the ADR 0057 markdown→PDF renderer over a deterministic
 * brief→markdown projection (no new render stack).
 */

import type { Request } from 'express';
import { ownerStampFromRequest } from '../../host/runOwner.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { authorizeOrgScope, optionalString } from '../featureRoute.js';
import { renderMarkdownToPdf } from '../documents/render.js';
import { purgeLinksForResource } from '../sharing/sharingService.js';
import { pruneThreadsForResourceAndComposites } from '../comments/commentsService.js';
import { getAsset as getMediaAsset } from '../media/mediaService.js';
import {
  listBriefs, getBrief, createBrief, updateBrief, transitionBrief, deleteBrief,
  listVersions, diffVersions, assembleMoodBoard, validateBriefContent, mergeBriefContent, extractBriefContent,
  type BriefContentInput,
} from './creativeBriefsService.js';
import { renderForBrief, renderVariantsForBrief, listRenders, deleteRender, deleteRendersForBrief, type RenderBriefArgs } from './render/renderService.js';
import { listTemplates } from './render/templates.js';
import type { CreativeBrief } from './types.js';
import { buildRunRecord, dispatchRunInBackground } from '../../host/runDispatch.js';
import { insertRunWithStartContext } from '../../host/runInsert.js';
import { seedRunVariables } from '../../host/variablesRuntime.js';
import { reserveConcurrentSlot } from '../../middleware/rateLimit.js';
import { CREATIVE_BRIEFS_REEL_ID } from './reelWorkflow.js';

const FEATURE = { toggleId: 'creative-briefs', label: 'Creative Briefs' };
const ORG = '/v1/host/openwop-app/creative-briefs/orgs/:orgId';

type Scope = 'workspace:read' | 'workspace:write' | 'host:members:manage';

/** Resolve the mood board's asset ids → display names via the media service.
 *  Deleted / foreign ids simply don't resolve, so they drop from any render
 *  (CB-CODE-6 / CS-DATA-10 — no dead `masset:` ids on an export). */
export async function resolveMoodBoardNames(b: CreativeBrief): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const item of b.moodBoard) {
    const a = await getMediaAsset(b.tenantId, b.orgId, item.mediaAssetId);
    if (a) names.set(item.mediaAssetId, a.name);
  }
  return names;
}

/** Deterministic brief → markdown projection. Mood-board items render by
 *  RESOLVED asset name only — raw `masset:` ids never print, and unresolvable
 *  ids are dropped (CB-CODE-6). `audience: 'internal'` (the authed PDF) keeps
 *  the selection notes + the internal needsAsset note; `'shared'` (the public
 *  page) renders neither. */
export function briefToMarkdown(b: CreativeBrief, opts: { moodBoardNames: ReadonlyMap<string, string>; audience: 'internal' | 'shared' }): string {
  const lines: string[] = [
    `# ${b.title}`,
    '',
    `**Asset type:** ${b.assetType} · **Status:** ${b.status} · **Version:** ${b.version}`,
    '',
    '## Scene',
    b.sceneDescription,
  ];
  if (b.composition) lines.push('', '## Composition', b.composition);
  if (b.cameraAngle || b.lighting) lines.push('', '## Camera & lighting', [b.cameraAngle, b.lighting].filter(Boolean).join(' · '));
  if (b.brandPalette?.length) lines.push('', '## Brand palette', b.brandPalette.join(', '));
  if (b.messagingIntent) lines.push('', '## Messaging intent', b.messagingIntent);
  if (b.platformSpec) lines.push('', '## Platform spec', [b.platformSpec.platform, b.platformSpec.format, b.platformSpec.textRulePct !== undefined ? `text ≤ ${b.platformSpec.textRulePct}%` : ''].filter(Boolean).join(' · '));
  if (b.directions.length > 0) {
    lines.push('', '## Creative directions');
    for (const d of b.directions) lines.push(`- **${d.label}**${d.rationale ? ` — ${d.rationale}` : ''}`);
  }
  const board = b.moodBoard
    .map((m) => ({ name: opts.moodBoardNames.get(m.mediaAssetId), note: m.note }))
    .filter((m): m is { name: string; note: string | undefined } => Boolean(m.name));
  if (board.length > 0) {
    lines.push('', '## Mood board');
    for (const m of board) lines.push(`- ${m.name}${opts.audience === 'internal' && m.note ? ` — ${m.note}` : ''}`);
  }
  if (opts.audience === 'internal' && b.needsAssetNote) lines.push('', '> ' + b.needsAssetNote);
  return lines.join('\n');
}

/** The SHARED/public projection (CB-CODE-6) — resolvable asset names only, no
 *  internal notes. The sharing resolver's one entry point. */
export async function briefToSharedMarkdown(b: CreativeBrief): Promise<string> {
  return briefToMarkdown(b, { moodBoardNames: await resolveMoodBoardNames(b), audience: 'shared' });
}

export function registerCreativeBriefsRoutes(deps: RouteDeps): void {
  const { app, storage, hostSuite } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);
  const notFound = (briefId: string): OpenwopError => new OpenwopError('not_found', 'Creative brief not found.', 404, { briefId });

  app.get(`${ORG}/briefs`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      res.json({ briefs: await listBriefs(tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/briefs`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as BriefContentInput & { mode?: unknown; base?: unknown; kernel?: unknown; platform?: unknown };
      // ADR 0353 P2 — the three ported build modes. `manual` (default) uses the
      // body fields; `extraction` projects a campaign kernel; `merge` overlays
      // sparse fields onto a base.
      let content: BriefContentInput = body;
      if (body.mode === 'extraction') {
        content = extractBriefContent({
          ...(optionalString(body.title) ? { title: optionalString(body.title) } : {}),
          ...(optionalString(body.assetType) ? { assetType: optionalString(body.assetType) } : {}),
          ...(body.kernel && typeof body.kernel === 'object' ? { kernel: body.kernel as Record<string, string> } : {}),
          ...(optionalString(body.platform) ? { platform: optionalString(body.platform) } : {}),
        });
      } else if (body.mode === 'merge') {
        if (!body.base || typeof body.base !== 'object') throw new OpenwopError('validation_error', '`base` is required for merge mode.', 400, { field: 'base' });
        content = mergeBriefContent(body.base as BriefContentInput, body);
      }
      const brief = await createBrief(tenantId, orgId, user.userId, content);
      res.status(201).json(brief);
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/briefs/:briefId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const b = await getBrief(tenantId, orgId, req.params.briefId);
      if (!b) throw notFound(req.params.briefId);
      res.json({ ...b, issues: validateBriefContent(b) });
    } catch (err) { next(err); }
  });

  app.patch(`${ORG}/briefs/:briefId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const before = await getBrief(tenantId, orgId, req.params.briefId);
      const b = await updateBrief(tenantId, orgId, req.params.briefId, user.userId, (req.body ?? {}) as BriefContentInput);
      // A content edit demoted an approved brief → purge its share links
      // (fail-closed: an externally shared brief never silently drifts).
      if (before?.status === 'approved' && b.status !== 'approved') {
        await purgeLinksForResource(tenantId, 'creative_brief', b.briefId);
      }
      res.json(b);
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/briefs/:briefId/transition`, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { status?: unknown };
      // Approval is privileged; other transitions stay at write.
      const scope: Scope = body.status === 'approved' ? 'host:members:manage' : 'workspace:write';
      const { user, orgId, tenantId } = await authz(req, scope);
      const before = await getBrief(tenantId, orgId, req.params.briefId);
      const b = await transitionBrief(tenantId, orgId, req.params.briefId, user.userId, body.status);
      if (before?.status === 'approved' && b.status !== 'approved') {
        await purgeLinksForResource(tenantId, 'creative_brief', b.briefId);
      }
      res.json(b);
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/briefs/:briefId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const ok = await deleteBrief(tenantId, orgId, req.params.briefId);
      if (!ok) throw notFound(req.params.briefId);
      await purgeLinksForResource(tenantId, 'creative_brief', req.params.briefId);
      // ADR 0399 — render records are children of the brief (the composed
      // media assets survive as library assets; media owns their lifecycle).
      await deleteRendersForBrief(tenantId, orgId, req.params.briefId);
      // CB-CODE-2 / CS-DATA-14 — a deleted brief's comment threads have no
      // reachable surface left; prune them (the canvas-delete precedent).
      await pruneThreadsForResourceAndComposites(tenantId, 'creative_brief', req.params.briefId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/briefs/:briefId/versions`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      res.json({ versions: await listVersions(tenantId, orgId, req.params.briefId) });
    } catch (err) { next(err); }
  });

  // Field-level diff between two versions (?from=2&to=5).
  app.get(`${ORG}/briefs/:briefId/diff`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const all = await listVersions(tenantId, orgId, req.params.briefId);
      const from = all.find((v) => v.version === Number(req.query.from));
      const to = all.find((v) => v.version === Number(req.query.to));
      if (!from || !to) throw new OpenwopError('not_found', 'Version not found.', 404, { from: req.query.from, to: req.query.to });
      res.json({ changes: diffVersions(from, to) });
    } catch (err) { next(err); }
  });

  // ADR 0353 P3 — assemble the mood board via media's weighted selection.
  app.post(`${ORG}/briefs/:briefId/moodboard`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as { product?: unknown; industry?: unknown; useCase?: unknown; personaIds?: unknown; limit?: unknown };
      const before = await getBrief(tenantId, orgId, req.params.briefId);
      const b = await assembleMoodBoard(tenantId, orgId, req.params.briefId, user.userId, {
        ...(optionalString(body.product) ? { product: optionalString(body.product) } : {}),
        ...(optionalString(body.industry) ? { industry: optionalString(body.industry) } : {}),
        ...(optionalString(body.useCase) ? { useCase: optionalString(body.useCase) } : {}),
        ...(Array.isArray(body.personaIds) ? { personaIds: body.personaIds.filter((x): x is string => typeof x === 'string') } : {}),
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
      });
      // CB-CODE-1 — assembly demoted an approved brief → purge its share links,
      // exactly like the PATCH content-edit flow above.
      if (before?.status === 'approved' && b.status !== 'approved') {
        await purgeLinksForResource(tenantId, 'creative_brief', b.briefId);
      }
      res.json(b);
    } catch (err) { next(err); }
  });

  // ADR 0353 P4 — PDF export (bytes, direct — the doc-editor export precedent).
  app.post(`${ORG}/briefs/:briefId/pdf`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const b = await getBrief(tenantId, orgId, req.params.briefId);
      if (!b) throw notFound(req.params.briefId);
      const pdf = await renderMarkdownToPdf(briefToMarkdown(b, { moodBoardNames: await resolveMoodBoardNames(b), audience: 'internal' }), { title: b.title });
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-disposition', `attachment; filename="${b.title.replace(/[^\w.-]+/g, '_').slice(0, 80)}.pdf"`);
      res.send(pdf);
    } catch (err) { next(err); }
  });

  // ── ADR 0399 — ad-layout renders ──────────────────────────────────────────

  // The static template catalog (geometry + safe zones) — the FE gallery +
  // safe-zone overlay draw from this, never from a server SVG.
  app.get(`${ORG}/render-templates`, async (req, res, next) => {
    try {
      await authz(req, 'workspace:read');
      res.json({ templates: listTemplates() });
    } catch (err) { next(err); }
  });

  // Render one template, or fan a template family (`templateIds`) — one brief,
  // N platform-correct creatives (ADR 0399 §3).
  app.post(`${ORG}/briefs/:briefId/renders`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Partial<RenderBriefArgs> & { templateIds?: unknown };
      const common = {
        briefId: req.params.briefId,
        ...(body.directionIndex !== undefined ? { directionIndex: Number(body.directionIndex) } : {}),
        ...(body.copy && typeof body.copy === 'object' ? { copy: body.copy } : {}),
        ...(body.layers && typeof body.layers === 'object' ? { layers: body.layers } : {}),
        ...(body.overrides !== undefined ? { overrides: body.overrides } : {}),
        ...(body.brandId !== undefined ? { brandId: body.brandId } : {}),
        ...(body.animate !== undefined ? { animate: body.animate } : {}),
      };
      if (Array.isArray(body.templateIds)) {
        const result = await renderVariantsForBrief(tenantId, orgId, user.userId, { ...common, templateIds: body.templateIds });
        res.status(201).json(result);
        return;
      }
      const templateId = optionalString(body.templateId);
      if (!templateId) throw new OpenwopError('validation_error', 'Provide `templateId` (one render) or `templateIds` (variant fan-out).', 400, { field: 'templateId' });
      const render = await renderForBrief(tenantId, orgId, user.userId, { ...common, templateId });
      res.status(201).json(render);
    } catch (err) { next(err); }
  });

  // ADR 0411 P3b — "Generate reel" (text-to-video). Video is slow (30–120 s), so
  // this is the ASYNC lane: it launches the pinned single-node reel workflow (the
  // P3a generate-reel node, boundary-clean over ctx) as a RUN and returns 202 +
  // the run's status/events URLs; the FE polls, then the reel render appears in
  // the brief's renders list. A sync route would force a creative-briefs→
  // aiProviders adapter import — the coupling the node avoids (ADR 0411 P3b).
  app.post(`${ORG}/briefs/:briefId/reel`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const briefId = req.params.briefId;
      const brief = await getBrief(tenantId, orgId, briefId);
      if (!brief) throw new OpenwopError('not_found', 'Creative brief not found.', 404, { briefId });
      const body = (req.body ?? {}) as { directionIndex?: unknown; aspectRatio?: unknown; durationSeconds?: unknown; provider?: unknown; credentialRef?: unknown };
      const wf = await hostSuite.workflowCatalog.getWorkflow(CREATIVE_BRIEFS_REEL_ID);
      if (!wf) throw new OpenwopError('internal_error', 'creative-briefs reel workflow is not registered.', 500, {});
      const inputs: Record<string, unknown> = {
        orgId, briefId,
        ...(typeof body.directionIndex === 'number' ? { directionIndex: body.directionIndex } : {}),
        ...(optionalString(body.aspectRatio) ? { aspectRatio: optionalString(body.aspectRatio) } : {}),
        ...(typeof body.durationSeconds === 'number' ? { durationSeconds: body.durationSeconds } : {}),
        ...(optionalString(body.provider) ? { provider: optionalString(body.provider) } : {}),
        ...(optionalString(body.credentialRef) ? { credentialRef: optionalString(body.credentialRef) } : {}),
      };
      const run = buildRunRecord({
        workflowId: CREATIVE_BRIEFS_REEL_ID,
        tenantId,
        inputs,
        metadata: { source: 'creative-briefs-reel', briefId },
        ...(user.userId ? { actingUserId: user.userId } : {}),
        owner: ownerStampFromRequest(req),
      });
      // ADR 0551 P1 — `enqueueDispatch`: the 202 below promises a start.
      await insertRunWithStartContext(storage, run, { definition: wf.definition, enqueueDispatch: true });
      seedRunVariables(run.runId, wf.definition.variables, inputs);
      reserveConcurrentSlot(req, run.runId);
      res.status(202).json({
        runId: run.runId,
        status: 'pending',
        statusUrl: `${req.protocol}://${req.get('host')}/v1/runs/${run.runId}`,
        eventsUrl: `${req.protocol}://${req.get('host')}/v1/runs/${run.runId}/events`,
      });
      dispatchRunInBackground({ storage, run, definition: wf.definition, hostSuite });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/briefs/:briefId/renders`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      res.json({ renders: await listRenders(tenantId, orgId, req.params.briefId) });
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/briefs/:briefId/renders/:renderId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const ok = await deleteRender(tenantId, orgId, req.params.briefId, req.params.renderId);
      if (!ok) throw new OpenwopError('not_found', 'Render not found.', 404, { renderId: req.params.renderId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

}
