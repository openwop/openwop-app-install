/**
 * ADR 0889 D2 — pack-shipped eval suites (RFC 0081 §A `evalSuiteRef`).
 *
 * `packs/agentLoader.ts` reads the manifest's `evalSuiteRef` file (path-confined,
 * like `systemPromptRef`) and keeps the PARSED JSON on the resolved manifest. It
 * is validated here, lazily and closed-world, with the same `validateEvalSuite`
 * a tenant suite gets: an invalid pack suite is logged once and ignored — the
 * agent itself still loads.
 *
 * A pack suite resolves ONLY through the requested agent's own manifest (never a
 * global ref table), is read-only (not in the tenant store, so never locked,
 * edited or deleted), and never gets live tools (A10: only a tenant suite may).
 * Its content is fixed by the pack version, so a run stamps the pack and a digest
 * of the suite, and resume refuses a suite that changed under it.
 */
import { getAgentRegistry, type ResolvedAgentManifest } from '../../executor/agentRegistry.js';
import { agentVisibleToTenant, resolveAgentForTenant } from '../agentVisibility.js';
import { agentStorageId } from '../../executor/agentIdAliases.js';
import { createLogger } from '../../observability/logger.js';
import { listEvalSuites, suiteDigest, suiteRef, validateEvalSuite, type AgentEvalSuite, type StoredEvalSuite } from './suiteStore.js';

const log = createLogger('host.evals.packSuites');
const validated = new WeakMap<ResolvedAgentManifest, AgentEvalSuite | null>();

/** The agent's pack suite, validated once per loaded manifest; null when absent or invalid. */
export function packSuiteFor(agent: ResolvedAgentManifest): AgentEvalSuite | null {
  if (agent.evalSuite === undefined || agent.ownerTenant) return null;
  if (validated.has(agent)) return validated.get(agent) ?? null;
  let suite: AgentEvalSuite | null = null;
  try {
    const v = validateEvalSuite(agent.evalSuite);
    // NP-EVAL-6 — a pack suite resolves ONLY through its shipping agent's manifest,
    // so a suite naming another agent would be listed for that agent and then 404.
    if (v.targetAgentId && agentStorageId(v.targetAgentId) !== agentStorageId(agent.agentId)) {
      throw new Error(`targetAgentId ${v.targetAgentId} is not the shipping agent ${agent.agentId}`);
    }
    // A pack suite with no target belongs to the agent that ships it.
    suite = v.targetAgentId ? v : { ...v, targetAgentId: agent.agentId };
  } catch (err) {
    log.warn('pack_eval_suite_invalid', { agentId: agent.agentId, packName: agent.packName, evalSuiteRef: agent.evalSuiteRef, error: err instanceof Error ? err.message : String(err) });
  }
  validated.set(agent, suite);
  return suite;
}

export const packRefOf = (agent: ResolvedAgentManifest): string => `${agent.packName}@${agent.packVersion}`;

/** Canonical content digest — moved to the store, which locks on it (EVD-1). */
export { suiteDigest };

/** Resolve `ref` against the requested agent's pack suite (its `suiteId@version` or its manifest ref). */
export async function resolvePackSuite(tenantId: string, agentId: string, ref: string): Promise<{ suite: AgentEvalSuite; pack: string } | null> {
  const agent = await resolveAgentForTenant(agentId, tenantId);
  if (!agent) return null;
  const suite = packSuiteFor(agent);
  if (!suite) return null;
  if (ref !== suiteRef(suite) && ref !== agent.evalSuiteRef) return null;
  return { suite, pack: packRefOf(agent) };
}

export type ListedSuite =
  | { source: 'tenant'; suite: AgentEvalSuite; stored: StoredEvalSuite }
  | { source: 'pack'; suite: AgentEvalSuite; pack: string };

/**
 * The ONE enumerator of the suites a tenant can run (architect amendment 2): the
 * suites list, the run history and the `suites` chat tool all read it, so a pack
 * suite's runs are not invisible. A tenant suite with the same ref shadows a pack's.
 */
export async function listResolvableSuites(tenantId: string, agentId?: string): Promise<ListedSuite[]> {
  const forAgent = (s: AgentEvalSuite): boolean => !agentId || !s.targetAgentId || agentStorageId(s.targetAgentId) === agentStorageId(agentId);
  const out: ListedSuite[] = (await listEvalSuites(tenantId)).filter((r) => forAgent(r.suite)).map((stored) => ({ source: 'tenant' as const, suite: stored.suite, stored }));
  const taken = new Set(out.map((s) => suiteRef(s.suite)));
  for (const agent of getAgentRegistry().list()) {
    if (!agentVisibleToTenant(agent, tenantId)) continue;
    const suite = packSuiteFor(agent);
    if (!suite || !forAgent(suite) || taken.has(suiteRef(suite))) continue;
    taken.add(suiteRef(suite));
    out.push({ source: 'pack', suite, pack: packRefOf(agent) });
  }
  return out;
}

/**
 * EVD-13 — the visible pack suite that owns `ref`, if any. A tenant suite may not
 * claim it: both would share `workflowId eval:<ref>`, so history, baselines and
 * resume would mix two different suites under one name.
 */
export function visiblePackSuiteOwning(tenantId: string, ref: string): { suite: AgentEvalSuite; pack: string } | null {
  for (const agent of getAgentRegistry().list()) {
    if (!agentVisibleToTenant(agent, tenantId)) continue;
    const suite = packSuiteFor(agent);
    if (suite && suiteRef(suite) === ref) return { suite, pack: packRefOf(agent) };
  }
  return null;
}
