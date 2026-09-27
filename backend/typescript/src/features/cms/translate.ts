/**
 * AI section translation (ADR 0064 Phase 3) — "translate from base".
 *
 * Ports the MyndHyve translation prompt (JSON-in / JSON-out, structure-preserving)
 * and runs it through the host's MANAGED (free-tier) provider seam — the
 * zero-config path for a reference host; no BYOK key required. The model's
 * output is parsed and then **sanitized through the same per-locale overlay
 * cleaner as a stored localization**, so an AI translation can never introduce
 * stored-XSS or an open-redirect. The result is a draft overlay the editor
 * reviews before saving (review-then-save).
 *
 * This is a synchronous one-shot utility (a short translate), not a long
 * workflow — so it dispatches in-route via the headless-provider resolver
 * (`resolveHeadlessAi`, ADR 0110) rather than standing up a node-pack/run. If
 * no text-capable provider is available (managed not configured / rate-capped /
 * sign-in required, and no BYOK default), the caller degrades to
 * copy-from-base + manual editing.
 */

import { resolveHeadlessAi } from '../../host/headlessAi.js';
import { OpenwopError } from '../../types.js';
import type { ChatMessage } from '../../providers/dispatch.js';
import { sanitizeSectionOverlay, type SectionType } from './cmsService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('feature.cms.translate');
const MAX_TOKENS = 2000;

const SYSTEM_PROMPT =
  'You are a professional localization engine. You translate the VALUES of a JSON object into a target language, ' +
  'preserving the exact keys and structure. Rules: return ONLY the translated JSON object (no prose, no code fences); ' +
  'keep every key unchanged; do NOT translate URLs, media tokens, email addresses, or template variables like {{name}}; ' +
  'adapt marketing copy naturally for the target locale; never add or remove keys.';

/** Name a BCP-47 tag as an English language name for the prompt (`pt-BR` →
 *  "Portuguese (Brazil)"); falls back to the tag. */
function languageName(locale: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

export function buildTranslationPrompt(data: Record<string, unknown>, targetLocale: string): string {
  return `Translate the values of this JSON content into ${languageName(targetLocale)} (${targetLocale}). ` +
    `Return ONLY the translated JSON with the same keys and structure:\n\n${JSON.stringify(data, null, 2)}`;
}

/** Pull a JSON object out of a model completion — tolerant of code fences and
 *  surrounding prose. Returns `{}` when nothing parseable is found. Prefer
 *  {@link extractJSONStrict} on authoring paths: `{}` conflates "the model
 *  returned an empty object" with "the completion was unparseable garbage",
 *  which is exactly the success-with-empty shape ADR 0592 §7 retires. */
export function extractJSON(text: string): Record<string, unknown> {
  return extractJSONStrict(text) ?? {};
}

/** ADR 0592 §7 (CMSL-2/CMSLWF-4) — like {@link extractJSON} but HONEST about
 *  failure: `null` = no JSON object could be extracted (a typed-failure/repair
 *  trigger, never silently an empty overlay). */
function extractJSONStrict(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  // Strip a ```json … ``` (or bare ```) fence if present.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Translate a section's base `data` into `targetLocale`, returning a sanitized
 * overlay (only the fields the model produced, cleaned). Throws if the managed
 * provider is unavailable — the route maps that to a 503 and the editor
 * degrades to manual translation.
 */
export async function translateSectionData(
  tenantId: string,
  sectionType: SectionType,
  data: Record<string, unknown>,
  targetLocale: string,
): Promise<Record<string, unknown>> {
  // Nothing to translate — an empty overlay is the CORRECT answer for empty
  // input, not a failure (the sweep already skips empty sections; this guards
  // direct route callers).
  if (Object.keys(data).length === 0) return {};
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildTranslationPrompt(data, targetLocale) },
  ];
  // ADR 0110 OQ-C: route through the single headless-provider resolver instead of a
  // hardcoded managed dispatch. For 'text' the managed provider always qualifies, so this is
  // behaviourally identical to before, plus a BYOK-default fallback if managed is unavailable.
  const dispatch = await resolveHeadlessAi(tenantId, 'text');
  if (!dispatch) throw new OpenwopError('internal_error', 'No text-capable AI provider is available for translation.', 503, {});

  // ADR 0592 §7 (CMSL-2/CMSLWF-4) — invalid model output is a TYPED failure
  // with ONE bounded error-fed repair (the app-builder authoring-path shape),
  // never success-with-empty: `{overlay:{}}` from unparseable garbage told the
  // editor "reviewed and empty" and the chain lane failed one node late with a
  // misattributed `empty`.
  const attempt = (completion: string): { ok: true; overlay: Record<string, unknown> } | { ok: false; reason: 'unparseable' | 'empty_object' | 'all_keys_dropped' } => {
    const extracted = extractJSONStrict(completion);
    if (extracted === null) return { ok: false, reason: 'unparseable' };
    if (Object.keys(extracted).length === 0) return { ok: false, reason: 'empty_object' };
    const overlay = sanitizeSectionOverlay(sectionType, extracted);
    if (Object.keys(overlay).length === 0) return { ok: false, reason: 'all_keys_dropped' };
    // XCH-CMS-1 (LLM-EXCHANGE-AUDIT Wave 5): a PARTIAL key drop stays a warn —
    // observable, sanitize-gated, human-reviewed.
    const droppedKeys = Object.keys(extracted).filter((k) => !(k in overlay));
    if (droppedKeys.length) {
      log.warn('translate_overlay_keys_dropped', { sectionType, targetLocale, droppedKeys: droppedKeys.slice(0, 20) });
    }
    return { ok: true, overlay };
  };

  const first = await dispatch(messages, { maxTokens: MAX_TOKENS });
  let result = attempt(first);
  if (!result.ok) {
    // ONE error-fed repair: feed the bad completion back with the specific
    // failure so the model can correct it. Bounded — a second failure is final.
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: first },
      {
        role: 'user',
        content: result.reason === 'all_keys_dropped'
          ? `Your previous reply used keys that do not exist in the source JSON. Return ONLY the translated JSON object with EXACTLY the same keys as the source (no prose, no code fences, no new keys).`
          : `Your previous reply was not a valid JSON object. Return ONLY the translated JSON object with exactly the same keys as the source — no prose, no code fences.`,
      },
    ];
    const second = await dispatch(repairMessages, { maxTokens: MAX_TOKENS });
    result = attempt(second);
    if (!result.ok) {
      throw new OpenwopError(
        'translation_invalid',
        'Automatic translation returned unusable output — edit the translation manually.',
        502,
        { sectionType, targetLocale, reason: result.reason, repairAttempted: true },
      );
    }
    log.info('translate_repaired', { sectionType, targetLocale });
  }
  return result.overlay;
}

