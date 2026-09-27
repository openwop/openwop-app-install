/**
 * feature.campaign-orchestration.nodes — the orchestration post-generation pipeline
 * (ADR 0158). consistency-check scores generated drafts against the brief's
 * kernel; finalize creates the MarketingCampaign from the brief. role:"action" —
 * outputs recorded, replay-safe. Pure-JS, Node-20 stdlib only.
 */

/** DEBT-3 — pack-local mirror of the providers.json SSoT default (the
 *  anthropic `recommended: true` model; src/providers/catalog.ts
 *  getDefaultModel). ctx.callAI REQUIRES an explicit model and standalone
 *  .mjs packs cannot import the catalog, so the default lives in this ONE
 *  greppable constant — the /refresh-model-catalog sweep updates it. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

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
  const echoScore = Math.round((echoed / drafts.length) * 100);

  // ADR 0356 P5 — blend a semantic LLM-judge leg (40%) with the deterministic
  // token echo (60%) — the exact brand-scorer pattern, degrading to
  // deterministic-only when no provider is available.
  let judgeScore = null;
  if (typeof ctx.callAI === 'function') {
    try {
      const ai = await ctx.callAI({
        provider: str(i.provider) || 'anthropic',
        model: str(i.model) || DEFAULT_MODEL,
        systemPrompt: 'You judge cross-channel campaign consistency. Given the messaging kernel and the channel drafts, score 0-100 how consistently the drafts carry the SAME core message, promise, and call to action (not word-for-word — semantically). Reply with strict JSON only.',
        messages: [{ role: 'user', content: `KERNEL:\n${JSON.stringify(kernel)}\n\nDRAFTS:\n${JSON.stringify(drafts).slice(0, 20000)}` }],
        responseSchema: { type: 'object', additionalProperties: false, required: ['score'], properties: { score: { type: 'number' }, rationale: { type: 'string' } } },
      });
      const v = ai && typeof ai === 'object' && ai.data ? Number(ai.data.score) : NaN;
      if (Number.isFinite(v)) judgeScore = Math.max(0, Math.min(100, Math.round(v)));
    } catch { /* judge optional — deterministic leg stands alone */ }
  }
  const score = judgeScore === null ? echoScore : Math.round(echoScore * 0.6 + judgeScore * 0.4);
  const dimensions = [{ name: 'kernelEcho', score: echoScore, description: `${echoed}/${drafts.length} drafts echo the kernel.` }];
  if (judgeScore !== null) dimensions.push({ name: 'semanticJudge', score: judgeScore, description: 'LLM-judged semantic consistency (40% of the blend).' });
  return {
    status: 'success',
    outputs: { report: { score, dimensions, divergences, passesThreshold: score >= 80, checkedAt: new Date().toISOString() } },
  };
}

/** ADR 0356 P4 — the setup gate check (the CS-008 assetDecisionGate semantic,
 *  composed — no engine primitive): reports which campaign assets the brief
 *  still lacks (brand / personas / kb). A brief carrying the refs AUTO-RESOLVES
 *  (missing: []) — campaign #2 sails through; the spine's optional approval
 *  gate prompts only when something is missing. */
export async function setupCheck(ctx) {
  const i = ctx.inputs ?? {};
  const cb = ctx.features && ctx.features['campaign-brief'];
  if (!cb || typeof cb.getBrief !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-brief surface unavailable' } };
  }
  const b = await cb.getBrief({ briefId: str(i.briefId) });
  if (!b || !b.brief) return { status: 'failed', error: { code: 'brief_not_found', message: `Brief not found: ${str(i.briefId)}` } };
  const brief = b.brief;
  const missing = [];
  if (!brief.brandId) missing.push({ slot: 'brand', hint: 'Bind a brand so voice + guardrails apply.' });
  if (!Array.isArray(brief.personaIds) || brief.personaIds.length === 0) missing.push({ slot: 'persona', hint: 'Pick at least one persona to target.' });
  if (!brief.kbCollectionId) missing.push({ slot: 'kb', hint: 'Bind a knowledge collection so generation is grounded.' });
  return { status: 'success', outputs: { missing, ready: missing.length === 0, prompt: missing.length === 0 ? 'All campaign assets are bound.' : `Missing setup: ${missing.map((x) => x.slot).join(', ')} — use existing assets or create them, then re-run.` } };
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
  'feature.campaign-orchestration.nodes.setup-check': setupCheck,
  'feature.campaign-orchestration.nodes.finalize': finalize,
};

export default nodes;
