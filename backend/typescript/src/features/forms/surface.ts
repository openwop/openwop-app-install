/**
 * Forms workflow surface (ADR 0014) — `ctx.features.forms`, a THIN read adapter
 * over `formsService`. Tenant comes from the run scope; org-scoped reads are
 * tenant+org-guarded by the service (CTI-1) and project out internal/attribution
 * columns. Read-only in v1 (a submit/mutation node is a follow-on, mirroring the
 * CRM surface).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listForms, getForm, listSubmissions, getSubmission } from './formsService.js';

const FORM_INTERNAL = new Set(['tenantId', 'createdBy']);
const SUB_INTERNAL = new Set(['tenantId', 'orgId']);
function project(o: object, drop: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!drop.has(k)) out[k] = v;
  return out;
}

export function buildFormsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    listForms: async (args) => {
      const forms = await listForms(tenantId, str(args.orgId));
      return { forms: forms.map((f) => project(f, FORM_INTERNAL)) };
    },
    getSubmissions: async (args) => {
      // getForm enforces tenant+org; absent/cross-tenant form ⇒ empty (no probe).
      const form = await getForm(tenantId, str(args.orgId), str(args.formId));
      if (!form) return { submissions: [] };
      const subs = await listSubmissions(tenantId, str(args.orgId), str(args.formId));
      return { submissions: subs.map((s) => project(s, SUB_INTERNAL)) };
    },
    /** ADR 0246 — one submission's values + the form's intake binding, for the
     *  forms→priority-matrix bridge chain. Tenant+org+form-guarded; a miss ⇒
     *  `{ found: false }` (no probe). This is the "re-fetch under authz" half of
     *  the ids-only event discipline.
     *
     *  ADR 0584 §Correction (FORM-QUAR-1) — `flagged` RIDES THE SHAPE. A
     *  quarantined submission must not move anything downstream, and this
     *  fixed shape carried no way for a node to tell. The only thing closing
     *  the chain lane was that `formSubmissionCreated` is never fired for a
     *  held row — an absence, not a guard: a tenant binding this chain to a
     *  different trigger, or authoring one over `list-submissions` (which
     *  leaks `flagged` for free through the generic projection below), would
     *  file quarantined leads as real intake. `feature.forms.nodes.get-submission`
     *  reads this and answers `willFile:'no'`. */
    getSubmission: async (args) => {
      const form = await getForm(tenantId, str(args.orgId), str(args.formId));
      if (!form) return { found: false };
      const sub = await getSubmission(tenantId, str(args.orgId), str(args.formId), str(args.submissionId));
      if (!sub) return { found: false };
      return {
        found: true,
        values: sub.values,
        orgId: form.orgId,
        formTitle: form.title, // fallback idea title when the mapped field is empty (grade-code BE#2)
        ...(sub.flagged ? { flagged: sub.flagged } : {}),
        ...(form.intakeBinding ? { intakeBinding: form.intakeBinding } : {}),
      };
    },
  };
}
