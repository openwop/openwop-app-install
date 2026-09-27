/**
 * feature.slides.nodes — the producer for ADR 0153 Phase 1 slide-deck canvases.
 * The `render` node normalizes a requested deck into the `canvas.slides` shape
 * ({ title?, theme?, slides[] }) and emits the typed `{ artifact }` output envelope
 * (ADR 0055/0083): the host run-output producer persists it with artifactTypeId
 * `canvas.slides` + the deck as the artifact CONTENT (JSON), and the chat workbench's
 * slides renderer (ADR 0153 Phase 0 registry) renders it inline.
 *
 * The content is CONSTRAINED TYPED JSON (the safe model-emits-against-a-schema
 * pattern), never executable code. The host artifact-type registry (ADR 0055) does
 * the authoritative AJV validation before the artifact.created event; this node does
 * lightweight structural normalization + fail-fast checks so a malformed deck never
 * reaches the registry as a silent empty render.
 *
 * Pure-JS, Node-20 stdlib only. No host capability.
 */

const LAYOUTS = new Set(['title', 'title-bullets', 'section', 'quote', 'image', 'blank', 'blocks']);
const THEMES = new Set(['default', 'light', 'dark', 'editorial', 'vibrant', 'brand']);
const VARIANTS = new Set(['full', 'hero', 'split', 'two-col']);
const TRANSITIONS = new Set(['none', 'fade', 'magic']);
// The closed BLOCK vocabulary — PINNED FALLBACK only (the chain tripwire test
// pins this list against SLIDE_BLOCKS so it cannot drift). XCH-SLIDES-1
// (Wave 3): on this host the prompts read the LIVE list via
// ctx.features['slides'].getCatalog() (the app-builder liveTypeList pattern);
// this literal serves hosts without the surface.
export const BLOCK_TYPES = 'heading, text, bullets, quote, callout, code, image, chart, table, statCard, divider, spacer';
const BLOCK_TYPE_SET = new Set(BLOCK_TYPES.split(', '));

/** XCH-SLIDES-1: the live closed type list from the feature surface, falling
 *  back to the pinned literal on hosts that don't expose it. */
async function liveBlockTypeList(ctx) {
  try {
    const s = ctx.features && ctx.features.slides;
    if (s && typeof s.getCatalog === 'function') {
      const cat = await s.getCatalog({});
      if (cat && typeof cat.blockTypeList === 'string' && cat.blockTypeList.length) return cat.blockTypeList;
    }
  } catch { /* fall through to the pinned literal */ }
  return BLOCK_TYPES;
}

/** Normalize one BLOCK ({type, props, children?}) against the closed catalog.
 *  Unknown types are DROPPED (closed world — the validator would 422 them). */
function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string' || !BLOCK_TYPE_SET.has(raw.type)) return null;
  const out = { type: raw.type };
  if (raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props)) {
    const props = {};
    for (const [k, v] of Object.entries(raw.props)) {
      if (typeof v === 'string') props[k] = v.slice(0, 4000);
      else if (Array.isArray(v)) props[k] = v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 400)).slice(0, 40);
      else if (typeof v === 'number' || typeof v === 'boolean') props[k] = v;
    }
    out.props = props;
  }
  if (Array.isArray(raw.children)) {
    const children = raw.children.map(normalizeBlock).filter(Boolean).slice(0, 40);
    if (children.length) out.children = children;
  }
  return out;
}

function fail(message) {
  return Object.assign(new Error(message), { code: 'validation_error' });
}

function safeParse(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}

function str(v, max) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return max && t.length > max ? t.slice(0, max) : t;
}

/** Normalize one slide to the closed `canvas.slides` slide shape. Unknown layouts
 *  fall back to a sensible default; unknown fields are dropped (closed schema). */
