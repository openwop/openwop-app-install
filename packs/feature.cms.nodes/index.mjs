/**
 * feature.cms.nodes — CMS feature nodes over the `ctx.features.cms` surface
 * (ADR 0064 Phase 3 / RFC 0103; write verbs ADR 0204 C6). Six action nodes:
 *
 *   get-page             reads a published page resolved for a target locale
 *                        (a tenant-store read — a side-effect → role:action).
 *   list-pages           an org's published pages (ids/slugs/titles).
 *   get-draft-page       a DRAFT page's raw sections — the edit-then-submit read.
 *   translate-section    drafts a sparse per-locale overlay for a section's
 *                        base data via the RUN-SCOPED provider (ctx.callAI) —
 *                        generation lives in the node, never in the surface.
 *   update-section-draft patches a DRAFT page's section (base or one locale
 *                        overlay) — draft-only, sanitized like an editor save.
 *   submit-page          submits a DRAFT for review with the SAME approval-
 *                        gate composition as the editor submit. A node can
 *                        draft and submit; it can NEVER publish.
 *
 * All record their outputs; replay/fork read the recorded result rather than
 * re-querying or re-generating. Pure-JS, Node-20 stdlib only.
 */

/** DEBT-3 — pack-local mirror of the providers.json SSoT default (the
 *  anthropic `recommended: true` model; src/providers/catalog.ts
 *  getDefaultModel). ctx.callAI REQUIRES an explicit model and standalone
 *  .mjs packs cannot import the catalog, so the default lives in this ONE
 *  greppable constant — the /refresh-model-catalog sweep updates it. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Resolve the CMS feature surface, or fail with the canonical capability error
 *  (workflow-register should refuse a workflow needing it on a host that doesn't
 *  expose it — ADR 0014 Phase 4 gating; this is the runtime backstop). */
function ensureCms(ctx) {
  const cms = ctx.features && ctx.features.cms;
  if (!cms || typeof cms.getPage !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.cms — the CMS feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.cms' },
    );
  }
  return cms;
}

/** Resolve the run-scoped provider, or fail with the canonical capability error. */
function ensureAi(ctx) {
  if (typeof ctx.callAI !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.callAI — translate-section requires aiProviders'),
      { code: 'host_capability_missing', capability: 'host.aiProviders' },
    );
  }
}

function str(v) { return typeof v === 'string' ? v : ''; }

/** Effective node arguments: static `config` (where chain params land —
 *  `{{inputs.*}}` are resolved per-run by the host) overlaid by edge-delivered
 *  `inputs` (edge data wins, e.g. an upstream node's overlay → `data`). */
function args(ctx) {
  const cfg = ctx.config && typeof ctx.config === 'object' ? ctx.config : {};
  const ins = ctx.inputs && typeof ctx.inputs === 'object' ? ctx.inputs : {};
  return { ...cfg, ...ins };
}

/** Name a BCP-47 tag as an English language name for the prompt (`pt-BR` →
 *  "Portuguese (Brazil)"); falls back to the tag. */
function languageName(locale) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

// Mirrors features/cms/translate.ts — the MyndHyve structure-preserving
// localization prompt (keep keys, don't translate URLs / media tokens /
// {{vars}}, return only JSON).
const SYSTEM_PROMPT =
  'You are a professional localization engine. You translate the VALUES of a JSON object into a target language, ' +
  'preserving the exact keys and structure. Rules: return ONLY the translated JSON object (no prose, no code fences); ' +
  'keep every key unchanged; do NOT translate URLs, media tokens, email addresses, or template variables like {{name}}; ' +
  'adapt marketing copy naturally for the target locale; never add or remove keys.';

/** Pull a JSON object out of a model completion — tolerant of code fences and
 *  surrounding prose. Returns `null` when nothing parseable is found (ADR 0592
 *  §7 — an unparseable completion is a TYPED failure trigger, never silently
 *  an empty overlay). */
function extractJSON(text) {
  if (typeof text !== 'string') return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function getPage(ctx) {
  const cms = ensureCms(ctx);
  const i = args(ctx);
  const out = await cms.getPage({
    orgId: str(i.orgId),
    slug: str(i.slug),
    ...(i.locale ? { locale: str(i.locale) } : {}),
  });
  return { status: 'success', outputs: { page: out.page ?? null, locale: out.locale ?? null } };
}

export async function listPages(ctx) {
  const cms = ensureCms(ctx);
  const i = args(ctx);
  const out = await cms.listPages({ orgId: str(i.orgId) });
  return { status: 'success', outputs: { pages: out.pages ?? [] } };
}

export async function translateSection(ctx) {
  ensureAi(ctx);
  const i = args(ctx);
  const data = i.data && typeof i.data === 'object' && !Array.isArray(i.data) ? i.data : {};
  const targetLocale = str(i.targetLocale);
  if (!targetLocale) {
    return { status: 'failed', error: { code: 'validation_error', message: 'targetLocale is required.' } };
  }
  const userPrompt = `Translate the values of this JSON content into ${languageName(targetLocale)} (${targetLocale}). ` +
    `Return ONLY the translated JSON with the same keys and structure:\n\n${JSON.stringify(data, null, 2)}`;
  const call = async (messages) => {
    const ai = await ctx.callAI({
      provider: str(i.provider) || 'anthropic',
      model: str(i.model) || DEFAULT_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      messages,
      ...(i.maxTokens ? { maxTokens: Number(i.maxTokens) } : {}),
    });
    return typeof ai.content === 'string' && ai.content.length > 0
      ? ai.content
      : (ai.data !== undefined ? JSON.stringify(ai.data) : '');
  };
  // Nothing to translate — an empty overlay is the correct answer, not a failure.
  if (Object.keys(data).length === 0) {
    return { status: 'success', outputs: { overlay: {}, targetLocale } };
  }
  // ADR 0592 §7 (CMSLWF-4) — invalid model output is a TYPED failure with ONE
  // bounded error-fed repair, never success-with-empty: the old
  // `overlay: extractJSON(raw)` shipped `{}` for garbage, and the failure then
  // surfaced one node LATE as the store node's `empty` (misattributed locus).
  const first = await call([{ role: 'user', content: userPrompt }]);
  let overlay = extractJSON(first);
  if (overlay === null || Object.keys(overlay).length === 0) {
    const second = await call([
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: first },
      { role: 'user', content: 'Your previous reply was not the required non-empty JSON object. Return ONLY the translated JSON object with exactly the same keys as the source — no prose, no code fences.' },
    ]);
    overlay = extractJSON(second);
    if (overlay === null || Object.keys(overlay).length === 0) {
      return {
        status: 'failed',
        error: {
          code: 'invalid_model_output',
          message: `The model did not return a usable ${targetLocale} translation (one bounded repair attempted).`,
        },
      };
    }
  }
  return { status: 'success', outputs: { overlay, targetLocale } };
}

