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

import { getBoardByHandle, ensureBoardChat } from '../../features/advisory-board/advisoryBoardClient.js';
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
  /** ADR 0278 (summon routing) — true when the CURRENT session has no messages
   *  yet. Optional: absent ⇒ the redirect never fires (legacy in-place summon). */
  isSessionEmpty?: () => boolean;
  /** ADR 0278 (summon routing) — open a conversation by id on this surface
   *  (rail select / deck open-or-focus). Optional: absent ⇒ in-place summon. */
  openBoardConversation?: (sessionId: string) => void;
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
    // ADR 0608 D9 (`CPWF-4`) — track whether the CONFIGURED moderator actually
    // resolved. `chairAgentId ??= routed` alone made whichever agent resolved first
    // the chair, and the chair both FRAMES and SYNTHESIZES (`planBoardroomTurns`
    // gives it the synthesis turn). So an ordinary async-load race in the mention
    // lineup silently promoted advisor #2 into the seat the server 422s a
    // non-member for — the moderator invariant defeated by a substitution, not by a
    // bypass.
    let moderatorResolved = false;
    for (const rosterId of cohortRosterIds) {
      const agentId = agentIdByRoster.get(rosterId);
      const entry = agentId ? agentEntries.find((e) => e.agentId === agentId) : undefined;
      if (entry) {
        const routed = activeAgents.activateAgent(entry);
        chairAgentId ??= routed;
        if (rosterId === project.moderatorRosterId) moderatorResolved = true;
        activatedAgentIds.push(entry.agentId);
      }
    }
    if (!chairAgentId) { emitSystem(t('chat:noProjectAgents')); return; }
    // `COLWF-2` — disclose a PARTIAL cohort, the way the board lane 130 lines below already
    // does. This lane reported only the total-zero case, so two convenes at different moments
    // could seat different teams and the second would say nothing. A convene that silently
    // runs short is the same "the transcript looks correct" failure the moderator guard just
    // above exists to prevent — one member's absence simply never reaches the reader.
    if (activatedAgentIds.length < cohortRosterIds.length) {
      emitSystem(t('chat:conveneProjectPartial', {
        activated: formatNumber(activatedAgentIds.length),
        total: formatNumber(cohortRosterIds.length),
      }));
    }
    // REFUSE rather than substitute. A convene framed and synthesized by an agent
    // the user did not choose is worse than one that did not start, because the
    // transcript looks correct. `orderConveneCohort` already DROPS a non-member
    // moderator (`boardroomCadence.ts:26`) — and dropping it is exactly what used
    // to trigger the promotion.
    if (project.moderatorRosterId && !moderatorResolved) {
      emitSystem(t('chat:conveneModeratorUnavailable'));
      return;
    }
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
      // ADR 0278 (summon routing) — a PURE summon (just `@@handle`, nothing to
      // say yet) in an EMPTY chat opens the board's ONE canonical conversation
      // instead of stamping a fresh disconnected boardroom. A summon WITH a
      // question keeps the in-place path untouched (the typed text must land
      // here, and the cadence owns that flow). Fail-open: if ensure fails
      // (visibility, network), fall through to the in-place summon.
      const isPureSummon = text.trim() === `@@${boardMatch.handle}`;
      if (isPureSummon && deps.isSessionEmpty?.() && deps.openBoardConversation) {
        try {
          const { sessionId, contextDegraded } = await ensureBoardChat(board.boardId);
          deps.openBoardConversation(sessionId);
          // M1 — the OTHER opener lane. `contextDegraded` had no consumer at all;
          // here the room is already open, so the honest surface is the chat's own
          // system line (the same channel the cadence halt uses).
          if (contextDegraded) emitSystem(t('chat:boardContextStale'));
          return { kind: 'handled' };
        } catch { /* fall through to the in-place summon */ }
      }
      const roster = await listRoster({ includeAdvisors: true }); // advisors are hidden from the general roster
      const agentIdByRoster = new Map(roster.map((r) => [r.rosterId, r.agentRef?.agentId]));
      const cohort = [
        ...(board.moderatorRosterId ? [board.moderatorRosterId] : []),
        ...board.advisors.filter((id) => id !== board.moderatorRosterId),
      ];
      let activated = 0;
      let moderatorResolved = false;
      const cohortAgentRefs: string[] = [];
      const activatedAgentIds: string[] = [];
      for (const rosterId of cohort) {
        const agentId = agentIdByRoster.get(rosterId);
        const entry = agentId ? agentEntries.find((e) => e.agentId === agentId) : undefined;
        if (entry) {
          const routed = activeAgents.activateAgent(entry);
          if (!chairAgentId) chairAgentId = routed;
          if (rosterId === board.moderatorRosterId) moderatorResolved = true;
          cohortAgentRefs.push(`agent:${entry.agentId}`);
          activatedAgentIds.push(entry.agentId);
          activated += 1;
        }
      }
      // ADR 0665 D1 — REFUSE rather than substitute, the same rule ADR 0608 D9 put on the
      // project lane ~80 lines above. The chair both FRAMES the discussion and writes the
      // SYNTHESIS, and the server 422s a non-member for that seat — so promoting whoever
      // activated first hands it to an agent the user did not choose, and (the project
      // lane's own words) "the transcript looks correct".
      //
      // The board lane's cause is narrower than the project lane's: it never calls
      // `orderConveneCohort` and a board moderator has no membership predicate
      // (`types.ts` `moderatorRosterId?`), so the only way to get here is an unresolved
      // roster/lineup entry — the async race.
      //
      // `{ kind: 'handled' }`, NOT a bare `return`: this lane is inside the submit
      // interceptor, and `runCoreSubmit` treats a falsy outcome as "not mine"
      // (`chatSubmit.ts`), which would send the raw `@@handle …` text to the model as prose
      // right after the refusal notice. Placed BEFORE `switchTo`/`attachBoard`/`cadenceStart`
      // and before the `activated === 0` notice, so an unresolved moderator says so rather
      // than reporting "no advisors".
      if (board.moderatorRosterId && !moderatorResolved) {
        emitSystem(t('chat:conveneBoardModeratorUnavailable'));
        return { kind: 'handled' };
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
        if (plan.length > 0) cadenceStart(plan, config, boardMatch.trailing?.trim() || text, boardMatch.handle);
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
