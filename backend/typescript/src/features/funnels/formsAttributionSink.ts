/**
 * Funnels' forms submission sink (ADR 0332 §D3) — the `funnel-attribution`
 * registrant on the ADR 0330 seam. A form submitted on a funnel-served page
 * carries opaque embed context (`meta.context.funnelId/stepId[/visitor]`);
 * this sink — funnels' own code, the ADR 0296 checkout pattern — turns that
 * server-truth capture into the EXISTING `funnel.step_completed` CDP event,
 * so the opt-in counts in the funnelStats rollup with the same sticky-variant
 * stamp `/next` would have emitted. No write-back (returns undefined), no
 * funnel lead store: the submission IS the lead (ADR 0330).
 *
 * Guards, in order: tenant's `funnels` toggle on → funnel exists IN THE
 * SUBMISSION'S tenant+org (context is public input; the submission row is
 * authoritative — cross-tenant context is inert) → step exists. Consent
 * (GC-FRM-1): the visitor key is re-gated through the SAME server-side
 * `isAllowed(…, 'analytics')` check the funnel `/next` path runs — the embed
 * context is public input, so "the surface passed a consented vk" is not a
 * property this sink may assume. An unconsented/denied vk degrades to the
 * empty visitor: the event still counts a completion (day-stat only — the
 * variant table needs a visitor, exactly like an unconsented `/next`).
 */

import { resolveOne } from '../../host/featureToggles/service.js';
import { collectEvent } from '../cdp/collectService.js';
import { isAllowed } from '../consent/consentService.js';
import { createLogger } from '../../observability/logger.js';
import { registerSubmissionSink } from '../forms/submissionSinks.js';
import { getFunnel, publicFunnelStep } from './funnelsService.js';

const log = createLogger('funnels.formsSink');

/** Register the `funnel-attribution` sink. Called once from funnels' boot path. */
export function registerFunnelsFormsSink(): void {
  registerSubmissionSink({
    id: 'funnel-attribution',
    async onSubmission(_form, submission) {
      const ctx = submission.meta.context;
      const funnelId = ctx?.funnelId;
      const stepId = ctx?.stepId;
      if (!funnelId || !stepId) return undefined; // the common, non-funnel case
      try {
        const toggle = await resolveOne('funnels', { tenantId: submission.tenantId });
        if (!toggle || !toggle.enabled) return undefined;
        // Tenant/org come from the SUBMISSION (authoritative), never the context.
        const funnel = await getFunnel(submission.tenantId, submission.orgId, funnelId);
        if (!funnel) return undefined;
        const ix = funnel.steps.findIndex((s) => s.stepId === stepId);
        const step = funnel.steps[ix];
        if (!step) return undefined;
        // GC-FRM-1 — the ONE consent gate, same as `/next`'s consentedVisitor:
        // a context-supplied vk enters analytics only if the tenant's consent
        // store allows it; denied/erroring resolves to the empty visitor.
        const rawVisitor = typeof ctx?.visitor === 'string' ? ctx.visitor : '';
        let visitor = '';
        if (rawVisitor) {
          try { visitor = (await isAllowed(submission.tenantId, rawVisitor, 'analytics')) ? rawVisitor : ''; } catch { visitor = ''; }
        }
        // Same sticky-variant stamp `/next` emits — re-derived deterministically.
        const served = visitor ? await publicFunnelStep(submission.tenantId, submission.orgId, funnel, ix, visitor) : null;
        await collectEvent(submission.tenantId, 'funnel.step_completed', {
          orgId: submission.orgId, funnelId: funnel.funnelId, funnelSlug: funnel.slug,
          stepId: step.stepId, stepKind: step.kind, stepIx: ix,
          visitor,
          // GC-FRM-2 — the idempotency key: the day-stats rollup counts each
          // submission's completion exactly once, however often the event is
          // (re-)emitted (the GC-D1-1 never-double-fire discipline).
          submissionId: submission.submissionId,
          ...(served?.experiment ? { experiment: served.experiment } : {}),
          ...(submission.meta.utm && Object.keys(submission.meta.utm).length ? { utm: submission.meta.utm } : {}),
          source: 'form-submit', // distinguishes sink-emitted completions from /next
        });
        // GC-FRM-4 — attribution throughput is log-visible (the capture side
        // logs submission_captured; this is the funnel-side confirmation).
        log.info('attribution_emitted', { tenantId: submission.tenantId, funnelId: funnel.funnelId, stepId: step.stepId, consented: visitor !== '' });
      } catch (err) {
        // Fail-soft by seam contract — attribution must never fail the capture.
        log.warn('funnel_attribution_failed', { funnelId, stepId, err: err instanceof Error ? err.message : String(err) });
      }
      return undefined;
    },
  });
}
