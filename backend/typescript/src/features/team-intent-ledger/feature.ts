/**
 * Team intent ledger (ADR 0831) — one versioned, owner-moved record of what a
 * project is for: the charter's goal and objectives (ADR 0054, still their only
 * home), plus decisions (ADR 0233 decision-record Documents, by reference), open
 * questions and scope. Changes are proposed and accepted; every accepted change
 * stores the full resulting state, so a run can later act on an exact version.
 *
 * P1: the store, REST, the charter listener and the DSAR eraser. The run stamp
 * and read-before-act are P2.
 *
 * ALWAYS ON since 2026-10-07 (maintainer decision): no toggle. It shipped OFF,
 * then default ON; a stored per-workspace override could still hide it, so the
 * toggle was removed.
 *
 * @see docs/adr/0831-team-intent-ledger.md
 */
import type { BackendFeature } from '../types.js';
import { createLogger } from '../../observability/logger.js';
import { getProject, onProjectCharterChanged } from '../projects/projectsService.js';
import { registerTeamLedgerRoutes } from './routes.js';
import { registerTeamLedgerAgentTools } from './agentTools.js';
import { registerLedgerEvidenceRoute } from './evidence.js';
import { recordCharterEdit, registerTeamLedgerErasure, countLedgerRowsForProject, deleteLedgerForProject, onLedgerChanged } from './ledgerStore.js';
import { registerSubjectDependent } from '../../host/subjectDependents.js';
import { registerRunStartContributor } from '../../host/runStartContext.js';
import { registerRunContextProvider } from '../../host/runContextProviders.js';
import { teamLedgerRunStartContributor } from './runStamp.js';
import { countSuggestionsForProject, deleteSuggestionsForProject, registerSuggestionErasure } from './suggestions.js';
import { teamLedgerChatContextProvider, teamLedgerContextProvider } from './runContext.js';
import { registerChatSubjectContextProvider } from '../../host/chatSubjectContextProviders.js';
import { registerHandoffObserver } from '../../host/handoff/handoffObservers.js';
import { handoffLedgerSource } from './handoffSource.js';
import { registerInterruptResolutionObserver } from '../../host/interruptResolutionObservers.js';
import { resolutionLedgerSource } from './resolutionSource.js';
import { registerInboundMessageObserver } from '../../host/inboundMessageObservers.js';
import { inboundDecisionSource } from './inboundSource.js';
import { onAnyRunTerminal } from '../../executor/runLifecycle.js';
import { runDecisionsSource } from './runDecisionsSource.js';
import { enqueueDriftCheck, startDriftWorker } from './driftCheck.js';
import { registerDocumentVersionObserver } from '../../host/documentVersionObservers.js';
import { notesDecisionSource } from './notesSource.js';
import { registerHumanChatMessageObserver } from '../../host/humanChatMessageObservers.js';
import { enqueueForSuggester, startDecisionSuggester } from './decisionSuggester.js';
import { maybeResync } from './resync.js';
import { registerConversationScopeContributor } from '../../host/conversationScopeContributors.js';
import { teamLedgerMissionInheritance, teamLedgerScopeContributor } from './toolPolicy.js';
import { registerMissionInheritanceProvider } from '../../host/missionDraftInheritance.js';

const log = createLogger('features.team-intent-ledger');

export const teamIntentLedgerFeature: BackendFeature = {
  id: 'team-intent-ledger',
  // Not `documents`: decision references are `decision-record` Documents (ADR
  // 0233 §C8) read through the documents SERVICE, which does not refuse when the
  // documents toggle is off (an ADR 0446 soft read). An always-on feature that
  // declared it would lock `documents` on for every workspace.
  dependsOn: ['projects'],
  registerRoutes: (deps) => {
    registerTeamLedgerRoutes(deps);
    registerLedgerEvidenceRoute(deps); // ADR 0831 P5 — the tripwire, measured
    registerTeamLedgerAgentTools(); // ADR 0831 P3 — the ADR 0308 seam
    // ADR 0831 P2 — freeze the version a project run acts on, and hand it to the agent.
    registerRunStartContributor(teamLedgerRunStartContributor);
    registerRunContextProvider('team-intent-ledger', teamLedgerContextProvider(deps.storage));
    // ADR 0831 B3 — and to a project chat's turns, live per turn and per caller.
    registerChatSubjectContextProvider('team-intent-ledger', teamLedgerChatContextProvider);
    // ADR 0831 P3 — a handoff note's new open questions become ONE proposed delta.
    registerHandoffObserver(handoffLedgerSource(deps.storage));
    // ADR 0853 D5 — resolved approvals become suggestions; an answered open question proposes closing it.
    registerInterruptResolutionObserver(resolutionLedgerSource(deps.storage));
    // ADR 0853 D4 — `decision:` messages on a project-linked inbound connection.
    registerInboundMessageObserver(inboundDecisionSource);
    // ADR 0853 D6 — a project run that reports `decisions` (meeting extraction, or any workflow).
    onAnyRunTerminal('team-ledger-run-decisions', runDecisionsSource(deps.storage));
    // ADR 0853 D7 — `Decision:` lines in a project's documents (meeting notes).
    registerDocumentVersionObserver('team-ledger-notes', notesDecisionSource);
    // ADR 0855 D1 — the drift check: enqueue on the run-terminal seam, check on a bounded worker tick.
    onAnyRunTerminal('team-ledger-drift', async (runId, status) => { await enqueueDriftCheck(deps.storage, runId, status); });
    startDriftWorker(deps.storage);
    // ADR 0855 D3 — a re-sync checkpoint when the team falls behind the ledger.
    onLedgerChanged(async (ledger) => { await maybeResync(ledger); });
    // ADR 0856 D2 — the ledger's tool policy narrows its project's chats (narrow-only seam).
    registerConversationScopeContributor('team-intent-ledger', teamLedgerScopeContributor);
    // ADR 0856 D2 — a mission drafted in those chats starts with the policy (drafting only).
    registerMissionInheritanceProvider('team-intent-ledger', teamLedgerMissionInheritance);
    // ADR 0853 D3 — the suggester: enqueue in-request, classify on a bounded worker tick.
    registerHumanChatMessageObserver(async (m) => { await enqueueForSuggester(m); });
    startDecisionSuggester();
    // Erasure.
    registerTeamLedgerErasure();
    // ADR 0839 D2 — the delete cascade: a project's ledger goes with the project.
    registerSubjectDependent('project', 'teamLedger', {
      count: (tenantId, subject) => countLedgerRowsForProject(tenantId, subject.id),
      purge: (tenantId, subject) => deleteLedgerForProject(tenantId, subject.id),
    });
    // ADR 0853 D1 — decision suggestions: erasure and the delete cascade.
    registerSuggestionErasure();
    registerSubjectDependent('project', 'teamLedgerSuggestions', {
      count: (tenantId, subject) => countSuggestionsForProject(tenantId, subject.id),
      purge: (tenantId, subject) => deleteSuggestionsForProject(tenantId, subject.id),
    });
    onProjectCharterChanged(async (c) => {
      if (c.origin === 'ledger') return; // the ledger's own write — already recorded as its delta
      const project = await getProject(c.tenantId, c.projectId);
      if (!project) return;
      await recordCharterEdit(project, c.before, c.actor);
      log.debug('team_ledger_charter_edit_recorded', { tenantId: c.tenantId, projectId: c.projectId });
    });
  },
};
