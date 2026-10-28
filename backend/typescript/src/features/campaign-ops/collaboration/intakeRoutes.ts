/**
 * ADR 0958 P3 — vendor asset intake routes. The service and the guard placement
 * are documented in `intake.ts`.
 *
 * COLLABORATOR side (signed in to their own account, through a bound grant):
 *   POST /collab/grants/:grantId/intakes                      send files + rights   [grant action `upload`]
 *   GET  /collab/grants/:grantId/intakes                      their own submissions [grant action `upload`]
 *   POST /collab/grants/:grantId/intakes/:intakeId/withdraw   withdraw an undecided one
 * Tenant, org and campaign come from the grant. Every refusal is the uniform 404.
 * No route here returns bytes: a vendor cannot read a file back, pending or not.
 *
 * AGENCY side (`/campaign-ops/clients/:orgId/intakes`), both toggles on:
 *   GET  /                          list            [workspace:read]
 *   GET  /:intakeId                 one             [workspace:read]
 *   GET  /:intakeId/files/:fileId   review download [workspace:write, the people who may accept]
 *   POST /:intakeId/accept          accept          [workspace:write]
 *   POST /:intakeId/reject          reject          [workspace:write]
 *
 * @see docs/adr/0958-vendor-and-guest-collaboration.md
 */
import type { Request, Response } from 'express';
import { OpenwopError } from '../../../types.js';
import type { RouteDeps } from '../../../routes/registerAllRoutes.js';
import { requireFeatureEnabled } from '../../featureRoute.js';
import { resolveCallerUser } from '../../users/usersGuards.js';
import { checkGrantUse, getCollaborator, grantResourceKind, type GrantUse } from '../../../host/externalCollaborators.js';
import { assetServeHeaders } from '../../../host/assetServeHeaders.js';
import { authorizeClient } from '../routes.js';
import { viewAsset } from '../../media/mediaService.js';
import type { Scope } from '../../../host/accessControlService.js';
import {
  acceptIntake, getIntake, listIntakes, listIntakesForGrant, readHeldFile, rejectIntake, submitIntake, withdrawIntake,
  type AssetIntake, type IntakeStatus,
} from './intake.js';

const notFound = (): OpenwopError => new OpenwopError('not_found', 'Not found.', 404, {});
const STATUSES: readonly IntakeStatus[] = ['submitted', 'accepted', 'rejected', 'withdrawn'];

/** What the vendor sees: their files, status and the agency's reason. Never an
 *  agency id, a reviewer, or the library asset the files became. */
function vendorView(r: AssetIntake): Record<string, unknown> {
  return {
    intakeId: r.intakeId, status: r.status, submittedAt: r.submittedAt,
    ...(r.reviewedAt ? { reviewedAt: r.reviewedAt } : {}), ...(r.reason ? { reason: r.reason } : {}),
    files: r.files.map((f) => ({ fileId: f.fileId, name: f.name, contentType: f.contentType, bytes: f.bytes })),
    rights: r.rights, ...(r.note ? { note: r.note } : {}),
  };
}

async function agencyView(r: AssetIntake): Promise<Record<string, unknown>> {
  const c = await getCollaborator(r.tenantId, r.orgId, r.collaboratorId);
  const { key: _k, tenantId: _t, acceptClaim, ...rest } = r;
  return { ...rest, accepting: Boolean(acceptClaim), collaborator: c ? { collaboratorId: c.collaboratorId, displayName: c.displayName, kind: c.kind, status: c.status } : null };
}

