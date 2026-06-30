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

const CHANNELS = ['landing_page', 'ad_variants', 'email_sequence', 'creative_briefs', 'social_posts'];

// ── per-channel system prompt + responseSchema (the five MyndHyve shapes) ──
const CITATION = 'Cite every factual claim with a [src_N] marker drawn ONLY from the grounded knowledge — never invent proof points.';
const CHANNEL_SPEC = {
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
    system: `You write ad variants from the kernel, one platform set per requested platform (Google, Meta, LinkedIn). Respect headline/description character limits. ${CITATION} Reply with strict JSON only.`,
    schema: { type: 'object', additionalProperties: false, required: ['platformSets'], properties: {
      platformSets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['platform', 'variants'], properties: { platform: { type: 'string' }, variants: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { headline: { type: 'string' }, description: { type: 'string' }, cta: { type: 'string' } } } } } } },
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
      briefs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['format', 'sceneDescription'], properties: { format: { type: 'string' }, sceneDescription: { type: 'string' }, composition: { type: 'string' }, messagingContext: { type: 'string' } } } },
      citations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { docId: { type: 'string' }, marker: { type: 'string' } } } },
    } },
    itemsKey: 'briefs',
  },
  social_posts: {
    system: `You write platform-adapted social posts from the kernel (LinkedIn, Twitter/X, Facebook, Instagram) — respect each platform's length + tone. ${CITATION} Reply with strict JSON only.`,
    schema: { type: 'object', additionalProperties: false, required: ['posts'], properties: {
      posts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['platform', 'content'], properties: { platform: { type: 'string' }, content: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } } } } },
      citations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { docId: { type: 'string' }, marker: { type: 'string' } } } },
    } },
    itemsKey: 'posts',
  },
};

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
    try { const v = await brand.resolveVoice({ brandId: str(brief.brandId), channel }); if (v && typeof v.voice === 'string') voiceBlock = v.voice; } catch { /* optional */ }
  }
  let grounding = '';
  const kb = ctx.features && ctx.features.kb;
  if (brief.kbCollectionId && kb && typeof kb.rag === 'function') {
    try {
      const q = `${str(brief.productName)} ${str(brief.industryVertical)} proof points`.trim();
      const r = await kb.rag({ orgId, collectionId: str(brief.kbCollectionId), query: q, topK: 6 });
      if (r && typeof r.augmentedPrompt === 'string') grounding = r.augmentedPrompt;
    } catch { /* optional */ }
  }

  if (typeof ctx.callAI !== 'function') {
    return { status: 'failed', error: { code: 'capability_missing', message: 'host does not expose ctx.callAI' } };
  }
  const userParts = [
    `MESSAGING KERNEL:\n${JSON.stringify(asm.kernel)}`,
    `CAMPAIGN CONTEXT:\n${str(asm.contextText)}`,
  ];
  if (voiceBlock) userParts.push(`BRAND VOICE:\n${voiceBlock}`);
  if (grounding) userParts.push(`GROUNDED KNOWLEDGE:\n${grounding}`);

  let data;
  try {
    const ai = await ctx.callAI({
      provider: str(i.provider) || 'anthropic',
      model: str(i.model) || 'claude-sonnet-4-6',
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

  const draft = { channel, briefId, ...data, generatedAt: new Date().toISOString() };

  // Bundle the two non-blocking checks so the channel workflow stays a clean
  // generate → approve pipeline (the executor's input-ref vocabulary doesn't
  // carry MyndHyve's cross-node {connection} wiring — the honest realization
  // composes the checks here, where the brand surface already is).
  const qualityReport = scoreQuality(draft, channel, 0);
  let complianceReport = null;
  if (brief.brandId && brand && typeof brand.checkComplianceDeterministic === 'function') {
    try {
      const c = await brand.checkComplianceDeterministic({ brandId: str(brief.brandId), content: JSON.stringify(draft), channel });
      complianceReport = c && typeof c.report === 'object' ? c.report : null;
    } catch { /* compliance optional */ }
  }

  return { status: 'success', outputs: { draft, qualityReport, complianceReport, itemsKey: spec.itemsKey } };
}

/** Pure content-quality score (citations, length, completeness). Shared by the
 *  standalone node and the generate bundle. */
function scoreQuality(draft, channel, maxLength) {
  const text = JSON.stringify(draft ?? {});
  const issues = [];
  let score = 100;
  const hasCitations = Array.isArray(draft?.citations) ? draft.citations.length > 0 : /\[src_\d+\]/.test(text);
  if (!hasCitations) { issues.push({ dimension: 'factCheck', severity: 'warning', description: 'No citations — claims may be ungrounded.' }); score -= 20; }
  if (maxLength > 0 && text.length > maxLength) { issues.push({ dimension: 'length', severity: 'warning', description: `Draft is ${text.length} chars; soft cap ${maxLength}.` }); score -= 10; }
  const itemArrays = ['sections', 'platformSets', 'emails', 'briefs', 'posts'];
  const hasContent = itemArrays.some((k) => Array.isArray(draft?.[k]) && draft[k].length > 0);
  if (!hasContent) { issues.push({ dimension: 'completeness', severity: 'error', description: 'Draft has no channel content.' }); score -= 40; }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { channel, overallScore: score, issues, passesThreshold: score >= 70, checkedAt: new Date().toISOString() };
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
  const idemBase = `${ctx.runId ?? 'run'}:${ctx.nodeId ?? 'publish-email'}`;
  try {
    const campaign = await email.createDraftCampaign({ orgId, name: str(i.name) || 'Campaign email sequence', emails, ...(str(i.stage) ? { stage: str(i.stage) } : {}), idemBase });
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

export async function publishAdVariants(ctx) {
  const i = ctx.inputs ?? {};
  // Real outbound dispatch (ADR 0167) is requested ONLY when the caller targets a
  // real ad account (adAccountId). The human approves the draft upstream; the
  // adapter creates a PAUSED campaign (no auto-spend). No account, no connection,
  // or an unconfigured host ⇒ fall back to the ADR 0166 document handoff.
  const adAccountId = str(i.adAccountId);
  const dryRun = i.dryRun === true; // preview-only: build the PAUSED payloads, make ZERO platform calls
  const p = str(i.platform).toLowerCase(); // ADR 0167: P1=meta, P2=google, P3=tiktok
  const platform = (p === 'google' || p === 'tiktok') ? p : 'meta'; // explicit allow-set — a bad value must NOT silently dispatch to the wrong platform
  if (adAccountId && ctx.ads && typeof ctx.ads.publishAd === 'function') {
    const draft = pickDraft(i);
    const briefId = str(i.briefId) || str(draft && draft.briefId);
    const copy = firstAdCopy(draft, platform);
    if (!briefId) return { status: 'failed', error: { code: 'brief_required', message: 'Dispatch needs a briefId (the fork-stable idempotency anchor).' } };
    if (!copy) return { status: 'failed', error: { code: 'empty_draft', message: 'ad_variants draft has no usable copy variant to dispatch.' } };
    try {
      const r = await ctx.ads.publishAd({
        platform, briefId, adAccountId,
        campaignName: str(i.campaignName) || str(draft && draft.title) || `Campaign ${briefId}`,
        ...(str(i.objective) ? { objective: str(i.objective) } : {}),
        ...(str(i.landingUrl) ? { landingUrl: str(i.landingUrl) } : {}),
        copy,
        ...(Number.isInteger(i.dailyBudgetMinor) ? { dailyBudgetMinor: i.dailyBudgetMinor } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      });
      // Preview: the exact PAUSED create payloads, nothing dispatched. Return the plan as
      // a success output — do NOT fall through to the document handoff (that would publish).
      if (r.outcome === 'preview') return { status: 'success', outputs: { preview: r } };
      if (r.outcome === 'published') return { status: 'success', outputs: { dispatched: r } };
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
};

export default nodes;
