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
import { restoreItemStates, sanitizeSectionOverlay, type SectionType } from './cmsService.js';
import { AI_PARTS_DEADLINE_MS, AI_SECTION_MAX_BATCHES, AI_SECTION_MAX_CHARS, joinParts, partReplyMismatch, planParts, PartsStopped, runParts } from './aiParts.js';
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
  // ADR 1112 P6 — the translate lane's parts (`aiParts`): words and ids only, a large
  // scheduleSim split by its decisions, at most AI_SECTION_MAX_BATCHES parts under one deadline.
  const plan = planParts(sectionType, data);
  if (!plan.ok) {
    const message = plan.batches === undefined
      ? `This section is too large for AI rewriting (${Math.ceil(plan.chars / 1000)}k characters; the limit is ${AI_SECTION_MAX_CHARS / 1000}k). Edit it by hand, or split it into smaller sections.`
      : `This section has too many decisions for AI rewriting: it would take ${plan.batches} requests, and the limit is ${AI_SECTION_MAX_BATCHES}. Edit it by hand, or split its decisions across smaller sections.`;
    throw new OpenwopError('validation_error', message, 400, { reason: 'too_large', chars: plan.chars, limit: AI_SECTION_MAX_CHARS, ...(plan.batches === undefined ? {} : { batches: plan.batches, maxBatches: AI_SECTION_MAX_BATCHES }) });
  }
  const dispatch = await resolveHeadlessAi(tenantId, 'text');
  if (!dispatch) throw new OpenwopError('internal_error', 'No text-capable AI provider is available for rewriting.', 503, {});

  // A part's reply is usable when it parses, answers every decision it was sent with the same
  // ids (parts join by position), and keeps something after the clean-up.
  const usable = (completion: string, part: Record<string, unknown>): Record<string, unknown> | null => {
    const extracted = extractObject(completion);
    if (!extracted || partReplyMismatch(part, extracted)) return null;
    if (Object.keys(sanitizeSectionOverlay(sectionType, restoreItemStates(data, extracted, sectionType))).length === 0) return null;
    return extracted;
  };
  const rewritePart = async (part: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Record<string, unknown>> => {
    const callOpts = { maxTokens: MAX_TOKENS, ...(signal ? { signal } : {}) };
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildRewritePrompt(part, action, instruction) },
    ];
    const first = await dispatch(messages, callOpts);
    let reply = usable(first, part);
    if (!reply) {
      const second = await dispatch([
        ...messages,
        { role: 'assistant', content: first },
        { role: 'user', content: 'Your previous reply was not a usable JSON object with the same keys (and every list item, in the same order, with the same ids). Return ONLY the edited JSON object, with exactly the keys of the source — no prose, no code fences.' },
      ], callOpts);
      reply = usable(second, part);
      if (!reply) {
        throw new OpenwopError('rewrite_invalid', 'The rewrite came back unusable. Try again, or edit the text yourself.', 502, { sectionType, action, repairAttempted: true });
      }
      log.info('rewrite_repaired', { sectionType, action });
    }
    return reply;
  };

  let replies: Record<string, unknown>[];
  try {
    replies = await runParts(plan.parts, rewritePart);
  } catch (err) {
    if (err instanceof PartsStopped) {
      throw new OpenwopError('rewrite_invalid', `The rewrite of this section took longer than ${AI_PARTS_DEADLINE_MS / 1000} seconds. Try again, or split its decisions across smaller sections.`, 504, { sectionType, action, reason: 'timeout', batches: plan.parts.length });
    }
    throw err;
  }
  // ADR 1038 D8 — a rewrite changes words, never a list item's state; restore and clean once,
  // on the joined reply, against the whole section.
  const cleaned = sanitizeSectionOverlay(sectionType, restoreItemStates(data, joinParts(replies), sectionType));
  if (plan.parts.length > 1) log.info('rewrite_in_parts', { sectionType, action, batches: plan.parts.length });
  return keepNonText(data, { ...data, ...cleaned }) as Record<string, unknown>;
}
