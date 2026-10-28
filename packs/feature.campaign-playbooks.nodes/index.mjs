/**
 * Campaign playbooks node pack (ADR 0959 matrix row 4) — READ-ONLY reads of a client's
 * playbook installation, over ctx.features['campaign-playbooks']. Ring advancement is not a node
 * in v1 (ADR 0959 OQ4): rollouts are human-initiated.
 */

function str(v) { return typeof v === 'string' ? v : ''; }

function ensurePlaybooks(ctx) {
  const s = ctx.features && ctx.features['campaign-playbooks'];
  if (!s || typeof s.getInstallation !== 'function') {
    throw Object.assign(new Error("host surface ctx.features['campaign-playbooks'] missing (campaign-playbooks toggle off?)"), {
      code: 'host_capability_missing', capability: 'features.campaign-playbooks',
    });
  }
  return s;
}

/** Which version of a playbook this client runs, its ring, and its install history.
 *  Inputs: { orgId, playbookId }. Output: { installed, version?, ring?, ... }. */
export async function readInstallation(ctx) {
  const s = ensurePlaybooks(ctx);
  const i = ctx.inputs ?? {};
  if (!str(i.orgId) || !str(i.playbookId)) return { status: 'failed', error: { code: 'validation_error', message: 'orgId and playbookId are required.' } };
  return { status: 'success', outputs: await s.getInstallation({ orgId: str(i.orgId), playbookId: str(i.playbookId) }) };
}

/** The values this client's installation runs with: defaults, then the agency's, then the
 *  client's, and its slot bindings. Inputs: { orgId, playbookId }. Output: { version, params, slots }. */
export async function effectiveConfig(ctx) {
  const s = ensurePlaybooks(ctx);
  const i = ctx.inputs ?? {};
  if (!str(i.orgId) || !str(i.playbookId)) return { status: 'failed', error: { code: 'validation_error', message: 'orgId and playbookId are required.' } };
  return { status: 'success', outputs: await s.effectiveConfig({ orgId: str(i.orgId), playbookId: str(i.playbookId) }) };
}

export const nodes = {
  'feature.campaign-playbooks.nodes.read-installation': readInstallation,
  'feature.campaign-playbooks.nodes.effective-config': effectiveConfig,
};
export default nodes;
