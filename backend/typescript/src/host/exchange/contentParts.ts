/**
 * Content-part helpers shared across the exchange pipeline (ADR 0327 P1).
 *
 * A leaf module: validate/transcribe/dispatch all consume these projections,
 * so they live below all three (never import back into the pipeline).
 */

import type { ContentPart } from '../../providers/dispatch.js';

/** A multimodal user turn: the dispatch `ContentPart[]` shape (text/audio/image/file),
 *  sent by the composer for attachment turns. Turn content is OPAQUE on the RFC 0005
 *  wire, so accepting an array here is host behavior, not a wire change. The guard
 *  VALIDATES the shape (field-typed per variant), so the narrowing to the dispatch
 *  type is honest — a malformed array falls through to the JSON text projection. */
export function isContentParts(v: unknown): v is ContentPart[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every((p) => {
    if (!p || typeof p !== 'object') return false;
    const t = (p as { type?: unknown }).type;
    if (t === 'text') return typeof (p as { text?: unknown }).text === 'string';
    if (t === 'audio') {
      const q = p as { mimeType?: unknown; dataBase64?: unknown };
      return typeof q.mimeType === 'string' && typeof q.dataBase64 === 'string';
    }
    if (t === 'image' || t === 'file') {
      const q = p as { mimeType?: unknown; dataBase64?: unknown; url?: unknown };
      return typeof q.mimeType === 'string' && (typeof q.dataBase64 === 'string' || typeof q.url === 'string');
    }
    return false;
  });
}

/** Whether a user turn carries a visual/document ATTACHMENT — an image or file
 *  part. The model-router `attachment` signal (ADR 0130 / CHAT-FIRST-PORT A8):
 *  fed into `TurnFeatures.hasAttachment` at the dispatch ignition site so the
 *  `attachment` rule + the multimodal difficulty bump receive the real turn
 *  content. Audio parts are voice clips (transcribed host-side to text before
 *  routing), NOT routing attachments, so they don't count — matching the
 *  vision-eligibility invariant (attachment ⇒ vision-capable target). */
export function hasAttachmentPart(content: unknown): boolean {
  if (!isContentParts(content)) return false;
  return content.some((p) => p.type === 'image' || p.type === 'file');
}

/** A part that actually carries payload — non-blank text, or media with bytes/url. */
export function partHasPayload(p: ContentPart): boolean {
  if (p.type === 'text') return p.text.trim().length > 0;
  if (p.type === 'audio') return p.dataBase64.length > 0;
  return (p.dataBase64 ?? '').length > 0 || (p.url ?? '').length > 0;
}

/**
 * ADR 0665 D4 — the content shape of a turn whose agent produced NOTHING.
 *
 * An empty completion used to persist as `content: ''` on an ordinary attributed
 * agent turn. In a council that is the worst available record: a silent advisor is
 * indistinguishable from one that was never asked, and — because the chair
 * synthesises over the transcript — indistinguishable from one that AGREED.
 *
 * Typed rather than a marker STRING on purpose. A sentence like "(no response)" is
 * something a model can also emit, so a reader (human or the synthesising chair)
 * could not tell a host statement from a quoted one. A `kind` discriminant can only
 * come from this host.
 *
 * Turn content is OPAQUE on the RFC 0005 wire (`conversation-turn.schema.json`), so
 * this is host behaviour, not a wire change — the same basis on which
 * `{ kind: 'workflow_run' }` already rides.
 *
 * NOT a failure: `errored` is not set, nothing throws, and the boardroom cadence
 * runs on. Raising it as an exchange error would abandon every remaining advisor
 * AND the synthesis turn (`useBoardroomCadence.ts` halts the queue on `errored`) —
 * dropping the very synthesis that is supposed to report the absence.
 */
export const NO_CONTRIBUTION_KIND = 'no_contribution';

export interface NoContributionContent {
  kind: typeof NO_CONTRIBUTION_KIND;
  /** The advisor that did not answer, when one was resolved. */
  agentId?: string;
  reason: 'empty_completion';
}

/** The text projection a model reads. Bracketed like the media markers above, so
 *  it cannot be mistaken for the speaker's own prose, and explicit enough that a
 *  synthesis prompt asked to "name each dissent and who holds it" can name the
 *  silence instead of inventing agreement. */
export const NO_CONTRIBUTION_TEXT = '[no response]';

export function makeNoContribution(agentId: string | undefined): NoContributionContent {
  return { kind: NO_CONTRIBUTION_KIND, reason: 'empty_completion', ...(agentId ? { agentId } : {}) };
}

/**
 * The predicate, extracted so it is testable on its own and has ONE owner.
 *
 * `runDispatchCount` is the clause that is easy to omit and wrong to omit: a
 * tool-bearing agent can settle with no prose precisely BECAUSE it ignited a run,
 * and those run bubbles render immediately below its turn. That agent contributed;
 * calling it silent would be a second false record in the opposite direction.
 */
export function producedNothing(completion: string, runDispatchCount: number): boolean {
  return completion.trim().length === 0 && runDispatchCount === 0;
}

export function isNoContribution(v: unknown): v is NoContributionContent {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return (v as { kind?: unknown }).kind === NO_CONTRIBUTION_KIND;
}

/** Text PROJECTION of turn content, for transcripts / scaffolds / summaries.
 *  Parts-aware: text parts join; media parts become short markers — NEVER the
 *  JSON (stringifying an audio part would dump base64 into a prompt). */
export function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isContentParts(content)) {
    return content
      .map((p) => (p.type === 'text' ? (typeof p.text === 'string' ? p.text : '') : `[${p.type} attachment]`))
      .filter((s) => s.length > 0)
      .join('\n');
  }
  if (isNoContribution(content)) return NO_CONTRIBUTION_TEXT;
  return JSON.stringify(content ?? '');
}
