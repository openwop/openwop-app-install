/**
 * convene — the shared `@@` convene/board interceptors (ADR 0140 G3). Extracted from
 * ChatSidebar so BOTH the single-session sidebar AND each multi-tab `TabSession` can run
 * them on the shared CORE submit pipeline (chatSubmit). They run BETWEEN /workflow and
 * the single `@` mention, so `@@board` is never read as `@board`.
 *
 *   - `buildBoardInterceptor` — `@@<board-handle>` summons a Board of Advisors (ADR 0040)
 *     in ANY conversation (the board is resolved by handle, tab-independent).
 *   - `buildProjectConveneInterceptor` — a BARE leading `@@` convenes the OWNING project's
 *     team (ADR 0054 D6); only meaningful when the conversation is a project group chat
 *     (`conveneProjectId` non-null), so a plain tab passes `conveneProjectId: null`.
 *
 * Both reuse the boardroom cadence (`planBoardroomTurns` + the surface's own
 * `useBoardroomCadence`) verbatim. The surface supplies its live deps (its own
 * activeAgents, cadence, send, session id) so the convened turns land in THAT surface.
 */

import { getBoardByHandle } from '../../features/advisory-board/advisoryBoardClient.js';
import { getProject } from '../../features/projects/projectsClient.js';
import { listRoster } from '../../agents/rosterClient.js';
import { planBoardroomTurns, orderConveneCohort } from './boardroomCadence.js';
import { detectBoardMention, type AgentMentionEntry } from '../lib/agentMentions.js';
import { formatNumber } from '../../i18n/format.js';
import type { TFunction } from 'i18next';
import type { BoardroomCadence } from './useBoardroomCadence.js';
import type { SubmitInterceptor } from '../lib/chatSubmit.js';
import type { BYOKActiveConfig } from '../../byok/lib/useBYOKConfig.js';
import type { SendOptions } from '../hooks/useChatSession.js';

/** Max agents a project convene seats at once (cost guardrail, ADR 0054 D6 §2). */
export const CONVENE_COHORT_CAP = 8;

export interface ConveneDeps {
  agentEntries: readonly AgentMentionEntry[];
  activeAgents: { activateAgent: (e: AgentMentionEntry) => string; switchTo: (id: string) => void };
  cadenceStart: BoardroomCadence['start'];
  send: (text: string, config: BYOKActiveConfig, opts?: SendOptions) => Promise<void>;
  config: BYOKActiveConfig;
  emitSystem: (text: string) => void;
  t: TFunction;
  attachBoard: (sessionId: string, boardId: string, participants: string[]) => Promise<void>;
  /** Read live so a board attach targets the CURRENT chat after a reset/switch. */
  getSessionId: () => string;
  /** The owning project id when this is a project group chat, else null. */
  conveneProjectId: string | null;
}

/** Convene the owning project's team on the boardroom cadence (ADR 0054 D6). The chair
 *  opens; advisors follow one voice at a time. Owns the turn (sends the opener). */
export async function runProjectConvene(topic: string, deps: ConveneDeps): Promise<void> {
  const { conveneProjectId, agentEntries, activeAgents, cadenceStart, send, config, emitSystem, t } = deps;
  if (!conveneProjectId) return;
  try {
    const [project, roster] = await Promise.all([getProject(conveneProjectId), listRoster()]);
    const agentIdByRoster = new Map(roster.map((r) => [r.rosterId, r.agentRef?.agentId]));
    const memberRosterIds = (project.members ?? []).filter((m) => m.ref.startsWith('agent:')).map((m) => m.ref.slice('agent:'.length));
    // Chair first (frames + synthesizes), then the rest — capped for cost.
    const cohortRosterIds = orderConveneCohort(project.moderatorRosterId, memberRosterIds, CONVENE_COHORT_CAP);
    let chairAgentId: string | undefined;
    const activatedAgentIds: string[] = [];
    for (const rosterId of cohortRosterIds) {
      const agentId = agentIdByRoster.get(rosterId);
      const entry = agentId ? agentEntries.find((e) => e.agentId === agentId) : undefined;
      if (entry) {
        const routed = activeAgents.activateAgent(entry);
        chairAgentId ??= routed;
        activatedAgentIds.push(entry.agentId);
      }
    }
    if (!chairAgentId) { emitSystem(t('chat:noProjectAgents')); return; }
    activeAgents.switchTo(chairAgentId);
    const plan = planBoardroomTurns(
      { chairAgentId, advisorAgentIds: activatedAgentIds },
      project.turnPolicy ?? { rounds: 1, order: 'declared', synthesize: true },
    );
    if (plan.length > 0) cadenceStart(plan, config, topic.trim() || project.name);
    const opener = topic.trim() || t('chat:conveneOpener');
    await send(opener, config, { activeAgentId: chairAgentId });
  } catch (err) {
    emitSystem(t('chat:conveneTeamFailed', { error: err instanceof Error ? err.message : String(err) }));
  }
}

