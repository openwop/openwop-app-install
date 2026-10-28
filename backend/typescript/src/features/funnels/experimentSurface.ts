/**
 * ADR 0949 P2a — the `funnel.step` experiment surface adapter. The target ref
 * is `<funnelId>:<stepId>`; arms reference CMS pages of the org (null = the
 * step's own page, the holdout). Launching writes the funnel row's step pointer,
 * which is what the public read follows; exposures and completions are the
 * stamped CDP funnel events.
 */
import { OpenwopError } from '../../types.js';
import { registerExperimentSurface } from '../../host/experiments/adapters.js';
import { mutateExperimentRow } from '../../host/experiments/store.js';
import type { Experiment } from '../../host/experiments/types.js';
import { getPage } from '../cms/cmsService.js';
import { collectedEventsRetainedSince, listCollectedEvents } from '../cdp/collectService.js';
import { attachStepExperiment, coerceExperimentVariants, findFunnelStep, getFunnel, reconcileStepPromotion } from './funnelsService.js';
import { stepExperimentUnits } from './funnelStats.js';
import { FUNNEL_STEP_SURFACE, stepFromEngine } from './stepExperimentsEngine.js';

const notFound = (): never => { throw new OpenwopError('not_found', 'Funnel step not found.', 404, {}); };

function splitRef(ref: string): { funnelId: string; stepId: string } {
  const i = ref.lastIndexOf(':');
  if (i <= 0 || i === ref.length - 1) throw new OpenwopError('validation_error', 'A funnel step target is `<funnelId>:<stepId>`.', 400, { field: 'surface.ref' });
  return { funnelId: ref.slice(0, i), stepId: ref.slice(i + 1) };
}

const nowIso = (): string => new Date().toISOString();

export function registerFunnelExperimentSurface(): void {
  registerExperimentSurface({
    kind: FUNNEL_STEP_SURFACE,
    async validateTarget(tenantId, orgId, ref, arms) {
      const { funnelId, stepId } = splitRef(ref);
      if (!(await findFunnelStep(tenantId, orgId, funnelId, stepId))) notFound();
      const variants = coerceExperimentVariants(arms.map((a) => ({ key: a.key, pageId: a.ref, weight: a.weight })));
      for (const v of variants) {
        if (v.pageId !== null && !(await getPage(tenantId, orgId, v.pageId))) {
          throw new OpenwopError('validation_error', `Variant page not found in this workspace: ${v.pageId}`, 400, { field: 'arms' });
        }
      }
    },
    async launch(e) {
      const { funnelId, stepId } = splitRef(e.surface.ref);
      const at = nowIso();
      // Only a draft launches: a row abandoned or stopped since the engine
      // checked must not come back to life.
      const running = await mutateExperimentRow(e.tenantId, e.orgId, e.experimentId, (cur) => {
        if (cur.status !== 'draft') throw new OpenwopError('conflict', 'The experiment changed before it could launch.', 409, { reason: 'not_launchable', status: cur.status });
        return { ...cur, status: 'running', startedAt: at, updatedAt: at };
      });
      if (!running) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
      try {
        await attachStepExperiment(e.tenantId, e.orgId, funnelId, stepId, stepFromEngine(running)!);
      } catch (err) {
        // The pointer write is what serves traffic: without it, the experiment is not live.
        await mutateExperimentRow(e.tenantId, e.orgId, e.experimentId, (cur) => ({ ...cur, status: e.status, updatedAt: nowIso(), ...(e.startedAt ? { startedAt: e.startedAt } : {}) }));
        throw err;
      }
      return running;
    },
    async stop(e) {
      const { funnelId, stepId } = splitRef(e.surface.ref);
      const at = nowIso();
      const stopped = await mutateExperimentRow(e.tenantId, e.orgId, e.experimentId, (cur) => (cur.status === 'running' ? { ...cur, status: 'stopped', stoppedAt: at, updatedAt: at } : null));
      if (!stopped) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
      const f = await getFunnel(e.tenantId, e.orgId, funnelId);
      const step = f?.steps.find((st) => st.stepId === stepId);
      if (step?.experiment?.experimentId === e.experimentId) await attachStepExperiment(e.tenantId, e.orgId, funnelId, stepId, stepFromEngine(stopped)!);
      return stopped;
    },
    // ADR 0950 G8 — a variant page must still exist and be published (the
    // holdout is the step's own page, already live).
    async checkPromotable(e, armKey) {
      const ref = e.arms.find((a) => a.key === armKey)?.ref ?? null;
      if (ref === null) return { ok: true };
      const page = await getPage(e.tenantId, e.orgId, ref);
      return page && page.status === 'published' ? { ok: true } : { ok: false, reason: page ? 'page_not_published' : 'page_missing' };
    },
    // ADR 0950 P1 — the winner's page becomes the step's page; the replaced
    // page is the baseline a rollback restores. A null-ref winner is already live.
    async finalize(e, winner) {
      const { funnelId, stepId } = splitRef(e.surface.ref);
      const ref = e.arms.find((a) => a.key === winner)?.ref ?? null;
      const receipt = await reconcileStepPromotion(e.tenantId, e.orgId, funnelId, stepId, e.experimentId, ref, 'finalize');
      return { baselineRef: ref === null ? null : receipt.baselineRef };
    },
    async restoreBaseline(e) {
      const { funnelId, stepId } = splitRef(e.surface.ref);
      const ref = e.arms.find((arm) => arm.key === e.promotion?.winner)?.ref ?? null;
      await reconcileStepPromotion(e.tenantId, e.orgId, funnelId, stepId, e.experimentId, ref, 'rollback');
    },
    async observe(e: Experiment) {
      const { stepId } = splitRef(e.surface.ref);
      const units = stepExperimentUnits(await listCollectedEvents(e.tenantId, Number.MAX_SAFE_INTEGER), stepId, e.experimentId);
      const retainedSince = await collectedEventsRetainedSince(e.tenantId);
      const since = e.startedAt ?? e.createdAt;
      return { units, coverage: retainedSince && retainedSince > since ? 'partial' : 'complete', sourceRetainedSince: retainedSince };
    },
  });
}
