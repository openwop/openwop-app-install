/**
 * ADR 0355 P1/P2 — platform copy limits AS DATA + the deterministic QA v2
 * helpers. Pack-local (packs are standalone .mjs — no backend imports):
 * limits table, per-field validation, token-Jaccard near-dup detection, and a
 * Flesch-style readability banding. All pure + deterministic (replay-safe).
 */

// ADR 0946 P1 (D3) — the caps and the near-duplicate check come from the ONE
// host channel spec table (backend/typescript/src/host/contentRules/), via a
// generated copy. Edit the table, then run scripts/gen-content-rules.mjs.
// LIMITS are the platforms' published hard maxima: over them, copy is
// regenerated and then truncated. RECOMMENDED lengths only warn: truncating
// to a recommendation when the platform allows more is a silent quality loss.
import {
  PLATFORM_LIMITS, PLATFORM_RECOMMENDED, SOCIAL_LIMITS, SOCIAL_RECOMMENDED, AD_FIELD_SCHEMA_MAX, findNearDuplicates,
} from './contentRules.generated.mjs';

export { PLATFORM_LIMITS, PLATFORM_RECOMMENDED, SOCIAL_LIMITS, SOCIAL_RECOMMENDED, AD_FIELD_SCHEMA_MAX, findNearDuplicates };

const norm = (p) => String(p ?? '').trim().toLowerCase();

/** Per-platform, per-field over-HARD-limit findings for an ad_variants draft.
 *  Each finding carries the platform SET index (`set`) so a fixer targets the
 *  exact offending set by INDEX — duplicate same-platform sets, or a raw
 *  platform string that only `norm()` maps, must never mis-target (QA-CODE-1). */
function adFindings(draft, table) {
  const findings = [];
  (Array.isArray(draft?.platformSets) ? draft.platformSets : []).forEach((set, si) => {
    const limits = table[norm(set.platform)];
    if (!limits) return;
    (Array.isArray(set.variants) ? set.variants : []).forEach((v, i) => {
      for (const field of ['headline', 'description']) {
        const text = typeof v?.[field] === 'string' ? v[field] : '';
        if (typeof limits[field] === 'number' && text.length > limits[field]) {
          findings.push({ platform: norm(set.platform), set: si, index: i, field, length: text.length, limit: limits[field] });
        }
      }
    });
  });
  return findings;
}

function postFindings(draft, table) {
  const findings = [];
  (Array.isArray(draft?.posts) ? draft.posts : []).forEach((p, i) => {
    const limit = table[norm(p?.platform)];
    const text = typeof p?.content === 'string' ? p.content : '';
    if (limit && text.length > limit) findings.push({ platform: norm(p.platform), index: i, field: 'content', length: text.length, limit });
  });
  return findings;
}

export function validateAdVariants(draft) {
  return adFindings(draft, PLATFORM_LIMITS);
}

/** Per-platform over-limit findings for a social_posts draft (hard caps). */
export function validateSocialPosts(draft) {
  return postFindings(draft, SOCIAL_LIMITS);
}

/** Over-RECOMMENDED findings (warn only; never regenerate or truncate). */
export function adVariantRecommendations(draft) {
  return adFindings(draft, PLATFORM_RECOMMENDED);
}

export function socialPostRecommendations(draft) {
  return postFindings(draft, SOCIAL_RECOMMENDED);
}

