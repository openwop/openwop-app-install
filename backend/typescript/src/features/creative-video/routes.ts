/**
 * Creative-video feature routes (ADR 0404 §b) — host-extension, authed org-scoped
 * operator surface: generate a video (the creative affordance drives this), list
 * jobs, and read a job's status. Connecting HeyGen (the API key) is the Connections
 * surface's job — no credential route here.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireFeatureEnabled, requireString, optionalString } from '../featureRoute.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { generateVideo, textToVideo, resolveVideoJob, jobView, creativeVideoEnabled } from './videoService.js';
import { listJobs } from './entities/videoJob.js';

const FEATURE = { toggleId: 'creative-video', label: 'AI Video' };
const T2V_FEATURE = { toggleId: 'creative-video.t2v', label: 'Text-to-video' };
const ORG = '/v1/host/openwop-app/creative-video/orgs/:orgId';

type Scope = 'workspace:read' | 'workspace:write';

/** Map a generation outcome to an HTTP status: a client-side cap is 429, a missing
 *  provider connection is 409, a real provider failure is 502, success is 201. */
function statusFor(out: { status: string; error?: string }): number {
  if (out.status !== 'failed') return 201;
  if (out.error === 'budget_exceeded') return 429;
  if (out.error === 'no_connection') return 409;
  return 502;
}

export function registerCreativeVideoRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  app.get(`${ORG}/jobs`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      res.json({ jobs: (await listJobs(tenantId, orgId)).map(jobView) });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/jobs/:jobId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:read');
      // Resolve = read + one poll if still in flight, so polling this endpoint drives
      // a long job to completion (grade-code CV-2 — the FE polls it).
      const brokerDeps = { storage: hostExtStorage(), tenantId, runId: `hostext:video:${orgId}`, actingUserId: user.userId, orgId };
      const job = await resolveVideoJob(brokerDeps, tenantId, orgId, req.params.jobId);
      if (!job) throw new OpenwopError('not_found', 'Job not found.', 404, {});
      res.json(jobView(job));
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/generate`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      if (!creativeVideoEnabled()) throw new OpenwopError('host_capability_missing', 'AI video generation is not enabled on this host.', 501, {});
      const body = (req.body ?? {}) as Record<string, unknown>;
      const brokerDeps = { storage: hostExtStorage(), tenantId, runId: `hostext:video:${orgId}`, actingUserId: user.userId, orgId };
      const out = await generateVideo(brokerDeps, {
        tenantId, orgId,
        script: requireString(body.script, 'script'),
        avatarId: requireString(body.avatarId, 'avatarId'),
        ...(optionalString(body.voiceId) ? { voiceId: optionalString(body.voiceId) } : {}),
        createdBy: user.userId,
      });
      res.status(statusFor(out)).json(out);
    } catch (err) { next(err); }
  });

  // ADR 0404 §P4 — frontier text-to-video. AND-gate: the parent `creative-video`
  // (via authz) AND the `creative-video.t2v` sub-toggle must both resolve on.
  app.post(`${ORG}/text-to-video`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      await requireFeatureEnabled(req, T2V_FEATURE.toggleId, T2V_FEATURE.label);
      if (!creativeVideoEnabled()) throw new OpenwopError('host_capability_missing', 'AI video generation is not enabled on this host.', 501, {});
      const body = (req.body ?? {}) as Record<string, unknown>;
      const brokerDeps = { storage: hostExtStorage(), tenantId, runId: `hostext:video:${orgId}`, actingUserId: user.userId, orgId };
      const out = await textToVideo(brokerDeps, {
        tenantId, orgId,
        prompt: requireString(body.prompt, 'prompt'),
        ...(optionalString(body.model) ? { model: optionalString(body.model) } : {}),
        ...(typeof body.durationSec === 'number' ? { durationSec: body.durationSec } : {}),
        createdBy: user.userId,
      });
      res.status(statusFor(out)).json(out);
    } catch (err) { next(err); }
  });
}
