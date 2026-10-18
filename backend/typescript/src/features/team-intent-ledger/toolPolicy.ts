/**
 * ADR 0856 D2 — the team ledger's tool policy, applied to its project's chats:
 * the project's group chat (owner subject) and every channel bound to it. A
 * forbidden tool is DISABLED; a require-approval tool suspends for a person.
 * The binding keeps applying when the project turns private (P0 finding 3:
 * narrowing must not silently lapse).
 */
import type { ConversationCapabilityScope, ConversationMeta } from '../../host/conversationStore.js';
import type { MissionInheritance, MissionInheritanceRequest } from '../../host/missionDraftInheritance.js';
import { ledgerAccess } from './access.js';
import { currentState, getLedger } from './ledgerStore.js';

/** The project whose ledger governs this conversation: its group chat, or a bound channel. */
function governingProject(meta: ConversationMeta): { projectId: string; viaChannelBinding: boolean } | undefined {
  if (meta.ownerSubject?.kind === 'project') return { projectId: meta.ownerSubject.id, viaChannelBinding: false };
  const bound = meta.channel?.boundProjectId;
  return bound ? { projectId: bound, viaChannelBinding: true } : undefined;
}

export async function teamLedgerScopeContributor(tenantId: string, meta: ConversationMeta): Promise<ConversationCapabilityScope | undefined> {
  const projectId = governingProject(meta)?.projectId;
  if (!projectId) return undefined;
  const p = (await getLedger(tenantId, projectId))?.toolPolicy;
  if (!p || (p.forbidden.length === 0 && p.requireApproval.length === 0)) return undefined;
  return {
    mode: 'restricted',
    ...(p.forbidden.length ? { disabled: p.forbidden } : {}),
    ...(p.requireApproval.length ? { requireApproval: p.requireApproval } : {}),
  };
}

/**
 * ADR 0856 D2 — the mission PRE-FILL for the same conversations: the team
 * ledger's goal and scope (text, for the form) and its tool policy (ids the
 * draft must keep). Composes NOTHING the drafting person cannot read (no leak
 * of a private project's text), and for a bound channel nothing unless the
 * project is org-visible — a channel's mission is read by every member (the
 * ADR 0852 D5 rule `teamLedgerChatContextProvider` applies). The gate above
 * enforces the policy in every case; this is drafting only.
 */
export async function teamLedgerMissionInheritance(req: MissionInheritanceRequest): Promise<MissionInheritance | undefined> {
  const g = governingProject(req.meta);
  if (!g || !req.callerUserId) return undefined;
  const access = await ledgerAccess(req.tenantId, g.projectId, req.callerUserId);
  if (!access) return undefined;
  if (g.viaChannelBinding && (access.project.visibility ?? 'org') !== 'org') return undefined;
  const ledger = await getLedger(req.tenantId, g.projectId);
  if (!ledger) return undefined;
  const state = currentState(ledger, access.project);
  return {
    source: { kind: 'project', id: access.project.id, name: access.project.name },
    ...(state.goal ? { goal: state.goal } : {}),
    inScope: state.inScope,
    outOfScope: state.outOfScope,
    forbidden: state.toolPolicy?.forbidden ?? [],
    requireApproval: state.toolPolicy?.requireApproval ?? [],
  };
}
