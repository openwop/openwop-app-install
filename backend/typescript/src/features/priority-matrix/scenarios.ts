/**
 * Planning-session scenarios (ADR 0235 §D1) — named what-if selections under
 * constraint sets, stored ON the session row (the aggregate root; architect
 * Q3). Resolution happens AT READ against the CURRENT ranking + idea intake
 * `estimatedValue` (ADR 0232): nothing resolved is stored, so a re-score
 * re-draws every line. A scenario is inert data — selecting it as plan of
 * record is a human route action (emit + audit, no execution; architect Q1),
 * which is why the AI arm may safely PROPOSE scenarios (`proposedBy:'agent'`).
 *
 * Strategy-coverage annotation is deliberately NOT computed here (the PM
 * feature never imports strategy — ADR 0079 direction); the FE overlays it
 * from the strategyRefs map it already holds.
 */
import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { createScenarioSelectApproval, hasPendingApprovalForScenario, listApprovals } from '../../host/approvalService.js';
import { listRankedIdeas, getSessionRow, mutateSessionRow, type RankedIdea } from './priorityMatrixService.js';
import { getIdeaIntake } from './intake.js';
import { SCENARIO_CAP_PER_SESSION, type PlanningSession, type SessionScenario } from './types.js';
import { priorityMutated } from './emit.js';

export interface ResolvedScenario extends SessionScenario {
  aboveLine: Array<{ cardId: string; title: string; rank: number; estimatedValue?: number }>;
  belowLine: Array<{ cardId: string; title: string; rank: number; estimatedValue?: number; droppedBy: 'maxItems' | 'maxBudget' | 'selection' }>;
  /** Cumulative estimatedValue of the above-line set (cards without a value count 0). */
  totalEstimatedValue: number;
  /** PMXU-2 (ADR 0590) — the decision state of the agent-proposal gate, joined
   *  at read from the shared approval row (absent for human scenarios). A
   *  REJECTED proposal is no longer byte-identical to an undecided one, so the
   *  UI can stop offering "Set as plan of record" on it. */
  approvalStatus?: 'pending' | 'approved' | 'rejected';
}

function parseScenarioInput(body: Record<string, unknown>, actor: string, proposedBy?: 'agent'): SessionScenario {
  const name = cleanString(body.name, 120);
  if (!name) throw new OpenwopError('validation_error', 'Field `name` is required.', 400, { field: 'name' });
  const sel = (body.selection ?? {}) as Record<string, unknown>;
  let selection: SessionScenario['selection'];
  if (sel.mode === 'top-n') {
    const n = typeof sel.n === 'number' ? sel.n : Number(sel.n);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new OpenwopError('validation_error', 'selection.n must be an integer 1–200.', 400, {});
    selection = { mode: 'top-n', n };
  } else if (sel.mode === 'manual') {
    const cardIds = Array.isArray(sel.cardIds) ? sel.cardIds.filter((c): c is string => typeof c === 'string' && c.length > 0).slice(0, 200) : [];
    if (cardIds.length === 0) throw new OpenwopError('validation_error', 'selection.cardIds must be a non-empty list.', 400, {});
    selection = { mode: 'manual', cardIds };
  } else {
    throw new OpenwopError('validation_error', "selection.mode must be 'top-n' or 'manual'.", 400, {});
  }
  const rawC = (body.constraints ?? {}) as Record<string, unknown>;
  const constraints: NonNullable<SessionScenario['constraints']> = {};
  if (rawC.maxItems !== undefined && rawC.maxItems !== null) {
    const n = Number(rawC.maxItems);
    if (!Number.isInteger(n) || n < 1) throw new OpenwopError('validation_error', 'constraints.maxItems must be a positive integer.', 400, {});
    constraints.maxItems = n;
  }
  if (rawC.maxBudget !== undefined && rawC.maxBudget !== null) {
    const n = Number(rawC.maxBudget);
    if (!Number.isFinite(n) || n <= 0) throw new OpenwopError('validation_error', 'constraints.maxBudget must be a positive number.', 400, {});
    constraints.maxBudget = n;
  }
  return {
    scenarioId: `scn-${randomUUID().slice(0, 12)}`,
    name,
    selection,
    ...(Object.keys(constraints).length ? { constraints } : {}),
    ...(proposedBy ? { proposedBy } : {}),
    createdBy: actor,
    createdAt: new Date().toISOString(),
  };
}

/** Add a scenario to a session (cap enforced; read-modify-write on the row —
 *  the existing session-update posture, accepted in the ADR). */
