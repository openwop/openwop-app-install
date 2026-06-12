/**
 * feature.consent.nodes — Consent gate/record nodes over the `ctx.features.consent`
 * surface (ADR 0014). Both are role:"action" (they read/write the tenant consent
 * store, a side-effect), so the engine records their outputs and replay/fork read
 * the recorded result. The SAME isAllowed/record helper Analytics/Email consume —
 * one consent rule. Pure-JS, Node-20 stdlib only.
 */

function ensureConsent(ctx) {
  const consent = ctx.features && ctx.features.consent;
  if (!consent || typeof consent.isAllowed !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.consent — the Consent feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.consent' },
    );
  }
  return consent;
}

function inputs(ctx) {
  const i = ctx.inputs ?? {};
  return {
    subjectKey: typeof i.subjectKey === 'string' ? i.subjectKey : '',
    category: typeof i.category === 'string' ? i.category : 'analytics',
    categories: typeof i.categories === 'object' && i.categories !== null ? i.categories : {},
  };
}

export async function check(ctx) {
  const consent = ensureConsent(ctx);
  const { subjectKey, category } = inputs(ctx);
  const out = await consent.isAllowed({ subjectKey, category });
  return { status: 'success', outputs: { allowed: out.allowed === true, category } };
}

export async function record(ctx) {
  const consent = ensureConsent(ctx);
  const { subjectKey, categories } = inputs(ctx);
  const out = await consent.record({ subjectKey, categories });
  return { status: 'success', outputs: { categories: out.categories } };
}

export const nodes = {
  'feature.consent.nodes.check': check,
  'feature.consent.nodes.record': record,
};

export default nodes;
