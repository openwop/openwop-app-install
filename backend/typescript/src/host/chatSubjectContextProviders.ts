/**
 * The chat counterpart of `runContextProviders.ts`: a feature adds a fenced
 * block to a conversation's scaffold when the conversation is owned by a
 * subject it knows (a project chat ⇒ the team intent ledger, ADR 0831), without
 * core importing the feature.
 *
 * PER TURN AND PER CALLER, like the board planning context (ADVB-1 in
 * `chatContext.ts`): a provider re-resolves for the person asking on THIS turn
 * and composes nothing they cannot read. A conversation is one long-lived run,
 * so a frozen run-start stamp would keep serving a version the owner has since
 * moved past. Fail-soft: a provider that throws is logged and skipped, and the
 * turn proceeds without its block.
 */
import { createLogger } from '../observability/logger.js';
import type { Subject } from './subject.js';

const log = createLogger('host.chatSubjectContextProviders');

export interface ChatSubjectContextRequest {
  tenantId: string;
  ownerSubject: Subject;
  /** The person on this turn. Absent ⇒ providers compose nothing caller-scoped. */
  callerUserId?: string | undefined;
  /** ADR 0852 D5 — the subject came from a CHANNEL's project binding, not its
   *  owner: every channel member reads the reply, so a provider must compose only
   *  what the whole workspace may see (an org-visible project). */
  viaChannelBinding?: boolean;
}
export type ChatSubjectContextProvider = (req: ChatSubjectContextRequest) => Promise<string | undefined>;

const providers: Array<{ id: string; fn: ChatSubjectContextProvider }> = [];

export function registerChatSubjectContextProvider(id: string, fn: ChatSubjectContextProvider): void {
  if (providers.some((p) => p.id === id)) return; // idempotent across re-registration
  providers.push({ id, fn });
}

/** Every provider's block for this conversation's owner, in registration order. */
export async function collectChatSubjectContextBlocks(req: ChatSubjectContextRequest): Promise<{ blocks: string[]; failed: string[] }> {
  const blocks: string[] = [];
  const failed: string[] = [];
  for (const p of providers) {
    try {
      const block = await p.fn(req);
      if (block) blocks.push(block);
    } catch (err) {
      failed.push(p.id);
      log.warn('chat_subject_context_provider_failed', { id: p.id, subjectKind: req.ownerSubject.kind, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { blocks, failed };
}