export async function addScenario(input: {
  tenantId: string; orgId: string; listId: string; sessionId: string; actor: string;
  body: Record<string, unknown>; proposedBy?: 'agent';
}): Promise<SessionScenario> {
  // Parse (which validates) BEFORE the CAS loop so a bad body 400s once, not per retry.
  const scenario = parseScenarioInput(input.body, input.actor, input.proposedBy);
  // PMXWF-6 (ADR 0590, architect option (c)) — CONTENT-KEYED, PENDING-GATED
  // idempotency on the AGENT lane only. A `:fork` RE-EXECUTES the propose node
  // (fork ≠ resume — a fresh runId, so a run-identity-derived id could never
  // collapse this), which minted a duplicate scenario + a second pending
  // approval for the same intent, permanently occupying cap slots. An
  // identical {name, selection, constraints} re-propose while the prior
  // proposal's approval is still PENDING returns the existing scenario
  // (mirrors the submit-idea ignition dedup contract). Pending-only: after a
  // human decides, an identical re-propose is a NEW ask — finality is never
  // resurrected. The human route lane (no `proposedBy`) is untouched.
  // Accepted residual (ADR 0590): two SIMULTANEOUS forks racing this pre-read
  // can still both mint — the pre-fix behavior, in a vanishingly narrow window.
  if (input.proposedBy === 'agent') {
    const row = await getSessionRow(input.tenantId, input.sessionId);
    const identical = row && row.listId === input.listId
      ? (row.scenarios ?? []).find((s) =>
        s.proposedBy === 'agent'
        && s.name === scenario.name
        && JSON.stringify(s.selection) === JSON.stringify(scenario.selection)
        && JSON.stringify(s.constraints ?? {}) === JSON.stringify(scenario.constraints ?? {}))
      : undefined;
    if (identical && (await hasPendingApprovalForScenario(input.tenantId, identical.scenarioId))) {
      return identical;
    }
  }
  // PM2: the cap is re-checked INSIDE the guarded mutator against the fresh row,
  // so two concurrent adds can't both squeak past a stale count.
  await mutateSessionRow(input.tenantId, input.listId, input.sessionId, (current) => {
    const scenarios = current.scenarios ?? [];
    if (scenarios.length >= SCENARIO_CAP_PER_SESSION) {
      throw new OpenwopError('validation_error', `This session already has the maximum ${SCENARIO_CAP_PER_SESSION} scenarios.`, 400, { cap: SCENARIO_CAP_PER_SESSION });
    }
    return { ...current, scenarios: [...scenarios, scenario] };
  });
  priorityMutated({ entity: 'session', verb: 'scenario-added', tenantId: input.tenantId, actor: input.actor, listId: input.listId, entityId: input.sessionId, orgId: input.orgId });
  // CHAT-FIRST-PORT-AUDIT D3 — an AGENT-proposed scenario raises a shared approval
  // row so adopting it as plan of record renders in the reviews inbox (and the
  // originating conversation), not only on the page's "Select" control. Approve ⇒
  // select as plan of record; reject ⇒ leave un-adopted (selection executes
  // nothing, architect Q1). Deterministic key = scenarioId; a retry dedups.
  if (input.proposedBy === 'agent' && !(await hasPendingApprovalForScenario(input.tenantId, scenario.scenarioId))) {
    await createScenarioSelectApproval({
      tenantId: input.tenantId,
      orgId: input.orgId,
      listId: input.listId,
      sessionId: input.sessionId,
      scenarioId: scenario.scenarioId,
      scenarioName: scenario.name,
      proposal: `Adopt scenario "${scenario.name}" as plan of record`,
    });
  }
  return scenario;
}

/** One scenario on a session (or null) — the select route reads it to route an
 *  AGENT-proposed scenario through its shared approval instead of a bespoke
 *  decision. Tenant + list scoped. */
export async function getScenario(tenantId: string, listId: string, sessionId: string, scenarioId: string): Promise<SessionScenario | null> {
  const session = await getSessionRow(tenantId, sessionId);
  if (!session || session.listId !== listId) return null;
  return (session.scenarios ?? []).find((s) => s.scenarioId === scenarioId) ?? null;
}

/** Mark ONE scenario as plan of record (clears the flag on siblings). Plain
 *  emit + audit — selection executes nothing (architect Q1). */
export async function selectScenario(input: {
  tenantId: string; orgId: string; listId: string; sessionId: string; scenarioId: string; actor: string;
}): Promise<SessionScenario> {
  const next = await mutateSessionRow(input.tenantId, input.listId, input.sessionId, (current) => {
    const scenarios = current.scenarios ?? [];
    if (!scenarios.some((s) => s.scenarioId === input.scenarioId)) {
      throw new OpenwopError('not_found', 'Scenario not found.', 404, { scenarioId: input.scenarioId });
    }
    return {
      ...current,
      scenarios: scenarios.map((s) => {
        const { planOfRecord: _drop, ...rest } = s;
        return s.scenarioId === input.scenarioId ? { ...rest, planOfRecord: true as const } : rest;
      }),
    };
  });
  priorityMutated({ entity: 'session', verb: 'scenario-selected', tenantId: input.tenantId, actor: input.actor, listId: input.listId, entityId: input.scenarioId, orgId: input.orgId });
  return next.scenarios!.find((s) => s.scenarioId === input.scenarioId)!;
}

