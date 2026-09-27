/**
 * feature.campaign-channels.nodes — Campaign Studio channel generation (ADR 0157).
 * ONE parameterized `generate` node (the MyndHyve channelWorkflowFactory pattern:
 * the per-channel difference is the prompt + schema, not the executor) + a
 * `content.quality.check` node. role:"action" so drafts are recorded → replay-safe.
 * Pure-JS, Node-20 stdlib only.
 *
 * generate composes the brief context + kernel (ctx.features['campaign-brief'].
 * assembleContext, ADR 0156), the brand voice (ctx.features.brand, ADR 0155), and
 * the KB grounding (ctx.features.kb.rag, ADR 0011), then calls the run-scoped
 * ctx.callAI with the channel-specific system prompt + responseSchema.
 */

/** DEBT-3 — pack-local mirror of the providers.json SSoT default (the
 *  anthropic `recommended: true` model; src/providers/catalog.ts
 *  getDefaultModel). ctx.callAI REQUIRES an explicit model and standalone
 *  .mjs packs cannot import the catalog, so the default lives in this ONE
 *  greppable constant — the /refresh-model-catalog sweep updates it. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function ensureBrief(ctx) {
  const cb = ctx.features && ctx.features['campaign-brief'];
  if (!cb || typeof cb.assembleContext !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['campaign-brief'] — Campaign Brief must be composed (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.campaign-brief' },
    );
  }
  return cb;
}

function str(v) { return typeof v === 'string' ? v : ''; }

import {
  PLATFORM_LIMITS, AD_FIELD_SCHEMA_MAX, validateAdVariants, validateSocialPosts, truncateAt,
  findNearDuplicates, readabilityBand, findUnsupportedClaims, verifyClaims, ITERATION_OPS,
} from './platformLimits.mjs';

const CHANNELS = ['landing_page', 'ad_variants', 'email_sequence', 'creative_briefs', 'social_posts'];

/** KB-CODE-2 — strict-mode retrieval floor for kb.rag grounding (mirrors the
 *  campaign-brief pack's kernel-node default): under `groundingPolicy:'strict'`
 *  a chunk below this score is not honest coverage. */
const STRICT_MIN_SCORE = 0.25;

// ── per-channel system prompt + responseSchema (the five MyndHyve shapes) ──
// Exported for the table↔schema parity test (QA-CODE-5): the ad_variants schema
// maxLengths are BUILT from AD_FIELD_SCHEMA_MAX, never hand-copied numbers.
const CITATION = 'Cite every factual claim with a [src_N] marker drawn ONLY from the grounded knowledge — never invent proof points.';
export const CHANNEL_SPEC = {
  landing_page: {
    system: `You write a conversion landing page from the messaging kernel. Sections: hero, features, how_it_works, social_proof, faq, cta. ${CITATION} Reply with strict JSON only.`,
    schema: { type: 'object', additionalProperties: false, required: ['title', 'sections'], properties: {
      title: { type: 'string' }, metaDescription: { type: 'string' },
      sections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'heading', 'body'], properties: { type: { type: 'string' }, heading: { type: 'string' }, body: { type: 'string' }, ctaText: { type: 'string' } } } },
      citations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { docId: { type: 'string' }, marker: { type: 'string' } } } },
    } },
    itemsKey: null,
  },
  ad_variants: {
    // QA-CODE-6: every platform in PLATFORM_LIMITS is solicited (TikTok was
    // validated but never asked for).
    system: `You write ad variants from the kernel, one platform set per requested platform (Google, Meta, LinkedIn, TikTok). HARD character limits (chars): ${Object.entries(PLATFORM_LIMITS).map(([p, l]) => `${p}: headline ${l.headline}, description ${l.description}`).join('; ')}. Produce variants as A/B PAIRS: even index = A, odd = B; each pair tests ONE hypothesis you state in the set's hypothesis field. ${CITATION} Reply with strict JSON only.`,
    // QA-CODE-5: schema maxLengths derive from AD_FIELD_SCHEMA_MAX — one table.
    schema: { type: 'object', additionalProperties: false, required: ['platformSets'], properties: {
      platformSets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['platform', 'variants'], properties: { platform: { type: 'string' }, hypothesis: { type: 'string', maxLength: 200 }, variants: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { headline: { type: 'string', maxLength: AD_FIELD_SCHEMA_MAX.headline }, description: { type: 'string', maxLength: AD_FIELD_SCHEMA_MAX.description }, cta: { type: 'string', maxLength: AD_FIELD_SCHEMA_MAX.cta }, abLabel: { type: 'string', enum: ['A', 'B'] } } } } } } },
      citations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { docId: { type: 'string' }, marker: { type: 'string' } } } },
    } },
    itemsKey: 'platformSets',
  },
  email_sequence: {
    system: `You write a multi-email drip sequence from the kernel. Each email: 3 subject-line variants, preview text, body, CTA, send delay (days). ${CITATION} Reply with strict JSON only.`,
    schema: { type: 'object', additionalProperties: false, required: ['emails'], properties: {
      emails: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['position', 'subjectLines', 'body'], properties: { position: { type: 'integer' }, subjectLines: { type: 'array', items: { type: 'string' } }, previewText: { type: 'string' }, body: { type: 'string' }, ctaText: { type: 'string' }, sendDelayDays: { type: 'integer' } } } },
      citations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { docId: { type: 'string' }, marker: { type: 'string' } } } },
    } },
    itemsKey: 'emails',
  },
  creative_briefs: {
    system: `You write visual creative briefs from the kernel — 2-3 direction variants per format with scene, composition, messaging context, technical specs. ${CITATION} Reply with strict JSON only.`,
    schema: { type: 'object', additionalProperties: false, required: ['briefs'], properties: {
      // R2 CRB-SP-6 — the prompt demands "2-3 direction variants" but this
      // schema (additionalProperties:false) had NO `directions` field, so the
      // model could never return them, the landing code's `vb.directions` was
      // dead, and every generated managed brief arrived direction-less — then
      // triggered the app's own "No creative directions" warning.
      briefs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['format', 'sceneDescription'], properties: { format: { type: 'string' }, sceneDescription: { type: 'string' }, composition: { type: 'string' }, messagingContext: { type: 'string' }, directions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string' }, rationale: { type: 'string' } } } } } } },
      citations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { docId: { type: 'string' }, marker: { type: 'string' } } } },
    } },
    itemsKey: 'briefs',
  },
  social_posts: {
    system: `You write platform-adapted social posts from the kernel (LinkedIn, Twitter/X, Facebook, Instagram). HARD length caps (chars): linkedin 3000, twitter/x 280, facebook 5000, instagram 2200. ${CITATION} Reply with strict JSON only.`,
    schema: { type: 'object', additionalProperties: false, required: ['posts'], properties: {
      posts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['platform', 'content'], properties: { platform: { type: 'string' }, content: { type: 'string', maxLength: 5000 }, hashtags: { type: 'array', items: { type: 'string' } } } } },
      citations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { docId: { type: 'string' }, marker: { type: 'string' } } } },
    } },
    itemsKey: 'posts',
  },
};