function normalizeSlide(raw, index) {
  if (!raw || typeof raw !== 'object') throw fail(`slide ${index} is not an object`);
  const layout = LAYOUTS.has(raw.layout) ? raw.layout : (Array.isArray(raw.bullets) && raw.bullets.length ? 'title-bullets' : 'title');
  const out = { layout };
  const title = str(raw.title, 240); if (title) out.title = title;
  const subtitle = str(raw.subtitle, 400); if (subtitle) out.subtitle = subtitle;
  if (Array.isArray(raw.bullets)) {
    const bullets = raw.bullets.map((b) => str(b, 400)).filter(Boolean).slice(0, 12);
    if (bullets.length) out.bullets = bullets;
  }
  const attribution = str(raw.attribution, 200); if (attribution) out.attribution = attribution;
  const imageUrl = str(raw.imageUrl, 2000); if (imageUrl) out.imageUrl = imageUrl;
  const notes = str(raw.notes, 4000); if (notes) out.notes = notes;
  // ADR 0328 P2-P5 fields (all closed-world; unknown values dropped).
  if (raw.background === 'accent' || raw.background === 'default') out.background = raw.background;
  if (typeof raw.skip === 'boolean') out.skip = raw.skip;
  if (typeof raw.transition === 'string' && TRANSITIONS.has(raw.transition)) out.transition = raw.transition;
  if (layout === 'blocks') {
    if (typeof raw.variant === 'string' && VARIANTS.has(raw.variant)) out.variant = raw.variant;
    if (typeof raw.build === 'boolean') out.build = raw.build;
    const blocks = Array.isArray(raw.blocks) ? raw.blocks.map(normalizeBlock).filter(Boolean).slice(0, 40) : [];
    out.blocks = blocks;
  }
  return out;
}

export async function render(ctx) {
  const i = ctx.inputs ?? {};
  // Accept the whole deck (`deck`), a JSON `source`, or loose `slides`+`title`+`theme`.
  const deckIn = (i.deck && typeof i.deck === 'object') ? i.deck
    : safeParse(i.source) ?? { slides: i.slides, title: i.title, theme: i.theme };

  const slidesIn = Array.isArray(deckIn.slides) ? deckIn.slides : null;
  if (!slidesIn || slidesIn.length === 0) {
    throw fail('`slides` is required — a non-empty array of { layout, title?, bullets?, ... }');
  }
  if (slidesIn.length > 100) throw fail('a deck may have at most 100 slides');

  const payload = { slides: slidesIn.map(normalizeSlide) };
  const title = str(deckIn.title, 200); if (title) payload.title = title;
  if (typeof deckIn.theme === 'string' && THEMES.has(deckIn.theme)) payload.theme = deckIn.theme;

  // Typed-artifact envelope (ADR 0055/0153) — the host producer reads
  // `artifact.{artifactTypeId,payload,title}` and persists a renderable run artifact.
  return {
    status: 'success',
    outputs: {
      slideCount: payload.slides.length,
      artifact: {
        artifactTypeId: 'canvas.slides',
        payload,
        ...(title ? { title } : {}),
      },
    },
  };
}

/* ── ADR 0328 Phase 6 — the slides.design chain nodes (the ADR 0325 shapes:
 *    provider-stamped ctx.callAI, soft-fail-loud enhancers, deterministic
 *    audit, everything re-normalized through the SAME closed-world gate). ── */

function ensureCallAI(ctx) {
  if (typeof ctx.callAI !== 'function') {
    const e = new Error('this host does not provide ctx.callAI (host.aiProviders)');
    e.code = 'host_capability_missing';
    throw e;
  }
}

/** RFC 0020 posture (mirrors core.openwop.ai): on an untrusted boundary,
 *  user-derived prompt content is wrapped in <UNTRUSTED> markers. */
function markUntrusted(ctx, text) {
  if (ctx.trustBoundary !== 'untrusted') return text;
  return text.includes('<UNTRUSTED>') ? text : `<UNTRUSTED>${text}</UNTRUSTED>`;
}

/** One BYOK call returning parsed JSON, or a diagnosable error (soft-fail —
 *  enhancers never kill the run). NEVER swallows the engine's SuspendSignal. */
