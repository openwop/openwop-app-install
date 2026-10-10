/**
 * ADR 0853 D6 — a project run that REPORTS decisions feeds them in as
 * suggestions. The contract: when a run stamped with a project's ledger
 * completes and its final output carries `decisions` (strings, or objects with a
 * `summary`), each becomes a SUGGESTION with `source.kind:'meeting'`, linked to
 * the run — a meeting-notes extraction (or any workflow) only has to return that
 * field. Nothing is recorded until a person does.
 *
 * At most `MAX_PER_RUN` per run; idempotent per (run, index). Subscribed through
 * the one run-terminal seam (`onAnyRunTerminal`), fail-soft.
 */
import type { Storage } from '../../storage/storage.js';
import { getProject } from '../projects/projectsService.js';
import { findLedgerById } from './ledgerStore.js';
import { readTeamLedgerStamp } from './runStamp.js';
import { createSuggestion } from './suggestions.js';

export const MAX_PER_RUN = 20;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);

/** The decisions a run's final outputs report (bounded; blanks dropped). */
export function reportedDecisions(outputs: unknown): string[] {
  if (!isObj(outputs) || !Array.isArray(outputs.decisions)) return [];
  const out: string[] = [];
  for (const d of outputs.decisions) {
    const text = typeof d === 'string' ? d : isObj(d) && typeof d.summary === 'string' ? d.summary : undefined;
    if (text && text.trim()) out.push(text.trim());
    if (out.length >= MAX_PER_RUN) break;
  }
  return out;
}

export function runDecisionsSource(storage: Storage) {
  return async (runId: string, status: string): Promise<void> => {
    if (status !== 'completed') return;
    const run = await storage.getRun(runId);
    if (!run) return;
    const stamp = readTeamLedgerStamp(run.metadata);
    if (!stamp) return;
    const ledger = await findLedgerById(run.tenantId, stamp.ledgerId);
    const project = ledger ? await getProject(run.tenantId, ledger.scope.id) : null;
    if (!project) return;
    const completed = (await storage.listEvents(runId)).find((e) => e.type === 'run.completed');
    const payload = (completed?.payload ?? {}) as Obj;
    const decisions = reportedDecisions(payload.outputs ?? payload.output);
    for (const [i, text] of decisions.entries()) {
      await createSuggestion({
        tenantId: run.tenantId, projectId: project.id,
        title: text.split('\n')[0]!.slice(0, 80), text,
        source: { kind: 'meeting', ref: `${runId}:${i}`, link: `/runs/${encodeURIComponent(runId)}` },
        suggestedBy: { kind: 'host', id: `run:${run.workflowId}` },
      });
    }
  };
}