function djb2(str) { let h = 5381; for (let k = 0; k < str.length; k++) h = ((h << 5) + h + str.charCodeAt(k)) | 0; return (h >>> 0).toString(16); }

export async function generate(ctx) {
  const cb = ensureBrief(ctx);
  const i = ctx.inputs ?? {};
  const briefId = str(i.briefId);
  const channel = str(i.channel);
  if (!CHANNELS.includes(channel)) {
    return { status: 'failed', error: { code: 'invalid_channel', message: `Unknown channel: ${channel}` } };
  }
  const spec = CHANNEL_SPEC[channel];

  const asm = await cb.assembleContext({ briefId });
  if (!asm.found) return { status: 'failed', error: { code: 'brief_not_found', message: `Brief not found: ${briefId}` } };
  if (!asm.kernel || typeof asm.kernel !== 'object') {
    return { status: 'failed', error: { code: 'kernel_required', message: 'Generate the messaging kernel before channel assets.' } };
  }
  const brief = asm.brief ?? {};
  const orgId = str(brief.orgId);

  // Brand voice (channel-scoped) + KB grounding legs.
  let voiceBlock = '';
  const brand = ctx.features && ctx.features.brand;
  if (brief.brandId && brand && typeof brand.resolveVoice === 'function') {
    try { const v = await brand.resolveVoice({ brandId: str(brief.brandId), channel, ...(Array.isArray(brief.personaIds) && brief.personaIds[0] ? { personaId: str(brief.personaIds[0]) } : {}) }); if (v && typeof v.voice === 'string') voiceBlock = v.voice; } catch { /* optional */ }
  }
  // ADR 0351 P2 — policy-aware grounding (mirrors the kernel node; the brief's
  // groundingPolicy is the single knob for BOTH stages).
  const groundingPolicy = brief.groundingPolicy === 'off' || brief.groundingPolicy === 'strict' ? brief.groundingPolicy : 'best-effort';
  let grounding = '';
  // ADR 0355 decision 2 (Option A) — retain the retrieved grounding contexts so
  // per-claim verdicts verify against THIS retrieval (never discarded, never a
  // second round-trip). Undefined ⇒ no retrieval happened (ungrounded / off).
  let contexts;
  let groundingInfo = { policy: groundingPolicy, coverage: 'none' };
  const kb = ctx.features && ctx.features.kb;
  if (groundingPolicy === 'strict' && (!brief.kbCollectionId || !kb || typeof kb.rag !== 'function')) {
    return { status: 'failed', error: { code: 'grounding_insufficient', message: 'groundingPolicy is strict but no KB collection is bound (or the kb feature is unavailable).' } };
  }
  if (groundingPolicy !== 'off' && brief.kbCollectionId && kb && typeof kb.rag === 'function') {
    try {
      const q = `${str(brief.productName)} ${str(brief.industryVertical)} proof points`.trim();
      // KB-CODE-2 mirror: under STRICT grounding, floor the retrieval score so
      // low-relevance chunks can't masquerade as coverage (same default as the
      // campaign-brief pack's kernel node).
      const r = await kb.rag({ orgId, collectionId: str(brief.kbCollectionId), query: q, topK: 6, ...(groundingPolicy === 'strict' ? { minScore: STRICT_MIN_SCORE } : {}) });
      if (r && typeof r.augmentedPrompt === 'string') grounding = r.augmentedPrompt;
      if (r && Array.isArray(r.contexts)) contexts = r.contexts; // retained for per-claim verify (ADR 0355 decision 2)
      groundingInfo = { policy: groundingPolicy, coverage: r && typeof r.coverage === 'string' ? r.coverage : (grounding ? 'ok' : 'none'), ...(r && r.embedding ? { embedding: r.embedding } : {}) };
      if (groundingPolicy === 'strict' && groundingInfo.coverage === 'none') {
        return { status: 'failed', error: { code: 'grounding_insufficient', message: 'The knowledge base returned no coverage for this channel (coverage: none). Add relevant documents or relax the grounding policy.' } };
      }
    } catch (e) {
      if (groundingPolicy === 'strict') {
        return { status: 'failed', error: { code: 'grounding_insufficient', message: `KB retrieval failed under strict grounding: ${e instanceof Error ? e.message : 'error'}` } };
      }
      /* best-effort — proceed ungrounded */
    }
  }

  if (typeof ctx.callAI !== 'function') {
    return { status: 'failed', error: { code: 'capability_missing', message: 'host does not expose ctx.callAI' } };
  }
  const userParts = [
    `MESSAGING KERNEL:\n${JSON.stringify(asm.kernel)}`,
    `CAMPAIGN CONTEXT:\n${str(asm.contextText)}`,
  ];
  // ADR 0355 P3 — named iteration ops: a refine pass transforms the prompt and
  // regenerates against the SAME schema + QA gates ("more-like-this",
  // "add-urgency", "more-technical", "simplify", "shorten").
  const refineOp = str(i.refineOp);
  if (refineOp && ITERATION_OPS[refineOp]) {
    userParts.push(`REFINE INSTRUCTION: ${ITERATION_OPS[refineOp]}`);
    if (i.priorDraft && typeof i.priorDraft === 'object') userParts.push(`EXISTING DRAFT:\n${JSON.stringify(i.priorDraft)}`);
  } else if (refineOp) {
    return { status: 'failed', error: { code: 'unknown_refine_op', message: `refineOp must be one of: ${Object.keys(ITERATION_OPS).join(', ')}` } };
  }
  // ADR 0355 P4 — persona lens: focus THIS generation on one persona (a
  // data-parallel dispatch can fan one child per persona, each passing its id).
  const personaId = str(i.personaId);
  if (personaId) {
    userParts.push(`FOCUS PERSONA: generate specifically for persona ${personaId} from the campaign context — their pain points, objections, and buying stage. Other personas are OUT of scope for this draft.`);
  }
  // ADR 0355 P5 — competitor differentiation (brief.competitors, optional).
  if (Array.isArray(brief.competitors) && brief.competitors.length > 0) {
    userParts.push(`COMPETITORS: differentiate against ${brief.competitors.map(String).join(', ')} — position on OUR strengths; never repeat or imply their claims.`);
  }
  if (voiceBlock) userParts.push(`BRAND VOICE:\n${voiceBlock}`);
  if (grounding) userParts.push(`GROUNDED KNOWLEDGE:\n${grounding}`);
  // ADR 0403 P4 — echo TESTED hooks (human-attested via the promote route;
  // the projection is tested-only + capped, so this block is already vetted).
  if (Array.isArray(asm.hooks) && asm.hooks.length > 0) {
    const lines = asm.hooks
      .filter((h) => h && typeof h.text === 'string' && h.text)
      .map((h) => `- (${typeof h.format === 'string' && h.format ? h.format : 'unspecified'}) ${h.text}`);
    if (lines.length > 0) userParts.push(`TESTED HOOKS (proven openers — reuse or adapt where the channel fits):\n${lines.join('\n')}`);
  }

  let data;
  try {
    const ai = await ctx.callAI({
      provider: str(i.provider) || 'anthropic',
      model: str(i.model) || DEFAULT_MODEL,
      systemPrompt: spec.system,
      messages: [{ role: 'user', content: userParts.join('\n\n') }],
      responseSchema: spec.schema,
    });
    data = ai && typeof ai === 'object' ? ai.data : undefined;
  } catch (e) {
    return { status: 'failed', error: { code: 'generation_failed', message: e instanceof Error ? e.message : 'channel generation failed' } };
  }
  if (!data || typeof data !== 'object') {
    return { status: 'failed', error: { code: 'generation_empty', message: 'The provider returned no draft.' } };
  }

  let draft = { channel, briefId, ...data, generatedAt: new Date().toISOString() };

  // ADR 0355 P1 — enforced platform limits: deterministic post-validate, ONE
  // field-scoped regeneration, then word-boundary truncation WITH a flag.
  // A silently over-limit ad never ships.
  const validator = channel === 'ad_variants' ? validateAdVariants : channel === 'social_posts' ? validateSocialPosts : null;
  let truncations = [];
  if (validator) {
    let findings = validator(draft);
    if (findings.length > 0) {
      try {
        const fixAi = await ctx.callAI({
          provider: str(i.provider) || 'anthropic',
          model: str(i.model) || DEFAULT_MODEL,
          systemPrompt: spec.system,
          messages: [{ role: 'user', content: `${userParts.join('\n\n')}\n\nYOUR PREVIOUS DRAFT EXCEEDED HARD LIMITS: ${JSON.stringify(findings)}. Regenerate the SAME JSON with every field within its limit. Reply with strict JSON only.` }],
          responseSchema: spec.schema,
        });
        const fixed = fixAi && typeof fixAi === 'object' ? fixAi.data : undefined;
        if (fixed && typeof fixed === 'object') {
          draft = { channel, briefId, ...fixed, generatedAt: draft.generatedAt };
          findings = validator(draft);
        }
      } catch { /* regen is best-effort — truncation below is the floor */ }
      if (findings.length > 0) {
        // Truncate the surviving offenders in place. QA-CODE-1: address each
        // offender by the SET INDEX the finding carries — a platform-string
        // re-lookup mis-targets duplicate same-platform sets (and drifted from
        // the validator's norm(), which also trims).
        for (const f of findings) {
          const set = channel === 'ad_variants' ? (draft.platformSets ?? [])[f.set] : null;
          const target = channel === 'ad_variants' ? set?.variants?.[f.index] : (draft.posts ?? [])[f.index];
          if (target && typeof target[f.field] === 'string') {
            const cut = truncateAt(target[f.field], f.limit);
            target[f.field] = cut.text;
            if (cut.truncated) truncations.push({ platform: f.platform, index: f.index, field: f.field });
          }
        }
      }
    }
  }
  if (truncations.length > 0) draft.truncated = truncations;

  // Bundle the two non-blocking checks so the channel workflow stays a clean
  // generate → approve pipeline (the executor's input-ref vocabulary doesn't
  // carry MyndHyve's cross-node {connection} wiring — the honest realization
  // composes the checks here, where the brand surface already is).
  const qualityReport = scoreQuality(draft, channel, 0, contexts);
  // ADR 0355 decision 2 (Option A) — strict grounding fails CLOSED on a claim the
  // knowledge base doesn't support. Best-effort/off keep `unsupported` as a WARNING
  // in the report (never fail here). Coverage:none already failed above, so this
  // leg only bites when there IS coverage but a specific claim doesn't match.
  if (groundingPolicy === 'strict' && Array.isArray(qualityReport.claimVerdicts)) {
    const unsupported = qualityReport.claimVerdicts.filter((v) => v.verdict === 'unsupported').length;
    if (unsupported > 0) {
      return { status: 'failed', error: { code: 'grounding_insufficient', message: `${unsupported} claim(s) unsupported by the knowledge base under strict grounding.` } };
    }
  }
  let complianceReport = null;
  if (brief.brandId && brand && typeof brand.checkComplianceDeterministic === 'function') {
    try {
      const c = await brand.checkComplianceDeterministic({ brandId: str(brief.brandId), content: JSON.stringify(draft), channel });
      complianceReport = c && typeof c.report === 'object' ? c.report : null;
    } catch { /* compliance optional */ }
  }

  // ADR 0353 P2 — when the creative-briefs feature is ON, the generated visual
  // briefs become MANAGED entities (lifecycle/versions/mood-board/sharing)
  // instead of transient drafts; the draft still returns for the approval flow.
  // CB-CODE-5: creation is IDEMPOTENT on (campaignBriefId, title) — a retry of
  // this node must not mint duplicate managed briefs — and failures are COUNTED
  // into `briefCreateErrors` instead of vanishing in a bare catch.
  let createdBriefIds = [];
  let briefCreateErrors = 0;
  const cbSurface = ctx.features && ctx.features['creative-briefs'];
  if (channel === 'creative_briefs' && cbSurface && typeof cbSurface.create === 'function' && Array.isArray(draft.briefs)) {
    let existing = [];
    if (typeof cbSurface.list === 'function') {
      try {
        const l = await cbSurface.list({ orgId });
        existing = Array.isArray(l && l.briefs) ? l.briefs : [];
      } catch { briefCreateErrors += 1; /* dedupe read failed — creates below still counted */ }
    }
    for (const vb of draft.briefs.slice(0, 6)) {
      const title = typeof vb.format === 'string' ? `${str(brief.productName) || 'Asset'} — ${vb.format}` : (str(brief.productName) || 'Visual brief');
      const match = existing.find((eb) => eb && eb.campaignBriefId === briefId && eb.title === title);
      if (match) {
        if (typeof match.briefId === 'string') createdBriefIds.push(match.briefId);
        continue; // already created by a prior run/retry — skip, don't duplicate
      }
      try {
        const r = await cbSurface.create({
          orgId,
          title,
          assetType: typeof vb.format === 'string' ? vb.format : 'image',
          sceneDescription: typeof vb.sceneDescription === 'string' ? vb.sceneDescription : 'Scene to be defined.',
          ...(typeof vb.composition === 'string' ? { composition: vb.composition } : {}),
          ...(typeof vb.messagingContext === 'string' ? { messagingIntent: vb.messagingContext } : {}),
          directions: Array.isArray(vb.directions) ? vb.directions : [],
          moodBoard: [],
          campaignBriefId: briefId,
          actor: 'campaign-channels',
        });
        if (r && r.brief && typeof r.brief.briefId === 'string') createdBriefIds.push(r.brief.briefId);
      } catch { briefCreateErrors += 1; /* entity creation is additive — the draft flow still works */ }
    }
  }

  return { status: 'success', outputs: { draft, qualityReport, complianceReport, grounding: groundingInfo, ...(createdBriefIds.length > 0 ? { createdBriefIds } : {}), ...(briefCreateErrors > 0 ? { briefCreateErrors } : {}), itemsKey: spec.itemsKey } };
}

