/**
 * Conversation exchange/close handler (RFC 0005 §D/§E, MAS Phase 4).
 *
 * Drives the `core.conversationGate` lifecycle from the resolve endpoint. Per
 * RFC 0005 §D an `exchange` round-trips WITHOUT resuming the node: it appends
 * the user turn, dispatches the addressed agent, appends the agent turn (each as
 * a `conversation.exchanged` event + a `messages`-channel write), and leaves the
 * node suspended. Only `close` resumes the node (via the injected `resume`).
 *
 * Conversation history is reconstructed from the EVENT LOG (replay-safe), not
 * in-process state. Turn ids are deterministic (`conversation.ts`). The answering
 * agent's prompt is the RFC-0002 persona wrapped by the multi-agent scaffold;
 * cross-agent turns are narrative-cast `[Persona]: …` so the model never adopts
 * another agent's identity.
 */

import { getEventLog } from '../executor/eventLog.js';
import { getAgentRegistry } from '../executor/agentRegistry.js';
import { getUser } from '../features/users/usersService.js';
import { composeAgentSystemPrompt } from './agentPromptScaffold.js';
import { appendChannelMessage } from './channelsRuntime.js';
import { makeTurn, type ConversationTurn } from './conversation.js';
import { dispatchChat, type ChatMessage } from '../providers/dispatch.js';
import { dispatchManagedChat, isManagedCredentialRef, managedProviderIdFromRef } from '../providers/managedProvider.js';
import { OpenwopError, type InterruptRecord, type RunRecord } from '../types.js';
import { stripSecretsFromPersisted } from '../byok/ephemeralRunSecrets.js';
import { sanitizeFreeText } from '../byok/textRedaction.js';
import type { Storage } from '../storage/storage.js';

const MAX_TOKENS = 1024;

/** Resume callback (the route injects `resolveAndResume`) — only `close` uses it. */
export type ResumeFn = (interruptId: string, value: unknown) => Promise<void>;

export interface ConversationResolve {
  operation: 'exchange' | 'close';
  turn?: { from?: unknown; to?: unknown; content?: unknown; role?: unknown };
  outcome?: unknown;
}

export interface ConversationResolveResult {
  operation: 'exchange' | 'close';
  conversationId: string;
  turns: ConversationTurn[];
}

/** Reconstruct the conversation's turns from the durable event log (sorted by
 *  turnIndex). The open turn + every exchanged turn for this conversationId. */
async function loadTurns(storage: Storage, runId: string, conversationId: string): Promise<ConversationTurn[]> {
  const events = await storage.listEvents(runId);
  const turns: ConversationTurn[] = [];
  for (const e of events) {
    const p = (e.payload ?? {}) as { conversationId?: string; initialTurn?: ConversationTurn; turn?: ConversationTurn };
    if (p.conversationId !== conversationId) continue;
    if (e.type === 'conversation.opened' && p.initialTurn) turns.push(p.initialTurn);
    else if (e.type === 'conversation.exchanged' && p.turn) turns.push(p.turn);
  }
  return turns.sort((a, b) => a.turnIndex - b.turnIndex);
}

function asText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

/** Build the provider messages: the answering agent's scaffold as the single
 *  system message, then the prior turns. A prior `agent` turn written by a
 *  DIFFERENT agent than the one now answering is narrative-cast `[Persona]: …`. */
function turnsToMessages(turns: readonly ConversationTurn[], scaffold: string, answeringAgentId: string | undefined): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: scaffold }];
  for (const t of turns) {
    if (t.role === 'system') continue; // the open turn — the scaffold supersedes it
    if (t.role === 'user') {
      msgs.push({ role: 'user', content: asText(t.content) });
    } else {
      const otherAgent = t.agent?.agentId && t.agent.agentId !== answeringAgentId;
      const label = otherAgent ? `[${t.from}]: ` : '';
      msgs.push({ role: 'assistant', content: label + asText(t.content) });
    }
  }
  return msgs;
}

