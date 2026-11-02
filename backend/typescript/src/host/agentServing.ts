/**
 * ADR 1014 D4 — what runs when nothing names a version.
 *
 * Behind `OPENWOP_AGENT_VERSIONS=on` (default off). For a pack agent with
 * deployment rows, an unpinned execution (chat, an agent-runner node with no
 * channel, A2A, a schedule, a widget, voice) runs what the agent's `stable`
 * channel resolves to (the user's Q1 decision), never simply the newest install.
 * An agent with no rows runs its head, as today.
 *
 * The deployment store lives in `features/agent-deployments/`, which registers
 * the resolver, so `host/` and `executor/` never import a feature (ADR 0001).
 * Every site that EXECUTES an agent's prompt reads it through
 * `resolveServedAgent`; `test/adr1014-p3-serving-ratchet.test.ts` pins that, so
 * a new execution site cannot read the head behind the deployment's back.
 * User-authored agents are served the same way since their revisions exist (P5).
 */
import { getAgentRegistry, type ResolvedAgentManifest } from '../executor/agentRegistry.js';
import type { NodeContext } from '../executor/types.js';

/** `undefined`: no rows, run the head. A string: that version. `null`: rows exist
 *  but nothing serves `stable`, so nothing runs (fail closed). */
export type ServingResolver = (tenantId: string, agentId: string, drawKey: string) => Promise<string | null | undefined>;
let resolver: ServingResolver | undefined;

export function registerAgentServingResolver(r: ServingResolver | undefined): void {
  resolver = r;
}

export function agentVersionsServed(): boolean {
  return process.env.OPENWOP_AGENT_VERSIONS === 'on' && resolver !== undefined;
}

/** The version an unpinned execution of a PACK agent runs; see `ServingResolver`. */
export async function servingVersion(tenantId: string | undefined, agentId: string, drawKey: string): Promise<string | null | undefined> {
  if (!agentVersionsServed() || !tenantId) return undefined;
  return resolver!(tenantId, agentId, drawKey);
}

/**
 * The manifest an unpinned execution runs: the serving version, else the head.
 * A serving version that cannot be loaded on this instance is `null`, never the
 * head: running other code than the deployment chose is the state ADR 1014
 * exists to remove. `drawKey` keeps one conversation or run on one side of a
 * canary split.
 */
export async function resolveServedAgent(agentId: string, tenantId: string | undefined, drawKey: string): Promise<ResolvedAgentManifest | null> {
  return (await resolveServedAgentDetailed(agentId, tenantId, drawKey)).agent;
}

/** As `resolveServedAgent`, saying WHY there is no agent: `refused` when the agent
 *  exists but its deployment serves nothing runnable here, so a caller fails closed
 *  instead of treating it as an unknown agent (and, say, degrading to a default
 *  prompt that reads like the agent's). */
export async function resolveServedAgentDetailed(
  agentId: string, tenantId: string | undefined, drawKey: string,
): Promise<{ agent: ResolvedAgentManifest | null; refused: boolean; version?: string }> {
  const head = await getAgentRegistry().resolve(agentId, tenantId);
  if (!head) return { agent: null, refused: false };
  const version = await servingVersion(tenantId, head.agentId, drawKey);
  if (version === undefined || version === head.packVersion) return { agent: head, refused: false };
  if (version === null) return { agent: null, refused: true };
  const agent = await getAgentRegistry().resolve(agentId, tenantId, version);
  return agent ? { agent, refused: false, version } : { agent: null, refused: true, version };
}

/**
 * ADR 1014 M6 — as `resolveServedAgentDetailed`, inside a run body: the version is
 * the run's recorded one (`ctx.pinServedAgent`), never a fresh draw, so a resume or
 * a fork runs what the run first ran.
 */
export async function resolveRunServedAgent(
  agentId: string, tenantId: string, pin: NonNullable<NodeContext['pinServedAgent']>,
): Promise<{ agent: ResolvedAgentManifest | null; refused: boolean; version?: string }> {
  const r = await pin(agentId);
  if (!r.ok) return { agent: null, refused: true };
  if (r.version === undefined) return { agent: await getAgentRegistry().resolve(agentId, tenantId), refused: false };
  const agent = await getAgentRegistry().resolve(agentId, tenantId, r.version);
  return agent ? { agent, refused: false, version: r.version } : { agent: null, refused: true, version: r.version };
}