/** Pure content-quality score (citations, length, completeness). Shared by the
 *  standalone node and the generate bundle. `contexts` (the retained kb.rag
 *  SearchHit[], ADR 0355 decision 2) drives per-claim verdicts; when it is
 *  undefined (standalone check / ungrounded run) the fact-check degrades to the
 *  `[src_N]`-presence check for uncited claims only. */
function scoreQuality(draft, channel, maxLength, contexts) {
  const text = JSON.stringify(draft ?? {});
  const issues = [];
  let score = 100;
  const hasCitations = Array.isArray(draft?.citations) ? draft.citations.length > 0 : /\[src_\d+\]/.test(text);
  if (!hasCitations) { issues.push({ dimension: 'factCheck', severity: 'warning', description: 'No citations — claims may be ungrounded.' }); score -= 20; }
  if (maxLength > 0 && text.length > maxLength) { issues.push({ dimension: 'length', severity: 'warning', description: `Draft is ${text.length} chars; soft cap ${maxLength}.` }); score -= 10; }
  const itemArrays = ['sections', 'platformSets', 'emails', 'briefs', 'posts'];
  const hasContent = itemArrays.some((k) => Array.isArray(draft?.[k]) && draft[k].length > 0);
  if (!hasContent) { issues.push({ dimension: 'completeness', severity: 'error', description: 'Draft has no channel content.' }); score -= 40; }

  // ── ADR 0355 P2 — QA v2 (all deterministic) ──
  // Per-field platform limits (post-enforcement: any survivor is an ERROR).
  const limitFindings = channel === 'ad_variants' ? validateAdVariants(draft) : channel === 'social_posts' ? validateSocialPosts(draft) : [];
  for (const f of limitFindings.slice(0, 5)) {
    issues.push({ dimension: 'charLimit', severity: 'error', description: `${f.platform} ${f.field}[${f.index}] is ${f.length} chars (limit ${f.limit}).` });
    score -= 15;
  }
  // Claim-level fact check: %/multiplier/superlative claims need [src_N].
  // QA-CODE-2: run PER extracted text field (the variantTexts pattern below) —
  // scanning the whole JSON blob let one [src_N] anywhere suppress every
  // uncited claim in the draft.
  const claimTexts = channel === 'ad_variants'
    ? (draft?.platformSets ?? []).flatMap((sset) => (Array.isArray(sset?.variants) ? sset.variants : []).flatMap((v) => [v?.headline, v?.description]))
    : channel === 'social_posts' ? (draft?.posts ?? []).map((pp) => pp?.content)
    : channel === 'email_sequence' ? (draft?.emails ?? []).flatMap((e) => [...(Array.isArray(e?.subjectLines) ? e.subjectLines : []), e?.previewText, e?.body])
    : channel === 'landing_page' ? (draft?.sections ?? []).flatMap((sec) => [sec?.heading, sec?.body])
    : channel === 'creative_briefs' ? (draft?.briefs ?? []).flatMap((b) => [b?.sceneDescription, b?.messagingContext])
    : [];
  const validClaimTexts = claimTexts.filter((t) => typeof t === 'string' && t.length > 0);
  // ADR 0355 decision 2 (Option A) — when the grounding retrieval's contexts were
  // retained, verify each claim's VERDICT against them; otherwise (standalone /
  // ungrounded) fall back to `[src_N]`-presence for uncited claims only.
  let claimVerdicts = null;
  if (Array.isArray(contexts)) {
    claimVerdicts = verifyClaims(validClaimTexts, contexts);
    const uncited = claimVerdicts.filter((v) => v.verdict === 'uncited');
    const unsupported = claimVerdicts.filter((v) => v.verdict === 'unsupported');
    if (uncited.length > 0) {
      issues.push({ dimension: 'factCheck', severity: 'warning', description: `${uncited.length} quantified claim(s) carry no [src_N] citation.`, claims: uncited.map((v) => v.claim).slice(0, 5) });
      score -= 15;
    }
    if (unsupported.length > 0) {
      issues.push({ dimension: 'factCheck', severity: 'warning', description: `${unsupported.length} cited claim(s) not supported by the knowledge base.`, claims: unsupported.map((v) => v.claim).slice(0, 5) });
      score -= 15;
    }
  } else {
    const claims = validClaimTexts.flatMap((t) => findUnsupportedClaims(t));
    if (claims.length > 0) {
      issues.push({ dimension: 'factCheck', severity: 'warning', description: `${claims.length} quantified claim(s) carry no [src_N] citation.`, claims: claims.slice(0, 5) });
      score -= 15;
    }
  }
  // QA-CODE-4 — A/B pair shape (deterministic, ADR 0355 decision 5). Only when
  // pairing was ATTEMPTED (abLabel or hypothesis present — the additive
  // contract): variants must form even-index-A / odd-index-B pairs with a
  // stated hypothesis. WARNING only — never fails the node.
  if (channel === 'ad_variants') {
    (draft?.platformSets ?? []).forEach((sset, si) => {
      const variants = Array.isArray(sset?.variants) ? sset.variants : [];
      const labeled = variants.some((v) => v && (v.abLabel === 'A' || v.abLabel === 'B'));
      const hasHypothesis = typeof sset?.hypothesis === 'string' && sset.hypothesis.trim().length > 0;
      if (!labeled && !hasHypothesis) return; // pairing not attempted — nothing to validate
      const paired = variants.length > 0 && variants.length % 2 === 0
        && variants.every((v, vi) => v && v.abLabel === (vi % 2 === 0 ? 'A' : 'B'));
      if (!paired || !hasHypothesis) {
        issues.push({ dimension: 'abPairing', severity: 'warning', description: `platform set ${si} carries A/B metadata but is not labeled A/B pairs with a hypothesis (${variants.length} variant(s), hypothesis ${hasHypothesis ? 'present' : 'missing'}).` });
        score -= 5;
      }
    });
  }
  // Near-duplicate variants (token-Jaccard ≥0.8 — the deterministic stand-in
  // for embedding cosine; ADR 0355 correction).
  const variantTexts = channel === 'ad_variants'
    ? (draft?.platformSets ?? []).flatMap((sset) => (sset.variants ?? []).map((v) => `${v.headline ?? ''} ${v.description ?? ''}`))
    : channel === 'social_posts' ? (draft?.posts ?? []).map((pp) => pp.content ?? '')
    : channel === 'email_sequence' ? (draft?.emails ?? []).flatMap((e) => e.subjectLines ?? []) : [];
  const dups = findNearDuplicates(variantTexts, 0.8);
  if (dups.length > 0) {
    issues.push({ dimension: 'variety', severity: 'warning', description: `${dups.length} near-duplicate variant pair(s) — regenerate for variety.`, pairs: dups.slice(0, 5) });
    score -= 10;
  }
  // Readability banding (informational — persona targeting arrives upstream).
  const bodyText = channel === 'landing_page' ? (draft?.sections ?? []).map((sec) => sec.body ?? '').join(' ') : text;
  const readability = readabilityBand(bodyText);

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { channel, overallScore: score, issues, readability, ...(claimVerdicts ? { claimVerdicts } : {}), passesThreshold: score >= 70, checkedAt: new Date().toISOString() };
}

