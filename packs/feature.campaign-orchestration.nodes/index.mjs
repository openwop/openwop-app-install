/**
 * feature.campaign-orchestration.nodes — the orchestration post-generation pipeline
 * (ADR 0158). consistency-check scores generated drafts against the brief's
 * kernel; finalize creates the MarketingCampaign from the brief (role
 * "side-effect" since ADR 0941 P5 — a fork serves its recorded outcome);
 * campaign-context reads the run's own campaign. Pure-JS, Node-20 stdlib only.
 */

/** ADR 0903 — no hard-coded vendor. A call passes the provider/model the node
 *  was given (a chain param frozen at instantiation, or a node input) and leaves
 *  the rest to the host: `ctx.callAI` fills a missing provider/model from the
 *  run's choice (`configurable.ai`), else the workspace's active AI binding, else
 *  the catalog default — resolved once at run start (host/runAiDefault.ts). */

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
 * report — unless the channel fan-out ran and every channel failed (see below).
 */
export async function consistencyCheck(ctx) {
  const i = ctx.inputs ?? {};
  const briefId = str(i.briefId);
  // ADR 0903 D8 — when the channel fan-out ran (its `dispatched` list reaches
  // this node by edge) and not one channel completed, there is nothing to score
  // and no campaign worth finalizing. Fail with the children's outcomes instead
  // of the neutral "no drafts to compare" report, which let the run complete.
  const dispatched = Array.isArray(i.dispatched) ? i.dispatched : null;
  if (dispatched && dispatched.length > 0 && !dispatched.some((d) => d && d.childStatus === 'completed')) {
    const outcomes = dispatched.map((d) => `${str(d && d.childWorkflowId) || 'unknown'}: ${str(d && d.childStatus) || 'unknown'}`).join(', ');
    return { status: 'failed', error: { code: 'channels_all_failed', message: `Every channel run failed, so there is nothing to check or finalize (${outcomes}).` } };
  }
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
        provider: str(i.provider) || undefined,
        model: str(i.model) || undefined,
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

/**
 * ADR 0941 P5 — the campaign this run belongs to. The host resolves it from the
 * run's own tag; this node passes no campaign id, so a chain cannot ask about a
 * campaign it was not started for. A run that is not a campaign run fails typed,
 * never "success with an empty campaign".
 */
export async function campaignContext(ctx) {
  const cs = ctx.features && ctx.features['campaign-orchestration'];
  if (!cs || typeof cs.campaignContext !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: "ctx.features['campaign-orchestration'].campaignContext is unavailable" } };
  }
  const out = await cs.campaignContext({});
  if (!out || !out.found) {
    const e = (out && out.error) || { code: 'campaign_not_found', message: 'No campaign for this run.' };
    return { status: 'failed', error: { code: str(e.code) || 'campaign_not_found', message: str(e.message) } };
  }
  return { status: 'success', outputs: { campaign: out.campaign, goal: out.goal ?? null, goalVersion: out.goalVersion ?? 0, role: out.role ?? null } };
}

/**
 * ADR 0942 D5 — the autonomy gate. The campaign's frozen autonomy policy decides
 * this step, host-side, from the RUN (`autonomyResolve` reads the stamp); the
 * node passes only the action class, the review stage and the risk facts, never
 * approvers. Outcomes:
 *  - legacy (unbound run, or toggle OFF with no stamp) → suspends exactly like
 *    core.approvalGate today (an open approval gate);
 *  - proceed (auto / notify-after) → success, the decision recorded in the output;
 *  - approve → suspends as an approval interrupt with role-based approvers and the
 *    host-written `autonomy` block (the inbox, quorum ledger, MCP refusal and the
 *    no-self-approval check all key on that interrupt);
 *  - blocked → typed failure `autonomy_blocked`.
 * Rejection fails the node (`autonomy_rejected`). The suspend key is constant, so
 * the resolution re-seeds the re-invoke.
 */
const APPROVER_CONFIG_KEYS = ['approverRefs', 'approverRoleRefs', 'approverGroupRefs', 'approversList', 'requiredApprovals', 'rejectionPolicy', 'overrideScopes'];

function isRejection(res) {
  return !!res && typeof res === 'object' && (res.action === 'reject' || res.decision === 'reject' || res.decision === 'rejected');
}

