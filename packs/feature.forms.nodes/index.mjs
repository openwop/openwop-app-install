/**
 * feature.forms.nodes — Forms read nodes over the `ctx.features.forms` surface
 * (ADR 0014). Both are role:"action" (they read the tenant form/submission stores,
 * a side-effect), so the engine records their outputs and replay/fork read the
 * recorded result rather than re-querying. Pure-JS, Node-20 stdlib only.
 */

/** Resolve the Forms feature surface, or fail with the canonical capability error. */
function ensureForms(ctx) {
  const forms = ctx.features && ctx.features.forms;
  if (!forms || typeof forms.listForms !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.forms — the Forms feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.forms' },
    );
  }
  return forms;
}

function inputs(ctx) {
  const i = ctx.inputs ?? {};
  return {
    orgId: typeof i.orgId === 'string' ? i.orgId : '',
    formId: typeof i.formId === 'string' ? i.formId : '',
    submissionId: typeof i.submissionId === 'string' ? i.submissionId : '',
  };
}

export async function listForms(ctx) {
  const forms = ensureForms(ctx);
  const { orgId } = inputs(ctx);
  const out = await forms.listForms({ orgId });
  return { status: 'success', outputs: { forms: out.forms ?? [] } };
}

export async function listSubmissions(ctx) {
  const forms = ensureForms(ctx);
  const { orgId, formId } = inputs(ctx);
  const out = await forms.getSubmissions({ orgId, formId });
  return { status: 'success', outputs: { submissions: out.submissions ?? [] } };
}

/** ADR 0247 — one submission's values + the form's intake binding, PROJECTED
 *  into idea-shaped fields for the forms→priority-matrix bridge chain (forms
 *  owns the binding→idea mapping). Emits `willFile: 'yes'` only when the form
 *  has a binding AND the submission was found AND the submission is not
 *  QUARANTINED, so the chain's conditional edge cleanly no-ops for a form with
 *  no intake binding. Also passes the raw `values`/`intakeBinding`/`flagged`
 *  through for generic consumers.
 *
 *  ADR 0584 §Correction (FORM-QUAR-1) — the `flagged` refusal. A held
 *  submission is stored for a human to review and must move nothing
 *  downstream; filing it as a priority-matrix idea IS moving it downstream.
 *  Before this, the only thing stopping that was that the host never fires
 *  `host.forms.submission.created` for a held row — an absence, not a refusal,
 *  and one a tenant undoes by binding this chain to any other trigger. */
export async function getSubmission(ctx) {
  const forms = ensureForms(ctx);
  if (typeof forms.getSubmission !== 'function') {
    throw Object.assign(new Error('ctx.features.forms.getSubmission is unavailable (host too old)'), { code: 'host_capability_missing', capability: 'host.sample.forms' });
  }
  const { orgId, formId, submissionId } = inputs(ctx);
  const out = await forms.getSubmission({ orgId, formId, submissionId });
  const values = (out && out.values) || {};
  const binding = (out && out.intakeBinding) || null;
  // Only text-ish values map into idea fields; a boolean/checkbox is skipped
  // (else a checkbox title would read "true"/"false" — grade-code BE#3).
  const pick = (key) => (key && typeof values[key] === 'string' ? values[key] : '');
  const flagged = out && typeof out.flagged === 'string' ? out.flagged : '';
  const willFile = out && out.found === true && !flagged && binding && binding.listId ? 'yes' : 'no';
  // submit-idea REQUIRES a non-empty title; a blank/optional/boolean mapped
  // field must not hard-fail the run — fall back to the form title (grade-code
  // BE#2). Description is optional, so no fallback.
  const formTitle = out && typeof out.formTitle === 'string' ? out.formTitle : '';
  const title = binding ? (pick(binding.titleField) || formTitle) : '';
  const found = out ? out.found === true : false;
  return {
    status: 'success',
    outputs: {
      found,
      willFile,
      // ADR 0584 §Correction (WF-FORM-5) — the MUTUALLY EXCLUSIVE branch
      // discriminator. `willFile` is a two-valued output being asked to drive
      // three branches, so `notEquals willFile 'yes'` and `falsy found` were
      // BOTH true on a miss and the chain fired `skip` and `refuse` together.
      // It only looked correct because `stop-and-error` terminates the run —
      // i.e. the test was pinned to a resolution rule, not to the routing.
      // This host evaluates equals/notEquals/contains/truthy/falsy on chain
      // edges and has no AND, so exclusivity has to live in the VALUE.
      route: !found ? 'refuse' : willFile === 'yes' ? 'file' : 'skip',
      // idea-shaped (fed to feature.priority-matrix.nodes.submit-idea):
      listId: binding && binding.listId ? binding.listId : '',
      title,
      description: binding ? pick(binding.notesField) : '',
      orgId: (out && out.orgId) || orgId,
      sourceSubmissionId: submissionId, // ADR 0247 OQ-5 — rides the get→file edge; submit-idea stamps it on the intake overlay

      // raw (generic consumers):
      values,
      intakeBinding: binding,
      // '' on a clean row; 'honeypot' | 'guard' on a QUARANTINED one. Exposed
      // so a chain that is not this one can branch on it explicitly rather
      // than inferring "held" from `willFile:'no'`, which also means "no
      // binding" and "not found".
      flagged,
    },
  };
}

export const nodes = {
  'feature.forms.nodes.list-forms': listForms,
  'feature.forms.nodes.list-submissions': listSubmissions,
  'feature.forms.nodes.get-submission': getSubmission,
};

export default nodes;