export async function contentQualityCheck(ctx) {
  const i = ctx.inputs ?? {};
  const draft = i.draft && typeof i.draft === 'object' ? i.draft : (i.input && typeof i.input === 'object' && i.input.draft ? i.input.draft : {});
  const channel = str(i.channel || draft.channel);
  const maxLength = Number(i.maxLength) > 0 ? Number(i.maxLength) : 0;
  return { status: 'success', outputs: { report: scoreQuality(draft, channel, maxLength) } };
}

// ── publish: channel draft → live entity (ADR 0162) ──────────────────────────
// The "last mile" deferred by ADR 0157/0158: a generated draft becomes a real
// (DRAFT, never auto-published/sent) CMS page / email campaign via the owning
// feature's surface (ctx.features.cms / .email). role:"action" + deterministic
// idem keys → a replay/fork reuses the entity instead of duplicating it.

/** The upstream draft, from `{ draft }` or a wrapped `{ input: { draft } }`. */
function pickDraft(i) {
  if (i.draft && typeof i.draft === 'object') return i.draft;
  if (i.input && typeof i.input === 'object' && i.input.draft && typeof i.input.draft === 'object') return i.input.draft;
  return {};
}

/** Resolve the owning org: explicit `orgId`, else the brief's org (briefId from
 *  inputs or stamped on the draft) via the campaign-brief surface. */
