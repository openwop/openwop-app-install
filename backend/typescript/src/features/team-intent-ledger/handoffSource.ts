/**
 * ADR 0831 P3 — structured handoff records (ADR 0829) as a write-back source.
 *
 * WHAT MAPS, AND WHAT DOES NOT. A handoff note's OPEN QUESTIONS are the one part
 * with a clean home: the ledger's `openQuestions` list. So a note that raises a
 * question the ledger does not already hold produces ONE proposed delta adding
 * it. The rest stays out on purpose (D5's "a wrong automatic proposal trains the
 * owner to reject the queue"):
 *   - `decisions` are free text; the ledger's decisions are references to
 *     `decision-record` Documents, never copies (ADR 0233 §C8);
 *   - `intent` is the intent of a piece of work, not of the project;
 *   - `tried` has no ledger field at all.
 *
 * WHO IT IS PROPOSED AS, and when nothing happens. A card note is proposed as the
 * person who wrote it, a run's record as the agent, with the run's acting user
 * as the authority. Either way the proposer must hold WRITE on the project (the
 * same bar as the REST propose and the agent tool); a reader's note stays a
 * note. Nothing is proposed when the ledger toggle is off for the tenant, the
 * card or run is not on a project with a ledger, every question is already on
 * the ledger, or the queue is full. Nothing is ever accepted here.
 *
 * IDEMPOTENT on the origin's `ref`: a replayed node or a retried request
 * announces the same record again, and a delta already carrying that source ref
 * is not proposed twice.
 *
 * @see docs/adr/0831-team-intent-ledger.md §D5
 */
import type { Storage } from '../../storage/storage.js';
import type { HandoffRecorded } from '../../host/handoff/handoffObservers.js';
import { getBoard } from '../../host/kanbanService.js';
import { createLogger } from '../../observability/logger.js';
import { getProject, resolveProjectAccess, type Project } from '../projects/projectsService.js';
import { cleanWhy, findLedgerById, getLedger, LEDGER_LIMITS, listDeltas, proposeDelta, validatePatch } from './ledgerStore.js';
import { readTeamLedgerStamp } from './runStamp.js';
import type { TeamLedger, TeamLedgerDelta } from './types.js';

const log = createLogger('feature.team-intent-ledger.handoff');

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

interface Target { project: Project; ledger: TeamLedger; author: TeamLedgerDelta['author']; actor: string }

async function resolveTarget(e: HandoffRecorded, storage: Storage): Promise<Target | null> {
  if (e.origin.kind === 'card') {
    const board = await getBoard(e.origin.boardId);
    if (!board || board.tenantId !== e.tenantId || board.ownerSubject?.kind !== 'project') return null;
    const project = await getProject(e.tenantId, board.ownerSubject.id);
    const ledger = project ? await getLedger(e.tenantId, project.id) : null;
    if (!project || !ledger) return null;
    return { project, ledger, author: { kind: 'user', id: e.origin.by }, actor: e.origin.by };
  }
  const run = await storage.getRun(e.origin.runId);
  if (!run || run.tenantId !== e.tenantId) return null;
  const stamp = readTeamLedgerStamp(run.metadata);
  const actor = (run.metadata as Record<string, unknown> | undefined)?.actingUserId;
  // No stamp ⇒ the run is not working on a project's ledger. No acting user ⇒
  // nobody whose write access could stand behind the proposal (as the agent tool).
  if (!stamp || typeof actor !== 'string') return null;
  const ledger = await findLedgerById(e.tenantId, stamp.ledgerId);
  const project = ledger ? await getProject(e.tenantId, ledger.scope.id) : null;
  if (!ledger || !project) return null;
  return { project, ledger, author: { kind: 'agent', id: e.origin.agentId ?? `run:${e.origin.runId}` }, actor };
}

export function handoffLedgerSource(storage: Storage) {
  return async (e: HandoffRecorded): Promise<void> => {
    if (e.record.openQuestions.length === 0) return;
    const t = await resolveTarget(e, storage);
    if (!t) return;
    if ((await resolveProjectAccess(e.tenantId, t.project.id, t.actor)) !== 'write') return;

    const existing = await listDeltas(e.tenantId, t.ledger.ledgerId);
    if (existing.some((d) => d.source?.kind === 'handoff' && d.source.ref === e.origin.ref)) return;

    const held = new Set(t.ledger.openQuestions.map(norm));
    const added: string[] = [];
    for (const q of e.record.openQuestions) {
      const k = norm(q);
      if (held.has(k)) continue;
      held.add(k);
      added.push(q);
    }
    if (added.length === 0) return;
    const next = [...t.ledger.openQuestions, ...added];
    if (next.length > LEDGER_LIMITS.listItems) {
      log.info('team_ledger_handoff_skipped_full', { tenantId: e.tenantId, ledgerId: t.ledger.ledgerId });
      return;
    }

    const prefix = 'Open questions raised in a handoff note: ';
    const room = LEDGER_LIMITS.why - prefix.length;
    const intent = e.record.intent.length > room ? `${e.record.intent.slice(0, room - 1)}…` : e.record.intent;
    try {
      const patch = await validatePatch({ openQuestions: next }, t.project);
      await proposeDelta({
        ledger: t.ledger,
        patch,
        why: cleanWhy(`${prefix}${intent}`),
        author: t.author,
        source: { kind: 'handoff', ref: e.origin.ref },
        baseVersion: t.ledger.version,
      });
    } catch (err) {
      // A full queue (409) or a question the ledger's strict rules refuse: the
      // note itself is unaffected; say so in the log, propose nothing.
      log.info('team_ledger_handoff_not_proposed', { tenantId: e.tenantId, ledgerId: t.ledger.ledgerId, error: err instanceof Error ? err.message : String(err) });
    }
  };
}
