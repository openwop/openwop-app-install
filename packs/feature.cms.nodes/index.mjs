/**
 * feature.cms.nodes — CMS feature nodes over the `ctx.features.cms` surface
 * (ADR 0064 Phase 3 / RFC 0103). Two action nodes:
 *
 *   get-page          reads a published page resolved for a target locale
 *                     (a tenant-store read — a side-effect → role:action).
 *   translate-section drafts a sparse per-locale overlay for a section's base
 *                     data via the RUN-SCOPED provider (ctx.callAI) — generation
 *                     lives in the node, never in the read-only surface.
 *
 * Both record their outputs; replay/fork read the recorded result rather than
 * re-querying or re-generating. Pure-JS, Node-20 stdlib only. The translate
 * overlay is sanitized on persist (the page PATCH write path), not here.
 */

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
 *  surrounding prose. Returns `{}` when nothing parseable is found. */
function extractJSON(text) {
  if (typeof text !== 'string') return {};
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return {};
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function getPage(ctx) {
  const cms = ensureCms(ctx);
  const i = ctx.inputs ?? {};
  const out = await cms.getPage({
    orgId: str(i.orgId),
    slug: str(i.slug),
    ...(i.locale ? { locale: str(i.locale) } : {}),
  });
  return { status: 'success', outputs: { page: out.page ?? null, locale: out.locale ?? null } };
}

export async function listPages(ctx) {
  const cms = ensureCms(ctx);
  const i = ctx.inputs ?? {};
  const out = await cms.listPages({ orgId: str(i.orgId) });
  return { status: 'success', outputs: { pages: out.pages ?? [] } };
}

export async function translateSection(ctx) {
  ensureAi(ctx);
  const i = ctx.inputs ?? {};
  const data = i.data && typeof i.data === 'object' && !Array.isArray(i.data) ? i.data : {};
  const targetLocale = str(i.targetLocale);
  if (!targetLocale) {
    return { status: 'failed', error: { code: 'validation_error', message: 'targetLocale is required.' } };
  }
  const ai = await ctx.callAI({
    provider: str(i.provider) || 'anthropic',
    model: str(i.model) || 'claude-sonnet-4-6',
    systemPrompt: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Translate the values of this JSON content into ${languageName(targetLocale)} (${targetLocale}). ` +
        `Return ONLY the translated JSON with the same keys and structure:\n\n${JSON.stringify(data, null, 2)}`,
    }],
    ...(i.maxTokens ? { maxTokens: Number(i.maxTokens) } : {}),
  });
  const raw = typeof ai.content === 'string' && ai.content.length > 0
    ? ai.content
    : (ai.data !== undefined ? JSON.stringify(ai.data) : '');
  return { status: 'success', outputs: { overlay: extractJSON(raw), targetLocale } };
}

export const nodes = {
  'feature.cms.nodes.get-page': getPage,
  'feature.cms.nodes.list-pages': listPages,
  'feature.cms.nodes.translate-section': translateSection,
};

export default nodes;
