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

export const nodes = {
  'feature.forms.nodes.list-forms': listForms,
  'feature.forms.nodes.list-submissions': listSubmissions,
};

export default nodes;
