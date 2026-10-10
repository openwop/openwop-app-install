/**
 * AI section rewrite (ADR 0828 phase 3): improve, shorten, expand, change the
 * tone of, or fix the text of ONE section, or follow the author's own short
 * instruction. The translate pattern (ADR 0064 Phase 3, ADR 0592 §7): one
 * headless dispatch, JSON in and out, the output cleaned by the stored-overlay
 * sanitizer, one bounded error-fed repair, a typed failure otherwise.
 *
 * The model may only change TEXT. Every field whose key names a link, a media
 * token or an id, and every non-string value, is taken from the input whatever
 * the model returns, so a rewrite can never repoint a button or swap an image.
 * The result is a proposal the editor shows before anything changes.
 */

import { resolveHeadlessAi } from '../../host/headlessAi.js';
import { OpenwopError } from '../../types.js';
import type { ChatMessage } from '../../providers/dispatch.js';
import { sanitizeSectionOverlay, type SectionType } from './cmsService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('feature.cms.rewrite');
const MAX_TOKENS = 2000;
export const REWRITE_INSTRUCTION_MAX = 500;

export const REWRITE_ACTIONS = ['improve', 'shorten', 'expand', 'friendlier', 'formal', 'fix'] as const;
export type RewriteAction = (typeof REWRITE_ACTIONS)[number] | 'custom';

const ACTION_TEXT: Record<Exclude<RewriteAction, 'custom'>, string> = {
  improve: 'Make the writing clearer and more direct, keeping the meaning and the facts.',
  shorten: 'Make it noticeably shorter, keeping the key points and the facts.',
  expand: 'Expand it with a little more useful detail, without inventing facts, figures or names.',
  friendlier: 'Make the tone warmer and more conversational, keeping the meaning.',
  formal: 'Make the tone more formal and precise, keeping the meaning.',
  fix: 'Fix spelling, grammar and punctuation only. Change nothing else.',
};

const SYSTEM_PROMPT =
  'You edit the text VALUES of a JSON object that holds one section of a web page. ' +
  'Rules: return ONLY the edited JSON object (no prose, no code fences); keep every key and the structure unchanged; ' +
  'never change URLs, media tokens, ids, or template variables like {{name}}; never add or remove keys; ' +
  'keep the light markup already in the text (**bold**, *italic*, [text](url), lines starting "- ", "1. ", "> ", "### "); ' +
  'do not invent facts, numbers, quotes or names; keep any [TODO …] marker exactly as written.';

/** Keys whose values are never the model's to change. */
const PROTECTED_KEY = /(url|href|link|token|id|ids|src|slug|email)$/i;

export function buildRewritePrompt(data: Record<string, unknown>, action: RewriteAction, instruction?: string): string {
  const what = action === 'custom' ? `Follow this instruction from the author: ${instruction ?? ''}` : ACTION_TEXT[action];
  return `${what}\nReturn ONLY the edited JSON with the same keys and structure:\n\n${JSON.stringify(data, null, 2)}`;
}

/** Restore everything the model may not change: protected keys and non-text
 *  values come from `original`, at any depth. Keys the original lacks are dropped. */
export function keepNonText(original: unknown, edited: unknown, key = ''): unknown {
  if (typeof original === 'string') {
    if (PROTECTED_KEY.test(key)) return original;
    return typeof edited === 'string' ? edited : original;
  }
  if (Array.isArray(original)) {
    const e = Array.isArray(edited) ? edited : [];
    return original.map((item, i) => keepNonText(item, e[i], key));
  }
  if (original && typeof original === 'object') {
    const e = (edited && typeof edited === 'object' && !Array.isArray(edited) ? edited : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(original as Record<string, unknown>)) out[k] = keepNonText(v, e[k], k);
    return out;
  }
  return original; // numbers, booleans, null: never the model's to change
}

function extractObject(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite a section's base `data`. Returns the full proposed data (text edited,
 * everything else as it was). Throws ManagedProviderError when no provider is
 * reachable (the route maps it to 503) and `rewrite_invalid` (502) when the
 * output stays unusable after the one repair.
 */
export async function rewriteSectionData(
  tenantId: string,
  sectionType: SectionType,
  data: Record<string, unknown>,
  action: RewriteAction,
  instruction?: string,
): Promise<Record<string, unknown>> {
  if (Object.keys(data).length === 0) return {};
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildRewritePrompt(data, action, instruction) },
  ];
  const dispatch = await resolveHeadlessAi(tenantId, 'text');
  if (!dispatch) throw new OpenwopError('internal_error', 'No text-capable AI provider is available for rewriting.', 503, {});

  const attempt = (completion: string): Record<string, unknown> | null => {
    const extracted = extractObject(completion);
    if (!extracted) return null;
    const cleaned = sanitizeSectionOverlay(sectionType, extracted);
    if (Object.keys(cleaned).length === 0) return null;
    return keepNonText(data, { ...data, ...cleaned }) as Record<string, unknown>;
  };

  const first = await dispatch(messages, { maxTokens: MAX_TOKENS });
  let result = attempt(first);
  if (!result) {
    const second = await dispatch([
      ...messages,
      { role: 'assistant', content: first },
      { role: 'user', content: 'Your previous reply was not a usable JSON object with the same keys. Return ONLY the edited JSON object, with exactly the keys of the source — no prose, no code fences.' },
    ], { maxTokens: MAX_TOKENS });
    result = attempt(second);
    if (!result) {
      throw new OpenwopError('rewrite_invalid', 'The rewrite came back unusable. Try again, or edit the text yourself.', 502, { sectionType, action, repairAttempted: true });
    }
    log.info('rewrite_repaired', { sectionType, action });
  }
  return result;
}