export async function autonomyGate(ctx) {
  const cfg = ctx.config ?? {};
  const forged = APPROVER_CONFIG_KEYS.filter((k) => cfg[k] !== undefined);
  if (forged.length > 0) {
    return { status: 'failure', retryable: false, error: { code: 'autonomy_config_approvers_refused', message: `Approvers come from the campaign's autonomy policy, never from node config (refused: ${forged.join(', ')}).` } };
  }
  const cs = ctx.features && ctx.features['campaign-orchestration'];
  if (!cs || typeof cs.autonomyResolve !== 'function') {
    throw Object.assign(new Error("host does not expose ctx.features['campaign-orchestration'].autonomyResolve (ADR 0942)"), { code: 'host_capability_missing', capability: 'host.sample.campaign-studio' });
  }
  const inputs = ctx.inputs ?? {};
  const factsKey = str(cfg.factsFrom) || 'facts';
  const facts = inputs[factsKey] && typeof inputs[factsKey] === 'object' ? inputs[factsKey] : {};
  // The content this approval binds to (a covering grant must match it, ADR 0942 P3).
  const contentHash = typeof inputs.contentHash === 'string' ? inputs.contentHash : undefined;
  const verdict = await cs.autonomyResolve({ actionClass: cfg.actionClass, ...(cfg.stage ? { stage: cfg.stage } : {}), facts, ...(contentHash ? { contentHash } : {}), vetoKey: ctx.nodeId });
  const prompt = str(cfg.prompt) || str(cfg.title) || 'Please approve to continue.';
  if (verdict.mode === 'blocked') {
    return { status: 'failure', retryable: false, error: { code: 'autonomy_blocked', message: `The campaign's autonomy policy blocks this step (${verdict.reason}; rule ${verdict.ruleId}).` } };
  }
  if (verdict.mode === 'lane_unavailable') {
    return { status: 'failure', retryable: false, error: { code: 'autonomy_lane_unavailable', message: `${verdict.actionClass} is decided by its own approval queue, which an in-run gate cannot open yet.` } };
  }
  if (verdict.mode === 'proceed') {
    return { status: 'success', outputs: { decision: verdict.outcome, ruleId: verdict.ruleId, layer: verdict.layer, policyHash: verdict.policyHash } };
  }
  // ADR 0942 P4b — a veto window is a TIMER, never an approval silence grants.
  // The step runs when the timer fires unless a notified person vetoed it. Only
  // the timer sweep may end the wait (the host refuses any other resolution of
  // an interrupt flagged `autonomy.vetoWindow`).
  if (verdict.mode === 'veto-window') {
    await ctx.suspend({
      reason: 'duration', seconds: verdict.seconds, key: 'autonomy-veto-window', prompt,
      autonomy: { vetoWindow: true, vetoId: verdict.vetoId, ...(verdict.campaignId ? { campaignId: verdict.campaignId } : {}), ruleId: verdict.ruleId, actionClass: cfg.actionClass },
    });
    if (typeof cs.autonomyVetoOutcome !== 'function') {
      throw Object.assign(new Error("host does not expose ctx.features['campaign-orchestration'].autonomyVetoOutcome (ADR 0942 P4b)"), { code: 'host_capability_missing', capability: 'host.sample.campaign-studio' });
    }
    const out = await cs.autonomyVetoOutcome({ vetoId: verdict.vetoId, ...(verdict.campaignId ? { campaignId: verdict.campaignId } : {}) });
    if (out && out.outcome === 'vetoed') {
      return { status: 'failure', retryable: false, error: { code: 'autonomy_vetoed', message: `Someone vetoed this step during its review window${out.reason ? ` (${out.reason})` : ''}.` } };
    }
    return { status: 'success', outputs: { decision: 'notify-after', vetoWindow: 'elapsed', ruleId: verdict.ruleId, layer: verdict.layer, policyHash: verdict.policyHash } };
  }
  const data = verdict.mode === 'approve' ? verdict.interruptData : {};
  const resolution = await ctx.suspend({
    kind: 'approval',
    key: 'autonomy-gate',
    prompt,
    actions: ['approve', 'reject'],
    ...data,
  });
  if (isRejection(resolution)) {
    return { status: 'failure', retryable: false, error: { code: 'autonomy_rejected', message: 'The approver rejected this step.' } };
  }
  return {
    status: 'success',
    outputs: {
      decision: 'approved',
      ...(verdict.mode === 'approve' ? { ruleId: verdict.interruptData.autonomy.ruleId, policyHash: verdict.interruptData.autonomy.policyHash } : { legacy: true }),
      resolution: resolution ?? null,
    },
  };
}


/** ADR 0942 D7 — the daily digest of notify-after steps (one notice per person per day). */
export async function autonomyDigest(ctx) {
  const cs = ctx.features && ctx.features['campaign-orchestration'];
  if (!cs || typeof cs.autonomyDigest !== 'function') {
    throw Object.assign(new Error("host does not expose ctx.features['campaign-orchestration'].autonomyDigest (ADR 0942)"), { code: 'host_capability_missing', capability: 'host.sample.campaign-studio' });
  }
  const out = await cs.autonomyDigest({});
  return { status: 'success', outputs: { recipients: out.recipients ?? 0, items: out.items ?? 0 } };
}

export const nodes = {
  'feature.campaign-orchestration.nodes.autonomy-digest': autonomyDigest,
  'feature.campaign-orchestration.nodes.autonomy-gate': autonomyGate,
  'feature.campaign-orchestration.nodes.consistency-check': consistencyCheck,
  'feature.campaign-orchestration.nodes.setup-check': setupCheck,
  'feature.campaign-orchestration.nodes.finalize': finalize,
  'feature.campaign-orchestration.nodes.campaign-context': campaignContext,
};

export default nodes;
