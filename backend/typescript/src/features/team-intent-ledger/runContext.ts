/**
 * ADR 0831 P2 — read before act: an agent turn on a stamped run receives the
 * ledger AS IT WAS at the stamped version (never "latest"), so a replayed turn
 * builds the same prompt. Fenced as data: accepted changes can carry
 * agent-proposed text.
 *
 * @see docs/adr/0831-team-intent-ledger.md §D4
 */
import type { Storage } from '../../storage/storage.js';
import type { RunContextRequest } from '../../host/runContextProviders.js';
import { fenceUntrustedItems, neutralizeUntrusted } from '../../host/untrustedContent.js';
import { getDocument } from '../documents/documentsService.js';
import { getProject, resolveProjectAccess, type Project } from '../projects/projectsService.js';
import type { ChatSubjectContextRequest } from '../../host/chatSubjectContextProviders.js';
import { createLogger } from '../../observability/logger.js';
import { currentState, findLedgerById, getLedger, stateAt } from './ledgerStore.js';
import { readTeamLedgerStamp } from './runStamp.js';
import type { LedgerState } from './types.js';

const RECENT_DECISIONS = 5;
const log = createLogger('feature.team-intent-ledger.context');

/** The fenced block for one ledger state. Exported for the composition test. */
export function ledgerContextBlock(projectName: string, version: number, state: LedgerState, decisionTitles: readonly string[]): string {
  const n = neutralizeUntrusted;
  const items = [
    `Team intent ledger for project "${n(projectName)}", version ${version} — what this work is for:`,
    ...(state.goal ? [`- Goal: ${n(state.goal)}`] : []),
    ...state.objectives.map((o) => `- Objective: ${n(o)}`),
    ...state.inScope.map((x) => `- In scope: ${n(x)}`),
    ...state.outOfScope.map((x) => `- Out of scope: ${n(x)}`),
    ...state.openQuestions.map((q) => `- Open question: ${n(q)}`),
    ...decisionTitles.map((t) => `- Decision: ${n(t)}`),
  ];
  return fenceUntrustedItems(items);
}

export function teamLedgerContextProvider(storage: Storage) {
  return async (req: RunContextRequest): Promise<string | undefined> => {
    const run = await storage.getRun(req.runId);
    if (!run || run.tenantId !== req.tenantId) return undefined;
    const stamp = readTeamLedgerStamp(run.metadata);
    if (!stamp) return undefined;
    const state = await stateAt(req.tenantId, stamp.ledgerId, stamp.version);
    if (!state) return undefined;
    // A stamp names the ledger; the ledger names its project.
    const ledger = await findLedgerById(req.tenantId, stamp.ledgerId);
    const project = ledger ? await getProject(req.tenantId, ledger.scope.id) : null;
    if (!project) return undefined;
    return ledgerContextBlock(project.name, stamp.version, state, await recentDecisionTitles(project, state));
  };
}

/** The titles of the last few decision records, for the block. */
async function recentDecisionTitles(project: Project, state: LedgerState): Promise<string[]> {
  const titles: string[] = [];
  for (const id of state.decisionDocumentIds.slice(-RECENT_DECISIONS)) {
    const doc = await getDocument(project.tenantId, project.orgId, id);
    if (doc) titles.push(doc.title);
  }
  return titles;
}

/**
 * The same block for a PROJECT CHAT turn (ADR 0831 B3). A conversation is one
 * long-lived run, so this reads the CURRENT version for the person asking, per
 * turn, and composes nothing when the toggle is off, the caller cannot read the
 * project, or there is no ledger. The version shown is logged.
 */
export async function teamLedgerChatContextProvider(req: ChatSubjectContextRequest): Promise<string | undefined> {
  if (req.ownerSubject.kind !== 'project') return undefined;
  const project = await getProject(req.tenantId, req.ownerSubject.id);
  if (!project) return undefined;
  if ((await resolveProjectAccess(req.tenantId, project.id, req.callerUserId)) === 'none') return undefined;
  // ADR 0852 D5 — a bound channel's reply is read by every member: a binding to a
  // project that has since been made private composes nothing (inert, not removed).
  if (req.viaChannelBinding && (project.visibility ?? 'org') !== 'org') return undefined;
  const ledger = await getLedger(req.tenantId, project.id);
  if (!ledger) return undefined;
  const state = currentState(ledger, project);
  log.info('team_ledger_chat_context', { tenantId: req.tenantId, ledgerId: ledger.ledgerId, version: ledger.version });
  return ledgerContextBlock(project.name, ledger.version, state, await recentDecisionTitles(project, state));
}

