/**
 * Creative-video workflow surface (ADR 0404 §b) — `ctx.features['creative-video']`.
 * Backs the `video.generate` action node. Runs in a RUN context (the broker
 * resolves the org's HeyGen credential). The node output is the ASSET ID (never
 * the bytes, never a regenerate handle), pinned so replay returns it.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { requireString as requireStr } from '../featureRoute.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { OpenwopError } from '../../types.js';
import type { BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { generateVideo, textToVideo, resolveVideoJob } from './videoService.js';

/** The frontier T2V node must AND-gate the sub-toggle with its parent — the parent
 *  gates the surface's presence, this gates the nested capability (ADR 0404 §P4). */
async function assertT2VEnabled(tenantId: string): Promise<void> {
  const a = await resolveOne('creative-video.t2v', { tenantId });
  if (!a || !a.enabled) throw new OpenwopError('not_found', 'Text-to-video is not enabled for this tenant.', 404, { feature: 'creative-video.t2v' });
}

export function buildCreativeVideoSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const actor = `run:${scope.runId ?? 'unknown'}`;
  const brokerDeps = (orgId: string): BrokeredEgressDeps => ({
    storage: hostExtStorage(),
    tenantId,
    runId: scope.runId ?? `hostext:video:${orgId}`,
    ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}),
    orgId,
  });

  return {
    generateVideo: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const out = await generateVideo(brokerDeps(orgId), {
        tenantId, orgId,
        script: requireStr(args.script, 'script'),
        avatarId: requireStr(args.avatarId, 'avatarId'),
        ...(optStr(args.voiceId) ? { voiceId: optStr(args.voiceId) } : {}),
        createdBy: scope.actingUserId ?? actor,
      });
      return { success: out.status !== 'failed', ...out };
    },

    textToVideo: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      await assertT2VEnabled(tenantId);
      const out = await textToVideo(brokerDeps(orgId), {
        tenantId, orgId,
        prompt: requireStr(args.prompt, 'prompt'),
        ...(optStr(args.model) ? { model: optStr(args.model) } : {}),
        ...(typeof args.durationSec === 'number' ? { durationSec: args.durationSec } : {}),
        createdBy: scope.actingUserId ?? actor,
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
