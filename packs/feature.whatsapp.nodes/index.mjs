/**
 * feature.whatsapp.nodes — the governed WhatsApp send node (ADR 0394 Phase 1)
 * over the `ctx.features.whatsapp` surface. The node carries NO credential and
 * NO compliance logic: consent, the 24h window, template discipline, and the
 * fork-stable dispatch ledger all live in the host service behind the surface
 * (the capability firewall cannot see node calls, so gates never live here).
 * role:"action" + sideEffecting — replay/fork read the recorded outcome.
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
    ...(inputs.templateVariables && typeof inputs.templateVariables === 'object'
      ? { templateVariables: inputs.templateVariables }
      : {}),
  });
  return {
    status: 'success',
    outputs: {
      sent: out.sent === true,
      providerSid: out.providerSid ?? null,
      kind: out.kind ?? null,
      deduped: out.deduped === true,
    },
  };
}

export const nodes = {
  'feature.whatsapp.nodes.send': send,
};

export default nodes;
