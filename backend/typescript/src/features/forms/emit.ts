/**
 * Forms mutation side-channel (ADR 0246 / ADR 0208 §1) — a form submission
 * landed. Ids-only payload by the dispatcher discipline (a bound bridge chain
 * re-fetches the values under authz via `ctx.features.forms.getSubmission`);
 * fire-and-forget by contract — `emitHostEvent` never throws, so a fanout
 * failure can never fail the submission. Mirrors `crm/emit.ts`.
 */
import { emitHostEvent } from '../../host/hostEventDispatcher.js';

export function formSubmissionCreated(input: { tenantId: string; orgId: string; formId: string; submissionId: string }): void {
  void emitHostEvent({
    type: 'host.forms.submission.created',
    tenantId: input.tenantId,
    payload: { formId: input.formId, submissionId: input.submissionId, orgId: input.orgId },
  });
}
