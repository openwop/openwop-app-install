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
import { restoreItemStates, sanitizeSectionOverlay, type SectionType } from './cmsService.js';
import { AI_PARTS_DEADLINE_MS, AI_SECTION_MAX_BATCHES, AI_SECTION_MAX_CHARS, joinParts, partReplyMismatch, planParts, PartsStopped, runParts, sectionPayload } from './aiParts.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('feature.cms.translate');
const MAX_TOKENS = 2000;
export { AI_SECTION_MAX_CHARS, AI_BATCH_CHARS, AI_SECTION_MAX_BATCHES } from './aiParts.js';
/** The parts' deadline (ADR 1112 P3); one value for translate and rewrite, in `aiParts`. */
export const AI_TRANSLATE_DEADLINE_MS = AI_PARTS_DEADLINE_MS;

type Raw = Record<string, unknown>;

/** What the model is sent (ADR 1112 P3); see `sectionPayload`. */
export const translationPayload = sectionPayload;

function tooLarge(chars: number, batches?: number): OpenwopError {
  const message = batches === undefined
    ? `This section is too large for AI translation (${Math.ceil(chars / 1000)}k characters; the limit is ${AI_SECTION_MAX_CHARS / 1000}k). Edit it by hand, or split it into smaller sections.`
    : `This section has too many decisions for AI translation: it would take ${batches} requests, and the limit is ${AI_SECTION_MAX_BATCHES}. Translate it by hand, or split its decisions across smaller sections.`;
  // `translation_invalid`, so the sweep skips this one section and the agent tool says why.
  return new OpenwopError('translation_invalid', message, 400, { reason: 'too_large', chars, limit: AI_SECTION_MAX_CHARS, ...(batches === undefined ? {} : { batches, maxBatches: AI_SECTION_MAX_BATCHES }) });
}

/**
 * The parts one section-locale is translated in (ADR 1112 P3, `planParts`). Throws the typed
 * `too_large` refusal, before any model call, when it cannot be done within the part budget.
 */
export function planSectionTranslation(sectionType: SectionType, data: Raw): Raw[] {
  const plan = planParts(sectionType, data);
  if (!plan.ok) throw tooLarge(plan.chars, plan.batches);
  return plan.parts;
}

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

/** ADR 1038 D8 — re-exported for the translate tests; it lives with the validator. */
export { restoreItemStates };

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
  /** A caller's own deadline (the submit sweep, ADR 1112 P5): aborting it stops every call. */
  opts?: { signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  // Nothing to translate — an empty overlay is the CORRECT answer for empty
  // input, not a failure (the sweep already skips empty sections; this guards
  // direct route callers).
  if (Object.keys(data).length === 0) return {};
  const batches = planSectionTranslation(sectionType, data);
  // ADR 0110 OQ-C: route through the single headless-provider resolver instead of a
  // hardcoded managed dispatch. For 'text' the managed provider always qualifies, so this is
  // behaviourally identical to before, plus a BYOK-default fallback if managed is unavailable.
  const dispatch = await resolveHeadlessAi(tenantId, 'text', { featureId: 'cms' });
  if (!dispatch) throw new OpenwopError('internal_error', 'No text-capable AI provider is available for translation.', 503, {});

  // ADR 0592 §7 (CMSL-2/CMSLWF-4) — invalid model output is a TYPED failure
  // with ONE bounded error-fed repair (the app-builder authoring-path shape),
  // never success-with-empty: `{overlay:{}}` from unparseable garbage told the
  // editor "reviewed and empty" and the chain lane failed one node late with a
  // misattributed `empty`.
  type Reason = 'unparseable' | 'empty_object' | 'all_keys_dropped' | 'items_missing';
  const attempt = (completion: string, part: Raw): { ok: true; reply: Raw } | { ok: false; reason: Reason } => {
    const extracted = extractJSONStrict(completion);
    if (extracted === null) return { ok: false, reason: 'unparseable' };
    if (Object.keys(extracted).length === 0) return { ok: false, reason: 'empty_object' };
    // ADR 1112 P3 — every decision the part was sent, with the same ids (`partReplyMismatch`).
    if (partReplyMismatch(part, extracted)) return { ok: false, reason: 'items_missing' };
    if (Object.keys(sanitizeSectionOverlay(sectionType, restoreItemStates(data, extracted, sectionType))).length === 0) return { ok: false, reason: 'all_keys_dropped' };
    return { ok: true, reply: extracted };
  };
  const repairText = (reason: Reason, part: Raw): string => {
    if (reason === 'all_keys_dropped') return `Your previous reply used keys that do not exist in the source JSON. Return ONLY the translated JSON object with EXACTLY the same keys as the source (no prose, no code fences, no new keys).`;
    if (reason === 'items_missing') return `Your previous reply did not have all ${(part.decisions as unknown[]).length} decisions. Return ONLY the translated JSON object with every decision, in the same order, with the same ids.`;
    return `Your previous reply was not a valid JSON object. Return ONLY the translated JSON object with exactly the same keys as the source — no prose, no code fences.`;
  };

  // The parts run under one deadline; the first failed part stops the rest (ADR 1112 P3, `runParts`).
  const translatePart = async (part: Raw, signal: AbortSignal | undefined): Promise<Raw> => {
    const callOpts = { maxTokens: MAX_TOKENS, ...(signal ? { signal } : {}) };
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildTranslationPrompt(part, targetLocale) },
    ];
    const first = await dispatch(messages, callOpts);
    let result = attempt(first, part);
    if (!result.ok) {
      // ONE error-fed repair: feed the bad completion back with the specific
      // failure so the model can correct it. Bounded — a second failure is final.
      const repairMessages: ChatMessage[] = [...messages, { role: 'assistant', content: first }, { role: 'user', content: repairText(result.reason, part) }];
      const second = await dispatch(repairMessages, callOpts);
      result = attempt(second, part);
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
    return result.reply;
  };

  let replies: Raw[];
  try {
    replies = await runParts(batches, translatePart, opts?.signal ? { signal: opts.signal } : undefined);
  } catch (err) {
    if (err instanceof PartsStopped && err.by === 'caller') {
      throw new OpenwopError('translation_invalid', 'Automatic translation of this section was stopped at the caller\'s time limit.', 504, { sectionType, targetLocale, reason: 'timeout', batches: batches.length });
    }
    if (err instanceof PartsStopped) {
      throw new OpenwopError('translation_invalid', `Automatic translation of this section took longer than ${AI_TRANSLATE_DEADLINE_MS / 1000} seconds. Try again, or split its decisions across smaller sections.`, 504, { sectionType, targetLocale, reason: 'timeout', batches: batches.length });
    }
    throw err;
  }

  const merged = joinParts(replies);
  const overlay = sanitizeSectionOverlay(sectionType, restoreItemStates(data, merged, sectionType));
  // XCH-CMS-1 (LLM-EXCHANGE-AUDIT Wave 5): a PARTIAL key drop stays a warn —
  // observable, sanitize-gated, human-reviewed.
  const droppedKeys = Object.keys(merged).filter((k) => !(k in overlay));
  if (droppedKeys.length) {
    log.warn('translate_overlay_keys_dropped', { sectionType, targetLocale, droppedKeys: droppedKeys.slice(0, 20) });
  }
  if (batches.length > 1) log.info('translate_in_parts', { sectionType, targetLocale, batches: batches.length });
  return overlay;
}