async function resolveOrgId(ctx, i, draft) {
  const direct = str(i.orgId);
  if (direct) return direct;
  const briefId = str(i.briefId) || str(draft && draft.briefId);
  if (!briefId) return '';
  const cb = ctx.features && ctx.features['campaign-brief'];
  if (!cb || typeof cb.assembleContext !== 'function') return '';
  try {
    const asm = await cb.assembleContext({ briefId });
    return asm && asm.brief ? str(asm.brief.orgId) : '';
  } catch { return ''; }
}

/** Map a landing_page draft `{ title, sections:[{heading,body,ctaText?}] }` onto
 *  CMS sections: first → hero, rest → richText (+ a cta block when a non-hero
 *  section carries ctaText). The CMS service sanitizes + validates the result. */
function landingDraftToSections(draft) {
  const secs = Array.isArray(draft && draft.sections) ? draft.sections : [];
  const out = [];
  for (let i = 0; i < secs.length; i++) {
    const s = secs[i] || {};
    const heading = str(s.heading).trim();
    const body = str(s.body).trim();
    const ctaText = str(s.ctaText).trim();
    if (i === 0) {
      const data = { heading: heading || str(draft && draft.title) || 'Landing page' };
      if (body) data.subheading = body;
      if (ctaText) data.ctaLabel = ctaText;
      out.push({ type: 'hero', data });
    } else {
      const data = {};
      if (heading) data.heading = heading;
      if (body) data.text = body;
      out.push({ type: 'richText', data });
      if (ctaText) out.push({ type: 'cta', data: { label: ctaText } });
    }
  }
  return out;
}

export async function publishLandingPage(ctx) {
  const i = ctx.inputs ?? {};
  const cms = ctx.features && ctx.features.cms;
  if (!cms || typeof cms.createDraftPage !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'ctx.features.cms.createDraftPage unavailable — enable the CMS feature (ADR 0162).' } };
  }
  const draft = pickDraft(i);
  const orgId = await resolveOrgId(ctx, i, draft);
  if (!orgId) return { status: 'failed', error: { code: 'org_required', message: 'Could not resolve orgId — pass briefId or orgId.' } };
  const sections = landingDraftToSections(draft);
  if (sections.length === 0) return { status: 'failed', error: { code: 'empty_draft', message: 'Landing-page draft has no sections to publish.' } };
  const idemBase = `${ctx.runId ?? 'run'}:${ctx.nodeId ?? 'publish-lp'}`;
  try {
    const page = await cms.createDraftPage({ orgId, title: str(draft && draft.title) || 'Campaign landing page', sections, pageId: `page:${idemBase}` });
    return { status: 'success', outputs: { page } };
  } catch (e) {
    return { status: 'failed', error: { code: 'publish_failed', message: e instanceof Error ? e.message : 'landing-page publish failed' } };
  }
}

export async function publishEmailSequence(ctx) {
  const i = ctx.inputs ?? {};
  const email = ctx.features && ctx.features.email;
  if (!email || typeof email.createDraftCampaign !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'ctx.features.email.createDraftCampaign unavailable — enable the Email feature (ADR 0162).' } };
  }
  const draft = pickDraft(i);
  const orgId = await resolveOrgId(ctx, i, draft);
  if (!orgId) return { status: 'failed', error: { code: 'org_required', message: 'Could not resolve orgId — pass briefId or orgId.' } };
  const emails = Array.isArray(draft && draft.emails) ? draft.emails : [];
  if (emails.length === 0) return { status: 'failed', error: { code: 'empty_sequence', message: 'Email-sequence draft has no emails to publish.' } };
  // ADR 0655 D7 (EMWF-10) — NO runId (the WF-EM-6 shape): a `:fork` mints a new runId,
  // so the old base minted DUPLICATE draft campaigns. Anchored on the node + the
  // sequence's CONTENT (brief id when present, else a hash of the subjects), so a
  // fork or retry reuses the same entities and a genuinely different sequence does not.
  const briefKey = str(i.briefId) || str(draft && draft.briefId) || djb2(JSON.stringify(emails.map((e) => (e && e.subject) || '')));
  const idemBase = `${ctx.nodeId ?? 'publish-email'}:${briefKey}`;
  try {
    // ADR 0245 — stamp provenance: the brief this email draft was published from
    // (links to its MarketingCampaign). Best-effort — absent briefId leaves it unset.
    const briefId = str(i.briefId) || str(draft && draft.briefId);
    const campaign = await email.createDraftCampaign({ orgId, name: str(i.name) || 'Campaign email sequence', emails, ...(str(i.stage) ? { stage: str(i.stage) } : {}), ...(briefId ? { sourceBriefId: briefId } : {}), idemBase });
    return { status: 'success', outputs: { campaign } };
  } catch (e) {
    return { status: 'failed', error: { code: 'publish_failed', message: e instanceof Error ? e.message : 'email-sequence publish failed' } };
  }
}