/** The acting human's display name for the scaffold — tenant-scoped, fail-soft. */
async function resolveUserName(run: RunRecord): Promise<string | null> {
  const uid = run.metadata?.['actingUserId'];
  if (typeof uid !== 'string' || uid.length === 0) return null;
  try {
    const user = await getUser(uid);
    if (!user || (user.tenantId && user.tenantId !== run.tenantId)) return null;
    const name = user.displayName?.trim();
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** Dispatch one agent reply for the conversation, honoring the run's provider
 *  config. Managed (the demo default) + mock are supported; BYOK-direct in the
 *  exchange path is a follow-up (the demo's default chat is managed). */
async function dispatchReply(run: RunRecord, messages: ChatMessage[]): Promise<string> {
  const inputs = (run.inputs ?? {}) as { provider?: unknown; model?: unknown; credentialRef?: unknown };
  const credentialRef = typeof inputs.credentialRef === 'string' ? inputs.credentialRef : 'managed:openwop-free';
  const provider = typeof inputs.provider === 'string' ? inputs.provider : undefined;
  const model = typeof inputs.model === 'string' ? inputs.model : 'unknown';

  if (provider === 'mock') {
    const r = await dispatchChat({ provider: 'mock', model, apiKey: '', messages, maxTokens: MAX_TOKENS });
    return r.completion;
  }
  if (isManagedCredentialRef(credentialRef)) {
    const r = await dispatchManagedChat({
      userFacingProvider: managedProviderIdFromRef(credentialRef),
      tenantId: run.tenantId,
      messages,
      maxTokens: MAX_TOKENS,
    });
    return r.completion;
  }
  throw new OpenwopError(
    'validation_error',
    'Conversation exchange currently supports the managed (free-tier) and mock providers; BYOK-direct dispatch in a conversation is not yet wired.',
    422,
    { credentialRef },
  );
}

/**
 * Handle one `ConversationResolve` against a suspended `core.conversationGate`.
 * Returns the operation + the conversation's turns after the operation.
 */
export async function handleConversationResolve(
  storage: Storage,
  interrupt: InterruptRecord,
  resumeValue: unknown,
  resume: ResumeFn,
): Promise<ConversationResolveResult> {
  const data = (interrupt.data ?? {}) as { conversationId?: string };
  const conversationId = data.conversationId ?? `${interrupt.runId}:${interrupt.nodeId}:0`;
  const body = (resumeValue ?? {}) as ConversationResolve;
  const operation: 'exchange' | 'close' = body.operation === 'close' ? 'close' : 'exchange';

  const run = await storage.getRun(interrupt.runId);
  if (!run) throw new OpenwopError('run_not_found', `run ${interrupt.runId} missing during conversation resolve`, 404);

  const existing = await loadTurns(storage, interrupt.runId, conversationId);
  const nextIndex = existing.length === 0 ? 1 : Math.max(...existing.map((t) => t.turnIndex)) + 1;
  const log = getEventLog();

  if (operation === 'close') {
    const finalTurn = makeTurn({
      conversationId, turnIndex: nextIndex, role: 'system', from: 'system',
      content: 'Conversation closed.', ts: Date.now(),
    });
    // stripSecretsFromPersisted — parity with ctx.emit; the outcome may echo data.
    await log.append({
      runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'conversation.closed',
      payload: stripSecretsFromPersisted({ conversationId, turnIndex: nextIndex, finalTurn, ...(body.outcome !== undefined ? { outcome: body.outcome } : {}) }),
    });
    await resume(interrupt.interruptId, body.outcome ?? null); // resumes the suspended node
    return { operation, conversationId, turns: [...existing, finalTurn] };
  }

  // ── exchange ───────────────────────────────────────────────────────────
  // Validate the turn (RFC 0005 §E — reject an empty/invalid exchange).
  const rawContent = body.turn?.content;
  if (rawContent === undefined || rawContent === null || asText(rawContent).trim().length === 0) {
    throw new OpenwopError('validation_error', 'Conversation exchange requires a non-empty turn.content.', 422, { conversationId });
  }
  const to = typeof body.turn?.to === 'string' ? body.turn.to : undefined;
  // Redact secrets from the user's text BEFORE it is persisted OR sent to the
  // model (a pasted key must not leak into the event log, channel, or prompt).
  const userText = sanitizeFreeText(asText(rawContent));
  const userTurn = makeTurn({
    conversationId, turnIndex: nextIndex, role: 'user', from: 'user',
    content: userText, ts: Date.now(), groupId: conversationId, ...(to ? { to } : {}),
  });

  // Resolve the addressed agent + compose its persona scaffold (tenant-scoped).
  const agent = to ? await getAgentRegistry().resolve(to) : null;
  const tenantOk = !agent || !agent.ownerTenant || agent.ownerTenant === run.tenantId;
  const userName = await resolveUserName(run);
  const scaffold = agent && agent.systemPrompt && tenantOk
    ? composeAgentSystemPrompt({ persona: agent.persona, role: agent.label, systemPrompt: agent.systemPrompt, userName })
    : 'You are a helpful AI assistant in a shared chat. Reply concisely.';
  const answeringId = agent && tenantOk ? agent.agentId : undefined;

  // Dispatch FIRST, then emit user + agent turns together. Idempotency: a failed
  // dispatch (rate-limit/cap) emits NOTHING, so a client retry can't leave a
  // dangling user turn that bumps turnIndex and duplicates the message.
  const messages = turnsToMessages([...existing, userTurn], scaffold, answeringId);
  let completion: string;
  try {
    completion = sanitizeFreeText(await dispatchReply(run, messages));
  } catch (err) {
    // Surface a clean 4xx/5xx with the provider reason instead of a raw 500;
    // nothing was persisted (dispatch-first), so the turn is cleanly retryable.
    if (err instanceof OpenwopError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new OpenwopError('internal_error', `Conversation reply failed: ${msg}`, 502, { conversationId });
  }

  const agentIndex = nextIndex + 1;
  const agentTurn = makeTurn({
    conversationId, turnIndex: agentIndex, role: 'agent',
    from: answeringId ?? 'assistant', content: completion, ts: Date.now(), groupId: conversationId,
    ...(answeringId ? { agent: { agentId: answeringId } } : {}),
  });
  for (const [idx, turn] of [[nextIndex, userTurn], [agentIndex, agentTurn]] as const) {
    await log.append({
      runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'conversation.exchanged',
      payload: stripSecretsFromPersisted({ conversationId, turnIndex: idx, turn }),
    });
  }
  appendChannelMessage(interrupt.runId, 'messages', { messageId: userTurn.messageId, role: 'user', content: userText, timestamp: new Date(userTurn.ts).toISOString() });
  appendChannelMessage(interrupt.runId, 'messages', {
    messageId: agentTurn.messageId, role: 'assistant', content: completion,
    timestamp: new Date(agentTurn.ts).toISOString(), ...(answeringId ? { agentId: answeringId } : {}),
  });

  return { operation, conversationId, turns: [...existing, userTurn, agentTurn] };
}