// ── Governed write verbs (ADR 0204 C6) ──────────────────────────────────────
// Draft-only + submit-only: a node can DRAFT and SUBMIT; it can NEVER publish
// (publish stays a human action — route or ApprovalsInbox). The surface
// enforces the policy server-side; these are thin, recorded wrappers.

export async function getDraftPage(ctx) {
  const cms = ensureCms(ctx);
  if (typeof cms.getDraftPage !== 'function') {
    throw Object.assign(
      new Error('host ctx.features.cms does not expose getDraftPage — needs the ADR 0204 surface'),
      { code: 'host_capability_missing', capability: 'host.sample.cms' },
    );
  }
  const i = args(ctx);
  const out = await cms.getDraftPage({ orgId: str(i.orgId), pageId: str(i.pageId) });
  const page = out.page ?? null;
  // Optional convenience pick: when `sectionId` is provided, also expose that
  // section's base data on its own port — so a chain can wire it straight into
  // translate-section without an extraction step.
  const sectionId = str(i.sectionId);
  const section = sectionId && page ? (page.sections ?? []).find((s) => s.sectionId === sectionId) : null;
  return { status: 'success', outputs: { page, sectionData: section ? section.data : null } };
}

export async function updateSectionDraft(ctx) {
  const cms = ensureCms(ctx);
  if (typeof cms.updateSectionDraft !== 'function') {
    throw Object.assign(
      new Error('host ctx.features.cms does not expose updateSectionDraft — needs the ADR 0204 surface'),
      { code: 'host_capability_missing', capability: 'host.sample.cms' },
    );
  }
  const i = args(ctx);
  const data = i.data && typeof i.data === 'object' && !Array.isArray(i.data) ? i.data : {};
  const out = await cms.updateSectionDraft({
    orgId: str(i.orgId),
    pageId: str(i.pageId),
    sectionId: str(i.sectionId),
    ...(i.locale ? { locale: str(i.locale) } : {}),
    data,
  });
  // UX_UPGRADE-content R2 (CMS2-B4) — a REFUSAL is not a success. The surface
  // answers `{updated:false, reason:'not_found'|'section_not_found'|'empty'}`,
  // and this used to hand that straight back under `status:'success'` — with
  // `reason` not even declared in pack.json's outputs, so a chain author could
  // not branch on it if they wanted to. A chain `get-draft-page →
  // translate-section → update-section-draft → submit-page` run against a
  // deleted page reported every step green and wrote nothing.
  // The CHAT lane already fixed exactly this (`agentTools.ts` → toolError on
  // `!res.updated`); the node lane was left behind.
  // NOTE: `tarballLoader` discards `outputs` on a non-success return, so the
  // ERROR CODE is the only channel a chain actually receives — hence the reason
  // rides there rather than in a field a chain author would look for and never
  // find. (An earlier comment here claimed the outputs survived; they do not.)
  if (out && out.updated === false) {
    return { status: 'failed', error: { code: out.reason ?? 'not_updated', message: `The section was not updated (${out.reason ?? 'unknown reason'}).` } };
  }
  return { status: 'success', outputs: out };
}

export async function submitPage(ctx) {
  const cms = ensureCms(ctx);
  if (typeof cms.submitPage !== 'function') {
    throw Object.assign(
      new Error('host ctx.features.cms does not expose submitPage — needs the ADR 0204 surface'),
      { code: 'host_capability_missing', capability: 'host.sample.cms' },
    );
  }
  const i = args(ctx);
  const out = await cms.submitPage({ orgId: str(i.orgId), pageId: str(i.pageId) });
  // CMS2-B4 — same shape: `{submitted:false, reason:'not_found'}`. A green
  // terminal output saying the page was submitted for review, with no approval
  // row anywhere, is the worst version of this: the run reports a human gate
  // was entered that nobody will ever see.
  // Same: the reason rides the error CODE, which is what survives the loader.
  if (out && out.submitted === false) {
    return { status: 'failed', error: { code: out.reason ?? 'not_submitted', message: `The page was not submitted (${out.reason ?? 'unknown reason'}).` } };
  }
  return { status: 'success', outputs: out };
}

export const nodes = {
  'feature.cms.nodes.get-page': getPage,
  'feature.cms.nodes.list-pages': listPages,
  'feature.cms.nodes.translate-section': translateSection,
  'feature.cms.nodes.get-draft-page': getDraftPage,
  'feature.cms.nodes.update-section-draft': updateSectionDraft,
  'feature.cms.nodes.submit-page': submitPage,
};

export default nodes;
