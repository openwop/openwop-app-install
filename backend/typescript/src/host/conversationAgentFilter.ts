/**
 * ADR 1040 D2 — "this agent's conversations": the ONE predicate behind
 * `GET /chat/sessions?agentId=` (and, in PR C, the agent-scoped search).
 *
 * It only ever NARROWS a list the caller may already see; the route applies it
 * after the visibility and rail-listing filters, never instead of them.
 *
 * One agent has several spellings in stored `agent:<id>` participants:
 *  - ADR 0763 legacy `feature.*.agents.*` vs canonical `vendor.openwop-app.*`
 *    (compared through `agentStorageId`, never a raw `===`);
 *  - a standing roster id (`host:<…>`, the persona a user renames) vs the
 *    registry id it instantiates (`agentRef.agentId`).
 *
 * Which conversations an id means (grade-code M2):
 *  - a ROSTER id names ONE persona: only conversations stamped with that roster
 *    id. Its sibling personas of the same registry agent are other people's
 *    "Kickbot", and a bare registry stamp does not say which persona spoke.
 *  - a REGISTRY id names the agent: conversations stamped with it under either
 *    ADR 0763 spelling, plus EVERY roster persona that instantiates it (all of
 *    them, from one roster read — not the identity resolver's first match or
 *    its 30 s cache).
 */
import { agentStorageId } from '../executor/agentIdAliases.js';
import { listRoster } from './rosterService.js';
import type { ConversationMeta } from './conversationStore.js';

const AGENT_PREFIX = 'agent:';

/** The storage-spelling keys any `agent:` participant of this agent can carry. */
export async function agentMatchKeys(tenantId: string, agentId: string): Promise<ReadonlySet<string>> {
  const requested = agentStorageId(agentId);
  const keys = new Set<string>([requested]);
  // A roster id is never a registry id, so for one it adds nothing: one persona.
  for (const entry of await listRoster(tenantId)) {
    if (agentStorageId(entry.agentRef.agentId) === requested) keys.add(entry.rosterId);
  }
  return keys;
}

/** Does this conversation name the agent (any spelling in `keys`) as a participant? */
export function conversationHasAgent(meta: Pick<ConversationMeta, 'participants'> | null | undefined, keys: ReadonlySet<string>): boolean {
  for (const p of meta?.participants ?? []) {
    if (!p.subjectRef.startsWith(AGENT_PREFIX)) continue;
    const id = p.subjectRef.slice(AGENT_PREFIX.length);
    if (keys.has(id) || keys.has(agentStorageId(id))) return true;
  }
  return false;
}
