/**
 * feature.profiles.nodes — ctx.features.profiles reads (NP-STALE-PROFILES-1;
 * ADR 0624 D1 — `get` made honest on both halves).
 *
 * `get` sends `{ userId }` (the key the surface reads — 1.0.0 sent `profileId`,
 * which `surfaceStr` coerced to `''` and the surface answered `null` for, so the
 * node reported `success` with `profile: null` for EVERY input, `UPWF-1`). The
 * surface now REFUSES an empty id with a typed `validation_error`; the node
 * forwards that as a `status:'failure'` carrying the surface's code (the
 * `feature.crm.nodes` shape the executor passes through verbatim), never as a
 * success-with-empty. A REAL-id miss is an explicit empty: `{ profile: null,
 * found: false }`, so a chain branches on `{ falsy found }`.
 */
function ensure(ctx, id, method) {
  const s = ctx.features && ctx.features[id];
  if (!s || typeof s[method] !== 'function') {
    throw Object.assign(
      new Error(`host does not expose ctx.features.${id}.${method} — the feature must be composed (ADR 0014)`),
      { code: 'host_capability_missing', capability: `host.sample.${id}` },
    );
  }
  return s;
}

/** A surface refusal is a TYPED node failure (its own code), never a success.
 *  ADR 0888 D3 — `forbidden_scope` too: a run with no acting user, an API key,
 *  a disabled user or a non-member is refused by the SAME directory resolver the
 *  `/profiles` route uses, and the reason rides `error.details.reason`. */
const REFUSALS = new Set(['validation_error', 'forbidden_scope']);
function isTypedRefusal(err) {
  return Boolean(err) && typeof err === 'object' && typeof err.code === 'string' && REFUSALS.has(err.code);
}
function refusal(err) {
  const reason = err && err.details && typeof err.details.reason === 'string' ? err.details.reason : undefined;
  return { status: 'failure', error: { code: err.code, message: err.message, ...(reason ? { details: { reason } } : {}) } };
}

export async function list(ctx) {
  const p = ensure(ctx, 'profiles', 'listProfiles');
  let out;
  try {
    out = await p.listProfiles({});
  } catch (err) {
    if (isTypedRefusal(err)) return refusal(err);
    throw err;
  }
  return { status: 'success', outputs: { profiles: out.profiles ?? [], ...(out.truncated ? { truncated: true } : {}) } };
}
export async function get(ctx) {
  const p = ensure(ctx, 'profiles', 'getProfile');
  const inputs = ctx.inputs ?? {};
  let out;
  try {
    out = await p.getProfile({ userId: inputs.userId });
  } catch (err) {
    if (isTypedRefusal(err)) return refusal(err);
    throw err;
  }
  return { status: 'success', outputs: { profile: out.profile ?? null, found: out.found === true } };
}
export const nodes = {
  'feature.profiles.nodes.list': list,
  'feature.profiles.nodes.get': get,
};
export default nodes;