// ── Auto-translate on submit (ADR 0064 amendment — the `autoTranslateOnPublish`
//    flag, honored) ───────────────────────────────────────────────────────────

/** Hard cap on translation ATTEMPTS (section, locale pairs) per submit —
 *  sections × locales can reach 50×N, and an unbounded synchronous fan-out in
 *  a request handler would self-DoS the managed provider. Beyond the cap the
 *  remainder is skipped and reported. NOTE (ADR 0592 §7): each attempt may
 *  make up to TWO provider calls (initial + the one bounded repair), so the
 *  provider-call ceiling is 2× this constant — still hard-bounded. */
export const AUTO_TRANSLATE_MAX_CALLS = 20;

export interface AutoTranslateResult {
  /** Sanitized overlays to merge: sectionId → locale → overlay. */
  overlays: Map<string, Record<string, Record<string, unknown>>>;
  /** Locale → number of sections translated (the reviewer-facing provenance). */
  translated: Record<string, number>;
  /** True when the call cap cut the sweep short. */
  capped: boolean;
  /** True when the provider failed mid-sweep (partial results kept). */
  errored: boolean;
  /** ADR 0592 §7 — (section, locale) pairs whose model output stayed unusable
   *  after the bounded repair (typed `translation_invalid`). The sweep SKIPS
   *  the pair and continues — one bad translation must not kill the rest. */
  invalid: number;
}

/**
 * Draft AI overlays for every (section, supported-locale) pair that has base
 * content but NO stored overlay yet — the submit-time half of
 * `autoTranslateOnPublish` (ADR 0064 amendment). Semantics ruled by the Phase-A
 * architecture review:
 *   - SUBMIT-time, so the approval gate reviews AI output BEFORE publish
 *     (publish-time would inject unreviewed content after approval);
 *   - missing-only: existing human/AI overlays are never overwritten;
 *   - best-effort: a provider failure stops the sweep but keeps what succeeded
 *     (the caller must never fail the submit because translation failed);
 *   - bounded: at most {@link AUTO_TRANSLATE_MAX_CALLS} provider calls.
 * Every overlay is sanitized by `translateSectionData` (same cleaner as a
 * stored localization). Deterministic order: sections in page order, locales in
 * settings order.
 */
export async function autoTranslateMissingOverlays(
  tenantId: string,
  sections: ReadonlyArray<{ sectionId: string; type: SectionType; data: Record<string, unknown>; localizations?: Record<string, Record<string, unknown>> }>,
  supportedLocales: readonly string[],
  maxCalls: number = AUTO_TRANSLATE_MAX_CALLS,
): Promise<AutoTranslateResult> {
  const overlays = new Map<string, Record<string, Record<string, unknown>>>();
  const translated: Record<string, number> = {};
  let calls = 0;
  let capped = false;
  let errored = false;
  let invalid = 0;

  outer: for (const section of sections) {
    if (Object.keys(section.data).length === 0) continue;
    for (const locale of supportedLocales) {
      if (section.localizations?.[locale]) continue; // missing-only
      if (calls >= maxCalls) { capped = true; break outer; }
      calls += 1;
      let overlay: Record<string, unknown>;
      try {
        overlay = await translateSectionData(tenantId, section.type, section.data, locale);
      } catch (err) {
        // ADR 0592 §7 — an UNUSABLE translation (typed, post-repair) is a
        // per-pair skip: the model may do fine on the next section/locale.
        // A provider failure still stops the sweep (nothing else will work).
        if (err instanceof OpenwopError && err.code === 'translation_invalid') {
          invalid += 1;
          continue;
        }
        errored = true; // provider down/capped — keep partial results, stop the sweep
        break outer;
      }
      if (Object.keys(overlay).length === 0) continue;
      const bySection = overlays.get(section.sectionId) ?? {};
      bySection[locale] = overlay;
      overlays.set(section.sectionId, bySection);
      translated[locale] = (translated[locale] ?? 0) + 1;
    }
  }
  return { overlays, translated, capped, errored, invalid };
}
