/**
 * Submission sinks (ADR 0330 §D1) — the inversion seam that makes Forms a
 * standalone capture primitive. A sink is a post-persist, in-process consumer
 * of a just-recorded submission, registered by ANOTHER feature at boot (the
 * integrator depends on the primitive: crm → forms for the `crm-contact`
 * sink, funnels → forms for `funnel-attribution` per ADR 0332). Forms itself
 * imports no destination feature.
 *
 * Contract: sinks run AFTER the submission row is durably persisted (ADR 0017
 * capture-ordering invariant) and are fail-soft — a sink may return markers
 * to annotate the submission (`contactId` / `error`) or `undefined` for pure
 * side-effect consumers; a thrown sink is logged and skipped, never failing
 * the capture. Not the ADR 0208 host-event seam: that dispatcher has no
 * in-process subscriber lane, and its trigger lane costs a workflow run per
 * event — this seam exists for synchronous, at-capture annotation.
 *
 * ORDERING (ADR 0338 §D3): sinks run in REGISTRATION order and markers apply
 * in-loop, so a later sink observes an earlier sink's `contactId` (crm
 * registers before email via BACKEND_FEATURES order). A sink that depends on
 * a marker MUST still fail-soft when it's absent.
 */

import { createLogger } from '../../observability/logger.js';
import type { FormDef, Submission } from './formsService.js';

const log = createLogger('forms.submissionSinks');

export interface SubmissionSinkResult {
  /** Set when the sink linked the submission to a CRM contact. First
   *  marker-returning sink wins (ADR 0330 open question — single slot v1). */
  contactId?: string;
  /** A recorded (non-fatal) failure marker, e.g. `contact_create_failed`. */
  error?: string;
}

export interface SubmissionSink {
  /** Stable id, e.g. `crm-contact`, `funnel-attribution`. Re-registering an
   *  id replaces the prior sink (idempotent boot). */
  id: string;
  onSubmission(form: FormDef, submission: Submission): Promise<SubmissionSinkResult | undefined>;
}

const sinks: SubmissionSink[] = [];

export function registerSubmissionSink(sink: SubmissionSink): void {
  const i = sinks.findIndex((s) => s.id === sink.id);
  if (i >= 0) sinks[i] = sink;
  else sinks.push(sink);
}

/** Test seam — boot registration is module-level, so tests reset between cases. */
export function clearSubmissionSinksForTest(): void {
  sinks.length = 0;
}

/**
 * Run every registered sink against a persisted submission, merging returned
 * markers (first `contactId` wins; first `error` wins). Fail-soft: a thrown
 * sink logs and contributes nothing. Returns whether any marker was applied
 * so the caller knows to re-persist.
 */
export async function runSubmissionSinks(form: FormDef, submission: Submission): Promise<boolean> {
  let changed = false;
  for (const sink of sinks) {
    try {
      const res = await sink.onSubmission(form, submission);
      if (res?.contactId && !submission.contactId) { submission.contactId = res.contactId; changed = true; }
      if (res?.error && !submission.error) { submission.error = res.error; changed = true; }
    } catch (err) {
      log.warn('submission sink failed', { sink: sink.id, formId: form.formId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return changed;
}
