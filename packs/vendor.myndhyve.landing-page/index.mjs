/**
 * vendor.myndhyve.landing-page — 7 landing-page executors.
 *
 * Lifted from MyndHyve's `src/canvas-types/campaign-studio/nodes/pageBuilder/modules.ts`
 * (1158 LOC TypeScript). Two AI-call sites use the host's `ctx.callAI`
 * via the declared `aiProviders` peer-dep. The original
 * `useDesignSystemStore` + `useIntegrationStore` direct Zustand reads
 * are replaced with optional input-passthrough fields (`inputs.designSystem`,
 * `inputs.trackingIntegrations`) so the workflow author resolves those
 * upstream and feeds them into the executor — keeps the pack
 * host-agnostic.
 *
 * Stage 5 Phase B pilot per /plan + openwop/openwop#11.
 */

import { randomBytes } from 'node:crypto';

/* ─── shared helpers ────────────────────────────────────── */

function makeLog(ctx) {
  const fn = typeof ctx?.log === 'function' ? ctx.log : null;
  return {
    info: (msg, data) => { if (fn) fn('info', msg, data); },
    debug: (msg, data) => { if (fn) fn('debug', msg, data); },
    warn: (msg, data) => { if (fn) fn('warn', msg, data); },
    error: (msg, data) => { if (fn) fn('error', msg, data); },
  };
}

function ensureCallAI(ctx) {
  if (typeof ctx.callAI !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.callAI — workflow-register should have refused this pack at peerDependency resolution time'),
      { code: 'host_capability_missing', capability: 'aiProviders' }
    );
  }
}

function hexBytes(n) {
  return randomBytes(n).toString('hex');
}

function generateSecureId(prefix) {
  return `${prefix}_${Date.now()}_${hexBytes(8)}`;
}

function generateShortId(prefix) {
  const id = hexBytes(6);
  return prefix ? `${prefix}_${id}` : id;
}

function generateSlug(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
  return `${base}-${generateShortId()}`;
}

const Ids = {
  page: () => generateSecureId('page'),
  section: () => generateSecureId('section'),
  variant: (personaId) => generateSecureId(`variant_${personaId}`),
  headline: () => generateSecureId('headline'),
  cta: () => generateSecureId('cta'),
  trackingEvent: () => generateSecureId('evt'),
  utmLink: () => generateSecureId('utm'),
};

const RATE_LIMITS = {
  MAX_SECTIONS_PER_PAGE: 20,
  MAX_VARIANTS_PER_PAGE: 10,
};

const SCORING_THRESHOLDS = {
  MIN_SEO_SCORE: 70,
  MIN_ACCESSIBILITY_SCORE_AA: 80,
  MIN_PERFORMANCE_SCORE: 60,
};

