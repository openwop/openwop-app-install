/**
 * feature.campaign-brief.nodes — Personas & Campaign Brief nodes (ADR 0156).
 * All role:"action" so the engine records outputs (replay/fork read the recorded
 * kernel rather than re-generating). Pure-JS, Node-20 stdlib only.
 *
 * generate-kernel composes THREE surfaces: the brief context (ctx.features
 * ['campaign-brief'].assembleContext), the brand voice (ctx.features.brand.
 * resolveVoice, ADR 0155), and the KB grounding (ctx.features.kb.rag, ADR 0011)
 * — then calls the run-scoped ctx.callAI for the kernel and persists it.
 */

function ensureBrief(ctx) {
  const cb = ctx.features && ctx.features['campaign-brief'];
  if (!cb || typeof cb.assembleContext !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['campaign-brief'] — the Campaign Brief feature must be composed (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.campaign-brief' },
    );
  }
  return cb;
}

function str(v) { return typeof v === 'string' ? v : ''; }
function strArr(v) { return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }

export async function validate(ctx) {
  const cb = ensureBrief(ctx);
  const i = ctx.inputs ?? {};
  const out = await cb.validateBrief({ briefId: str(i.briefId) });
  return { status: 'success', outputs: { valid: out.valid === true, issues: out.issues ?? [], enabledChannels: out.enabledChannels ?? [] } };
}

export async function generateKernel(ctx) {
  const cb = ensureBrief(ctx);
  const i = ctx.inputs ?? {};
  const briefId = str(i.briefId);

  // 1) Brief-owned context (product + audience + messaging).
  const asm = await cb.assembleContext({ briefId });
  if (!asm.found) {
    return { status: 'failed', error: { code: 'brief_not_found', message: `Brief not found: ${briefId}` } };
  }
  const brief = asm.brief ?? {};
  const orgId = str(brief.orgId);

  // 2) Brand voice leg (optional — composes ctx.features.brand, ADR 0155).
  let voiceBlock = '';
  const brand = ctx.features && ctx.features.brand;
  if (brief.brandId && brand && typeof brand.resolveVoice === 'function') {
    try {
      const v = await brand.resolveVoice({ brandId: str(brief.brandId) });
      if (v && typeof v.voice === 'string') voiceBlock = v.voice;
    } catch { /* brand optional — proceed without */ }
  }

  // 3) KB grounding leg (optional — composes ctx.features.kb.rag, ADR 0011).
  let grounding = '';
  let sourceDocIds = [];
  const kb = ctx.features && ctx.features.kb;
  if (brief.kbCollectionId && kb && typeof kb.rag === 'function') {
    try {
      const query = `${str(brief.productName)} ${str(brief.industryVertical)} value proposition proof points`.trim();
      const r = await kb.rag({ orgId, collectionId: str(brief.kbCollectionId), query, topK: 6 });
      if (r && typeof r.augmentedPrompt === 'string') grounding = r.augmentedPrompt;
      if (r && Array.isArray(r.citations)) {
        sourceDocIds = r.citations.map((c) => (c && typeof c.docId === 'string' ? c.docId : null)).filter(Boolean);
      }
    } catch { /* KB optional — proceed ungrounded */ }
  }

  // 4) Generate the kernel with the run-scoped provider.
  if (typeof ctx.callAI !== 'function') {
    return { status: 'failed', error: { code: 'capability_missing', message: 'host does not expose ctx.callAI' } };
  }
  const systemPrompt =
    'You are a senior marketing strategist. From the CAMPAIGN CONTEXT, BRAND VOICE, and grounded KNOWLEDGE, produce the messaging kernel — the single strategic foundation every channel will echo. Ground every claim in the provided knowledge; do not invent proof points. Reply with strict JSON only.';
  const userParts = [`CAMPAIGN CONTEXT:\n${str(asm.contextText)}`];
  if (voiceBlock) userParts.push(`BRAND VOICE:\n${voiceBlock}`);
  if (grounding) userParts.push(`GROUNDED KNOWLEDGE:\n${grounding}`);

  let data;
  try {
    const ai = await ctx.callAI({
      provider: str(i.provider) || 'anthropic',
      model: str(i.model) || 'claude-sonnet-4-6',
      systemPrompt,
      messages: [{ role: 'user', content: userParts.join('\n\n') }],
      responseSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['headline', 'supportingStatement', 'proofPoints', 'primaryCta', 'tone'],
        properties: {
          headline: { type: 'string' },
          supportingStatement: { type: 'string' },
          proofPoints: { type: 'array', items: { type: 'string' } },
          primaryCta: { type: 'string' },
          secondaryCta: { type: 'string' },
          tone: { type: 'string' },
        },
      },
    });
    data = ai && typeof ai === 'object' ? ai.data : undefined;
  } catch (e) {
    return { status: 'failed', error: { code: 'generation_failed', message: e instanceof Error ? e.message : 'kernel generation failed' } };
  }
  if (!data || typeof data !== 'object' || typeof data.headline !== 'string') {
    return { status: 'failed', error: { code: 'generation_empty', message: 'The provider returned no kernel.' } };
  }

  const kernel = {
    headline: str(data.headline),
    supportingStatement: str(data.supportingStatement),
    proofPoints: strArr(data.proofPoints),
    primaryCta: str(data.primaryCta),
    secondaryCta: str(data.secondaryCta),
    tone: str(data.tone),
    channelTones: {},
    sourceDocIds,
    // Recorded in the node output → replay/fork reads this verbatim (role:action).
    generatedAt: new Date().toISOString(),
  };

  // 5) Persist on the brief (clears stale, advances status to validated).
  await cb.setKernel({ briefId, kernel });
  return { status: 'success', outputs: { kernel } };
}

export const nodes = {
  'feature.campaign-brief.nodes.validate': validate,
  'feature.campaign-brief.nodes.generate-kernel': generateKernel,
};

export default nodes;