async function tryAiJson(ctx, systemPrompt, userText) {
  try {
    const { provider, model, temperature, maxTokens } = ctx.config ?? {};
    const result = await ctx.callAI({
      provider,
      model,
      systemPrompt,
      messages: [{ role: 'user', content: markUntrusted(ctx, userText) }],
      ...(temperature !== undefined ? { temperature } : {}),
      maxTokens: maxTokens ?? 4000,
    });
    const parsed = safeParse(String(result.content ?? ''));
    return parsed && typeof parsed === 'object' ? { data: parsed } : { error: 'malformed JSON from the model' };
  } catch (err) {
    if (err && err.name === 'SuspendSignal') throw err;
    return { error: `${err?.code ?? 'ai_error'}: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}

/** Normalize a whole deck through the render gate (title/theme/slides). */
function normalizeDeck(deckIn) {
  const slidesIn = Array.isArray(deckIn?.slides) ? deckIn.slides : [];
  const payload = { slides: slidesIn.slice(0, 100).map(normalizeSlide) };
  const title = str(deckIn?.title, 200); if (title) payload.title = title;
  if (typeof deckIn?.theme === 'string' && THEMES.has(deckIn.theme)) payload.theme = deckIn.theme;
  return payload;
}

const deckArtifact = (payload) => ({
  artifactTypeId: 'canvas.slides',
  payload,
  ...(payload.title ? { title: payload.title } : {}),
});

/**
 * outline (P6) — ONE call turning the brief into a deck OUTLINE, emitted as a
 * SKELETON DECK artifact (one section slide per planned slide, the intent in
 * its notes) so the HITL outline gate previews it with the existing slides
 * renderer. The outline OBJECT rides its own port for the draft stage. The
 * outline is the paid checkpoint — a failure here FAILS the run (nothing
 * downstream is worth generating against a missing narrative).
 */
export async function outline(ctx) {
  ensureCallAI(ctx);
  const brief = str(ctx.inputs?.brief, 4000);
  if (!brief) throw fail('`brief` is required — what should this deck argue, to whom?');
  const attempt = await tryAiJson(
    ctx,
    'You are a presentation strategist. From the brief, output ONLY a JSON object (raw JSON, no prose, no code fences): { "title": string, "audience": string, "slides": [{ "name": string, "intent": string, "keyPoints": [string, ...] }] }. 5-12 slides. The narrative arc matters more than coverage: open with the ONE message, sequence a real argument, end with the ask. Names are short slide titles; intent is one sentence on what the slide must accomplish; keyPoints are 2-4 concrete points (specific, never placeholder).',
    `BRIEF:\n${brief}`,
  );
  if (attempt.error || !Array.isArray(attempt.data?.slides) || attempt.data.slides.length === 0) {
    throw fail(`outline generation failed: ${attempt.error ?? 'no slides in the outline'}`);
  }
  const o = attempt.data;
  const planned = o.slides.slice(0, 20).map((sl, i) => ({
    name: str(sl?.name, 80) ?? `Slide ${i + 1}`,
    intent: str(sl?.intent, 300) ?? '',
    keyPoints: Array.isArray(sl?.keyPoints) ? sl.keyPoints.map((k) => str(k, 200)).filter(Boolean).slice(0, 4) : [],
  }));
  const skeleton = normalizeDeck({
    title: str(o.title, 200) ?? 'Untitled deck',
    theme: 'default',
    slides: planned.map((sl) => ({
      layout: 'section',
      title: sl.name,
      notes: [sl.intent, ...sl.keyPoints.map((k) => `• ${k}`)].filter(Boolean).join('\n'),
    })),
  });
  return {
    status: 'success',
    outputs: {
      // The gate binds this WHOLE map: `.artifact` drives the typed preview;
      // NO top-level string outputs (they would become junk picker options).
      artifact: deckArtifact(skeleton),
      outline: { title: skeleton.title, audience: str(o.audience, 200) ?? '', slides: planned },
      slideCount: planned.length,
    },
  };
}

/**
 * draft (P6) — ONE call expanding the APPROVED outline into a full blocks-based
 * deck against the closed block catalog, re-normalized through the same gate
 * the render node uses. The paid core — a failure fails the run.
 */
export async function draft(ctx) {
  ensureCallAI(ctx);
  const o = ctx.inputs?.outline;
  if (!o || typeof o !== 'object' || !Array.isArray(o.slides) || o.slides.length === 0) {
    throw fail('`outline` is required — run the outline stage first');
  }
  const blockTypes = await liveBlockTypeList(ctx);
  const attempt = await tryAiJson(
    ctx,
    `You are a slide designer. Expand the outline you are given into a complete deck. Output ONLY a JSON object (raw JSON, no prose, no code fences): { "title": string, "theme": "default"|"light"|"dark"|"editorial"|"vibrant", "slides": [{ "layout": "blocks", "variant": "full"|"hero"|"split"|"two-col", "blocks": [{ "type": string, "props": object }], "notes": string, "background": "default"|"accent" }] }. Use ONLY these block types: ${blockTypes}. Props by type: heading{buildTiming:"after"|"with",text,level:"1"|"2"|"3"}, text{buildTiming:"after"|"with",text,size:"sm"|"md"|"lg",tone:"default"|"muted"|"accent"}, bullets{buildTiming:"after"|"with",items:[string]}, quote{buildTiming:"after"|"with",text,attribution}, callout{buildTiming:"after"|"with",text,tone:"info"|"success"|"warning"|"danger"}, code{buildTiming:"after"|"with",text,language:"text"|"js"|"ts"|"python"|"json"|"bash"|"sql"}, image{buildTiming:"after"|"with",src,fit:"cover"|"contain",caption}, chart{buildTiming:"after"|"with",spec: a JSON string like {"chartType":"bar","title":string,"data":{"labels":[...],"datasets":[{"data":[...]}]}}}, table{buildTiming:"after"|"with",columns:"a, b",rows:"1, 2\\n3, 4"}, statCard{buildTiming:"after"|"with",label,value,delta,tone:"default"|"success"|"warning"|"danger"}, divider{buildTiming:"after"|"with"}, spacer{buildTiming:"after"|"with",size:"sm"|"md"|"lg"}. buildTiming = build timing when the slide build toggle is on: "after" starts a new step (default), "with" appears together with the previous block. One slide per outline entry, same order. VARIANT: 'hero' for the opener and section turns, 'split' when an image or chart pairs with text, 'two-col' for dense comparisons, else 'full'. CONTENT: expand every keyPoint into real, specific copy — plausible numbers, named things, NEVER placeholder text. 2-6 blocks per slide. NOTES: 2-4 spoken sentences per slide carrying the intent. Set background:"accent" on at most 2 emphasis slides.`,
    `OUTLINE:\n${JSON.stringify(o).slice(0, 12000)}`,
  );
  if (attempt.error || !Array.isArray(attempt.data?.slides) || attempt.data.slides.length === 0) {
    throw fail(`draft generation failed: ${attempt.error ?? 'no slides in the draft'}`);
  }
  let payload = normalizeDeck({ title: attempt.data.title ?? o.title, theme: attempt.data.theme, slides: attempt.data.slides });

  // XCH-SLIDES-2 (LLM-EXCHANGE-AUDIT Wave 4): ONE bounded repair — when the
  // host exposes the slides surface and the normalized deck still fails
  // closed-world validation, feed the validator's errors back to the model
  // (the workflow-author/app-builder pattern) instead of shipping a deck the
  // artifact registry will reject.
  try {
    const s = ctx.features && ctx.features.slides;
    if (s && typeof s.validate === 'function') {
      const v = await s.validate({ deck: payload });
      if (!v.ok && Array.isArray(v.errors) && v.errors.length) {
        const errorList = v.errors.slice(0, 10).map((e) => `${e.path}: ${e.message}`).join('\n');
        const repair = await tryAiJson(
          ctx,
          `You are a slide designer FIXING an invalid deck. Output ONLY the corrected full deck JSON object (same shape as before). Use ONLY these block types: ${blockTypes}. Fix ALL of the listed validation errors; change nothing else.`,
          `INVALID DECK:\n${JSON.stringify(payload).slice(0, 12000)}\n\nVALIDATION ERRORS:\n${errorList}`,
        );
        if (!repair.error && Array.isArray(repair.data?.slides) && repair.data.slides.length) {
          const repaired = normalizeDeck({ title: repair.data.title ?? payload.title, theme: repair.data.theme ?? payload.theme, slides: repair.data.slides });
          const rv = await s.validate({ deck: repaired });
          if (rv.ok) payload = repaired;
        }
      }
    }
  } catch { /* validation unavailable — the artifact registry stays the gate */ }

  return { status: 'success', outputs: { artifact: deckArtifact(payload), slideCount: payload.slides.length } };
}

/**
 * deepen (P6) — the ADR 0325 per-item regeneration: pick the ≤maxSlides
 * THINNEST blocks slides (block count under the threshold), one call per
 * slide sequentially, each re-normalized through the SAME closed-world gate;
 * a per-slide failure keeps the original. Soft-fail-loud enhancer.
 */
export async function deepen(ctx) {
  ensureCallAI(ctx);
  const artifactIn = ctx.inputs?.artifact;
  const payloadIn = artifactIn && typeof artifactIn === 'object' ? artifactIn.payload : null;
  if (!payloadIn || !Array.isArray(payloadIn.slides)) throw fail('`artifact` (a canvas.slides envelope) is required');
  // Deep-clone: the scheduler delivers outputs BY REFERENCE (the ADR 0325 lesson).
  const payload = JSON.parse(JSON.stringify(payloadIn));
  const cfg = ctx.config ?? {};
  const maxSlides = Math.max(0, Math.min(4, Number.isFinite(Number(cfg.maxSlides)) ? Number(cfg.maxSlides) : 3));
  const minBlocks = Number.isFinite(Number(cfg.minBlocks)) ? Number(cfg.minBlocks) : 3;
  const thin = payload.slides
    .map((sl, i) => ({ sl, i, n: sl.layout === 'blocks' ? (sl.blocks?.length ?? 0) : Infinity }))
    .filter((x) => x.n < minBlocks)
    .sort((a, b) => a.n - b.n)
    .slice(0, maxSlides);
  const warnings = [];
  let improved = 0;
  const blockTypes = await liveBlockTypeList(ctx);
  for (const { sl, i } of thin) {
    const attempt = await tryAiJson(
      ctx,
      `You are a slide designer enriching ONE thin slide. Output ONLY a JSON object for the improved slide (raw JSON): { "layout": "blocks", "variant": string, "blocks": [...], "notes": string }. Use ONLY these block types: ${blockTypes}. Keep the slide's message; add substance (a statCard, a chart spec, tighter bullets), 3-6 blocks. Never placeholder text.`,
      `DECK TITLE: ${payload.title ?? ''}\nSLIDE ${i + 1} (name: ${sl.title ?? ''}):\n${JSON.stringify(sl).slice(0, 4000)}`,
    );
    if (attempt.error || !Array.isArray(attempt.data?.blocks)) {
      warnings.push(`slide ${i + 1}: ${attempt.error ?? 'no blocks returned'}`);
      continue;
    }
    // Keep the original speaker notes unless the model wrote real ones —
    // an empty/absent notes field must not erase them through the merge.
    const enriched = { ...sl, ...attempt.data, layout: 'blocks' };
    if (!str(attempt.data.notes, 1)) enriched.notes = sl.notes;
    const normalized = normalizeSlide(enriched, i);
    if ((normalized.blocks?.length ?? 0) > (sl.blocks?.length ?? 0)) {
      payload.slides[i] = normalized;
      improved += 1;
    } else {
      warnings.push(`slide ${i + 1}: enrichment did not add substance — kept the original`);
    }
  }
  const outputs = { artifact: deckArtifact(payload), deepened: improved };
  if (thin.length > 0 && improved === 0) outputs.warning = `deepen improved nothing (${warnings.join('; ') || 'no thin slides enriched'})`;
  else if (warnings.length) outputs.warning = `deepen partial: ${warnings.join('; ')}`;
  return { status: 'success', outputs };
}

