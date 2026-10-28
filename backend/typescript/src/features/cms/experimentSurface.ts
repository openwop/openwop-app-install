/**
 * ADR 0949 P2a — the `cms.page` experiment surface adapter. The engine owns the
 * model, the plan and the statistics; this adapter keeps what is the CMS's:
 * the variant rules (versions of the page, weights), the start lock and its
 * gates (one running experiment per page, the content-review stamp, the publish
 * blockers), and where exposures live (stamped analytics events, server-derived
 * only — ADR 0651 D3).
 */
import { OpenwopError } from '../../types.js';
import { registerExperimentSurface } from '../../host/experiments/adapters.js';
import { getExperimentRow } from '../../host/experiments/store.js';
import type { Experiment } from '../../host/experiments/types.js';
import type { UnitObservation } from '../../host/experiments/rollup.js';
import { analyticsEventsRetainedSince, listEventsForExperiment } from '../analytics/analyticsService.js';
import { CMS_PAGE_SURFACE, checkArmPromotable, finalizePagePromotion, restorePageBaseline, startExperiment, stopExperiment, validateCmsArms } from './pageExperimentsService.js';

async function stored(e: Experiment): Promise<Experiment> {
  const row = await getExperimentRow(e.tenantId, e.orgId, e.experimentId);
  if (!row) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
  return row;
}

export function registerCmsExperimentSurface(): void {
  registerExperimentSurface({
    kind: CMS_PAGE_SURFACE,
    validateTarget: (tenantId, orgId, pageId, arms) => validateCmsArms(tenantId, orgId, pageId, arms),
    async launch(e, actor) {
      // `null` = the CMS no longer sees a startable experiment (abandoned or
      // stopped since the engine checked): never report that as a launch.
      const started = await startExperiment(e.tenantId, e.orgId, e.surface.ref, e.experimentId, actor, { managed: true });
      const row = await stored(e);
      if (!started || row.status !== 'running') throw new OpenwopError('conflict', 'The experiment changed before it could launch.', 409, { reason: 'not_launchable', status: row.status });
      return row;
    },
    async stop(e, actor) {
      await stopExperiment(e.tenantId, e.orgId, e.surface.ref, e.experimentId, actor, { managed: true });
      return stored(e);
    },
    finalize: (e, winner, actor) => finalizePagePromotion(e.tenantId, e.orgId, e.surface.ref, e.arms.find((a) => a.key === winner)?.ref ?? null, actor, e.name, e.experimentId),
    restoreBaseline: (e, baselineRef, actor) => restorePageBaseline(e.tenantId, e.orgId, e.surface.ref, baselineRef, actor, e.name, e.experimentId, e.arms.find((arm) => arm.key === e.promotion?.winner)?.ref ?? null),
    checkPromotable: (e, armKey) => checkArmPromotable(e.tenantId, e.orgId, e.surface.ref, e.arms.find((a) => a.key === armKey)?.ref ?? null, armKey),
    async observe(e) {
      const first = new Map<string, { arm: string; at: string }>();
      const converted = new Set<string>();
      for (const ev of await listEventsForExperiment(e.tenantId, e.orgId, e.experimentId)) {
        // Only a server-derived stamp counts (ANL-18); a dropped stamp never does.
        if (!ev.sessionKey || !ev.experiment || ev.experiment.derived !== true) continue;
        if (ev.type === 'conversion') converted.add(ev.sessionKey);
        const seen = first.get(ev.sessionKey);
        if (!seen || ev.ts < seen.at) first.set(ev.sessionKey, { arm: ev.experiment.variant, at: ev.ts });
      }
      const units: UnitObservation[] = [...first].map(([k, v]) => ({ arm: v.arm, firstExposureAt: v.at, converted: converted.has(k) }));
      const retainedSince = await analyticsEventsRetainedSince(e.tenantId);
      const since = e.startedAt ?? e.createdAt;
      return { units, coverage: retainedSince && retainedSince > since ? 'partial' : 'complete', sourceRetainedSince: retainedSince };
    },
  });
}
