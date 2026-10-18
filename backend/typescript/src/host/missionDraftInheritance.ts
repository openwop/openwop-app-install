/**
 * ADR 0856 D2 — the seam a feature uses to PRE-FILL an ADR 0136 mission draft in
 * a conversation it governs (a team ledger for its project's chat and bound
 * channels), without core importing the feature.
 *
 * A DRAFTING convenience, not an enforcement path: the tool restrictions here are
 * already applied by `resolveConversationToolGate` through
 * `conversationScopeContributors.ts`, whatever the mission says. What this seam
 * adds is that a draft starts with them and cannot be saved without them.
 *
 * PER CALLER, like `chatSubjectContextProviders.ts`: a provider composes nothing
 * the drafting person cannot read. The text it returns is untrusted user text —
 * data for a form, never instructions. A provider that throws contributes
 * nothing (logged); safe because the gate still enforces the policy.
 */
import { createLogger } from '../observability/logger.js';
import { tokenMatches } from './agentToolPermissions.js';
import type { ConversationMeta } from './conversationStore.js';

const log = createLogger('host.missionDraftInheritance');

export interface MissionInheritance {
  /** Where it came from, for the form ("from project X's team ledger"). */
  source: { kind: 'project'; id: string; name: string };
  goal?: string;
  inScope: string[];
  outOfScope: string[];
  /** Tool ids/prefixes the mission must keep forbidden. */
  forbidden: string[];
  /** Tool ids/prefixes the mission must keep behind approval (or forbid). */
  requireApproval: string[];
}
export interface MissionInheritanceRequest { tenantId: string; meta: ConversationMeta; callerUserId: string | undefined }
export type MissionInheritanceProvider = (req: MissionInheritanceRequest) => Promise<MissionInheritance | undefined>;

const providers: Array<{ id: string; fn: MissionInheritanceProvider }> = [];

export function registerMissionInheritanceProvider(id: string, fn: MissionInheritanceProvider): void {
  if (providers.some((p) => p.id === id)) return;
  providers.push({ id, fn });
}

export async function collectMissionInheritance(req: MissionInheritanceRequest): Promise<MissionInheritance[]> {
  const out: MissionInheritance[] = [];
  for (const p of providers) {
    try {
      const m = await p.fn(req);
      if (m) out.push(m);
    } catch (err) {
      log.warn('mission_inheritance_provider_failed', { id: p.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Inherited ids the mission no longer carries. A forbidden id is kept by a mission
 *  `forbidden` token covering it (exact or dotted prefix — the gate's own match); a
 *  require-approval id by a covering `requireApproval` OR `forbidden` token
 *  (forbidding is narrower than asking). Empty ⇒ the mission only narrows. */
export function droppedInheritedRestrictions(
  inherited: readonly MissionInheritance[],
  mission: { forbidden: readonly string[]; requireApproval: readonly string[] },
): { forbidden: string[]; requireApproval: string[] } {
  const covered = (tokens: readonly string[], id: string): boolean => tokens.some((t) => tokenMatches(t, id));
  const forbidden = new Set<string>();
  const requireApproval = new Set<string>();
  for (const m of inherited) {
    for (const id of m.forbidden) if (!covered(mission.forbidden, id)) forbidden.add(id);
    for (const id of m.requireApproval) {
      if (!covered(mission.requireApproval, id) && !covered(mission.forbidden, id)) requireApproval.add(id);
    }
  }
  return { forbidden: [...forbidden], requireApproval: [...requireApproval] };
}
