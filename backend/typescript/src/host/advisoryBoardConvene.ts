/**
 * Board-of-Advisors convene orchestration (ADR 0040, Phase 2/3) — the broadcast
 * fan-out that turns one user prompt into a shared, attributed council transcript.
 *
 * Lives in the HOST layer (like `agentKnowledgeComposition.ts`) because every
 * primitive it composes is host-owned — the roster (`rosterService`), the agent
 * registry, the per-agent knowledge retrieval (ADR 0038), the multi-agent prompt
 * scaffold (`agentPromptScaffold` — already guards conformity / confabulation /
 * impersonation), and the managed/mock chat dispatch. So the `advisory-board`
 * feature calls IN to this host module; core never imports the feature
 * (ADR 0001 import boundary).
 *
 * Each advisor replies in declared order, seeing the user turn AND the earlier
 * advisors' turns this round (so they build on / challenge each other by name),
 * grounded in its OWN bound corpus (ADR 0038, retrieved per advisor). A moderator
 * then synthesizes. The `reply` function is injected (default: managed/mock chat,
 * mirroring `conversationExchange.dispatchReply`) so the loop is deterministically
 * testable without a live model.
 *
 * @see docs/adr/0040-board-of-advisors.md
 */

import { getRosterEntry } from './rosterService.js';
import { getAgentRegistry } from '../executor/agentRegistry.js';
import { composeAgentSystemPrompt } from './agentPromptScaffold.js';
import { createAgentMemoryPort, agentMemoryScope } from './agentMemoryAdapter.js';
import { resolveAgentKnowledgeRetrieve } from './agentKnowledgeComposition.js';
import { dispatchChat, type ChatMessage } from '../providers/dispatch.js';
import { dispatchManagedChat, isManagedCredentialRef, managedProviderIdFromRef } from '../providers/managedProvider.js';
import { sanitizeFreeText } from '../byok/textRedaction.js';
import type { CouncilTurn, PersonaKind } from '../features/advisory-board/types.js';

const MAX_TOKENS = 1024;
/** Cap the per-advisor knowledge block so one corpus can't crowd the prompt. */
const MAX_KNOWLEDGE_CHUNKS = 4;

/** The injected reply seam — given the composed messages, return one completion. */
export type CouncilReply = (input: { messages: ChatMessage[] }) => Promise<string>;

export interface ConveneAdvisorsInput {
  tenantId: string;
  /** The acting human's display name (or null → addressed in the second person). */
  userName: string | null;
  prompt: string;
  /** Ordered advisor roster ids (the resolved cohort). */
  advisors: string[];
  /** Optional synthesizer roster id; absent ⇒ a generic "Moderator" synthesis. */
  moderatorRosterId?: string | undefined;
  /** Dominant persona kind — drives the likeness simulation notice. */
  personaKind: PersonaKind;
  /** Append a closing moderator synthesis turn. */
  synthesize: boolean;
  /** Prior transcript when continuing a session (for cross-turn context). */
  priorTurns?: CouncilTurn[];
}

export interface ConveneAdvisorsDeps {
  reply: CouncilReply;
}

/** A managed/mock reply seam from a convene request's provider config — the
 *  feature route's default `reply`. `provider:'mock'` ⇒ the deterministic mock
 *  (used by tests); otherwise the managed free tier (the demo default). */
export function defaultCouncilReply(tenantId: string, provider?: string, credentialRef?: string): CouncilReply {
  const credRef = credentialRef && credentialRef.length > 0 ? credentialRef : 'managed:openwop-free';
  return async ({ messages }) => {
    if (provider === 'mock') {
      const r = await dispatchChat({ provider: 'mock', model: 'mock', apiKey: '', messages, maxTokens: MAX_TOKENS });
      return r.completion;
    }
    if (isManagedCredentialRef(credRef)) {
      const r = await dispatchManagedChat({
        userFacingProvider: managedProviderIdFromRef(credRef),
        tenantId,
        messages,
        maxTokens: MAX_TOKENS,
      });
      return r.completion;
    }
    // BYOK-direct council dispatch is a follow-on (the demo default is managed).
    const r = await dispatchManagedChat({ userFacingProvider: 'openwop-free', tenantId, messages, maxTokens: MAX_TOKENS });
    return r.completion;
  };
}

/** The simulation notice prepended to every advisor (and the moderator) — the
 *  likeness / right-of-publicity guard (ADR 0040 § "Legal / likeness governance").
 *  Strongest for `living`, but present for every simulated real person. */
function simulationNotice(kind: PersonaKind): string {
  if (kind === 'original' || kind === 'fictional') return '';
  return [
    'SIMULATION NOTICE: You are a SIMULATED persona for ideation and strategy only —',
    'you are NOT the real individual and you do not speak for them. Do NOT fabricate',
    'verbatim quotes, endorsements, or present-day statements. Reason from the public',
    'frameworks and decision-making style associated with this person, and explicitly',
    'flag when you are speculating beyond what is actually documented.',
  ].join(' ');
}

const DIVERSITY_NOTE =
  'Give your own distinct, candid perspective. Where you disagree with another ' +
  'advisor in this thread, say so by name and explain why — do not simply echo the ' +
  'emerging consensus. Be concise.';

