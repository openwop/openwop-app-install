/**
 * ADR 0856 D2 — a mission drafted in a project's conversation starts from the
 * team ledger and can only narrow it. Read through the host seam
 * (`host/missionDraftInheritance.ts`); this feature never imports the team
 * ledger.
 *
 * Two rules, applied on EVERY write path (the /draft and PUT routes and the
 * `draft-contract` agent tool):
 *   - PRE-FILL: an absent `goal` takes the inherited goal; an absent `forbidden` /
 *     `requireApproval` takes the inherited ids.
 *   - REFUSE, never rewrite (the XCH-TL-1 posture of the ledger validators): a
 *     list that is supplied but drops an inherited id is a 400 naming the ids, so
 *     a person or a model can repair it. Silently re-adding would report success
 *     for something the caller never sent.
 *
 * Not an enforcement path: the gate applies the team policy whatever the mission
 * says. The inherited text is untrusted user text, stored and shown as data like
 * any typed goal (fenced only where it is composed into a prompt).
 */
import { OpenwopError } from '../../types.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { collectMissionInheritance, droppedInheritedRestrictions, type MissionInheritance } from '../../host/missionDraftInheritance.js';

export async function missionInheritanceFor(tenantId: string, conversationId: string, callerUserId: string | undefined): Promise<MissionInheritance[]> {
  const meta = await getConversationMeta(tenantId, conversationId);
  if (!meta) return [];
  return collectMissionInheritance({ tenantId, meta, callerUserId });
}

/** The draft a form starts from: the first inherited goal, the union of the ids. */
export function prefillOf(inherited: readonly MissionInheritance[]): { goal?: string; forbidden: string[]; requireApproval: string[] } {
  const goal = inherited.find((m) => m.goal)?.goal;
  return {
    ...(goal ? { goal } : {}),
    forbidden: [...new Set(inherited.flatMap((m) => m.forbidden))],
    requireApproval: [...new Set(inherited.flatMap((m) => m.requireApproval))],
  };
}

/** Fill the fields the caller left out. A supplied field is never touched. */
export function withInheritedDefaults(raw: unknown, inherited: readonly MissionInheritance[]): unknown {
  if (inherited.length === 0) return raw;
  const o = { ...((raw ?? {}) as Record<string, unknown>) };
  const p = prefillOf(inherited);
  if ((typeof o.goal !== 'string' || !o.goal.trim()) && p.goal) o.goal = p.goal;
  if (o.forbidden === undefined) o.forbidden = p.forbidden;
  if (o.requireApproval === undefined) o.requireApproval = p.requireApproval;
  return o;
}

/** 400 when the mission drops an inherited restriction (it may only narrow). */
export function assertKeepsInherited(
  mission: { forbidden: readonly string[]; requireApproval: readonly string[] },
  inherited: readonly MissionInheritance[],
): void {
  const dropped = droppedInheritedRestrictions(inherited, mission);
  if (dropped.forbidden.length === 0 && dropped.requireApproval.length === 0) return;
  const parts = [
    ...(dropped.forbidden.length ? [`forbidden: ${dropped.forbidden.join(', ')}`] : []),
    ...(dropped.requireApproval.length ? [`requireApproval: ${dropped.requireApproval.join(', ')}`] : []),
  ];
  throw new OpenwopError(
    'validation_error',
    `This conversation's team ledger restricts tools the mission must keep (it can only narrow them) — ${parts.join('; ')}.`,
    400,
    { field: dropped.forbidden.length ? 'forbidden' : 'requireApproval', inherited: dropped },
  );
}