// ── publish: ad / creative / social drafts → document handoff (ADR 0166) ─────
// These three channels have no first-party platform target in-app (real outbound
// ad/social dispatch is RFC-gated, deferred). The honest target is a durable
// `documents` handoff packet (Markdown) via ctx.features.documents.createDraftDocument
// — reviewable + exportable, nothing faked. role:"action" + deterministic idem keys.

/** Bounded markdown-escape for a table/inline cell (strips pipes + newlines). */
function cell(v) {
  return str(v).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** ad_variants `{platformSets:[{platform,variants:[{headline,description,cta}]}]}` → md. */
function adVariantsToMarkdown(draft) {
  const sets = Array.isArray(draft && draft.platformSets) ? draft.platformSets : [];
  const out = ['# Ad Copy', ''];
  for (const set of sets) {
    const platform = cell(set && set.platform) || 'Platform';
    out.push(`## ${platform}`, '', '| Headline | Description | CTA |', '| --- | --- | --- |');
    const variants = Array.isArray(set && set.variants) ? set.variants : [];
    for (const v of variants) out.push(`| ${cell(v && v.headline)} | ${cell(v && v.description)} | ${cell(v && v.cta)} |`);
    out.push('');
  }
  return out.join('\n').trim();
}

/** creative_briefs `{briefs:[{format,sceneDescription,composition,messagingContext}]}` → md. */
function creativeBriefsToMarkdown(draft) {
  const briefs = Array.isArray(draft && draft.briefs) ? draft.briefs : [];
  const out = ['# Creative Briefs', ''];
  briefs.forEach((b, idx) => {
    out.push(`## ${str(b && b.format).trim() || `Brief ${idx + 1}`}`, '');
    if (str(b && b.sceneDescription).trim()) out.push(`**Scene:** ${str(b.sceneDescription).trim()}`, '');
    if (str(b && b.composition).trim()) out.push(`**Composition:** ${str(b.composition).trim()}`, '');
    if (str(b && b.messagingContext).trim()) out.push(`**Messaging:** ${str(b.messagingContext).trim()}`, '');
  });
  return out.join('\n').trim();
}

/** social_posts `{posts:[{platform,content,hashtags[]}]}` → a platform-grouped calendar. */
function socialPostsToMarkdown(draft) {
  const posts = Array.isArray(draft && draft.posts) ? draft.posts : [];
  const byPlatform = new Map();
  for (const p of posts) {
    const platform = str(p && p.platform).trim() || 'Other';
    if (!byPlatform.has(platform)) byPlatform.set(platform, []);
    byPlatform.get(platform).push(p);
  }
  const out = ['# Social Calendar', ''];
  for (const [platform, group] of byPlatform) {
    out.push(`## ${platform}`, '');
    for (const p of group) {
      if (str(p && p.content).trim()) out.push(str(p.content).trim());
      const tags = Array.isArray(p && p.hashtags) ? p.hashtags.map((t) => str(t).trim()).filter(Boolean) : [];
      if (tags.length) out.push(tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' '));
      out.push('');
    }
  }
  return out.join('\n').trim();
}

/** Shared publish-to-document body: fail-closed on no items, map → md, write via the surface. */
async function publishToDocument(ctx, { itemsKey, toMarkdown, kind, title, nodeFallback }) {
  const i = ctx.inputs ?? {};
  const docs = ctx.features && ctx.features.documents;
  if (!docs || typeof docs.createDraftDocument !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'ctx.features.documents.createDraftDocument unavailable — enable the Documents feature (ADR 0166).' } };
  }
  const draft = pickDraft(i);
  const orgId = await resolveOrgId(ctx, i, draft);
  if (!orgId) return { status: 'failed', error: { code: 'org_required', message: 'Could not resolve orgId — pass briefId or orgId.' } };
  const items = Array.isArray(draft && draft[itemsKey]) ? draft[itemsKey] : [];
  if (items.length === 0) return { status: 'failed', error: { code: 'empty_draft', message: `Draft has no ${itemsKey} to publish.` } };
  const content = toMarkdown(draft);
  if (!content) return { status: 'failed', error: { code: 'empty_draft', message: `Draft mapped to empty ${kind} content.` } };
  const idemBase = `${ctx.runId ?? 'run'}:${ctx.nodeId ?? nodeFallback}`;
  try {
    const res = await docs.createDraftDocument({ orgId, kind, title: str(i.title) || title, content, idemBase });
    if (res && res.error) return { status: 'failed', error: res.error };
    return { status: 'success', outputs: { document: res.document, version: res.version } };
  } catch (e) {
    return { status: 'failed', error: { code: 'publish_failed', message: e instanceof Error ? e.message : 'document publish failed' } };
  }
}

/** Pull the first usable ad copy variant from an ad_variants draft (any platform set). */
function firstAdCopy(draft, platform) {
  const sets = Array.isArray(draft && draft.platformSets) ? draft.platformSets : [];
  const match = sets.find((s) => str(s && s.platform).toLowerCase().includes(platform)) || sets[0];
  const v = match && Array.isArray(match.variants) ? match.variants[0] : null;
  if (!v || !str(v.headline).trim()) return null;
  return { headline: str(v.headline).trim(), ...(str(v.description).trim() ? { description: str(v.description).trim() } : {}), ...(str(v.cta).trim() ? { ctaText: str(v.cta).trim() } : {}) };
}

/** Append a brief's UTM schema to an outbound URL (campaign gap plan C8 —
 *  utm_campaign is the C5 attribution join key). Existing query params and
 *  explicit utm_* on the URL win; falls back to utm_campaign=<briefId>. */
export function appendUtm(url, utm, briefId) {
  const params = {
    utm_source: utm && utm.source, utm_medium: utm && utm.medium,
    utm_campaign: (utm && utm.campaign) || briefId,
    utm_term: utm && utm.term, utm_content: utm && utm.content,
  };
  try {
    // Resolve against a dummy base so a RELATIVE landingUrl (e.g. `/pricing`)
    // still gets stamped (grade-code AUDIT-9): a bare `new URL(relative)` throws,
    // and the old catch dropped ALL utm params — silently breaking the C5
    // attribution join (utm_campaign is its key) for every relative URL.
    const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    const base = 'https://x.invalid';
    const u = new URL(url, base);
    for (const [k, v] of Object.entries(params)) {
      if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
    }
    return isAbsolute ? u.toString() : u.pathname + u.search + u.hash;
  } catch { return url; }
}

