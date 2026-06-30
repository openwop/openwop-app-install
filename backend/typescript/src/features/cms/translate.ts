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
 *  surrounding prose. Returns `{}` when nothing parseable is found (the caller
 *  then sanitizes, yielding an empty overlay rather than throwing). */
export function extractJSON(text: string): Record<string, unknown> {
  if (typeof text !== 'string') return {};
  // Strip a ```json … ``` (or bare ```) fence if present.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return {};
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
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
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildTranslationPrompt(data, targetLocale) },
  ];
  // ADR 0110 OQ-C: route through the single headless-provider resolver instead of a
  // hardcoded managed dispatch. For 'text' the managed provider always qualifies, so this is
  // behaviourally identical to before, plus a BYOK-default fallback if managed is unavailable.
  const dispatch = await resolveHeadlessAi(tenantId, 'text');
  if (!dispatch) throw new OpenwopError('internal_error', 'No text-capable AI provider is available for translation.', 503, {});
  const completion = await dispatch(messages, { maxTokens: MAX_TOKENS });
  return sanitizeSectionOverlay(sectionType, extractJSON(completion));
}
