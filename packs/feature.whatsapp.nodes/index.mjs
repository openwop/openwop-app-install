/**
 * feature.whatsapp.nodes — the governed WhatsApp send node (ADR 0394 Phase 1)
 * over the `ctx.features.whatsapp` surface. The node carries NO credential and
 * NO compliance logic: consent, the 24h window, template discipline, and the
 * fork-stable dispatch ledger all live in the host service behind the surface
 * (the capability firewall cannot see node calls, so gates never live here).
 * role:"action" + sideEffecting — replay/fork read the recorded outcome.
 * ADR 1053 D3 — a send reports what is KNOWN: the BSP accepted it
 * (`accepted`, `deliveryStatus: "accepted"`; `sent` is kept as an alias).
 * Delivery comes later, from verified provider callbacks, through the
 * `delivery-status` read node.
 * Pure-JS, Node-20 stdlib only.
 */

function ensureWhatsApp(ctx) {
  const wa = ctx.features && ctx.features.whatsapp;
  if (!wa || typeof wa.send !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.whatsapp — the WhatsApp feature must be composed (ADR 0394)'),
      { code: 'host_capability_missing', capability: 'host.sample.whatsapp' },
    );
  }
  return wa;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export async function send(ctx) {
  const wa = ensureWhatsApp(ctx);
  const inputs = ctx.inputs && typeof ctx.inputs === 'object' ? ctx.inputs : {};
  const out = await wa.send({
    connectionId: str(inputs.connectionId) ?? '',
    to: str(inputs.to) ?? '',
    ...(str(inputs.body) ? { body: str(inputs.body) } : {}),
    ...(str(inputs.templateId) ? { templateId: str(inputs.templateId) } : {}),
    ...(str(inputs.languageCode) ? { languageCode: str(inputs.languageCode) } : {}),
    ...(inputs.templateVariables && typeof inputs.templateVariables === 'object'
      ? { templateVariables: inputs.templateVariables }
      : {}),
  });
  return {
    status: 'success',
    outputs: {
      accepted: out.sent === true,
      /** @deprecated alias of `accepted` — the BSP took it; it is not "delivered". */
      sent: out.sent === true,
      deliveryStatus: out.deliveryStatus ?? 'accepted',
      providerSid: out.providerSid ?? null,
      kind: out.kind ?? null,
      deduped: out.deduped === true,
    },
  };
}

/** ADR 1053 D3 — what the provider has reported for one sent message. A READ:
 *  it re-executes on replay/fork (delivery is live state). An unknown id is the
 *  surface's typed not_found, never a fabricated status. */
export async function deliveryStatus(ctx) {
  const wa = ensureWhatsApp(ctx);
  if (typeof wa.deliveryStatus !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.features.whatsapp.deliveryStatus (ADR 1053)'), { code: 'host_capability_missing', capability: 'host.sample.whatsapp' });
  }
  const inputs = ctx.inputs && typeof ctx.inputs === 'object' ? ctx.inputs : {};
  const out = await wa.deliveryStatus({ connectionId: str(inputs.connectionId) ?? '', providerSid: str(inputs.providerSid) ?? '' });
  return {
    status: 'success',
    outputs: {
      providerSid: out.providerSid,
      status: out.status,
      errorCode: out.errorCode ?? null,
      updatedAt: out.updatedAt ?? null,
    },
  };
}

export const nodes = {
  'feature.whatsapp.nodes.send': send,
  'feature.whatsapp.nodes.delivery-status': deliveryStatus,
};

export default nodes;
