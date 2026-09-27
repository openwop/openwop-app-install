/**
 * Resolve-body parsing + turn validation for the exchange pipeline (ADR 0327 P1).
 *
 * Owns the `ConversationResolve` shape (the resume value the routes hand the
 * orchestrator), the per-exchange override extraction, and the RFC 0005 §E
 * non-empty-turn rule. Pure: no storage, no dispatch.
 */

import { OpenwopError } from '../../types.js';
import { asText, isContentParts, partHasPayload } from './contentParts.js';

export interface ConversationResolve {
  operation: 'exchange' | 'close';
  turn?: { from?: unknown; to?: unknown; content?: unknown; role?: unknown };
  outcome?: unknown;
  /** Client idempotency key (ADR 0067 §Phase 2): a stable id for THIS exchange
   *  attempt, reused verbatim across retries of the same send. When present, a
   *  retry returns the already-appended turns instead of dispatching again.
   *  (Event tailing — ADR 0067 §Phase 4 — is a frontend read optimization over
   *  `GET /runs/{id}/events?fromSeq`; the handler always folds full history here
   *  because the model prompt needs every prior turn.) */
  exchangeKey?: unknown;
  /** Per-EXCHANGE web-search/grounding override (ADR 0101 Phase 2 → deferral).
   *  When present it overrides `run.inputs.webSearch` for THIS turn, so flipping
   *  the chat toggle takes effect immediately (the run-input value is the
   *  open-time default). The conversation resume value is host-internal + not
   *  strictly validated, so this is not a wire-shape change. */
  webSearch?: unknown;
  /** Per-EXCHANGE permission mode (ADR 0150). `'safe'` (default) gates the high-blast-radius
   *  tools behind the firewall's approval card; `'bypass'` lets the agent act without asking
   *  (the user pre-authorized via the composer toolbar). Host-internal resume value (like
   *  `webSearch`) — not a wire-shape change; rides the run log ⇒ replay-deterministic. */
  permissionMode?: unknown;
}

/** The parsed, typed projection of one resolve body — every per-exchange
 *  override extracted with its documented fallback semantics. */
export interface ParsedResolveBody {
  body: ConversationResolve;
  operation: 'exchange' | 'close';
  /** Per-exchange web-search override (undefined ⇒ fall back to run.inputs at dispatch). */
  exchangeWebSearch: boolean | undefined;
  /** Per-exchange permission mode (ADR 0150); anything but the explicit 'bypass' is safe (fail-safe). */
  exchangePermissionMode: 'safe' | 'bypass' | undefined;
  /** ADR 0124 Phase 3 — per-exchange model switch (the in-chat selector). Host-internal
   *  (not a wire-shape change, same as webSearch); undefined fields fall through. */
  exchangeModelOverride: { provider?: string; model?: string } | undefined;
  /** Idempotency (ADR 0067 §Phase 2) — absent key ⇒ legacy behavior (no dedup). */
  exchangeKey: string | undefined;
  /** The @mentioned agent, when the turn addresses one. */
  to: string | undefined;
}

export function parseResolveBody(resumeValue: unknown): ParsedResolveBody {
  const body = (resumeValue ?? {}) as ConversationResolve;
  const operation: 'exchange' | 'close' = body.operation === 'close' ? 'close' : 'exchange';
  const exchangeWebSearch: boolean | undefined = typeof body.webSearch === 'boolean' ? body.webSearch : undefined;
  const exchangePermissionMode: 'safe' | 'bypass' | undefined = body.permissionMode === 'bypass' ? 'bypass' : body.permissionMode === 'safe' ? 'safe' : undefined;
  const bm = body as { model?: unknown; provider?: unknown };
  const exchangeModelOverride: { provider?: string; model?: string } | undefined =
    typeof bm.model === 'string' || typeof bm.provider === 'string'
      ? { ...(typeof bm.provider === 'string' ? { provider: bm.provider } : {}), ...(typeof bm.model === 'string' ? { model: bm.model } : {}) }
      : undefined;
  const exchangeKey = typeof body.exchangeKey === 'string' && body.exchangeKey.length > 0 ? body.exchangeKey : undefined;
  const to = typeof body.turn?.to === 'string' ? body.turn.to : undefined;
  return { body, operation, exchangeWebSearch, exchangePermissionMode, exchangeModelOverride, exchangeKey, to };
}

/** Validate the turn (RFC 0005 §E — reject an empty/invalid exchange). Non-empty =
 *  non-blank text, OR a multimodal ContentPart[] with ≥1 part that actually carries
 *  payload — an audio-only clip with no typed text is a VALID turn (the pre-fix
 *  text-only check 422'd exactly that send). Throws 422 on an empty turn. */
export function validateExchangeContent(rawContent: unknown, conversationId: string): void {
  const hasContent = isContentParts(rawContent)
    ? rawContent.some(partHasPayload)
    : rawContent !== undefined && rawContent !== null && asText(rawContent).trim().length > 0;
  if (!hasContent) {
    throw new OpenwopError('validation_error', 'Conversation exchange requires a non-empty turn.content.', 422, { conversationId });
  }
}
