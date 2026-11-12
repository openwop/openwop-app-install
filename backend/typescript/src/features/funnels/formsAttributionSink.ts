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

import { resolveToggle } from '../../host/featureToggles/service.js';
import { collectEvent } from '../cdp/collectService.js';
import { isAllowed } from '../consent/consentService.js';
import { visitorAnalyticsAllowed } from '../consent/visitorConsent.js';
import { createLogger } from '../../observability/logger.js';
import { registerSubmissionSink } from '../forms/submissionSinks.js';
import { getFunnel, publicFunnelStep, type Funnel, type FunnelStep } from './funnelsService.js';
import { resolveStepExperiment } from './stepExperimentsEngine.js';
import { deliverableSectionsForPage, getPage, resolveSharedRefs } from '../cms/cmsService.js';
import { getMarketingEvent } from '../webinars/entities/marketingEvent.js';

const log = createLogger('funnels.formsSink');

/** True when `formId` appears anywhere in `value` as a `formId` field. */
function mentionsForm(value: unknown, formId: string, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => mentionsForm(v, formId, depth + 1));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'formId' && v === formId) return true;
    if (mentionsForm(v, formId, depth + 1)) return true;
  }
  return false;
}

/**
 * ADR 1023 D6 — does this step serve `formId`? Its bound form (an application step's
 * form, a webinar's registration form) or a form in what DELIVERY serves for any of
 * the step's pages: the holdout and every step-experiment variant page (an
 * unconsented submitter has no assigned variant to check), each with its running CMS
 * page experiment's sections and its shared-section refs resolved — a form kept in a
 * shared section has an empty `data` on the page itself (architect round 1, B3).
 */
async function formServedOnStep(tenantId: string, orgId: string, funnel: Funnel, step: FunnelStep, formId: string): Promise<boolean> {
  if (step.application?.formId === formId) return true;
  if (step.webinar) {
    const ev = await getMarketingEvent(tenantId, orgId, step.webinar.marketingEventId);
    if (ev?.formId === formId) return true;
  }
  const exp = await resolveStepExperiment(tenantId, orgId, funnel.funnelId, step.stepId, step.experiment);
  const pageIds = new Set([step.pageId, ...(exp?.variants ?? []).map((v) => v.pageId).filter((id): id is string => typeof id === 'string')]);
  for (const pageId of pageIds) {
    const page = await getPage(tenantId, orgId, pageId);
    if (!page) continue;
    const delivered = await resolveSharedRefs({ ...page, sections: await deliverableSectionsForPage(page) });
    if (mentionsForm(delivered.sections, formId)) return true;
  }
  return false;
}

/** Register the `funnel-attribution` sink. Called once from funnels' boot path. */
export function registerFunnelsFormsSink(): void {
  registerSubmissionSink({
    id: 'funnel-attribution',
    async onSubmission(form, submission, capture) {
      const ctx = submission.meta.context;
      const funnelId = ctx?.funnelId;
      const stepId = ctx?.stepId;
      if (!funnelId || !stepId) return undefined; // the common, non-funnel case
      try {
        // ADR 0819 §1 opt-out — a PUBLIC lane (tenant from the resource): ADR 0419 never paywalls a shopper/visitor on the operator's plan.
        const toggle = await resolveToggle('funnels', { tenantId: submission.tenantId });
        if (!toggle || !toggle.enabled) return undefined;
        // Tenant/org come from the SUBMISSION (authoritative), never the context.
        const funnel = await getFunnel(submission.tenantId, submission.orgId, funnelId);
        if (!funnel) return undefined;
        const ix = funnel.steps.findIndex((s) => s.stepId === stepId);
        const step = funnel.steps[ix];
        if (!step) return undefined;
        // ADR 1023 D6 (FN72WF-15) — `context` is visitor-supplied: the ids are public
        // in every step response, so any form of the org could name any step of any
        // funnel and inflate it. Attribute only a PUBLISHED funnel's step that
        // actually serves this form.
        if (funnel.status !== 'published' || !(await formServedOnStep(submission.tenantId, submission.orgId, funnel, step, form.formId))) {
          log.info('attribution_refused', { tenantId: submission.tenantId, funnelId: funnel.funnelId, stepId: step.stepId, reason: funnel.status !== 'published' ? 'funnel_not_published' : 'form_not_on_step' });
          return undefined;
        }
        // GC-FRM-1 — the ONE consent gate, same as `/next`'s consentedVisitor:
        // a context-supplied vk enters analytics only if the tenant's consent
        // store allows it; denied/erroring resolves to the empty visitor.
        const rawVisitor = typeof ctx?.visitor === 'string' ? ctx.visitor : '';
        let visitor = '';
        if (rawVisitor) {
          // ADR 0860 D3 (architect B1) — a live submit hands the visitor's token
          // subject + region through the transient capture, so this is the SAME
          // decision the funnel routes make. No capture (a release, a seed) keeps
          // the legacy subject-only decision.
          try {
            const vc = capture?.visitorConsent;
            const ok = vc === null
              ? false // a refused token is a refusal, never a fall-back (grade-code M1)
              : vc
                ? await visitorAnalyticsAllowed(submission.tenantId, rawVisitor, vc)
                : await isAllowed(submission.tenantId, rawVisitor, 'analytics');
            visitor = ok ? rawVisitor : '';
          } catch { visitor = ''; }
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
        }, undefined, { source: 'first-party' }); // ADR 1024 D4.2 — gated above by the visitor decision
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