export async function publishAdVariants(ctx) {
  const i = ctx.inputs ?? {};
  // Real outbound dispatch (ADR 0167) is requested ONLY when the caller targets a
  // real ad account (adAccountId). The human approves the draft upstream; the
  // adapter creates a PAUSED campaign (no auto-spend). No account, no connection,
  // or an unconfigured host ⇒ fall back to the ADR 0166 document handoff.
  const adAccountId = str(i.adAccountId);
  const dryRun = i.dryRun === true; // preview-only: build the PAUSED payloads, make ZERO platform calls
  const p = str(i.platform).toLowerCase(); // ADR 0167: meta/google/tiktok; + linkedin (ADR 0223)
  // Explicit allow-set (grade-code AUDIT-10): empty ⇒ default meta; a NON-EMPTY
  // typo (e.g. 'googel') must FAIL, not silently dispatch to the wrong platform.
  const KNOWN = new Set(['meta', 'google', 'tiktok', 'linkedin']);
  const platform = p === '' ? 'meta' : (KNOWN.has(p) ? p : null);
  if (platform === null) {
    return { status: 'failed', error: { code: 'unknown_platform', message: `Unknown ad platform "${str(i.platform)}" — expected one of meta|google|tiktok|linkedin.` } };
  }
  if (adAccountId && ctx.ads && typeof ctx.ads.publishAd === 'function') {
    const draft = pickDraft(i);
    const briefId = str(i.briefId) || str(draft && draft.briefId);
    const copy = firstAdCopy(draft, platform);
    if (!briefId) return { status: 'failed', error: { code: 'brief_required', message: 'Dispatch needs a briefId (the fork-stable idempotency anchor).' } };
    if (!copy) return { status: 'failed', error: { code: 'empty_draft', message: 'ad_variants draft has no usable copy variant to dispatch.' } };
    // ADR 0245 — operator-authored targeting (Meta targeting / LinkedIn
    // targetingCriteria), forwarded verbatim. The host never invents a default;
    // absent ⇒ no targeting (the platform requires one at activation, a human
    // step). Validate ONLY that it's a plain, size-bounded object.
    let targeting;
    if (i.targeting !== undefined && i.targeting !== null) {
      if (typeof i.targeting !== 'object' || Array.isArray(i.targeting)) {
        return { status: 'failed', error: { code: 'validation_error', message: 'targeting must be a plain object (the platform-native targeting/targetingCriteria shape).' } };
      }
      if (JSON.stringify(i.targeting).length > 32768) {
        return { status: 'failed', error: { code: 'validation_error', message: 'targeting is too large (max 32KB).' } };
      }
      targeting = i.targeting;
    }
    // C8: stamp the brief's UTM schema onto the landing URL (best-effort read
    // through the campaign-brief surface; the URL still works without it).
    let landingUrl = str(i.landingUrl);
    if (landingUrl) {
      let utm;
      try {
        const cb = ctx.features && ctx.features['campaign-brief'];
        if (cb && typeof cb.getBrief === 'function') {
          const res = await cb.getBrief({ briefId });
          utm = res && res.brief && res.brief.utm;
        }
      } catch { /* best-effort */ }
      landingUrl = appendUtm(landingUrl, utm, briefId);
    }
    try {
      const r = await ctx.ads.publishAd({
        platform, briefId, adAccountId,
        campaignName: str(i.campaignName) || str(draft && draft.title) || `Campaign ${briefId}`,
        ...(str(i.objective) ? { objective: str(i.objective) } : {}),
        ...(landingUrl ? { landingUrl } : {}),
        copy,
        ...(Number.isInteger(i.dailyBudgetMinor) ? { dailyBudgetMinor: i.dailyBudgetMinor } : {}),
        // ADR 0223 creative-affecting inputs (each changes the idempotency key):
        // meta REQUIRES pageId (fails closed missing_page_id); tiktok REQUIRES
        // identityId (missing_identity_id); mediaAssetId uploads the media-library
        // image platform-side (Meta image_hash / TikTok image_ids).
        ...(str(i.pageId) ? { pageId: str(i.pageId) } : {}),
        ...(str(i.identityId) ? { identityId: str(i.identityId) } : {}),
        ...(str(i.mediaAssetId) ? { mediaAssetId: str(i.mediaAssetId) } : {}),
        // ADR 0411 §P3c — mediaKind:'video' routes the reel to the platform VIDEO
        // surface (Meta advideos/video_data; TikTok SINGLE_VIDEO). Dry-run previews
        // the plan; live fails closed video_dispatch_live_pending (live-smoke-pending).
        ...(str(i.mediaKind) === 'video' ? { mediaKind: 'video' } : {}),
        ...(targeting ? { targeting } : {}), // ADR 0245 — operator targeting, spend-shaping → in the idem key
        ...(dryRun ? { dryRun: true } : {}),
      });
      // Preview: the exact PAUSED create payloads, nothing dispatched. Return the plan as
      // a success output — do NOT fall through to the document handoff (that would publish).
      if (r.outcome === 'preview') return { status: 'success', outputs: { preview: r } };
      if (r.outcome === 'published') return { status: 'success', outputs: { dispatched: r } };
      // Spend governance (campaign gap plan B3): the tenant's ad-spend threshold
      // requires a human sign-off. NOT a document-handoff case — surface the
      // pending approval so the operator approves it in the Approvals inbox and
      // re-runs; the same fork-stable key then proceeds.
      if (r.outcome === 'requires_approval') {
        return { status: 'failed', error: { code: 'spend_approval_pending', message: `Ad spend requires approval (${r.approvalId}). Approve it in the Approvals inbox, then re-run — the dispatch resumes under the same idempotency key.` } };
      }
      // A real platform rejection surfaces; but a host CONFIG-not-ready (no connection,
      // or the operator hasn't set the Google developer-token) is honest degradation —
      // fall through to the ADR 0166 document handoff rather than fail the user.
      if (r.outcome === 'failed' && r.error !== 'no_developer_token') return { status: 'failed', error: { code: 'ad_dispatch_failed', message: r.error } };
      // no_connection / no_developer_token → document handoff.
    } catch (e) {
      return { status: 'failed', error: { code: 'ad_dispatch_failed', message: e instanceof Error ? e.message : 'ad dispatch failed' } };
    }
  }
  return publishToDocument(ctx, { itemsKey: 'platformSets', toMarkdown: adVariantsToMarkdown, kind: 'campaign-ad-copy', title: 'Ad Copy', nodeFallback: 'publish-ad' });
}
export async function publishCreativeBriefs(ctx) {
  return publishToDocument(ctx, { itemsKey: 'briefs', toMarkdown: creativeBriefsToMarkdown, kind: 'campaign-creative-briefs', title: 'Creative Briefs', nodeFallback: 'publish-creative' });
}

