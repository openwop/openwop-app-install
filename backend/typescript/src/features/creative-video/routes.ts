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
import { recordLikenessConsent, LIKENESS_CONSENT_TEXT_VERSION } from './likenessConsent.js';
import { runwayModelsView } from './host/runwayModels.js';

const FEATURE = { toggleId: 'creative-video', label: 'AI Video' };
const T2V_FEATURE = { toggleId: 'creative-video.t2v', label: 'Text-to-video' };
const ORG = '/host/openwop-app/creative-video/orgs/:orgId';

type Scope = 'workspace:read' | 'workspace:write';

/** Map a generation outcome to an HTTP status: a client-side cap is 429, paid
 *  video switched off (cap 0, ADR 1051 D3) is 403, a missing provider connection
 *  is 409, a provider failure or an unconfirmed submit is 502, success is 201. */
function statusFor(out: { status: string; error?: string }): number {
  if (out.status !== 'failed') return 201;
  if (out.error === 'budget_exceeded') return 429;
  if (out.error === 'video_budget_disabled') return 403;
  if (out.error === 'no_connection') return 409;
  return 502;
}

/** ADR 1051 D5 — the body's attestation: `{ attested: true, textVersion }` for the
 *  sentence the page showed. Anything else (absent, false, an older sentence) is
 *  a typed refusal before anything is recorded or sent. */
function requireAttestation(raw: unknown): void {
  const a = (raw ?? {}) as Record<string, unknown>;
  if (a.attested !== true || a.textVersion !== LIKENESS_CONSENT_TEXT_VERSION) {
    throw new OpenwopError('likeness_consent_required', "Confirm you have the depicted person's consent to use their likeness and voice.", 422, { field: 'likenessConsent', textVersion: LIKENESS_CONSENT_TEXT_VERSION });
  }
}

export function registerCreativeVideoRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  // ADR 1051 D2/D5 — the ONE model table for the page's selects, and the version
  // of the consent sentence the page must show (so the page never carries its own).
  app.get(`${ORG}/video-models`, async (req, res, next) => {
    try {
      await authz(req, 'workspace:read');
      res.json({ ...runwayModelsView(), likenessConsentTextVersion: LIKENESS_CONSENT_TEXT_VERSION });
    } catch (err) { next(err); }
  });

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
      const script = requireString(body.script, 'script');
      const avatarId = requireString(body.avatarId, 'avatarId').trim();
      const voiceId = optionalString(body.voiceId)?.trim() || undefined;
      // ADR 1051 D5 — the signed-in person affirms consent for this avatar/voice;
      // the record lets their later workflow runs use the same avatar.
      requireAttestation(body.likenessConsent);
      const likenessConsent = await recordLikenessConsent({ tenantId, orgId, userId: user.userId, avatarId, ...(voiceId ? { voiceId } : {}) });
      const brokerDeps = { storage: hostExtStorage(), tenantId, runId: `hostext:video:${orgId}`, actingUserId: user.userId, orgId };
      const out = await generateVideo(brokerDeps, {
        tenantId, orgId, script, avatarId, ...(voiceId ? { voiceId } : {}),
        createdBy: user.userId, likenessConsent,
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
        ...(optionalString(body.ratio) ? { ratio: optionalString(body.ratio) } : {}),
        ...(typeof body.durationSec === 'number' ? { durationSec: body.durationSec } : {}),
        createdBy: user.userId,
      });
      res.status(statusFor(out)).json(out);
    } catch (err) { next(err); }
  });
}