/** Resolve every scenario of a session against the CURRENT ranking + intake values. */
export async function resolveScenarios(tenantId: string, listId: string, sessionId: string): Promise<ResolvedScenario[]> {
  const session = await requireSession(tenantId, listId, sessionId);
  const ranked = await listRankedIdeas(tenantId, listId);
  const values = new Map<string, number | undefined>();
  for (const r of ranked) {
    const intake = await getIdeaIntake(listId, r.card.id);
    values.set(r.card.id, intake?.estimatedValue);
  }
  // PMXU-2 (ADR 0590) — join the gate's decision state for agent-proposed
  // scenarios (ONE approvals read for the whole session, matched in memory).
  const scenarios = session.scenarios ?? [];
  let statusByScenario = new Map<string, 'pending' | 'approved' | 'rejected'>();
  if (scenarios.some((s) => s.proposedBy === 'agent')) {
    statusByScenario = new Map(
      (await listApprovals(tenantId))
        .filter((a) => a.kind === 'pm-scenario-select' && a.scenarioSelect?.scenarioId)
        .map((a) => [a.scenarioSelect!.scenarioId, a.status]),
    );
  }
  return scenarios.map((s) => {
    const status = s.proposedBy === 'agent' ? statusByScenario.get(s.scenarioId) : undefined;
    return { ...resolveOne(s, ranked, values), ...(status ? { approvalStatus: status } : {}) };
  });
}

function resolveOne(s: SessionScenario, ranked: RankedIdea[], values: Map<string, number | undefined>): ResolvedScenario {
  const byRank = [...ranked].sort((a, b) => a.rank - b.rank);
  const candidates = s.selection.mode === 'top-n'
    ? byRank.slice(0, s.selection.n)
    : byRank.filter((r) => (s.selection as { cardIds: string[] }).cardIds.includes(r.card.id));
  const above: ResolvedScenario['aboveLine'] = [];
  const below: ResolvedScenario['belowLine'] = [];
  let total = 0;
  for (const r of candidates) {
    const v = values.get(r.card.id);
    const row = { cardId: r.card.id, title: r.card.title, rank: r.rank, ...(v !== undefined ? { estimatedValue: v } : {}) };
    if (s.constraints?.maxItems !== undefined && above.length >= s.constraints.maxItems) {
      below.push({ ...row, droppedBy: 'maxItems' });
      continue;
    }
    if (s.constraints?.maxBudget !== undefined && total + (v ?? 0) > s.constraints.maxBudget) {
      below.push({ ...row, droppedBy: 'maxBudget' });
      continue;
    }
    total += v ?? 0;
    above.push(row);
  }
  return { ...s, aboveLine: above, belowLine: below, totalEstimatedValue: total };
}

/** Pairwise diff: which ideas move above/below between scenario A and B. */
export async function compareScenarios(tenantId: string, listId: string, sessionId: string, a: string, b: string): Promise<{
  a: ResolvedScenario; b: ResolvedScenario;
  gainedInB: Array<{ cardId: string; title: string }>;
  droppedInB: Array<{ cardId: string; title: string }>;
}> {
  const resolved = await resolveScenarios(tenantId, listId, sessionId);
  const ra = resolved.find((s) => s.scenarioId === a);
  const rb = resolved.find((s) => s.scenarioId === b);
  if (!ra || !rb) throw new OpenwopError('not_found', 'Scenario not found.', 404, { a, b });
  const aAbove = new Set(ra.aboveLine.map((x) => x.cardId));
  const bAbove = new Set(rb.aboveLine.map((x) => x.cardId));
  return {
    a: ra,
    b: rb,
    gainedInB: rb.aboveLine.filter((x) => !aAbove.has(x.cardId)).map((x) => ({ cardId: x.cardId, title: x.title })),
    droppedInB: ra.aboveLine.filter((x) => !bAbove.has(x.cardId)).map((x) => ({ cardId: x.cardId, title: x.title })),
  };
}

async function requireSession(tenantId: string, listId: string, sessionId: string): Promise<PlanningSession> {
  const session = await getSessionRow(tenantId, sessionId);
  if (!session || session.listId !== listId) throw new OpenwopError('not_found', 'Planning session not found.', 404, { sessionId });
  return session;
}
