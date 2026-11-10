/**
 * ADR 1052 D13 — subject erasure for BI metric definitions.
 *
 * `bi:metric.createdBy` was on the actor-attribution debt list
 * (`subject-erasure-feature-stores.test.ts` `ACTOR_ATTRIBUTED_DEBT`): a metric
 * definition is ORG configuration that pages, dashboards, chat tools and workflow
 * nodes resolve by id, so deleting it on a member's erasure would break every one
 * of them. It is RE-ATTRIBUTED instead: the erased person's id becomes the `ERASED`
 * sentinel and the definition stays (the territories-model precedent). The
 * definition holds no other personal field.
 *
 * Each rewrite is a compare-and-swap against the row read, so a concurrent edit is
 * never overwritten with the stale definition; a lost race is re-read and retried
 * (the edit kept `createdBy`, so the retry still finds it).
 */
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED } from '../../host/subjectErasureRedaction.js';
import { createLogger } from '../../observability/logger.js';
import { metrics, storedMetricKey, __metricsForErasure } from './metricStore.js';

const log = createLogger('bi.erasure');

export async function eraseSubjectBiMetrics(tenantId: string, subjectKey: string): Promise<void> {
  const forms = subjectKeyForms(subjectKey).forms;
  let touched = 0;
  const failed: string[] = [];
  for (const m of await __metricsForErasure(tenantId)) {
    if (!forms.has(m.createdBy)) continue;
    let current: typeof m | null = m;
    let done = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!current || !forms.has(current.createdBy)) { done = true; break; } // deleted, or no longer theirs
      if (await metrics.compareAndSwap(current, { ...current, createdBy: ERASED })) { touched += 1; done = true; break; }
      current = await metrics.get(storedMetricKey(current.tenantId, current.orgId, current.metricId));
    }
    if (!done) failed.push(m.metricId);
  }
  if (touched) log.info('bi subject erasure applied', { tenantId, metricsReattributed: touched });
  // Never report success over a row that still names the person (grade-code L6), but
  // finish every other metric first (re-grade L2). The fan-out records the throw in
  // `failedFeatures`.
  if (failed.length) throw new Error(`bi erasure: ${failed.length} metric(s) kept changing; createdBy not re-attributed (${failed.join(', ')})`);
}

export function registerBiErasure(): void {
  registerSubjectEraser(eraseSubjectBiMetrics);
}
