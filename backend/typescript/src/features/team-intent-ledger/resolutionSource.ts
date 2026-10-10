/**
 * ADR 0853 D5 — resolved approvals and clarifications as ledger sources (the
 * two ADR 0831 D5 deferred). Only for a run STAMPED with a ledger version — the
 * run was working on that project.
 *
 *   - A resolved APPROVAL is a decision, but which ledger field it changes is a
 *     person's call: it becomes a SUGGESTION ("Approved: …" / "Rejected: …"),
 *     linked to the run.
 *   - An answered CLARIFICATION whose question is one of the ledger's open
 *     questions (case- and space-insensitive) PROPOSES removing that question,
 *     with the answer as the reason. The owner accepts. Any other clarification
 *     does nothing.
 *
 * Idempotent on the interrupt id; nothing is ever accepted here.
 */
import type { Storage } from '../../storage/storage.js';
import type { InterruptResolved } from '../../host/interruptResolutionObservers.js';
import { createLogger } from '../../observability/logger.js';
import { getProject } from '../projects/projectsService.js';
import { cleanWhy, findLedgerById, LEDGER_LIMITS, listDeltas, proposeDelta, validatePatch } from './ledgerStore.js';
import { readTeamLedgerStamp } from './runStamp.js';
import { createSuggestion } from './suggestions.js';

const log = createLogger('feature.team-intent-ledger.resolution');

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x.trim() : undefined);

function questionOf(data: unknown): string | undefined {
  if (!isObj(data)) return undefined;
  return str(data.question) ?? (Array.isArray(data.questions) && isObj(data.questions[0]) ? str(data.questions[0].question) : undefined);
}
function answerOf(v: unknown): string | undefined {
  if (typeof v === 'string') return str(v);
  if (isObj(v)) return str(v.answer) ?? str(v.value) ?? str(v.text);
  return undefined;
}

export function resolutionLedgerSource(storage: Storage) {
  return async (e: InterruptResolved): Promise<void> => {
    if (e.kind !== 'approval' && e.kind !== 'clarification') return;
    const run = await storage.getRun(e.runId);
    if (!run) return;
    const stamp = readTeamLedgerStamp(run.metadata);
    if (!stamp) return;
    const ledger = await findLedgerById(run.tenantId, stamp.ledgerId);
    const project = ledger ? await getProject(run.tenantId, ledger.scope.id) : null;
    if (!ledger || !project) return;

    if (e.kind === 'approval') {
      const what = (isObj(e.data) ? str(e.data.prompt) ?? str(e.data.title) : undefined) ?? 'an approval in a project run';
      await createSuggestion({
        tenantId: run.tenantId, projectId: project.id,
        title: `${e.outcome === 'accepted' ? 'Approved' : 'Rejected'}: ${what}`,
        text: `${e.outcome === 'accepted' ? 'Approved' : 'Rejected'} during run ${run.workflowId}: ${what}`,
        source: { kind: 'approval', ref: e.interruptId, link: `/runs/${encodeURIComponent(run.runId)}` },
        suggestedBy: { kind: 'host', id: 'approval' },
      });
      return;
    }

    // Clarification: only a question the ledger is holding open.
    const question = questionOf(e.data);
    const answer = answerOf(e.resumeValue);
    if (!question || !answer) return;
    const held = ledger.openQuestions.find((q) => norm(q) === norm(question));
    if (!held) return;
    const existing = await listDeltas(run.tenantId, ledger.ledgerId);
    if (existing.some((d) => d.source?.kind === 'run' && d.source.ref === e.interruptId)) return;
    const why = `Answered: ${answer}`;
    try {
      const patch = await validatePatch({ openQuestions: ledger.openQuestions.filter((q) => q !== held) }, project);
      await proposeDelta({
        ledger, patch,
        why: cleanWhy(why.length > LEDGER_LIMITS.why ? `${why.slice(0, LEDGER_LIMITS.why - 1)}…` : why),
        author: { kind: 'agent', id: `run:${run.runId}` },
        source: { kind: 'run', ref: e.interruptId },
        baseVersion: ledger.version,
      });
    } catch (err) {
      log.info('team_ledger_clarification_not_proposed', { ledgerId: ledger.ledgerId, error: err instanceof Error ? err.message : String(err) });
    }
  };
}
