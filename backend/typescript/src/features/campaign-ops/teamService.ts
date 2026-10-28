/**
 * ADR 0943 P4 — the campaign team as one client sees it: each role, the agent it
 * runs as for this client (its binding, else the chain's default), and the last
 * workspace eval of that agent.
 *
 * WHICH AGENTS ARE THE TEAM. The team is data (ADR 0943 D1): every agent that
 * ships an eval suite in one of the team's packs. This file names PACKS, never a
 * role id (the `adr0943-team-ids-ratchet` forbids those here), so a role added to
 * one of these packs with its suite appears without a code change. A pinned agent
 * the client has bound but that is not a team role still gets a row, so an
 * override is never invisible.
 *
 * Eval scores are WORKSPACE-wide (an eval run is not per client) and are read
 * only through the ONE evals access predicate; a refused read says so rather than
 * showing an empty score.
 *
 * @see docs/adr/0943-campaign-agent-team-and-node-assignment.md
 */
import { getAgentRegistry, type ResolvedAgentManifest } from '../../executor/agentRegistry.js';
import { agentVisibleToTenant } from '../../host/agentVisibility.js';
import { packSuiteFor, listResolvableSuites } from '../../host/evals/packSuites.js';
import { evalWorkflowId, suiteRef } from '../../host/evals/suiteStore.js';
import { isAgentEvalRun } from '../../host/evals/agentEvalRun.js';
import { agentEvalsRefusal, type AgentEvalsRefusal } from '../../host/evals/access.js';
import { resolveAgentIdentity } from '../../host/agentIdentity.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { listAgentBindings } from './agentBindingService.js';
import type { ClientAgentBinding } from './types.js';

/** The packs whose suite-carrying agents are the campaign team (ADR 0943 D1). */
export const TEAM_PACKS: readonly string[] = [
  'vendor.openwop-app.campaign-studio.agents',
  'vendor.openwop-app.campaign-orchestration.agents',
  'vendor.openwop-app.campaign-intel.agents',
];

export interface EvalScore {
  suiteRef: string;
  runId: string;
  completedAt?: string;
  aggregateScore?: number;
  passed?: boolean;
  passedCount?: number;
  taskCount?: number;
}

export interface TeamAgent {
  agentId: string;
  label: string;
  /** The latest completed workspace eval of this agent, or null when it has none. */
  eval: EvalScore | null;
}

export interface TeamMember {
  /** The chain's default agent for this role (the pin a binding replaces). */
  role: TeamAgent & { description?: string; modelClass: string; teamRole: boolean };
  /** The client's binding for this pin when one exists (pin-only scope first). */
  binding: (Pick<ClientAgentBinding, 'bindingId' | 'workflowId' | 'nodeId'> & { agent: TeamAgent; model?: { provider: string; model: string } }) | null;
  /** Further narrower bindings of the same pin (one workflow or one node). */
  narrowerBindings: number;
}

export interface TeamView {
  members: TeamMember[];
  evals: { available: true } | { available: false; reason: AgentEvalsRefusal };
}

const labelOf = (a: ResolvedAgentManifest | null | undefined, fallback: string): string => a?.label ?? a?.persona ?? fallback;

/** The newest completed eval run of `ref` in this tenant: one indexed read. */
async function latestEval(tenantId: string, ref: string): Promise<EvalScore | null> {
  const runs = await hostExtStorage().listRuns({ tenantId, workflowId: evalWorkflowId(ref), limit: 5 });
  for (const r of runs) {
    if (r.tenantId !== tenantId || !isAgentEvalRun(r) || r.status !== 'completed') continue;
    const s = r.metadata?.evalSummary as { aggregateScore?: number; passed?: boolean; taskCount?: number; passedCount?: number } | undefined;
    if (!s) continue;
    return {
      suiteRef: ref, runId: r.runId,
      ...(r.completedAt ? { completedAt: r.completedAt } : {}),
      ...(typeof s.aggregateScore === 'number' ? { aggregateScore: s.aggregateScore } : {}),
      ...(typeof s.passed === 'boolean' ? { passed: s.passed } : {}),
      ...(typeof s.passedCount === 'number' ? { passedCount: s.passedCount } : {}),
      ...(typeof s.taskCount === 'number' ? { taskCount: s.taskCount } : {}),
    };
  }
  return null;
}

/** The eval of any agent: its first resolvable suite (pack or tenant). */
async function evalOfAgent(tenantId: string, agentId: string, withEvals: boolean): Promise<EvalScore | null> {
  if (!withEvals) return null;
  const suites = await listResolvableSuites(tenantId, agentId);
  const first = suites[0];
  return first ? latestEval(tenantId, suiteRef(first.suite)) : null;
}

export async function getClientTeam(tenantId: string, orgId: string, viewer: { userId?: string }): Promise<TeamView> {
  const refusal = await agentEvalsRefusal({ tenantId, ...(viewer.userId ? { userId: viewer.userId } : {}) });
  const withEvals = refusal === null;
  const registry = getAgentRegistry();
  const bindings = await listAgentBindings(tenantId, orgId);

  const roles: Array<{ manifest: ResolvedAgentManifest | null; agentId: string; teamRole: boolean }> = [];
  for (const agent of registry.list()) {
    if (!TEAM_PACKS.includes(agent.packName) || !agentVisibleToTenant(agent, tenantId) || !packSuiteFor(agent)) continue;
    roles.push({ manifest: agent, agentId: agent.agentId, teamRole: true });
  }
  for (const b of bindings) {
    if (roles.some((r) => r.agentId === b.pinnedAgentId)) continue;
    roles.push({ manifest: await registry.resolve(b.pinnedAgentId, tenantId), agentId: b.pinnedAgentId, teamRole: false });
  }

  const members: TeamMember[] = [];
  for (const r of roles) {
    const mine = bindings.filter((b) => b.pinnedAgentId === r.agentId);
    const broad = mine.find((b) => b.workflowId === undefined && b.nodeId === undefined) ?? null;
    let binding: TeamMember['binding'] = null;
    if (broad) {
      const identity = await resolveAgentIdentity(tenantId, broad.agentId, { allowReverseScan: true });
      const manifest = await registry.resolve(identity.agentId, tenantId);
      binding = {
        bindingId: broad.bindingId,
        agent: { agentId: broad.agentId, label: identity.entry?.persona ?? labelOf(manifest, broad.agentId), eval: await evalOfAgent(tenantId, identity.agentId, withEvals) },
        // The key name is never returned; only that a model is pinned.
        ...(broad.model ? { model: { provider: broad.model.provider, model: broad.model.model } } : {}),
      };
    }
    const suite = r.manifest ? packSuiteFor(r.manifest) : null;
    members.push({
      role: {
        agentId: r.agentId,
        label: labelOf(r.manifest, r.agentId),
        ...(r.manifest?.description ? { description: r.manifest.description } : {}),
        modelClass: r.manifest?.modelClass ?? 'chat',
        teamRole: r.teamRole,
        eval: withEvals ? (suite ? await latestEval(tenantId, suiteRef(suite)) : await evalOfAgent(tenantId, r.agentId, true)) : null,
      },
      binding,
      narrowerBindings: mine.filter((b) => b !== broad).length,
    });
  }
  members.sort((a, b) => Number(b.role.teamRole) - Number(a.role.teamRole) || a.role.label.localeCompare(b.role.label));
  return { members, evals: refusal === null ? { available: true } : { available: false, reason: refusal } };
}