// ── Auto-translate on submit (ADR 0064 amendment — the `autoTranslateOnPublish`
//    flag, honored) ───────────────────────────────────────────────────────────

/** Hard cap on translation ATTEMPTS (section, locale pairs) per submit —
 *  sections × locales can reach 50×N, and an unbounded synchronous fan-out in
 *  a request handler would self-DoS the managed provider. Beyond the cap the
 *  remainder is skipped and reported. A section translated in parts (ADR 1112
 *  P3) costs one attempt per part. NOTE (ADR 0592 §7): each attempt may
 *  make up to TWO provider calls (initial + the one bounded repair), so the
 *  provider-call ceiling is 2× this constant — still hard-bounded. */
export const AUTO_TRANSLATE_MAX_CALLS = 20;

/** ADR 1112 P5 — the submit sweep runs inside the submit request, behind the hosting proxy's
 *  60 s. Past this deadline it starts no new pair and aborts the call in flight; what it
 *  drafted is kept, and the rest is left for the next submit or the author (`timedOut`). */
export const AUTO_TRANSLATE_DEADLINE_MS = 40_000;

export interface AutoTranslateResult {
  /** Sanitized overlays to merge: sectionId → locale → overlay. */
  overlays: Map<string, Record<string, Record<string, unknown>>>;
  /** Locale → number of sections translated (the reviewer-facing provenance). */
  translated: Record<string, number>;
  /** True when the call cap cut the sweep short. */
  capped: boolean;
  /** True when the provider failed mid-sweep (partial results kept). */
  errored: boolean;
  /** True when the sweep's deadline cut it short (partial results kept; ADR 1112 P5). */
  timedOut: boolean;
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
  deadlineMs: number = AUTO_TRANSLATE_DEADLINE_MS,
): Promise<AutoTranslateResult> {
  const overlays = new Map<string, Record<string, Record<string, unknown>>>();
  const translated: Record<string, number> = {};
  let calls = 0;
  let capped = false;
  let errored = false;
  let invalid = 0;
  let timedOut = false;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  timer.unref?.(); // never holds the process open on an early throw

  outer: for (const section of sections) {
    if (Object.keys(section.data).length === 0) continue;
    for (const locale of supportedLocales) {
      if (section.localizations?.[locale]) continue; // missing-only
      if (deadline.signal.aborted) { timedOut = true; break outer; }
      if (calls >= maxCalls) { capped = true; break outer; }
      // ADR 1112 P3 — a section sent in parts costs one attempt per part. One too large to
      // translate never reaches a model; one that would overrun the budget is left whole for
      // the next submit, never half translated.
      let parts: number;
      try {
        parts = planSectionTranslation(section.type, section.data).length;
      } catch (err) {
        if (err instanceof OpenwopError && err.code === 'translation_invalid') { invalid += 1; continue; }
        throw err;
      }
      if (calls + parts > maxCalls) { capped = true; continue; }
      calls += parts;
      let overlay: Record<string, unknown>;
      try {
        overlay = await translateSectionData(tenantId, section.type, section.data, locale, { signal: deadline.signal });
      } catch (err) {
        // The deadline aborted the call in flight: stop, keeping what was drafted.
        if (deadline.signal.aborted) { timedOut = true; break outer; }
        // ADR 0592 §7 — an UNUSABLE translation (typed, post-repair) is a
        // per-pair skip: the model may do fine on the next section/locale, and so is a
        // section that ran out of time (ADR 1112 P3). A provider failure still stops the
        // sweep (nothing else will work).
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
  clearTimeout(timer);
  return { overlays, translated, capped, errored, timedOut, invalid };
}