/**
 * notes (P6) — speaker-notes generation for slides missing them, ONE call for
 * the whole deck (cost honesty). Soft-fail-loud enhancer: the deck passes
 * through unchanged on failure.
 */
export async function notes(ctx) {
  ensureCallAI(ctx);
  const artifactIn = ctx.inputs?.artifact;
  const payloadIn = artifactIn && typeof artifactIn === 'object' ? artifactIn.payload : null;
  if (!payloadIn || !Array.isArray(payloadIn.slides)) throw fail('`artifact` (a canvas.slides envelope) is required');
  const payload = JSON.parse(JSON.stringify(payloadIn));
  const missing = payload.slides.map((sl, i) => ({ sl, i })).filter((x) => !str(x.sl.notes, 1));
  if (missing.length === 0) {
    return { status: 'success', outputs: { artifact: deckArtifact(payload), notesAdded: 0 } };
  }
  const attempt = await tryAiJson(
    ctx,
    'You are a speech coach. For each numbered slide you are given, write 2-4 spoken sentences of speaker notes (what the presenter SAYS — not a caption). Output ONLY a JSON object: { "notes": { "<slideIndex>": string, ... } } with the SAME indices you were given.',
    missing.map(({ sl, i }) => `SLIDE ${i}: ${JSON.stringify({ title: sl.title, blocks: sl.blocks, bullets: sl.bullets }).slice(0, 1500)}`).join('\n\n'),
  );
  let added = 0;
  if (!attempt.error && attempt.data?.notes && typeof attempt.data.notes === 'object') {
    for (const { sl, i } of missing) {
      const n = str(attempt.data.notes[String(i)], 4000);
      if (n) { sl.notes = n; added += 1; }
    }
  }
  const outputs = { artifact: deckArtifact(payload), notesAdded: added };
  if (added === 0) outputs.warning = `notes generation failed: ${attempt.error ?? 'model returned no usable notes'}`;
  return { status: 'success', outputs };
}