function asMessages(scaffold: string, transcript: readonly CouncilTurn[], answeringSpeakerId: string): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: scaffold }];
  for (const t of transcript) {
    if (t.role === 'user') {
      msgs.push({ role: 'user', content: t.content });
    } else {
      // A turn by a DIFFERENT speaker is narrative-cast `[Name]: …` so the model
      // never adopts another advisor's identity (the scaffold's failure-mode guard).
      const other = t.speakerId !== answeringSpeakerId;
      msgs.push({ role: 'assistant', content: (other ? `[${t.speakerName}]: ` : '') + t.content });
    }
  }
  return msgs;
}

/** Retrieve a per-advisor knowledge block (TRUSTED chunks only — untrusted,
 *  externally-sourced chunks are dropped here rather than injected as advisor-
 *  trusted; ADR 0038 §C). Best-effort: any failure yields no block. */
async function knowledgeBlockFor(tenantId: string, agentId: string, query: string): Promise<{ block: string; grounded: boolean }> {
  try {
    const memory = createAgentMemoryPort(tenantId);
    const retrieve = await resolveAgentKnowledgeRetrieve(tenantId, agentId, memory, agentMemoryScope(agentId));
    if (!retrieve) return { block: '', grounded: false };
    const chunks = (await retrieve(query)).filter((c) => c.contentTrust !== 'untrusted').slice(0, MAX_KNOWLEDGE_CHUNKS);
    if (chunks.length === 0) return { block: '', grounded: false };
    const lines = chunks.map((c) => `- ${c.title ? `(${c.title}) ` : ''}${c.content}`);
    return { block: `Relevant material from your own corpus (cite it where you draw on it):\n${lines.join('\n')}`, grounded: true };
  } catch {
    return { block: '', grounded: false };
  }
}

/** Run one council round: append the user turn, fan out to each advisor in order
 *  (each grounded in its own corpus + seeing the earlier advisors), then a
 *  moderator synthesis. Returns the NEW turns (the caller appends them to the
 *  session transcript). */
export async function conveneAdvisors(input: ConveneAdvisorsInput, deps: ConveneAdvisorsDeps): Promise<CouncilTurn[]> {
  const prior = input.priorTurns ?? [];
  let index = prior.length;
  const now = (): string => new Date().toISOString();
  const newTurns: CouncilTurn[] = [];

  const userTurn: CouncilTurn = {
    turnIndex: index++,
    speakerId: 'user',
    speakerName: input.userName && input.userName.trim().length > 0 ? input.userName.trim() : 'You',
    role: 'user',
    content: input.prompt,
    ts: now(),
  };
  newTurns.push(userTurn);

  const notice = simulationNotice(input.personaKind);

  for (const rosterId of input.advisors) {
    const entry = await getRosterEntry(rosterId);
    if (!entry || entry.tenantId !== input.tenantId) continue; // defensive: skip a stale/cross-tenant id
    const manifest = await getAgentRegistry().resolve(entry.agentRef.agentId);
    const persona = entry.persona || manifest?.persona || rosterId;
    const role = entry.label ?? manifest?.label;
    const authored = (manifest?.systemPrompt ?? '').trim();
    const personaBody = authored.length > 0
      ? authored
      : `You are ${persona}. Advise candidly, in character, from the real-world frameworks and decision-making style associated with you.`;

    // Knowledge + memory are keyed by the agent's `agentProfile.profileId` =
    // rosterId (ADR 0038 binds via the roster member, NOT the shared manifest
    // pack id) — so retrieval MUST use `rosterId`, not `agentRef.agentId` (which
    // many roster members can share, and which carries no binding).
    const { block, grounded } = await knowledgeBlockFor(input.tenantId, rosterId, input.prompt);
    const systemPrompt = [personaBody, notice, DIVERSITY_NOTE, block].filter((s) => s && s.length > 0).join('\n\n');
    const scaffold = composeAgentSystemPrompt({ persona, role, systemPrompt, userName: input.userName });

    const transcript = [...prior, ...newTurns];
    const completion = sanitizeFreeText(await deps.reply({ messages: asMessages(scaffold, transcript, rosterId) }));
    newTurns.push({
      turnIndex: index++,
      speakerId: rosterId,
      speakerName: persona,
      role: 'advisor',
      content: completion,
      ts: now(),
      ...(grounded ? { grounded: true } : {}),
    });
  }

  if (input.synthesize) {
    let moderatorName = 'Moderator';
    let moderatorSpeaker = 'moderator';
    if (input.moderatorRosterId) {
      const mod = await getRosterEntry(input.moderatorRosterId);
      if (mod && mod.tenantId === input.tenantId) {
        moderatorName = mod.persona || moderatorName;
        moderatorSpeaker = `moderator:${input.moderatorRosterId}`;
      }
    }
    const synthSystem = [
      `You are ${moderatorName}, the neutral moderator of an advisory council.`,
      `Synthesize the advisors' contributions for ${input.userName && input.userName.trim() ? input.userName.trim() : 'the user'}:`,
      'state the points of genuine AGREEMENT, the real DISAGREEMENTS (name which advisor holds which view),',
      'and a concise recommended decision or a short set of options. Be balanced and do NOT invent positions',
      'no advisor took.',
      notice ? `(${notice})` : '',
    ].filter(Boolean).join(' ');
    const transcript = [...prior, ...newTurns];
    const completion = sanitizeFreeText(await deps.reply({ messages: asMessages(synthSystem, transcript, moderatorSpeaker) }));
    newTurns.push({
      turnIndex: index++,
      speakerId: moderatorSpeaker,
      speakerName: moderatorName,
      role: 'moderator',
      content: completion,
      ts: now(),
    });
  }

  return newTurns;
}