/** BARE leading `@@` → convene the owning project's team. In a non-project conversation
 *  a bare `@@` has nothing to convene, so we give honest guidance instead of sending
 *  "@@" to the model as prose. `@@<handle>` (no leading space) is NOT matched here, so it
 *  still falls through to the board interceptor. */
export function buildProjectConveneInterceptor(deps: ConveneDeps): SubmitInterceptor {
  return async (text, attachments) => {
    if (!attachments && /^@@(\s|$)/.test(text.trim())) {
      if (!deps.conveneProjectId) {
        deps.emitSystem(deps.t('chat:conveneNoProject'));
        return { kind: 'handled' };
      }
      await runProjectConvene(text.trim().replace(/^@@\s*/, ''), deps);
      return { kind: 'handled' };
    }
    return null;
  };
}

/** `@@<board-handle>` → summon the board's council (chair + advisors) into the lineup,
 *  attach the board to this conversation, queue the cadence, and route the turn to the
 *  chair. A summon OWNS the turn — never falls back to a previously-selected agent. */
export function buildBoardInterceptor(deps: ConveneDeps): SubmitInterceptor {
  const { agentEntries, activeAgents, cadenceStart, config, emitSystem, t, attachBoard, getSessionId } = deps;
  return async (text, attachments) => {
    if (attachments) return null;
    const boardMatch = detectBoardMention(text);
    if (!boardMatch) return null;
    let chairAgentId: string | undefined;
    try {
      const board = await getBoardByHandle(boardMatch.handle);
      const roster = await listRoster({ includeAdvisors: true }); // advisors are hidden from the general roster
      const agentIdByRoster = new Map(roster.map((r) => [r.rosterId, r.agentRef?.agentId]));
      const cohort = [
        ...(board.moderatorRosterId ? [board.moderatorRosterId] : []),
        ...board.advisors.filter((id) => id !== board.moderatorRosterId),
      ];
      let activated = 0;
      const cohortAgentRefs: string[] = [];
      const activatedAgentIds: string[] = [];
      for (const rosterId of cohort) {
        const agentId = agentIdByRoster.get(rosterId);
        const entry = agentId ? agentEntries.find((e) => e.agentId === agentId) : undefined;
        if (entry) {
          const routed = activeAgents.activateAgent(entry);
          if (!chairAgentId) chairAgentId = routed;
          cohortAgentRefs.push(`agent:${entry.agentId}`);
          activatedAgentIds.push(entry.agentId);
          activated += 1;
        }
      }
      if (chairAgentId) activeAgents.switchTo(chairAgentId);
      if (activated > 0) {
        // AWAIT: attaching snapshots the board's strategy context (ADR 0079 §5) onto the
        // conversation meta — the chair's opening turn dispatches just after and reads it.
        await attachBoard(getSessionId(), board.boardId, cohortAgentRefs);
        const plan = planBoardroomTurns(
          { chairAgentId: chairAgentId ?? null, advisorAgentIds: activatedAgentIds },
          board.turnPolicy,
        );
        if (plan.length > 0) cadenceStart(plan, config, boardMatch.trailing?.trim() || text);
      }
      if (activated === 0) {
        emitSystem(t('chat:conveneBoardNoAdvisors', { handle: boardMatch.handle }));
        return { kind: 'handled' };
      }
      if (activated < cohort.length) {
        emitSystem(t('chat:conveneBoardPartial', { handle: boardMatch.handle, activated: formatNumber(activated), total: formatNumber(cohort.length) }));
      }
    } catch (err) {
      emitSystem(t('chat:conveneBoardFailed', { handle: boardMatch.handle, error: err instanceof Error ? err.message : String(err) }));
      return { kind: 'handled' };
    }
    return { kind: 'route', ...(chairAgentId ? { activeAgentId: chairAgentId } : {}), boardSummoned: true };
  };
}