/**
 * audit (P6) — DETERMINISTIC, zero AI: narrative/consistency checks the
 * validator deliberately does not own. Never re-implements validateSlidesDoc.
 * Passes the artifact THROUGH (the review gate's binding needs it) and keeps
 * every string INSIDE `report` (no junk picker options on the gate).
 */
export function audit(ctx) {
  const artifactIn = ctx.inputs?.artifact;
  const payload = artifactIn && typeof artifactIn === 'object' ? artifactIn.payload : null;
  if (!payload || !Array.isArray(payload.slides)) throw fail('`artifact` (a canvas.slides envelope) is required');
  const findings = [];
  const slides = payload.slides;
  const titles = new Map();
  slides.forEach((sl, i) => {
    const label = `slide ${i + 1}`;
    if (!sl || typeof sl !== 'object' || Array.isArray(sl)) {
      findings.push({ code: 'empty_slide', severity: 'high', message: `${label} is not a slide object` });
      return;
    }
    const hasContent = Boolean(str(sl.title, 1) || str(sl.subtitle, 1) || (sl.bullets?.length) || (sl.blocks?.length) || str(sl.imageUrl, 1) || str(sl.attribution, 1));
    if (!hasContent && sl.layout !== 'blank') findings.push({ code: 'empty_slide', severity: 'high', message: `${label} has no content` });
    const t = str(sl.title, 240);
    if (t) {
      const k = t.toLowerCase();
      if (titles.has(k)) findings.push({ code: 'duplicate_title', severity: 'low', message: `${label} repeats the title of slide ${titles.get(k) + 1}` });
      else titles.set(k, i);
    }
    if (Array.isArray(sl.bullets) && sl.bullets.length > 7) findings.push({ code: 'bullet_overload', severity: 'medium', message: `${label} has ${sl.bullets.length} bullets — split it` });
    if (sl.layout === 'blocks' && (sl.blocks?.length ?? 0) > 8) findings.push({ code: 'block_overload', severity: 'medium', message: `${label} has ${sl.blocks.length} blocks — split it` });
    if (!str(sl.notes, 1)) findings.push({ code: 'missing_notes', severity: 'low', message: `${label} has no speaker notes` });
  });
  if (slides.length < 3) findings.push({ code: 'deck_too_small', severity: 'medium', message: `only ${slides.length} slide(s) — a narrative needs an opening, an argument, and an ask` });
  if (slides.length > 0 && slides.every((sl) => sl.skip === true)) findings.push({ code: 'all_skipped', severity: 'high', message: 'every slide is marked skip — the show would be empty' });
  const deepenWarning = str(ctx.inputs?.deepenWarning, 500);
  if (deepenWarning) findings.push({ code: 'deepen_skipped', severity: 'medium', message: deepenWarning });
  const notesWarning = str(ctx.inputs?.notesWarning, 500);
  if (notesWarning) findings.push({ code: 'notes_skipped', severity: 'medium', message: notesWarning });
  const penalty = { high: 25, medium: 10, low: 3 };
  const score = Math.max(0, 100 - findings.reduce((acc, f) => acc + (penalty[f.severity] ?? 5), 0));
  return {
    status: 'success',
    outputs: {
      artifact: deckArtifact(payload),
      report: {
        score,
        findings,
        summary: findings.length ? `${findings.length} finding(s), score ${score}/100` : `clean, score ${score}/100`,
      },
    },
  };
}

