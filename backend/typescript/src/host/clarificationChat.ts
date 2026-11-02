/**
 * ADR 1001 D7 (P2) — the CHAT lane's clarification: an agent in a conversation
 * ends its turn with structured questions (the `openwop:ask-user` tool),
 * the person answers on the card, and the answer comes back as the NEXT
 * exchange. There is no interrupt and no suspended node: a chat turn runs in
 * the resolve handler (RFC 0005 §D), so ADR 0834 D6's disposition stands.
 *
 * What lives here (core — every caller is core: the tool loop, the exchange,
 * `loadTurns`):
 *  - the turn-scoped SINK a tool records its ask on (the `onRunDispatched`
 *    precedent): present only on the conversation transport, so the tool fails
 *    closed on voice and the run lane;
 *  - the two run-log events the ask and its answer ride, read back by
 *    `loadTurns` with the turns (durable, replay-copied, no second store);
 *  - the model-facing rendering of an answer: a chosen option is MODEL text,
 *    so it reaches the model inside a fence, while the person's own free text
 *    is their turn (ADR 1001 O2).
 */
import { fenceUntrustedBlock } from './untrustedContent.js';
import type { LiftedQuestion } from './clarificationLift.js';

/** Run-log events (host-ext, never on the normative `conversation.exchanged`). */
export const CLARIFICATION_REQUESTED_EVENT = 'openwop-app.conversation.clarification-requested';
export const CLARIFICATION_ANSWERED_EVENT = 'openwop-app.conversation.clarification-answered';

/** What the tool records for the turn. */
export interface ChatClarificationAsk {
  questions: LiftedQuestion[];
  data: { questions: Array<{ id: string; question: string; schema: Record<string, unknown> }>; contextType?: string };
  resumeSchema: Record<string, unknown>;
}

export interface ChatClarificationSink {
  record(ask: ChatClarificationAsk): 'recorded' | 'already_asked';
}

/** One ask per turn: a second call in the same turn is refused to the model. */
export function createChatClarificationCollector(): { sink: ChatClarificationSink; drain: () => ChatClarificationAsk | undefined } {
  let ask: ChatClarificationAsk | undefined;
  return {
    sink: { record: (a) => { if (ask) return 'already_asked'; ask = a; return 'recorded'; } },
    drain: () => ask,
  };
}

/** The persisted ask (the `clarification-requested` event payload). `askId` is
 *  the agent turn's messageId: one ask per turn, stable across replays. */
export interface ChatAskRecord {
  conversationId: string;
  askId: string;
  questions: LiftedQuestion[];
  data: ChatClarificationAsk['data'];
  resumeSchema: Record<string, unknown>;
}

/** The persisted answer (the `clarification-answered` event payload). */
export interface ChatAnswerRecord {
  conversationId: string;
  askId: string;
  /** The user turn that carried the answer. */
  turnMessageId: string;
  /** What the MODEL reads in place of that turn's content. */
  modelText: string;
  /** The person skipped (no answers). */
  skipped?: true;
}

/** The plain-text questions an agent turn shows (and a client without the card
 *  reads); the model sees its own ask in this form in later turns. */
export function renderAskText(questions: readonly LiftedQuestion[]): string {
  const lines = questions.map((q, i) => {
    const choices = q.answer.kind === 'choice' ? ` (${q.answer.choices.join(' / ')})` : q.answer.kind === 'boolean' ? ' (yes / no)' : '';
    return `${questions.length > 1 ? `${i + 1}. ` : ''}${q.question}${choices}`;
  });
  return lines.join('\n');
}

/** The resolved answer, already validated against the ask's resumeSchema. */
export type ChatAnswers = Array<{ id: string; answer: string | boolean }>;

/**
 * The user turn's DISPLAYED content and the MODEL's rendering of it.
 * Displayed: the person's answers, readable, as their own message. Model: host
 * framing, the person's free text as theirs, and every value that came from the
 * model's own options (a choice; yes/no is host vocabulary) inside one fence.
 */
export function renderChatAnswer(questions: readonly LiftedQuestion[], answers: ChatAnswers): { display: string; modelText: string } {
  if (answers.length === 0) {
    const text = 'I skipped your questions.';
    return { display: text, modelText: `${text} Do not guess the missing information; finish with what you have and say what is missing.` };
  }
  const byId = new Map(answers.map((a) => [a.id, a.answer]));
  const display: string[] = [];
  const own: string[] = [];
  const chosen: string[] = [];
  for (const q of questions) {
    const a = byId.get(q.id);
    if (a === undefined) continue;
    const v = typeof a === 'boolean' ? (a ? 'yes' : 'no') : a;
    display.push(`${q.question} ${v}`);
    if (q.answer.kind === 'choice') chosen.push(`${q.id} (${q.question}): ${JSON.stringify(v)}`);
    else own.push(`${q.question} ${v}`);
  }
  const parts = ['My answers to your questions.'];
  if (own.length > 0) parts.push(own.join('\n'));
  if (chosen.length > 0) {
    parts.push('I picked these from the options you offered:');
    parts.push(fenceUntrustedBlock(chosen.join('\n'), 'the options you proposed'));
  }
  return { display: display.join('\n'), modelText: parts.join('\n') };
}

/**
 * Whether the chat ask is enabled for a tenant: the feature's toggle (and its
 * parent), late-bound by `features/agent-clarification` so core names no
 * feature toggle. Unbound ⇒ off (fail closed).
 */
let chatAskEnabled: ((tenantId: string) => Promise<boolean>) | null = null;
export function setChatAskEnabledResolver(fn: ((tenantId: string) => Promise<boolean>) | null): void {
  chatAskEnabled = fn;
}
export async function isChatAskEnabled(tenantId: string): Promise<boolean> {
  if (!chatAskEnabled) return false;
  try { return await chatAskEnabled(tenantId); } catch { return false; }
}
