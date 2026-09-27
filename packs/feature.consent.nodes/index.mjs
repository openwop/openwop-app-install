/**
 * feature.consent.nodes — Consent gate/record nodes over the `ctx.features.consent`
 * surface (ADR 0014). `record` is role:"side-effect" + `side-effectful` (it writes
 * the tenant consent store), so the engine serves its recorded outcome on
 * replay/fork; `check` is role:"read" and RE-EXECUTES — a gate verdict is live by
 * design (ADR 0657 D3; the old docblock claimed both were served, and neither was).
 * The SAME isAllowed/record helper Analytics/Email consume —
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

/**
 * WHERE THE ARGUMENTS COME FROM (`WF-CONS-3`, the Path-A half).
 *
 * Both nodes read `ctx.inputs` and NOTHING else. But RFC 0013 **Path A** — the
 * `…/workflows/from-chain` default — freezes a chain's `{{params.subjectKey}}`
 * into EITHER `config` OR `inputs`, depending on where the author put the token
 * (`workflowChainPackLoader.ts`, `mentions(n.config,p) || mentions(n.inputs,p)`).
 * So a subject bound in `config` never arrived and the gate silently evaluated
 * the empty subject — the `WF-ANL-1` / `WF-CMNT-3` defect, here composing with
 * the fabrication below into a `success`-wrapped `allowed:true`.
 *
 * The merged-args contract is the corpus idiom (`feature.crm.nodes` has always
 * honoured it; `feature.analytics.nodes` and `feature.comments.nodes` were fixed
 * to it). INPUTS WIN ON CONFLICT: a DAG-forwarded value is a runtime fact, a
 * config value an authoring-time default.
 */
function args(ctx) {
  return { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
}

/**
 * NO COERCION HERE (`WF-CONS-3`).
 *
 * This used to read `typeof i.subjectKey === 'string' ? i.subjectKey : ''` and
 * `typeof i.category === 'string' ? i.category : 'analytics'`. Both defaults
 * MANUFACTURED an argument the caller never supplied, and the surface then
 * answered a verdict over it: an absent subject missed every record and fell to
 * the tenant's `defaultMode`, so on an opt-out tenant an unidentified person
 * came back `allowed:true` — as a `status:'success'`, indistinguishable from a
 * real grant. Values are passed through verbatim; `surface.ts` validates them
 * and throws a typed `validation_error` naming the offending field.
 */
function inputs(ctx) {
  const i = args(ctx);
  return { subjectKey: i.subjectKey, category: i.category, categories: i.categories };
}

export async function check(ctx) {
  const consent = ensureConsent(ctx);
  const { subjectKey, category } = inputs(ctx);
  const out = await consent.isAllowed({ subjectKey, category });
  return { status: 'success', outputs: { allowed: out.allowed === true, category: out.category } };
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
