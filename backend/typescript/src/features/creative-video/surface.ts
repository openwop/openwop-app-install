/**
 * Creative-video workflow surface (ADR 0404 §b) — `ctx.features['creative-video']`.
 * Backs the `video.generate` action node. Runs in a RUN context (the broker
 * resolves the org's HeyGen credential). The node output is the ASSET ID (never
 * the bytes, never a regenerate handle), pinned so replay returns it.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceOptStr as optStr, type FeatureSurface, type FeatureSurfaceOrgPolicy } from '../../host/featureSurfaces.js';
import { requireString as requireStr } from '../featureRoute.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { OpenwopError } from '../../types.js';
import type { BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { generateVideo, textToVideo, imageToVideo, resolveVideoJob, creativeVideoEnabled } from './videoService.js';
import { findLikenessConsent } from './likenessConsent.js';

/**
 * ADR 1051 D1 — the spend methods ask the HTTP door's write scope at the ADR 0832
 * org floor. `getVideoStatus` stays a read: it never submits or reserves, though
 * it can download the finished video (up to 200 MiB), mint its media asset, use
 * the org's storage and write a fidelity verdict — finishing a job a writer
 * already paid for, with that writer's connection (D10).
 */
export const CREATIVE_VIDEO_SURFACE_POLICY: FeatureSurfaceOrgPolicy = {
  methodScopes: { generateVideo: 'workspace:write', textToVideo: 'workspace:write', imageToVideo: 'workspace:write' },
};

/** Every surface method, named read or write (the ratchet test reads this). */
export const CREATIVE_VIDEO_SURFACE_METHODS = { generateVideo: 'write', textToVideo: 'write', imageToVideo: 'write', getVideoStatus: 'read' } as const;

/** ADR 1051 D1 — spend needs an accountable person: the run's actor, else the
 *  member who caused it. The ADR 0832 floor passes a run with neither ("no
 *  person ⇒ no check"), so the spend methods refuse it here, before any row or
 *  reservation, and also honour the host kill switch the routes honour. */
function spendingPerson(scope: BundleScope): string {
  if (!creativeVideoEnabled()) throw new OpenwopError('host_capability_missing', 'AI video generation is not enabled on this host.', 501, {});
  const person = scope.actingUserId ?? scope.orgScopeSubject;
  if (!person) throw new OpenwopError('forbidden_scope', 'Paid video generation needs a person behind the run; a system or webhook run cannot spend.', 403, { scope: 'workspace:write' });
  return person;
}

/** The frontier T2V node must AND-gate the sub-toggle with its parent — the parent
 *  gates the surface's presence, this gates the nested capability (ADR 0404 §P4). */
async function assertT2VEnabled(tenantId: string): Promise<void> {
  const a = await resolveOne('creative-video.t2v', { tenantId });
  if (!a || !a.enabled) throw new OpenwopError('not_found', 'Text-to-video is not enabled for this tenant.', 404, { feature: 'creative-video.t2v' });
}

export function buildCreativeVideoSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const brokerDeps = (orgId: string): BrokeredEgressDeps => ({
    storage: hostExtStorage(),
    tenantId,
    runId: scope.runId ?? `hostext:video:${orgId}`,
    ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}),
    orgId,
  });

  return {
    generateVideo: async (args) => {
      const person = spendingPerson(scope);
      const orgId = requireStr(args.orgId, 'orgId');
      const avatarId = requireStr(args.avatarId, 'avatarId').trim();
      const voiceId = optStr(args.voiceId)?.trim() || undefined;
      // ADR 1051 D5 — the workflow lane takes NO attestation input (a literal in
      // a saved definition would attest for every later runner): it needs the
      // ACTING user's own record, made on the page. Not the causing member's
      // (grade-code CV83CD-3): `orgScopeSubject` only narrows (ADR 0832 D3), and a
      // consent record is a grant, so a caused run cannot render a likeness.
      const consent = scope.actingUserId
        ? await findLikenessConsent({ tenantId, orgId, userId: scope.actingUserId, avatarId, ...(voiceId ? { voiceId } : {}) })
        : null;
      if (!consent) throw new OpenwopError('likeness_consent_required', "This avatar needs your consent attestation first: generate it once from the AI Video page, confirming you have the depicted person's consent.", 422, { field: 'likenessConsent', avatarId });
      const out = await generateVideo(brokerDeps(orgId), {
        tenantId, orgId,
        script: requireStr(args.script, 'script'),
        avatarId, ...(voiceId ? { voiceId } : {}),
        createdBy: person, likenessConsent: consent,
      });
      return { success: out.status !== 'failed', ...out };
    },

    textToVideo: async (args) => {
      const person = spendingPerson(scope);
      const orgId = requireStr(args.orgId, 'orgId');
      await assertT2VEnabled(tenantId);
      const out = await textToVideo(brokerDeps(orgId), {
        tenantId, orgId,
        prompt: requireStr(args.prompt, 'prompt'),
        ...(optStr(args.model) ? { model: optStr(args.model) } : {}),
        ...(optStr(args.ratio) ? { ratio: optStr(args.ratio) } : {}),
        ...(typeof args.durationSec === 'number' ? { durationSec: args.durationSec } : {}),
        createdBy: person,
      });
      return { success: out.status !== 'failed', ...out };
    },

    // ADR 0945 D7 — animate a checked product shot or a product photo. Rides the
    // `creative-video.t2v` sub-toggle (same provider, same spend meter).
    imageToVideo: async (args) => {
      const person = spendingPerson(scope);
      const orgId = requireStr(args.orgId, 'orgId');
      await assertT2VEnabled(tenantId);
      const out = await imageToVideo(brokerDeps(orgId), {
        tenantId, orgId,
        sourceAssetId: requireStr(args.sourceAssetId, 'sourceAssetId'),
        prompt: requireStr(args.prompt, 'prompt'),
        ...(optStr(args.productId) ? { productId: optStr(args.productId) } : {}),
        ...(optStr(args.model) ? { model: optStr(args.model) } : {}),
        ...(optStr(args.ratio) ? { ratio: optStr(args.ratio) } : {}),
        ...(typeof args.durationSec === 'number' ? { durationSec: args.durationSec } : {}),
        createdBy: person,
      });
      return { success: out.status !== 'failed', ...out };
    },

    getVideoStatus: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      // Resolve = read + a single poll if still in flight, so a `pending` generate
      // node is advanced to its final asset id from here (ADR 0404 grade-code CV-2).
      const job = await resolveVideoJob(brokerDeps(orgId), tenantId, orgId, requireStr(args.jobId, 'jobId'));
      return job ? { success: true, status: job.status, ...(job.assetId ? { assetId: job.assetId } : {}), ...(job.error ? { error: job.error } : {}) } : { success: false, error: 'not_found' };
    },
  };
}
