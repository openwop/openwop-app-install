/**
 * feature.campaign-connectors.nodes — CSV import + live sync (ADR 0159).
 * import-csv composes ctx.features['campaign-connectors'].importCsv; sync is
 * honest-off (connector_not_configured) until the Connections broker reach is
 * wired (ADR 0037 day-1 matrix). role:"action". Pure-JS, Node-20 stdlib only.
 */

function ensureConnectors(ctx) {
  const cc = ctx.features && ctx.features['campaign-connectors'];
  if (!cc || typeof cc.importCsv !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['campaign-connectors'] — the feature must be composed (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.campaign-connectors' },
    );
  }
  return cc;
}

function str(v) { return typeof v === 'string' ? v : ''; }

export async function importCsv(ctx) {
  const cc = ensureConnectors(ctx);
  const i = ctx.inputs ?? {};
  const out = await cc.importCsv({
    orgId: str(i.orgId), csv: str(i.csv),
    ...(i.defaultPlatform ? { defaultPlatform: str(i.defaultPlatform) } : {}),
    ...(i.campaignId ? { campaignId: str(i.campaignId) } : {}),
  });
  return { status: 'success', outputs: out };
}

export async function sync(ctx) {
  ensureConnectors(ctx);
  const i = ctx.inputs ?? {};
  const platform = str(i.platform);
  // Honest-off (ADR 0037): the live broker reach for ad platforms is deploy-gated.
  // The connection packs are loaded; the actual pull is not yet wired. Fail with a
  // structured, advertised reason rather than pretending to sync.
  return {
    status: 'failed',
    error: {
      code: 'connector_not_configured',
      message: `Live ${platform || 'ad-platform'} sync is not configured on this host. Import a CSV export, or wire the Connections broker reach (ADR 0037).`,
    },
  };
}

export const nodes = {
  'feature.campaign-connectors.nodes.import-csv': importCsv,
  'feature.campaign-connectors.nodes.sync': sync,
};

export default nodes;