/**
 * restyle (P6 / research S8) — re-theme an existing deck WITHOUT touching its
 * content: ONE call returns ONLY style fields (theme + per-slide variant/
 * background/transition), applied onto the input deck. Content preservation
 * is BY CONSTRUCTION — the model's content fields are never read.
 */
export async function restyle(ctx) {
  ensureCallAI(ctx);
  const i = ctx.inputs ?? {};
  const deckIn = (i.deck && typeof i.deck === 'object') ? i.deck
    : (i.artifact && typeof i.artifact === 'object' ? i.artifact.payload : safeParse(i.source));
  if (!deckIn || !Array.isArray(deckIn.slides) || deckIn.slides.length === 0) {
    throw fail('a deck is required (`deck`, `artifact`, or `source` JSON)');
  }
  const direction = str(i.direction, 500) ?? 'more polished and cohesive';
  const payload = normalizeDeck(deckIn);
  const attempt = await tryAiJson(
    ctx,
    'You are an art director restyling a deck WITHOUT changing its content. Output ONLY a JSON object: { "theme": "default"|"light"|"dark"|"editorial"|"vibrant"|"brand", "slides": [{ "variant": "full"|"hero"|"split"|"two-col", "background": "default"|"accent", "transition": "none"|"fade"|"magic" }] } — one entry per slide, SAME order and count as given. Choose for rhythm: hero for turns, accent sparingly (max 2), one transition style used consistently.',
    `DIRECTION: ${direction}\nDECK (${payload.slides.length} slides):\n${JSON.stringify(payload).slice(0, 10000)}`,
  );
  let applied = 0;
  if (!attempt.error && attempt.data && typeof attempt.data === 'object') {
    const d = attempt.data;
    if (typeof d.theme === 'string' && THEMES.has(d.theme)) { payload.theme = d.theme; applied += 1; }
    if (Array.isArray(d.slides)) {
      payload.slides.forEach((sl, idx) => {
        const st = d.slides[idx];
        if (!st || typeof st !== 'object') return;
        if (sl.layout === 'blocks' && typeof st.variant === 'string' && VARIANTS.has(st.variant)) { sl.variant = st.variant; applied += 1; }
        if (st.background === 'accent' || st.background === 'default') { sl.background = st.background; applied += 1; }
        if (typeof st.transition === 'string' && TRANSITIONS.has(st.transition)) { sl.transition = st.transition; applied += 1; }
      });
    }
  }
  const outputs = { artifact: deckArtifact(payload), restyled: applied };
  if (applied === 0) outputs.warning = `restyle applied nothing: ${attempt.error ?? 'model returned no usable style fields'}`;
  return { status: 'success', outputs };
}

export const nodes = {
  'feature.slides.nodes.render': render,
  'feature.slides.nodes.outline': outline,
  'feature.slides.nodes.draft': draft,
  'feature.slides.nodes.deepen': deepen,
  'feature.slides.nodes.notes': notes,
  'feature.slides.nodes.audit': audit,
  'feature.slides.nodes.restyle': restyle,
};