export function registerIntakeRoutes(deps: RouteDeps, collabEnabledFor: (tenantId: string) => Promise<boolean>, collabToggle: string): void {
  const { app } = deps;

  /** The checked `upload` use of the caller's grant, with both toggles on the GRANT's tenant. */
  async function uploadUse(req: Request): Promise<GrantUse> {
    const user = await resolveCallerUser(req);
    let use: GrantUse;
    try {
      use = await checkGrantUse({ grantId: req.params.grantId, via: { userId: user.userId }, action: 'upload' });
    } catch {
      throw notFound();
    }
    if (use.grant.resource.kind !== 'campaign' || !(await collabEnabledFor(use.tenantId))) throw notFound();
    // The same "presentable now" rule the grant page uses: a campaign the vendor
    // can no longer see (archived) takes no files either.
    const kind = grantResourceKind('campaign');
    if (!kind || !(await kind.project(use.tenantId, use.orgId, use.grant.resource.id))) throw notFound();
    return use;
  }

  const V = '/host/openwop-app/collab/grants/:grantId/intakes';

  app.post(V, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const use = await uploadUse(req);
      const body = (req.body ?? {}) as { files?: unknown; rights?: unknown; note?: unknown };
      res.status(201).json({ intake: vendorView(await submitIntake(use, body)) });
    } catch (err) { next(err); }
  });

  app.get(V, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const use = await uploadUse(req);
      res.json({ intakes: (await listIntakesForGrant(use)).map(vendorView) });
    } catch (err) { next(err); }
  });

  app.post(`${V}/:intakeId/withdraw`, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const use = await uploadUse(req);
      res.json({ intake: vendorView(await withdrawIntake(use, req.params.intakeId)) });
    } catch (err) { next(err); }
  });

  // ── agency ──
  const A = '/host/openwop-app/campaign-ops/clients/:orgId/intakes';

  async function agency(req: Request, scope: Scope): Promise<{ tenantId: string; userId: string; orgId: string }> {
    await requireFeatureEnabled(req, collabToggle, 'External collaborators');
    const { tenantId, userId } = await authorizeClient(req, scope);
    return { tenantId, userId, orgId: req.params.orgId };
  }

  app.get(A, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await agency(req, 'workspace:read');
      const raw = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (raw !== undefined && !(STATUSES as readonly string[]).includes(raw)) {
        throw new OpenwopError('validation_error', `\`status\` must be one of: ${STATUSES.join(', ')}.`, 400, { field: 'status' });
      }
      const rows = await listIntakes(tenantId, orgId, raw as IntakeStatus | undefined);
      res.json({ intakes: await Promise.all(rows.map(agencyView)) });
    } catch (err) { next(err); }
  });

  app.get(`${A}/:intakeId`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await agency(req, 'workspace:read');
      const r = await getIntake(tenantId, orgId, req.params.intakeId);
      if (!r) throw notFound();
      res.json({ intake: await agencyView(r) });
    } catch (err) { next(err); }
  });

  /**
   * The ONE read of pending bytes: for the people who may accept, always a
   * download (never rendered in the app's origin), never cached, under the
   * ADR 0818 sandbox CSP and `nosniff`.
   */
  app.get(`${A}/:intakeId/files/:fileId`, async (req: Request, res: Response, next) => {
    try {
      const { tenantId, orgId } = await agency(req, 'workspace:write');
      const held = await readHeldFile(tenantId, orgId, req.params.intakeId, req.params.fileId);
      if (!held) throw notFound();
      const h = assetServeHeaders(held.file.contentType);
      res.status(200);
      res.setHeader('Content-Type', h['Content-Type']!);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(held.bytes);
    } catch (err) { next(err); }
  });

  app.post(`${A}/:intakeId/accept`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await agency(req, 'workspace:write');
      const { intake, assets } = await acceptIntake(tenantId, orgId, req.params.intakeId, userId);
      res.json({ intake: await agencyView(intake), assets: assets.map(viewAsset) });
    } catch (err) { next(err); }
  });

  app.post(`${A}/:intakeId/reject`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await agency(req, 'workspace:write');
      res.json({ intake: await agencyView(await rejectIntake(tenantId, orgId, req.params.intakeId, userId, (req.body ?? {}).reason)) });
    } catch (err) { next(err); }
  });
}
