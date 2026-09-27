/**
 * feature.webinars.nodes — Zoom webinar connector nodes (ADR 0404 §a). Compose
 * ctx.features.webinars (the broker-backed adapter surface). role:"action".
 * Pure-JS, Node-20 stdlib only.
 */

function ensureWebinars(ctx) {
  const w = ctx.features && ctx.features.webinars;
  if (!w || typeof w.registerRegistrant !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.webinars (ADR 0404) — the feature must be composed'),
      // R2 WB-SP-4 — this named a nonexistent `host.sample.webinars` capability.
      { code: 'host_capability_missing', capability: 'host.webinars' },
    );
  }
  return w;
}

const str = (v) => (typeof v === 'string' ? v : '');

export async function register(ctx) {
  const w = ensureWebinars(ctx);
  const i = ctx.inputs ?? {};
  const orgId = str(i.orgId);
  const webinarId = str(i.webinarId);
  const email = str(i.email);
  if (!orgId || !webinarId || !email) {
    return { status: 'failed', error: { code: 'validation_error', message: 'orgId, webinarId, and email are required.' } };
  }
  const out = await w.registerRegistrant({ orgId, webinarId, email, ...(str(i.name) ? { name: str(i.name) } : {}) });
  // The local CRM `registered` activity is always recorded, but the NODE reflects
  // the provider push outcome so a workflow's default fail branch reacts to a
  // dropped Zoom registration (the outputs still carry the detail).
  if (out && out.success === false) {
    return { status: 'failed', error: { code: 'provider_push_failed', message: `Zoom registrant push failed: ${out.error || 'unknown'}` }, outputs: out };
  }
  return { status: 'success', outputs: out };
}

export async function sync(ctx) {
  const w = ensureWebinars(ctx);
  if (typeof w.syncEvent !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'ctx.features.webinars.syncEvent unavailable on this host.' } };
  }
  const i = ctx.inputs ?? {};
  const orgId = str(i.orgId);
  const eventId = str(i.eventId);
  if (!orgId || !eventId) {
    return { status: 'failed', error: { code: 'validation_error', message: 'orgId and eventId are required.' } };
  }
  const out = await w.syncEvent({ orgId, eventId });
  // R2 WB-SP-4 — the sibling `register` node maps a surface failure to a node
  // failure; this one returned success-on-error, so a workflow's fail branch
  // never fired for a broken sync.
  if (out && (out.success === false || out.outcome === 'error')) {
    return { status: 'failed', error: { code: 'sync_failed', message: `Webinar sync failed: ${out.error || out.reason || 'unknown'}` }, outputs: out };
  }
  return { status: 'success', outputs: out };
}

export const nodes = {
  'feature.webinars.nodes.register': register,
  'feature.webinars.nodes.sync': sync,
};

export default nodes;
