/**
 * ADR 0831 P2 — the run stamp: a run that works on a project acts on an exact
 * ledger version, frozen into `run.metadata.teamLedger = { ledgerId, version }`
 * at creation and read back verbatim on replay and `:fork`.
 *
 * WHICH PROJECT, and why it is derived and then checked. A run is bound to a
 * project only through host-written attribution: a card run on the project's
 * board (`metadata.kanban.boardId` → the board's `ownerSubject`) or a
 * project-fired schedule (`metadata.schedule.ownerScope = 'project:<id>'`).
 * Neither block is trusted as authorization — `POST /runs` (and its `/v1` twin) spreads caller
 * metadata into the run, and those keys are not reserved — so the binding only
 * holds when the run's ACTING USER (host-stamped from the authenticated
 * principal, never a client value) can read the project. A run with no acting
 * user was created by host code, which never forwards caller metadata.
 *
 * @see docs/adr/0831-team-intent-ledger.md §D3
 */
import type { RunStartContext } from '../../host/runStartContext.js';
import { getBoard } from '../../host/kanbanService.js';
import { resolveRunProject } from '../../host/runProjectBinding.js';
import { getProject, resolveProjectAccess } from '../projects/projectsService.js';
import { getLedger } from './ledgerStore.js';
import { ledgerEvidence, TEAM_LEDGER_STAMP_SHAPE } from './evidence.js';

export const TEAM_LEDGER_STAMP_KEY = 'teamLedger';

export interface TeamLedgerStamp { ledgerId: string; version: number }

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);

/** The project a run's host-written attribution points at, if any. */
async function boundProjectId(tenantId: string, metadata: Readonly<Obj>): Promise<string | undefined> {
  const k = metadata.kanban;
  if (isObj(k) && typeof k.boardId === 'string') {
    const board = await getBoard(k.boardId);
    if (board?.ownerSubject?.kind === 'project') return board.ownerSubject.id;
  }
  const s = metadata.schedule;
  if (isObj(s) && typeof s.ownerScope === 'string' && s.ownerScope.startsWith('project:')) {
    return s.ownerScope.slice('project:'.length);
  }
  // ADR 0852 D2 — a feature-owned binding (a campaign run ⇒ the campaign's project).
  return resolveRunProject(tenantId, metadata);
}

/** The run-start contributor. Fail-soft by contract (a throw contributes nothing). */
export async function teamLedgerRunStartContributor(ctx: RunStartContext): Promise<Record<string, unknown>> {
  if (ctx.derivedFromRun) return {}; // ADR 0604: a copied blob is authoritative, present or absent
  const metadata = ctx.metadata ?? {};
  const projectId = await boundProjectId(ctx.tenantId, metadata);
  if (!projectId) return {};
  const project = await getProject(ctx.tenantId, projectId);
  if (!project) return {}; // another tenant's project resolves to nothing
  const actor = typeof metadata.actingUserId === 'string' ? metadata.actingUserId : undefined;
  if (actor !== undefined && (await resolveProjectAccess(ctx.tenantId, project.id, actor)) === 'none') return {};
  const ledger = await getLedger(ctx.tenantId, project.id);
  if (!ledger) return {};
  const stamp: TeamLedgerStamp = { ledgerId: ledger.ledgerId, version: ledger.version };
  await ledgerEvidence.record(ctx.tenantId, `project:${project.id}`, new Date(), TEAM_LEDGER_STAMP_SHAPE); // ADR 0831 P5 (fail-soft)
  return { [TEAM_LEDGER_STAMP_KEY]: stamp };
}

/** Read a run's stamp back (defensive: the key is reserved, but old rows predate that). */
export function readTeamLedgerStamp(metadata: unknown): TeamLedgerStamp | undefined {
  if (!isObj(metadata)) return undefined;
  const s = metadata[TEAM_LEDGER_STAMP_KEY];
  if (!isObj(s) || typeof s.ledgerId !== 'string' || typeof s.version !== 'number' || !Number.isInteger(s.version) || s.version < 1) return undefined;
  return { ledgerId: s.ledgerId, version: s.version };
}
