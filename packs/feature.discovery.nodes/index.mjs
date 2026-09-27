/**
 * feature.discovery.nodes — MERCH-C nodes over `ctx.features.discovery` (ADR 0275 /
 * ADR 0058). `search` reads the mutable catalog ⇒ role:"action" recorded; the two
 * upserts author collections / merch-rules (no money, reversible ⇒ direct). All
 * role:"action". Pure-JS, Node-20 stdlib only. Calls the SAME service the REST route calls.
 */
function ensureDisc(ctx) {
  const s = ctx.features && ctx.features.discovery;
  if (!s || typeof s.search !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.features.discovery — the discovery feature must be composed (ADR 0275)'), { code: 'host_capability_missing', capability: 'host.discovery' });
  }
  return s;
}
const merged = (ctx) => ({ ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) });

export async function search(ctx) {
  const s = ensureDisc(ctx);
  const i = merged(ctx);
  if (!i.orgId) throw Object.assign(new Error('search requires `orgId`'), { code: 'validation_error' });
  return { status: 'success', outputs: await s.search(i) };
}

export async function collectionUpsert(ctx) {
  const s = ensureDisc(ctx);
  const i = merged(ctx);
  if (!i.orgId || !i.name || !i.type) throw Object.assign(new Error('collection-upsert requires `orgId`, `name`, `type`'), { code: 'validation_error' });
  return { status: 'success', outputs: await s.createCollection(i) };
}

export async function merchRuleUpsert(ctx) {
  const s = ensureDisc(ctx);
  const i = merged(ctx);
  if (!i.orgId || !i.name || !Array.isArray(i.actions) || i.actions.length === 0) throw Object.assign(new Error('merch-rule-upsert requires `orgId`, `name`, and a non-empty `actions` array'), { code: 'validation_error' });
  return { status: 'success', outputs: await s.createMerchRule(i) };
}

export const nodes = {
  'feature.discovery.nodes.search': search,
  'feature.discovery.nodes.collection-upsert': collectionUpsert,
  'feature.discovery.nodes.merch-rule-upsert': merchRuleUpsert,
};
export default nodes;
