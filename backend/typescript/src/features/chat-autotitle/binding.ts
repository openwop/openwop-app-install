/**
 * ADR 0151 Phase 2 — fire-and-forget, FAIL-CLOSED first-exchange auto-titling.
 *
 * Called from `conversationExchange.finishExchange` after the first user+agent turns
 * are durable (mirroring `maybeExtractMemoryOnClose`'s pattern, but at the FIRST
 * exchange, not close). It is a no-op unless: the conversation has a chat session,
 * the acting user has the `chat-autotitle` toggle enabled, and the session is still
 * at its `'default'` placeholder title (so it runs ONCE and never clobbers a manual
 * rename — `titleSource` is the idempotency key, robust to the multi-tab regression
 * the FE `messages.length===0` guard suffered).
 *
 * Non-replay: the title is a host-extension display label on the session store, not a
 * run-event / `run.metadata`, so this non-deterministic LLM side-effect stays entirely
 * outside replay/`:fork` — exactly like memory-extract.
 *
 * @see docs/adr/0151-conversation-auto-titling.md
 */
import type { Storage } from '../../storage/storage.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createLogger } from '../../observability/logger.js';
import { generateTitle } from './titleGenerator.js';

const log = createLogger('features.chat-autotitle');

export const AUTOTITLE_TOGGLE_ID = 'chat-autotitle';

export interface AutotitleParams {
  tenantId: string;
  /** The acting human (toggle subject); absent ⇒ tenant-bucketed (status:'on' still applies). */
  userId: string | undefined;
  /** The chat session whose title we write; absent ⇒ no-op (conformance/older clients). */
  chatSessionId: string | undefined;
  /** First user message + first agent reply — the title context. */
  userText: string;
  replyText: string;
  storage: Storage;
  /** Emit the non-normative `conversation.titled` host event so the FE rail/tab
   *  updates live. Caller owns the run-log binding; the feature stays decoupled. */
  onTitled: (title: string) => void;
  /** The LLM title generator (INJECTED — the call site provides the dispatch-backed
   *  `generateTitle`; tests inject a stub). So the security-relevant wiring (toggle
   *  gate + the never-clobber guard) is covered without the provider coupling. */
  generate?: (tenantId: string, userText: string, replyText: string) => Promise<string | null>;
}

/** Fire-and-forget. Never awaits into the caller, never throws — a failure leaves the
 *  placeholder title untouched (today's behavior). */
export function maybeAutotitleOnFirstExchange(params: AutotitleParams): void {
  void autotitleOnFirstExchange(params).catch((e) =>
    log.debug('autotitle failed', { error: e instanceof Error ? e.message : String(e) }),
  );
}

/** The awaitable core (the fire-and-forget wrapper detaches this). Exported so tests
 *  can assert the toggle gate + the never-clobber guard deterministically. */
export async function autotitleOnFirstExchange(params: AutotitleParams): Promise<void> {
  const { tenantId, userId, chatSessionId, userText, replyText, storage, onTitled } = params;
  if (!chatSessionId) return; // no session to title

  // Toggle gate (server-authoritative, per-user bucketed). Fail-closed: a null
  // assignment (retired/absent) or a disabled one ⇒ no LLM call, no write.
  const assignment = await resolveOne(AUTOTITLE_TOGGLE_ID, { tenantId, ...(userId ? { userId } : {}) });
  if (!assignment?.enabled) return;

  // Idempotency / never-clobber gate: only the 'default' placeholder is titleable.
  const session = await storage.getChatSession(tenantId, chatSessionId);
  if (!session) return;
  if ((session.titleSource ?? 'default') !== 'default') return;

  const title = await (params.generate ?? generateTitle)(tenantId, userText, replyText);
  if (!title) return;

  // TOCTOU re-check: a manual rename could have landed during the ~1–2s LLM call.
  // Re-read and skip if the session is no longer at its default placeholder, so a
  // user rename mid-generation is never overwritten.
  const fresh = await storage.getChatSession(tenantId, chatSessionId);
  if (!fresh || (fresh.titleSource ?? 'default') !== 'default') return;

  await storage.updateChatSession(tenantId, chatSessionId, {
    title,
    titleSource: 'auto',
    updatedAt: new Date().toISOString(),
  });
  onTitled(title);
}
