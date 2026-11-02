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
import { getConversationMeta } from '../../host/conversationStore.js';
import type { HeadlessDispatch } from '../../host/headlessAi.js';
import { createLogger } from '../../observability/logger.js';
import { generateTitleWith, resolveTitleDispatch, type TitleConversation } from './titleGenerator.js';

const log = createLogger('features.chat-autotitle');

export const AUTOTITLE_TOGGLE_ID = 'chat-autotitle';

export interface AutotitleParams {
  tenantId: string;
  /** The acting human (toggle subject + managed meter); absent ⇒ tenant-bucketed. */
  userId: string | undefined;
  /** The chat session whose title we write; absent ⇒ no-op (conformance/older clients). */
  chatSessionId: string | undefined;
  /** ADR 1019 D1 — true only when no earlier USER turn exists in the conversation
   *  run. Only a chat's first exchange is titled. */
  firstExchange: boolean;
  /** ADR 1019 D3 — the conversation's credential and what served this exchange. */
  credentialRef: string | undefined;
  served: TitleConversation['served'];
  /** First user message + first agent reply — the title context. */
  userText: string;
  replyText: string;
  storage: Storage;
  /** Emit the non-normative `openwop-app.conversation.titled` host event so the FE rail/tab
   *  updates live. Caller owns the run-log binding; the feature stays decoupled. */
  onTitled: (title: string) => void;
  /** TEST seams. `resolveDispatch` defaults to the conversation-credential resolver,
   *  `generate` to one bounded title call on that dispatch. */
  resolveDispatch?: (conv: TitleConversation) => Promise<HeadlessDispatch | null>;
  generate?: (dispatch: HeadlessDispatch, userText: string, replyText: string) => Promise<string | null>;
}

/** Fire-and-forget. Never awaits into the caller, never throws — a failure leaves the
 *  placeholder title untouched (today's behavior). */
export function maybeAutotitleOnFirstExchange(params: AutotitleParams): void {
  // `warn`, not `debug`: the prod log level defaults to `info`, so a storage/toggle/CAS
  // failure of a default-ON feature at `debug` was INVISIBLE — the same "silently never
  // lands" mode ATC-2 made legible for the provider timeout (it.51). No PII: message only.
  void autotitleOnFirstExchange(params).catch((e) =>
    log.warn('autotitle_binding_failed', { error: e instanceof Error ? e.message : String(e) }),
  );
}

/** ADR 1019 D1 — a session predating `'given'` (NULL title_source) is titleable only
 *  when its conversation meta, if any, is a plain agent chat: not a group, person,
 *  workspace or channel conversation, and not bound to a board, an entity, a DM key
 *  or a branch. */
async function isPlainChat(tenantId: string, chatSessionId: string): Promise<boolean> {
  const meta = await getConversationMeta(tenantId, chatSessionId);
  if (!meta) return true;
  return meta.type === 'agent' && !meta.boardId && !meta.ownerSubject && !meta.dmKey && !meta.branchedFrom;
}

/** The awaitable core (the fire-and-forget wrapper detaches this). Exported so tests
 *  can assert every gate deterministically. Order (ADR 1019 D2): everything that can
 *  refuse without spending runs BEFORE the claim; the claim is the one model call. */
export async function autotitleOnFirstExchange(params: AutotitleParams): Promise<void> {
  const { tenantId, userId, chatSessionId, userText, replyText, storage, onTitled } = params;
  if (!chatSessionId) return; // no session to title
  if (!params.firstExchange) return; // D1 — a chat is named by its first exchange only

  // Toggle gate (server-authoritative, per-user bucketed). Fail-closed: a null
  // assignment (retired/absent) or a disabled one ⇒ no LLM call, no write.
  const assignment = await resolveOne(AUTOTITLE_TOGGLE_ID, { tenantId, ...(userId ? { userId } : {}) });
  if (!assignment?.enabled) return;

  // Only a placeholder is titleable: never a rename ('user'), a source-given name
  // ('given'), a written title ('auto') or a spent claim ('claimed').
  const session = await storage.getChatSession(tenantId, chatSessionId);
  if (!session) return;
  if ((session.titleSource ?? 'default') !== 'default') return;
  if (!(await isPlainChat(tenantId, chatSessionId))) return;

  // D3 — the conversation's own credential, or nothing.
  const dispatch = await (params.resolveDispatch ?? resolveTitleDispatch)({
    tenantId, credentialRef: params.credentialRef, served: params.served, ...(userId ? { actingSubject: userId } : {}),
  });
  if (!dispatch) {
    log.info('autotitle_skipped', { reason: 'no_dispatch_for_credential' });
    return;
  }

  // D2 — claim the one call. Moves only title_source, so the rail shows nothing yet.
  // Losing it (a rename, a peer instance, an earlier run of this chat) ⇒ no call.
  if (!(await storage.claimChatSessionTitleSource(tenantId, chatSessionId, 'default', 'claimed'))) {
    log.info('autotitle_skipped', { reason: 'claim_lost' });
    return;
  }

  const title = await (params.generate ?? generateTitleWith)(dispatch, userText, replyText);
  if (!title) {
    // Stays 'claimed' with its placeholder — never retried. Logged so the failure
    // rate ADR 1019 OQ1 waits on counts unusable output too, not only provider errors.
    log.info('autotitle_no_title', { reason: 'unusable_or_failed' });
    return;
  }

  // ATC-3/4 — the CAS makes the write conditional on the claim still standing: a
  // manual rename during the call moved title_source to 'user', and must win.
  const won = await storage.casChatSessionTitle(
    tenantId,
    chatSessionId,
    { title, titleSource: 'auto', updatedAt: new Date().toISOString() },
    'claimed',
  );
  if (won) onTitled(title);
}