// ── render-concepts: creative_briefs draft → rendered concept images (D3) ────
// OPTIONAL leg — deliberately NOT on the channel child workflow spine (the
// generate → approve flow is unchanged); an agent/chain-callable verb (ADR 0229).
// Calls the host image seam via the SAME ctx delegate core.openwop.ai.
// image-generate uses (ctx.callImageGenerator / ctx.aiProviders.callImageGenerator
// — never a pack-level HTTP client); honest-off `host_capability_missing` when no
// provider is wired, exactly like the seam. The per-tenant DAILY image budget
// (ADR 0115 Phase 5) is enforced INSIDE the seam before the metered dispatch —
// this node adds no second budget path. Each image is registered as a durable
// Media-Library asset WITH lineage (generatedBy:'ai', prompt, model) via
// ctx.features.media, and the outputs carry asset refs + serve URLs so the
// existing artifact workbench renders the variants side-by-side (no studio UI).

export async function renderConcepts(ctx) {
  const i = ctx.inputs ?? {};
  const gen = typeof ctx.callImageGenerator === 'function'
    ? ctx.callImageGenerator
    : (ctx.aiProviders && typeof ctx.aiProviders.callImageGenerator === 'function' ? ctx.aiProviders.callImageGenerator : null);
  if (!gen) {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'host does not implement callImageGenerator — image generation is not wired (ADR 0115).' } };
  }
  const media = ctx.features && ctx.features.media;
  if (!media || typeof media.createAssetFromServeUrl !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'ctx.features.media.createAssetFromServeUrl unavailable — the Media Library surface is required (ADR 0229).' } };
  }
  const draft = pickDraft(i);
  const briefs = Array.isArray(draft && draft.briefs) ? draft.briefs : [];
  if (briefs.length === 0) return { status: 'failed', error: { code: 'empty_draft', message: 'creative_briefs draft has no briefs to render.' } };
  const orgId = await resolveOrgId(ctx, i, draft);
  if (!orgId) return { status: 'failed', error: { code: 'org_required', message: 'Could not resolve orgId — pass briefId or orgId.' } };
  const maxImages = Math.min(Math.max(1, Number.isInteger(i.maxImages) ? i.maxImages : 1), 3);

  const concepts = [];
  let stoppedBy = null;
  for (let idx = 0; idx < briefs.length && concepts.length < maxImages; idx++) {
    const b = briefs[idx] || {};
    // One prompt per brief direction: scene + composition + messaging context.
    // Bounded to the lineage-prompt cap (2000) — under the seam's 4000 cap too.
    const prompt = [str(b.sceneDescription).trim(), str(b.composition).trim(), str(b.messagingContext).trim()]
      .filter(Boolean).join('\n').slice(0, 2000);
    if (!prompt) continue;
    try {
      const r = await gen.call(ctx, {
        prompt,
        n: 1,
        ...(str(i.provider) ? { provider: str(i.provider) } : {}),
        ...(str(i.model) ? { model: str(i.model) } : {}),
        ...(str(i.size) ? { size: str(i.size) } : {}),
        ...(str(i.credentialRef) ? { credentialRef: str(i.credentialRef) } : {}),
      });
      const images = r && Array.isArray(r.images) ? r.images : [];
      for (const img of images) {
        if (!img || typeof img.url !== 'string') continue;
        const model = (img.metadata && typeof img.metadata.model === 'string' && img.metadata.model) || str(i.model);
        const asset = await media.createAssetFromServeUrl({
          orgId,
          url: img.url,
          name: `Concept — ${str(b.format).trim() || `brief ${idx + 1}`}`,
          tags: ['campaign', 'concept'],
          lineage: {
            generatedBy: 'ai',
            prompt,
            ...(model ? { model } : {}),
            ...(str(i.derivedFromAssetId) ? { derivedFrom: str(i.derivedFromAssetId) } : {}),
          },
        });
        concepts.push({
          briefIndex: idx,
          format: str(b.format),
          prompt,
          assetId: asset.assetId,
          // MED2-R2 — `serveToken`/`serveUrl` deliberately NOT re-emitted: both
          // are bearer credentials to the bytes (the URL is the token in a
          // path), and this node's output is recorded in a run log whose reads
          // are tenant-scoped with no org check. `assetId` is the handle; the
          // bytes are fetched through the authorized media read.
          mimeType: str(img.mimeType) || asset.contentType,
        });
      }
    } catch (e) {
      // Seam errors pass through honestly (host_capability_missing when the
      // provider is unconfigured; provider_rate_limited when the ADR 0115 daily
      // budget is spent). Partial renders are kept, never discarded.
      stoppedBy = { code: (e && e.code) || 'render_failed', message: e instanceof Error ? e.message : 'concept render failed' };
      break;
    }
  }
  if (concepts.length === 0) {
    return { status: 'failed', error: stoppedBy || { code: 'empty_draft', message: 'No renderable briefs (each needs a scene description).' } };
  }
  // CS-DATA-5 — make the campaign→asset edge durable: register the generated
  // concepts as the campaign's tracked assets (media "used in N campaigns" +
  // cleanup on campaign delete). Best-effort — never fail a render on it.
  const orch = ctx.features && ctx.features['campaign-orchestration'];
  if (orch && typeof orch.attachAssets === 'function' && str(i.briefId)) {
    try {
      await orch.attachAssets({ briefId: str(i.briefId), assetIds: concepts.map((c) => c.assetId).filter(Boolean) });
    } catch { /* attach is best-effort — never fail a render */ }
  }
  return { status: 'success', outputs: { concepts, count: concepts.length, ...(stoppedBy ? { truncatedBy: stoppedBy.code } : {}) } };
}
export async function publishSocialPosts(ctx) {
  return publishToDocument(ctx, { itemsKey: 'posts', toMarkdown: socialPostsToMarkdown, kind: 'campaign-social-calendar', title: 'Social Calendar', nodeFallback: 'publish-social' });
}

export const nodes = {
  'feature.campaign-channels.nodes.generate': generate,
  'feature.campaign-channels.nodes.content-quality-check': contentQualityCheck,
  'feature.campaign-channels.nodes.publish-landing-page': publishLandingPage,
  'feature.campaign-channels.nodes.publish-email-sequence': publishEmailSequence,
  'feature.campaign-channels.nodes.publish-ad-variants': publishAdVariants,
  'feature.campaign-channels.nodes.publish-creative-briefs': publishCreativeBriefs,
  'feature.campaign-channels.nodes.publish-social-posts': publishSocialPosts,
  'feature.campaign-channels.nodes.render-concepts': renderConcepts,
};

export default nodes;
