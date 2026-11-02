/**
 * ADR 1001 D7 (P2) — accept a person's answer to an agent's chat question card
 * as the NEXT exchange.
 *
 * Refused unless every one of these holds, each a typed error a client can show:
 *  - the tenant's chat ask is enabled (400, as if the field did not exist);
 *  - the ask exists in THIS conversation (404 `clarification_not_found`);
 *  - it is the conversation's latest turn, so a stale card cannot answer an ask
 *    the conversation has moved past (409 `clarification_stale`);
 *  - it has no recorded answer (409 `clarification_answered`);
 *  - the answers satisfy the ask's generated resumeSchema (400).
 * The 409s are `conflict`, NEVER `interrupt_already_resolved`: the chat client
 * reads that code as a DEAD conversation run and drops its binding, so a stale
 * card would have orphaned a live conversation.
 * At-most-once is the exchange claim, keyed `clarify:<askId>` by the caller:
 * two concurrent answers race that one claim, and the loser gets the existing
 * claim's 409 or turns.
 */
import type { Storage } from '../../storage/storage.js';
import { OpenwopError } from '../../types.js';
import type { ConversationTurn } from '../conversation.js';
import { assertResumeMatchesSchema } from '../resumeSchemaValidation.js';
import { isChatAskEnabled, renderChatAnswer, type ChatAnswers } from '../clarificationChat.js';
import { loadClarificationState } from './loadTurns.js';

export interface PreparedChatAnswer {
  askId: string;
  /** The user turn's displayed content (host-built from the answers). */
  display: string;
  /** What the model reads in place of that turn. */
  modelText: string;
  /** No answers: the person skipped (rendered per viewer locale by the client). */
  skipped: boolean;
  /** The agent that asked, so the answer reaches it. */
  askedBy?: string;
}

/** Parse the host-internal `clarificationAnswer` field of a resolve body. */
export function readClarificationAnswer(raw: unknown): { askId: string; answers: unknown } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as { askId?: unknown; answers?: unknown };
  return typeof r.askId === 'string' && r.askId ? { askId: r.askId, answers: r.answers } : undefined;
}

export async function prepareChatAnswer(input: {
  storage: Storage; tenantId: string; runId: string; conversationId: string;
  existing: readonly ConversationTurn[]; answer: { askId: string; answers: unknown };
}): Promise<PreparedChatAnswer> {
  const { storage, tenantId, runId, conversationId, existing, answer } = input;
  if (!(await isChatAskEnabled(tenantId))) {
    throw new OpenwopError('validation_error', 'clarificationAnswer is not accepted in this workspace.', 400, { field: 'clarificationAnswer' });
  }
  const { asks, answers } = await loadClarificationState(storage, runId, conversationId);
  const ask = asks.get(answer.askId);
  if (!ask) throw new OpenwopError('not_found', 'clarification_not_found: no such question in this conversation.', 404, { reason: 'clarification_not_found' });
  if (answers.has(answer.askId)) {
    throw new OpenwopError('conflict', 'clarification_answered: this question was already answered.', 409, { reason: 'clarification_answered' });
  }
  const latest = [...existing].filter((t) => t.role !== 'system').sort((a, b) => a.turnIndex - b.turnIndex).at(-1);
  if (!latest || latest.messageId !== answer.askId) {
    throw new OpenwopError('conflict', 'clarification_stale: the conversation has moved on since this question.', 409, { reason: 'clarification_stale' });
  }
  const value = { answers: answer.answers };
  assertResumeMatchesSchema(ask.resumeSchema, value); // 400 on a bad shape
  const rendered = renderChatAnswer(ask.questions, answer.answers as ChatAnswers);
  // The turn's display and model text are BOTH host-built: the client's own
  // `turn.content` is never read for an answer, so nothing it sends reaches the
  // model or another participant. A Skip is flagged so each viewer's client can
  // show it in their own language.
  const skipped = Array.isArray(answer.answers) && answer.answers.length === 0;
  const askedBy = latest.agent?.agentId ?? (latest.from !== 'assistant' ? latest.from : undefined);
  return { askId: answer.askId, display: rendered.display, skipped, modelText: rendered.modelText, ...(askedBy ? { askedBy } : {}) };
}