/** Word-boundary truncation WITH a flag — the last resort after a regen. */
export function truncateAt(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return { text, truncated: false };
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return { text: (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd(), truncated: true };
}

/** Flesch-style reading-ease approximation banded to easy|standard|technical.
 *  Deterministic; syllables approximated by vowel groups. */
export function readabilityBand(text) {
  const t = String(text ?? '');
  const sentences = Math.max(1, (t.match(/[.!?]+/g) ?? []).length);
  const words = (t.match(/[a-zA-Z0-9']+/g) ?? []);
  if (words.length === 0) return { band: 'standard', score: 60 };
  const syllables = words.reduce((n, w) => n + Math.max(1, (w.toLowerCase().match(/[aeiouy]+/g) ?? []).length), 0);
  const score = Math.round(206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllables / words.length));
  return { band: score >= 70 ? 'easy' : score >= 45 ? 'standard' : 'technical', score };
}

/** Claim extraction (the vendor pack's proof-requirement patterns): sentences
 *  carrying %/multiplier/superlative claims MUST carry a [src_N] citation. */
export function findUnsupportedClaims(text) {
  const t = String(text ?? '');
  const sentences = t.split(/(?<=[.!?])\s+/);
  const CLAIM = /(\d+(?:\.\d+)?%|\d+(?:\.\d+)?x\b|#1\b|number one|best[- ]in[- ]class)/i;
  const out = [];
  for (const s of sentences) {
    if (CLAIM.test(s) && !/\[src_\d+\]/i.test(s)) out.push(s.trim().slice(0, 160));
  }
  return out;
}

/** Salient-token containment floor for a superlative (non-numeric) claim —
 *  conservative (bias toward `supported`): only a claim whose salient words are
 *  largely absent from every chunk is `unsupported`. */
const CLAIM_SUPPORT_MIN_OVERLAP = 0.34;

/** Generic function words dropped before the containment overlap (superlative
 *  branch only). Claim-bearing words (best/class/number/one/faster…) are kept. */
const CLAIM_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'we', 'our', 'us', 'you', 'your',
  'it', 'its', 'this', 'that', 'these', 'those', 'with', 'for', 'and', 'or', 'to', 'of',
  'in', 'on', 'at', 'by', 'from', 'as', 'than',
]);

/**
 * ADR 0355 decision 2 (Option A) — deterministic PER-CLAIM verdict verification
 * against the ALREADY-RETRIEVED grounding contexts (`kb.rag` SearchHit[]), NOT a
 * second retrieval. Token-overlap is the accepted pack-local stand-in for an
 * embedding-cosine match (packs are standalone .mjs with zero backend imports —
 * the same normalization idiom as `findNearDuplicates` above). Pure + deterministic
 * (no wall-clock, no I/O), so it is replay-safe.
 *
 * Conservative by design (bias toward `supported`): a cited claim is `unsupported`
 * only when its quantified proof (a `%` / `×` token) — the strongest un-grounded
 * signal — appears in NO retrieved chunk; a superlative-only claim falls back to
 * salient-token containment against the best chunk at a low threshold.
 *
 * @param {Array<string>} claimTexts  per-field text (the same fields scoreQuality extracts)
 * @param {Array<{text?:string}>} contexts  kb.rag SearchHit[]; `[]` ⇒ nothing to support against
 * @returns {Array<{claim:string, verdict:'uncited'|'supported'|'unsupported'}>}
 */
export function verifyClaims(claimTexts, contexts) {
  const CLAIM = /(\d+(?:\.\d+)?%|\d+(?:\.\d+)?x\b|#1\b|number one|best[- ]in[- ]class)/i;
  const NUMERIC_CLAIM = /\d+(?:\.\d+)?%|\d+(?:\.\d+)?x\b/gi;
  const tokenize = (t) => String(t ?? '').toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const chunkSets = (Array.isArray(contexts) ? contexts : []).map((c) => new Set(tokenize(c && c.text)));
  const out = [];
  for (const field of Array.isArray(claimTexts) ? claimTexts : []) {
    if (typeof field !== 'string' || field.length === 0) continue;
    for (const raw of field.split(/(?<=[.!?])\s+/)) {
      if (!CLAIM.test(raw)) continue; // only claim-bearing sentences are verified — the rest are ignored
      const claim = raw.trim().slice(0, 160);
      if (!/\[src_\d+\]/i.test(raw)) { out.push({ claim, verdict: 'uncited' }); continue; }
      // Cited: the quantified proof token(s) MUST appear in some retrieved chunk.
      // Both marker and chunk go through the same tokenizer, so a marker matches a
      // chunk only when EVERY one of its tokens is present (consistent by source).
      const numericMarkers = (raw.match(NUMERIC_CLAIM) ?? []).map(tokenize).filter((mt) => mt.length > 0);
      if (numericMarkers.length > 0) {
        const grounded = numericMarkers.some((mt) => chunkSets.some((cs) => mt.every((t) => cs.has(t))));
        out.push({ claim, verdict: grounded ? 'supported' : 'unsupported' });
        continue;
      }
      // Superlative-only claim (#1 / number one / best-in-class): salient-token
      // containment in the best chunk (containment, not Jaccard — a short claim in
      // a long chunk would drown a Jaccard score; containment is the honest measure).
      const claimTokens = new Set(tokenize(raw.replace(/\[src_\d+\]/gi, '')).filter((t) => !CLAIM_STOPWORDS.has(t)));
      if (claimTokens.size === 0) { out.push({ claim, verdict: 'supported' }); continue; }
      let best = 0;
      for (const cs of chunkSets) {
        let inter = 0;
        for (const t of claimTokens) if (cs.has(t)) inter += 1;
        best = Math.max(best, inter / claimTokens.size);
      }
      out.push({ claim, verdict: best >= CLAIM_SUPPORT_MIN_OVERLAP ? 'supported' : 'unsupported' });
    }
  }
  return out;
}

/** The named iteration ops (ADR 0355 P3) — prompt transforms for a refine pass. */
export const ITERATION_OPS = {
  'more-like-this': 'Produce more variants in the same style and voice as the existing draft.',
  'add-urgency': 'Rework the copy to add time-bound urgency (deadlines, scarcity, momentum) without inventing offers.',
  'more-technical': 'Rework the copy for a technical evaluator: concrete specs, integration details, measurable outcomes.',
  'simplify': 'Rework the copy at a simpler reading level: shorter sentences, no jargon, one idea per sentence.',
  'shorten': 'Cut every piece to roughly half its length while keeping the claim and the call to action.',
};
