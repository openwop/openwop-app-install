/**
 * feature.campaign-orchestration.nodes — the orchestration post-generation pipeline
 * (ADR 0158). consistency-check scores generated drafts against the brief's
 * kernel; finalize creates the MarketingCampaign from the brief. role:"action" —
 * outputs recorded, replay-safe. Pure-JS, Node-20 stdlib only.
 */

function ensureStudio(ctx) {
  const cs = ctx.features && ctx.features['campaign-orchestration'];
  if (!cs || typeof cs.finalizeFromBrief !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['campaign-orchestration'] — Campaign Studio must be composed (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.campaign-studio' },
    );
  }
  return cs;
}

function str(v) { return typeof v === 'string' ? v : ''; }

/**
 * Deterministic cross-asset consistency: each draft should echo the kernel's
 * headline keywords + primary CTA. Score = fraction of drafts that do. When no
 * drafts are supplied (the workflow path before a gather step), returns a neutral
 * report so the pipeline never blocks.
 */
export async function consistencyCheck(ctx) {
  const i = ctx.inputs ?? {};
  const briefId = str(i.briefId);
  const cb = ctx.features && ctx.features['campaign-brief'];

  let kernel = null;
  if (cb && typeof cb.getBrief === 'function') {
    try { const b = await cb.getBrief({ briefId }); kernel = b && b.brief ? b.brief.kernel : null; } catch { /* optional */ }
  }
  const drafts = Array.isArray(i.drafts) ? i.drafts : [];
  if (!kernel || drafts.length === 0) {
    return { status: 'success', outputs: { report: { score: 100, dimensions: [], divergences: [], passesThreshold: true, checkedAt: new Date().toISOString(), note: 'no drafts to compare' } } };
  }

  const kernelTokens = `${str(kernel.headline)} ${str(kernel.primaryCta)} ${(Array.isArray(kernel.proofPoints) ? kernel.proofPoints.join(' ') : '')}`
    .toLowerCase().split(/\W+/).filter((w) => w.length > 4);
  const divergences = [];
  let echoed = 0;
  for (const d of drafts) {
    const text = JSON.stringify(d ?? {}).toLowerCase();
    const hit = kernelTokens.some((tok) => text.includes(tok));
    if (hit) echoed += 1;
    else divergences.push({ channel: str(d && d.channel) || 'unknown', severity: 'medium', description: 'Draft does not visibly echo the kernel headline/CTA/proof points.' });
  }
  const score = Math.round((echoed / drafts.length) * 100);
  return {
    status: 'success',
    outputs: { report: { score, dimensions: [{ name: 'kernelEcho', score, description: `${echoed}/${drafts.length} drafts echo the kernel.` }], divergences, passesThreshold: score >= 80, checkedAt: new Date().toISOString() } },
  };
}

export async function finalize(ctx) {
  const cs = ensureStudio(ctx);
  const i = ctx.inputs ?? {};
  const out = await cs.finalizeFromBrief({ briefId: str(i.briefId), createdBy: str(i.createdBy) });
  if (!out.found) return { status: 'failed', error: { code: 'brief_not_found', message: `Brief not found: ${str(i.briefId)}` } };
  // ADR 0161 — also emit the `canvas.campaign` artifact (registered by the canvas
  // campaign-studio feature, ADR 0153) so the finalized campaign renders inline in
  // chat. Best-effort: if the type isn't registered the host ignores the output.
  const artifact = campaignToCanvas(out.campaign);
  return { status: 'success', outputs: { campaign: out.campaign, ...(artifact ? { artifact } : {}) } };
}

/** ADR 0161 — map my 5 channel types onto the canvas.campaign channel enum. */
const CANVAS_CHANNEL_TYPE = {
  landing_page: 'content', ad_variants: 'display', email_sequence: 'email', creative_briefs: 'content', social_posts: 'social',
};
const CHANNEL_LABEL = {
  landing_page: 'Landing page', ad_variants: 'Ad variants', email_sequence: 'Email sequence', creative_briefs: 'Creative briefs', social_posts: 'Social posts',
};
const clip = (v, n) => str(v).slice(0, n);

/** Pure: build the `canvas.campaign` artifact (ADR 0153 shape) from a finalized
 *  MarketingCampaign + its kernel. Returns null when there are no channels (the
 *  canvas schema requires ≥1). */
function campaignToCanvas(campaign) {
  if (!campaign || typeof campaign !== 'object') return null;
  const chans = Array.isArray(campaign.channels) ? campaign.channels : [];
  const channels = chans.map((c) => ({ name: CHANNEL_LABEL[c] || str(c), type: CANVAS_CHANNEL_TYPE[c] || 'content' }));
  if (channels.length === 0) return null;
  const name = clip(campaign.name, 200) || 'Campaign';
  const kernel = campaign.kernel && typeof campaign.kernel === 'object' ? campaign.kernel : null;
  const payload = { name, channels };
  if (campaign.objective) payload.objective = clip(campaign.objective, 600);
  if (kernel) {
    payload.assets = chans.map((c) => ({
      channel: CHANNEL_LABEL[c] || str(c),
      format: str(c),
      headline: clip(kernel.headline, 240),
      body: clip(kernel.supportingStatement, 2000),
      cta: clip(kernel.primaryCta, 120),
    }));
    payload.funnel = [
      { stage: 'awareness', description: clip(kernel.supportingStatement, 600) },
      { stage: 'conversion', description: clip(kernel.primaryCta, 600), kpis: (Array.isArray(kernel.proofPoints) ? kernel.proofPoints : []).slice(0, 8).map((p) => clip(p, 120)) },
    ];
  }
  return { artifactTypeId: 'canvas.campaign', payload, title: name };
}

export const nodes = {
  'feature.campaign-orchestration.nodes.consistency-check': consistencyCheck,
  'feature.campaign-orchestration.nodes.finalize': finalize,
};

export default nodes;