function parseJSONFromAI(content) {
  const cleaned = String(content ?? '').replace(/```json?\s*/g, '').replace(/```/g, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/* ─── 1. landing.content.generate ───────────────────────── */

// XCH-LP-1 (LLM-EXCHANGE-AUDIT Wave 2): the branded DEFAULT_HEADLINES /
// DEFAULT_SECTIONS / DEFAULT_CTAS / DEFAULT_SEO placeholder library is GONE.
// A failed generation is a typed failure; optional pieces (CTAs, SEO) are
// DERIVED from the model's real content, never fabricated boilerplate.

export async function contentGenerate(ctx) {
  ensureCallAI(ctx);
  const log = makeLog(ctx);
  const inputs = ctx.inputs ?? {};
  const config = ctx.config ?? {};

  log.info('Generating landing page content', {
    blueprintId: inputs.blueprintId,
    personaCount: inputs.personaIds?.length ?? 0,
  });

  let headlines = [];
  let sections = [];
  let ctaVariants = [];
  let seoMetadata = null;

  try {
    // XCH-LP-1 grounding (Wave 4): prefer FULL objects when the workflow
    // supplies them (`blueprint`, `personas`) — a bare id gives the model
    // nothing to write from. Ids remain accepted for compatibility, with the
    // weak grounding named in the prompt so the model hedges accordingly.
    const blueprintContext = inputs.blueprint && typeof inputs.blueprint === 'object'
      ? `Blueprint (full):\n${JSON.stringify(inputs.blueprint).substring(0, 3000)}`
      : inputs.blueprintId ? `Blueprint ID (unresolved — you have NO blueprint details): ${inputs.blueprintId}` : '';
    const personaContext = Array.isArray(inputs.personas) && inputs.personas.length
      ? `Target personas (full):\n${JSON.stringify(inputs.personas).substring(0, 3000)}`
      : inputs.personaIds?.length
        ? `Target persona IDs (unresolved — you have NO persona details): ${inputs.personaIds.join(', ')}`
        : '';
    const pillarsContext = inputs.messagePillars
      ? `Message pillars: ${JSON.stringify(inputs.messagePillars).substring(0, 2000)}`
      : '';

    const SYSTEM = `You are a landing page copywriter. Generate landing page content. Return ONLY JSON with keys:
- "headlines": array of { "text": string, "angle": "outcome"|"benefit"|"social-proof"|"urgency"|"curiosity" }
- "sections": array of { "type": "hero"|"features"|"testimonials"|"pricing"|"cta"|"faq", "content": object with relevant fields }
- "ctaVariants": array of { "text": string, "style": "primary"|"secondary" }
- "seoMetadata": { "title": string, "description": string, "keywords": string[], "ogTitle": string, "ogDescription": string }
Ground every claim in the provided blueprint/personas/pillars; where they are unresolved ids, write neutral copy and NEVER invent product facts.`;
    const promptMessages = [{
      role: 'user',
      content: `Generate landing page content for:\n${blueprintContext}\n${personaContext}\n${pillarsContext}\n\nGenerate 3 headlines, 5 sections, 3 CTA variants, and SEO metadata.`,
    }];
    const result = await ctx.callAI({
      provider: config.provider,
      model: config.model,
      systemPrompt: SYSTEM,
      messages: promptMessages,
      temperature: 0.7,
      maxTokens: 3000,
      responseSchema: { type: 'object' },
    });

    let parsed = (result && typeof result.data === 'object' && result.data !== null) ? result.data : parseJSONFromAI(result?.content);
    if (!parsed) {
      // XCH-MI-1 (Wave 4): ONE bounded repair before the typed failure.
      log.warn('AI response could not be parsed as JSON — attempting one bounded repair');
      try {
        const retry = await ctx.callAI({
          provider: config.provider,
          model: config.model,
          systemPrompt: SYSTEM,
          messages: [
            ...promptMessages,
            { role: 'assistant', content: String(result?.content ?? '') },
            { role: 'user', content: 'Your previous reply was not parseable JSON. Return ONLY the JSON object the instructions describe — no prose, no code fences.' },
          ],
          temperature: 0,
          responseSchema: { type: 'object' },
        });
        parsed = (retry && typeof retry.data === 'object' && retry.data !== null) ? retry.data : parseJSONFromAI(retry?.content);
      } catch { /* fall through to the typed failure */ }
    }
    if (!parsed) {
      log.warn('AI response could not be parsed as JSON — failing typed (was: silent branded-placeholder fallback)');
      return { status: 'error', error: { code: 'AI_OUTPUT_UNPARSEABLE', message: 'AI response could not be parsed as JSON', retryable: true } };
    }
    if (!Array.isArray(parsed.headlines) || parsed.headlines.length === 0 || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
      return { status: 'error', error: { code: 'AI_OUTPUT_UNPARSEABLE', message: 'AI reply parsed but is missing the required headlines/sections content', retryable: true } };
    }
    headlines = parsed.headlines.slice(0, 5).map((h) => ({
      id: Ids.headline(),
      text: String(h.text ?? ''),
      angle: String(h.angle ?? 'benefit'),
    }));
    sections = parsed.sections.slice(0, RATE_LIMITS.MAX_SECTIONS_PER_PAGE).map((s) => ({
      id: Ids.section(),
      type: String(s.type ?? 'hero'),
      content: (s.content && typeof s.content === 'object') ? s.content : {},
      variants: [],
    }));
    if (Array.isArray(parsed.ctaVariants) && parsed.ctaVariants.length > 0) {
      ctaVariants = parsed.ctaVariants.slice(0, 5).map((c) => ({
        id: Ids.cta(),
        text: String(c.text ?? ''),
        style: String(c.style ?? 'primary'),
      }));
    } else {
      // Derive from the model's REAL content — a hero/cta section's ctaText —
      // never from a placeholder library.
      const derived = sections
        .map((s) => (s.content && typeof s.content.ctaText === 'string' ? s.content.ctaText : null))
        .filter((t) => t && t.trim());
      ctaVariants = derived.slice(0, 3).map((text) => ({ id: Ids.cta(), text, style: 'primary' }));
    }
    if (parsed.seoMetadata && typeof parsed.seoMetadata === 'object') {
      const seo = parsed.seoMetadata;
      seoMetadata = {
        title: String(seo.title ?? headlines[0].text),
        description: String(seo.description ?? ''),
        keywords: Array.isArray(seo.keywords) ? seo.keywords.filter((k) => typeof k === 'string') : [],
        ogTitle: String(seo.ogTitle ?? seo.title ?? headlines[0].text),
        ogDescription: String(seo.ogDescription ?? seo.description ?? ''),
      };
    } else {
      const hero = sections.find((s) => s.type === 'hero');
      const heroSub = hero && typeof hero.content.subheadline === 'string' ? hero.content.subheadline : '';
      seoMetadata = {
        title: headlines[0].text,
        description: heroSub,
        keywords: [],
        ogTitle: headlines[0].text,
        ogDescription: heroSub,
      };
    }
    log.info('AI content generation succeeded', {
      headlineCount: headlines.length,
      sectionCount: sections.length,
    });
  } catch (err) {
    log.warn('AI content generation failed — failing typed (was: silent branded-placeholder fallback)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 'error', error: { code: 'AI_GENERATION_FAILED', message: err instanceof Error ? err.message : String(err), retryable: true } };
  }

  if (sections.length > RATE_LIMITS.MAX_SECTIONS_PER_PAGE) {
    sections = sections.slice(0, RATE_LIMITS.MAX_SECTIONS_PER_PAGE);
  }

  const content = { headlines, sections, ctaVariants, seoMetadata };
  return {
    status: 'success',
    outputs: { content, headlines, sections, ctaVariants, seoMetadata, success: true },
  };
}

/* ─── 2. landing.structure.create ───────────────────────── */

export async function structureCreate(ctx) {
  const log = makeLog(ctx);
  const inputs = ctx.inputs ?? {};
  if (!inputs.content) {
    return { status: 'error', error: { code: 'MISSING_CONTENT', message: 'inputs.content is required', retryable: false } };
  }

  const pageId = Ids.page();
  const now = new Date().toISOString();
  const inSections = Array.isArray(inputs.content.sections) ? inputs.content.sections : [];
  const sections = inSections
    .slice(0, RATE_LIMITS.MAX_SECTIONS_PER_PAGE)
    .map((s, i) => ({
      id: Ids.section(),
      type: s.type,
      order: i + 1,
      content: s.content,
      style: {},
    }));

  const page = {
    id: pageId,
    name: 'New Landing Page',
    slug: generateSlug('new-landing-page'),
    status: 'draft',
    sections,
    theme: {
      id: inputs.themeId || 'default',
      colors: {},
      typography: {},
      spacing: {},
    },
    seo: inputs.content.seoMetadata,
    tracking: { pixelIds: [], events: [], utmLinks: [] },
    createdAt: now,
    updatedAt: now,
  };

  const layoutConfig = {
    template: inputs.templateId || 'standard',
    responsive: true,
    maxWidth: '1200px',
  };

  log.info('Page structure created', { pageId, sectionCount: sections.length });
  return { status: 'success', outputs: { pageId, page, sections, layoutConfig, success: true } };
}

/* ─── 3. landing.variants.generate ──────────────────────── */

export async function variantsGenerate(ctx) {
  ensureCallAI(ctx);
  const log = makeLog(ctx);
  const inputs = ctx.inputs ?? {};
  const config = ctx.config ?? {};

  if (!inputs.pageId || !inputs.page || !Array.isArray(inputs.personaIds) || inputs.personaIds.length === 0) {
    return {
      status: 'error',
      error: { code: 'INVALID_INPUTS', message: 'pageId + page + non-empty personaIds[] required', retryable: false },
    };
  }

  log.info('Generating persona variants', {
    pageId: inputs.pageId,
    personaCount: inputs.personaIds.length,
  });

  const variants = [];
  const variantIds = [];
  const personaMapping = {};

  const personaIds = inputs.personaIds.slice(0, RATE_LIMITS.MAX_VARIANTS_PER_PAGE);
  const trafficPerPersona = Math.floor(100 / personaIds.length);
  const inputSections = Array.isArray(inputs.page.sections) ? inputs.page.sections : [];

  for (const personaId of personaIds) {
    const variantId = Ids.variant(personaId);
    let variantName = `Variant for Persona ${personaId}`;
    // XCH-LP-1: when the AI leg fails, the variant is an IDENTITY COPY of the
    // page — real content, but NOT persona-customized. Say so instead of
    // presenting an uncustomized copy as an optimized variant.
    let customized = false;
    const variantSections = inputSections.map((s) => ({
      ...s,
      id: Ids.section(),
      personaId,
      content: { ...(s.content ?? {}) },
    }));

    try {
      const sectionSummary = inputSections.map((s) => ({
        type: s.type,
        contentKeys: Object.keys(s.content ?? {}),
      }));
      const result = await ctx.callAI({
        provider: config.provider,
        model: config.model,
        systemPrompt: 'You are a conversion optimization expert. Customize landing page content for a specific persona. Return ONLY JSON with keys: "variantName" (string), "sectionOverrides" (array of { "index": number, "content": object } where content has the same keys as the original section but with persona-customized values).',
        messages: [{
          role: 'user',
          content: `Customize this landing page for persona "${personaId}":\nSections: ${JSON.stringify(sectionSummary)}\nOriginal content preview: ${JSON.stringify(inputSections.map((s) => s.content)).substring(0, 1500)}`,
        }],
        temperature: 0.6,
        maxTokens: 2000,
      });
      const parsed = parseJSONFromAI(result?.content);
      if (parsed) {
        if (parsed.variantName) variantName = String(parsed.variantName);
        if (Array.isArray(parsed.sectionOverrides)) {
          for (const o of parsed.sectionOverrides) {
            const idx = Number(o.index);
            if (idx >= 0 && idx < variantSections.length && o.content && typeof o.content === 'object') {
              variantSections[idx] = {
                ...variantSections[idx],
                content: { ...variantSections[idx].content, ...o.content },
              };
              customized = true;
            }
          }
        }
      } else {
        log.warn('persona variant AI reply unparseable — emitting an UNCUSTOMIZED identity copy', { personaId });
      }
    } catch (err) {
      // identity copy already in variantSections
      log.warn('persona variant AI leg failed — emitting an UNCUSTOMIZED identity copy', { personaId, error: err instanceof Error ? err.message : String(err) });
    }

    variants.push({
      id: variantId,
      pageId: inputs.pageId,
      name: variantName,
      personaId,
      sections: variantSections,
      trafficPercentage: trafficPerPersona,
      customized,
    });
    variantIds.push(variantId);
    personaMapping[personaId] = variantId;
  }

  log.info('Persona variants generated', { variantCount: variants.length });
  return { status: 'success', outputs: { variants, variantIds, personaMapping, success: true } };
}

/* ─── 4. landing.theme.apply ────────────────────────────── */

const DEFAULT_THEME_TOKENS = {
  primary: '#3b82f6',
  secondary: '#6366f1',
  background: '#ffffff',
  text: '#1f2937',
  headingFont: 'Inter',
  bodyFont: 'Inter',
  sectionSpacing: '4rem',
  elementSpacing: '1rem',
};

export async function themeApply(ctx) {
  const log = makeLog(ctx);
  const inputs = ctx.inputs ?? {};
  if (!inputs.pageId || !inputs.page || !inputs.themeId) {
    return { status: 'error', error: { code: 'INVALID_INPUTS', message: 'pageId + page + themeId required', retryable: false } };
  }

  log.info('Applying theme to page', {
    pageId: inputs.pageId,
    themeId: inputs.themeId,
    variantCount: inputs.variants?.length ?? 0,
  });

  // Resolve theme tokens — caller-supplied DS or hard defaults.
  // DS shape mirrors MyndHyve's: { id, semantic: { light|dark: {primary, secondary, surface, onSurface} }, primitives: { typography, spacing } }
  const ds = inputs.designSystem;
  let theme;
  if (ds && ds.id === inputs.themeId) {
    const mode = (ds.effectiveMode === 'dark') ? 'dark' : 'light';
    const semantic = ds.semantic?.[mode] ?? {};
    const primitives = ds.primitives ?? {};
    theme = {
      id: inputs.themeId,
      colors: {
        primary: semantic.primary?.default ?? DEFAULT_THEME_TOKENS.primary,
        secondary: semantic.secondary?.default ?? DEFAULT_THEME_TOKENS.secondary,
        background: semantic.surface?.default ?? DEFAULT_THEME_TOKENS.background,
        text: semantic.onSurface?.default ?? DEFAULT_THEME_TOKENS.text,
      },
      typography: {
        heading: primitives.typography?.fontFamilies?.headline ?? DEFAULT_THEME_TOKENS.headingFont,
        body: primitives.typography?.fontFamilies?.body ?? DEFAULT_THEME_TOKENS.bodyFont,
      },
      spacing: {
        section: primitives.spacing?.[16] ?? DEFAULT_THEME_TOKENS.sectionSpacing,
        element: primitives.spacing?.[4] ?? DEFAULT_THEME_TOKENS.elementSpacing,
      },
    };
  } else {
    log.warn('Design system not provided, using defaults', { themeId: inputs.themeId });
    theme = {
      id: inputs.themeId,
      colors: {
        primary: DEFAULT_THEME_TOKENS.primary,
        secondary: DEFAULT_THEME_TOKENS.secondary,
        background: DEFAULT_THEME_TOKENS.background,
        text: DEFAULT_THEME_TOKENS.text,
      },
      typography: { heading: DEFAULT_THEME_TOKENS.headingFont, body: DEFAULT_THEME_TOKENS.bodyFont },
      spacing: { section: DEFAULT_THEME_TOKENS.sectionSpacing, element: DEFAULT_THEME_TOKENS.elementSpacing },
    };
  }

  const styledSections = (inputs.page.sections ?? []).map((s) => ({
    ...s,
    style: { ...(s.style ?? {}), themeId: inputs.themeId },
  }));
  const styledPage = { ...inputs.page, theme, sections: styledSections };
  const variants = inputs.variants ?? [];
  const styledVariants = variants.map((v) => ({
    ...v,
    sections: (v.sections ?? []).map((s) => ({
      ...s,
      style: { ...(s.style ?? {}), themeId: inputs.themeId },
    })),
  }));
  const appliedStyles = {
    themeId: inputs.themeId,
    appliedAt: new Date().toISOString(),
    affectedSections: styledSections.length,
    affectedVariants: styledVariants.length,
  };

  return { status: 'success', outputs: { styledPage, styledVariants, appliedStyles, success: true } };
}

/* ─── 5. landing.tracking.setup ─────────────────────────── */

function generateTrackingCode(pixelIds, events) {
  if (!pixelIds.length) return '';
  const sanitizedIds = pixelIds.filter((id) => /^[\w-]{1,64}$/.test(String(id)));
  const eventComments = events.map((e) => `  // ${e.name}: ${e.trigger}`).join('\n');
  return `<!-- Tracking Code -->\n<script>\n  // Google Analytics 4\n  gtag('config', '${sanitizedIds[0] || 'GA_MEASUREMENT_ID'}');\n\n  // Custom event tracking\n${eventComments}\n</script>`;
}

export async function trackingSetup(ctx) {
  const log = makeLog(ctx);
  const inputs = ctx.inputs ?? {};
  if (!inputs.pageId) {
    return { status: 'error', error: { code: 'MISSING_PAGE_ID', message: 'inputs.pageId required', retryable: false } };
  }

  log.info('Setting up tracking', { pageId: inputs.pageId });

  const integrations = Array.isArray(inputs.trackingIntegrations) ? inputs.trackingIntegrations : [];
  const trackingPixels = integrations.filter((i) => i.type === 'tracking-pixel' && i.enabled);
  const analyticsIntegrations = integrations.filter((i) => i.type === 'analytics' && i.enabled);
  const pixelIds = [
    ...analyticsIntegrations.map((i) => i.config?.measurementId),
    ...trackingPixels.map((i) => i.config?.pixelId),
  ].filter(Boolean);

  if (pixelIds.length === 0) {
    log.warn('No connected tracking pixels found, using empty configuration');
  }

  const events = [
    { id: Ids.trackingEvent(), name: 'PageView', trigger: 'page_load', properties: {} },
    { id: Ids.trackingEvent(), name: 'FormSubmit', trigger: 'form_submission', properties: {} },
    { id: Ids.trackingEvent(), name: 'CtaClick', trigger: 'button_click', properties: { button: 'cta' } },
    { id: Ids.trackingEvent(), name: 'Scroll50', trigger: 'scroll_depth', properties: { depth: 50 } },
    { id: Ids.trackingEvent(), name: 'Scroll90', trigger: 'scroll_depth', properties: { depth: 90 } },
  ];

  const campaignName = inputs.campaignId || 'default';
  const pageUrl = inputs.pageUrl || '';
  const utmLinks = [
    { id: Ids.utmLink(), source: 'google', medium: 'cpc', campaign: campaignName, url: `${pageUrl}?utm_source=google&utm_medium=cpc&utm_campaign=${encodeURIComponent(campaignName)}` },
    { id: Ids.utmLink(), source: 'meta', medium: 'paid_social', campaign: campaignName, url: `${pageUrl}?utm_source=meta&utm_medium=paid_social&utm_campaign=${encodeURIComponent(campaignName)}` },
    { id: Ids.utmLink(), source: 'email', medium: 'email', campaign: campaignName, url: `${pageUrl}?utm_source=email&utm_medium=email&utm_campaign=${encodeURIComponent(campaignName)}` },
  ];

  const trackingConfig = { pixelIds, events, utmLinks };
  const trackingCode = generateTrackingCode(pixelIds, events);

  return { status: 'success', outputs: { trackingConfig, pixelIds, events, utmLinks, trackingCode, success: true } };
}

/* ─── 6. landing.page.validate ──────────────────────────── */

export async function pageValidate(ctx) {
  const log = makeLog(ctx);
  const inputs = ctx.inputs ?? {};
  if (!inputs.pageId || !inputs.page) {
    return { status: 'error', error: { code: 'INVALID_INPUTS', message: 'pageId + page required', retryable: false } };
  }
  const { page } = inputs;
  const issues = [];

  // SEO checks
  let seoScore = 100;
  if (!page.seo?.title) {
    issues.push({ type: 'seo', severity: 'error', message: 'Page title is missing' });
    seoScore -= 20;
  }
  if (!page.seo?.description) {
    issues.push({ type: 'seo', severity: 'error', message: 'Meta description is missing' });
    seoScore -= 20;
  }
  const titleMaxLength = 60;
  if ((page.seo?.title?.length ?? 0) > titleMaxLength) {
    issues.push({ type: 'seo', severity: 'warning', message: `Title is too long (>${titleMaxLength} chars)` });
    seoScore -= 10;
  }

  // Accessibility checks
  let accessibilityScore = 100;
  const sections = Array.isArray(page.sections) ? page.sections : [];
  for (const section of sections) {
    if (section.type === 'hero' && !section.content?.headline) {
      issues.push({
        type: 'accessibility',
        severity: 'warning',
        message: 'Hero section should have a clear headline',
        location: section.id,
      });
      accessibilityScore -= 10;
    }
  }

  // Performance checks
  let performanceScore = 100;
  const maxSectionsForPerformance = 10;
  if (sections.length > maxSectionsForPerformance) {
    issues.push({ type: 'performance', severity: 'warning', message: 'Many sections may impact load time' });
    performanceScore -= 10;
  }

  const isValid = issues.filter((i) => i.severity === 'error').length === 0;

  if (seoScore < SCORING_THRESHOLDS.MIN_SEO_SCORE) {
    issues.push({ type: 'seo', severity: 'warning', message: `SEO score (${seoScore}) below minimum threshold (${SCORING_THRESHOLDS.MIN_SEO_SCORE})` });
  }
  if (accessibilityScore < SCORING_THRESHOLDS.MIN_ACCESSIBILITY_SCORE_AA) {
    issues.push({ type: 'accessibility', severity: 'warning', message: `Accessibility score (${accessibilityScore}) below minimum threshold (${SCORING_THRESHOLDS.MIN_ACCESSIBILITY_SCORE_AA})` });
  }
  if (performanceScore < SCORING_THRESHOLDS.MIN_PERFORMANCE_SCORE) {
    issues.push({ type: 'performance', severity: 'warning', message: `Performance score (${performanceScore}) below minimum threshold (${SCORING_THRESHOLDS.MIN_PERFORMANCE_SCORE})` });
  }

  const validationReport = { isValid, seoScore, accessibilityScore, performanceScore, issues };
  log.info('Page validation complete', { isValid, seoScore, accessibilityScore, performanceScore, issueCount: issues.length });
  return {
    status: 'success',
    outputs: { validationReport, isValid, seoScore, accessibilityScore, performanceScore, issues, success: true },
  };
}

/* ─── 7. landing.page.publish ───────────────────────────── */

export async function pagePublish(ctx) {
  const log = makeLog(ctx);
  const inputs = ctx.inputs ?? {};
  if (!inputs.pageId || !inputs.page) {
    return { status: 'error', error: { code: 'INVALID_INPUTS', message: 'pageId + page required', retryable: false } };
  }
  if (!inputs.approved) {
    return { status: 'error', error: { code: 'PAGE_NOT_APPROVED', message: 'Page not approved', retryable: false } };
  }

  log.info('Publishing page', {
    pageId: inputs.pageId,
    variantCount: inputs.variants?.length ?? 0,
    customDomain: inputs.customDomain,
  });

  const publishedAt = new Date().toISOString();
  const version = generateSecureId('v');
  const domain = inputs.customDomain || 'pages.myndhyve.ai';
  const page = inputs.page;
  const publishedUrl = `https://${domain}/${page.slug}`;
  const variants = Array.isArray(inputs.variants) ? inputs.variants : [];
  const variantUrls = variants.map(
    (v) => `https://${domain}/${page.slug}?variant=${encodeURIComponent(v.id)}`,
  );
  const cdnUrls = {
    css: `https://cdn.myndhyve.ai/pages/${inputs.pageId}/${version}/styles.css`,
    js: `https://cdn.myndhyve.ai/pages/${inputs.pageId}/${version}/scripts.js`,
    assets: `https://cdn.myndhyve.ai/pages/${inputs.pageId}/${version}/assets/`,
  };

  return { status: 'success', outputs: { publishedUrl, variantUrls, publishedAt, version, cdnUrls, success: true } };
}

/* ─── default export ────────────────────────────────────── */

export const nodes = {
  'landing.content.generate': contentGenerate,
  'landing.structure.create': structureCreate,
  'landing.variants.generate': variantsGenerate,
  'landing.theme.apply': themeApply,
  'landing.tracking.setup': trackingSetup,
  'landing.page.validate': pageValidate,
  'landing.page.publish': pagePublish,
};

export default nodes;
