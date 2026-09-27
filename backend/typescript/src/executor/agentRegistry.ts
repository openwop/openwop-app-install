/**
 * Module-scope AgentRegistry singleton — the manifest-agent parallel to
 * `nodeRegistry.ts` (RFC 0070 / RFC 0003 §ImplNotes `installAgents`).
 *
 * Holds the resolved `AgentManifest`s a host has installed from pack
 * `agents[]` arrays, keyed by `agentId`. `installAgents` is append-only;
 * a manifest agent is resolvable for dispatch via `core.dispatch` once it
 * lands here. Like the node registry, a single in-process map suffices for
 * the reference app; multi-instance hosts would replicate via a shared store.
 */

import type { PackTrustReason, PackTrustTier } from '../host/packTrust.js';

/** A pack-declared agent manifest, resolved for runtime use.
 *  Mirrors `schemas/agent-manifest.schema.json` (RFC 0003). After load,
 *  `systemPromptRef` is resolved to inline `systemPrompt`, and the two
 *  `handoff.*SchemaRef`s are resolved to parsed JSON Schemas. */
export interface ResolvedAgentManifest {
  agentId: string;
  persona: string;
  modelClass: string;
  /** Resolved system prompt body (inline, or read from `systemPromptRef`). */
  systemPrompt: string;
  /** Provenance: the tarball-relative ref when the prompt was external. */
  systemPromptRef?: string;
  toolAllowlist?: string[];
  /** RFC 0092 — host-capability keys this agent needs to run fully. A host that
   *  doesn't advertise a listed key surfaces the agent as degraded on the
   *  inventory (the `degraded[]` projection). */
  requiresCapabilities?: string[];
  memoryShape?: { scratchpad?: boolean; conversation?: boolean; longTerm?: boolean };
  confidence?: { defaultThreshold?: number };
  /** ADR 0089 Phase 4 (Option B) — agent-declared opt-in to "deep investigation":
   *  when a tool-bearing agent with `investigationDepth: 'deep'` is @mentioned in
   *  a conversation, its tool loop is dispatched as a SEPARATE persisted run
   *  (embedded as a `workflow_run` chat bubble) instead of the inline turn loop —
   *  a first-class, long-horizon run with progress. Absent/any-other value ⇒ the
   *  default inline behavior (no regression for existing agents). */
  investigationDepth?: 'deep';
  /** Resolved handoff JSON Schemas (parsed) + their provenance refs + the
   *  validators pre-compiled at load (RFC 0003 §D "MAY pre-compile"). Pre-
   *  compiling avoids per-dispatch recompilation and the shared-Ajv `$id`
   *  collision that a long-lived instance hits across packs. */
  handoff?: {
    taskSchemaRef?: string;
    returnSchemaRef?: string;
    taskSchema?: unknown;
    returnSchema?: unknown;
    validateTask?: AgentSchemaValidator;
    validateReturn?: AgentSchemaValidator;
  };
  label?: string;
  description?: string;
  /** The pack this agent was loaded from. */
  packName: string;
  packVersion: string;
  /** RFC 0072 §C — capability keys this agent's pack declared as
   *  `peerDependenciesMeta.optional` that this host does NOT satisfy, so they
   *  are inert for this installation. Absent/empty ⇒ full declared capability. */
  degraded?: string[];
  /** Owning tenant id for user-authored agents (host-extension
   *  `POST /v1/host/openwop-app/agents`, phase E1 2026-05-28). Pack-installed
   *  agents OMIT this field — they are tenant-agnostic (a host
   *  loads them once at boot for every tenant to share).
   *
   *  When present, the agent is ONLY visible to + dispatchable by
   *  the owning tenant. Enforces `agent-memory.md` CTI-1 cross-tenant
   *  isolation: the systemPrompt body is tenant-owned IP (an
   *  authoring artifact a tenant pays to compose) and MUST NOT leak
   *  across tenant boundaries via `GET /v1/agents` projections,
   *  `@`-mention picker results, or chat dispatch resolution.
   *
   *  Consumers MUST gate visibility / dispatch on
   *  `(!ownerTenant || ownerTenant === requestTenant)`. */
  ownerTenant?: string;
}

/** A pre-compiled handoff-schema validator (closes over an Ajv ValidateFunction
 *  produced at load). Returns a structured result so the dispatch path can cite
 *  the violation without re-touching Ajv. */
export type AgentSchemaValidator = (value: unknown) => { ok: boolean; errors?: string };

type AgentPackResolver = (agentId: string, tenant?: string) => Promise<unknown>;

/**
 * ADR 0555 P1 (P0 residue (b)) — an untrusted pack's agents, VISIBLY refused.
 *
 * P0 had `agentLoader` return `[]` for a non-dispatchable pack, which made those
 * agents invisible rather than refused: an operator debugging "why is my agent
 * missing" had a log line and nothing else. The residue asked for a registry
 * field carrying tier + reason.
 *
 * They land in a SEPARATE map, not in `inProcess` with a flag, and the reason is
 * the sentence P0 wrote about this path: "an agent has no separate execute seam
 * to wrap — being in the AgentRegistry IS being dispatchable". A flag on a row
 * every existing consumer already reads (`list()`, the @-mention picker, chat
 * dispatch resolution) would make refusal depend on ~a dozen call sites each
 * remembering to check it. A second map cannot be dispatched from by
 * construction: `get`, `has` and `resolve` never look in it.
 *
 * It deliberately carries NO `systemPrompt`, `toolAllowlist` or handoff schema.
 * Those are the parts of an agent manifest that STEER a model and gate which
 * host tools it may call; surfacing them from unattested bytes would put the
 * untrusted content into host read surfaces, which is most of what refusing the
 * pack was for. Identity and the refusal reason are the whole payload.
 */
export interface RefusedAgentEntry {
  readonly agentId: string;
  readonly label?: string;
  readonly description?: string;
  readonly packName: string;
  readonly packVersion: string;
  readonly tier: PackTrustTier;
  readonly reason: PackTrustReason;
  readonly detail?: string;
  /** Always false. Present so a consumer reads a decision, not infers one. */
  readonly dispatchable: false;
}

/** ADR 0379 Phase 2 — the registry keys USER-authored agents by
 *  (ownerTenant, agentId) so persona-scoped ids (`user.<slug>`, shared across
 *  tenants after Phase 3) can coexist. Pack agents (no `ownerTenant`) remain
 *  keyed by bare agentId — their ids are globally unique by convention
 *  (`<packId>.<agent>`). A tenant-less lookup therefore sees pack agents only;
 *  every user-agent lookup must carry the tenant (Phase 1 made that threadable
 *  everywhere). */
const inProcess = new Map<string, ResolvedAgentManifest>();
const refused = new Map<string, RefusedAgentEntry>();
let resolver: AgentPackResolver | null = null;

const userKey = (tenant: string, agentId: string): string => `u\u0000${tenant}\u0000${agentId}`;

function lookup(agentId: string, tenant?: string): ResolvedAgentManifest | null {
  const pack = inProcess.get(agentId);
  if (pack) return pack;
  if (tenant !== undefined) return inProcess.get(userKey(tenant, agentId)) ?? null;
  return null;
}

export function getAgentRegistry() {
  return {
    /** Append-only install of a resolved manifest agent (RFC 0003). User
     *  agents key under their `ownerTenant`; pack agents under the bare id. */
    register(agent: ResolvedAgentManifest): void {
      inProcess.set(agent.ownerTenant ? userKey(agent.ownerTenant, agent.agentId) : agent.agentId, agent);
    },
    /** Drop one agent from the in-process registry. Returns true when
     *  a row was removed. The pack-loader path is append-only (RFC
     *  0003), so this is intended only for user-authored agents
     *  (`DELETE /v1/host/openwop-app/agents/:agentId`, phase E1 2026-05-28) —
     *  which is why `tenant` is REQUIRED here, unlike the lookups. */
    remove(agentId: string, tenant: string): boolean {
      return inProcess.delete(userKey(tenant, agentId));
    },
    has(agentId: string, tenant?: string): boolean {
      return lookup(agentId, tenant) !== null;
    },
    /** Synchronous get (in-process only). Tenant-less ⇒ pack agents only. */
    get(agentId: string, tenant?: string): ResolvedAgentManifest | null {
      return lookup(agentId, tenant);
    },
    /** Async resolve — falls through to the pack resolver on miss. As with
     *  the node registry, the resolver typically registers EVERY agent in
     *  the matching pack, so we re-read after it runs. */
    async resolve(agentId: string, tenant?: string): Promise<ResolvedAgentManifest | null> {
      const direct = lookup(agentId, tenant);
      if (direct) return direct;
      if (resolver) {
        await resolver(agentId, tenant);
        const reread = lookup(agentId, tenant);
        if (reread) return reread;
      }
      return null;
    },
    listAgentIds(): readonly string[] {
      // Project from VALUES — the map keys are composite for user agents.
      return Array.from(inProcess.values()).map((a) => a.agentId).sort();
    },
    /** All resolved manifests (for the inventory route / CLI). Dispatchable
     *  agents only — refused ones are read through `listRefused()`. */
    list(): readonly ResolvedAgentManifest[] {
      return Array.from(inProcess.values()).sort((a, b) => a.agentId.localeCompare(b.agentId));
    },
    /** ADR 0555 P1 — record an agent this host refuses to register, with the
     *  trust verdict that caused it. Never reachable by `get`/`has`/`resolve`. */
    registerRefused(entry: RefusedAgentEntry): void {
      refused.set(`${entry.packName}\u0000${entry.agentId}`, entry);
    },
    /** Agents a pack declared that this host will not dispatch, with tier +
     *  reason. Feeds the Operations/marketplace surface (matrix row 10). */
    listRefused(): readonly RefusedAgentEntry[] {
      return Array.from(refused.values()).sort((a, b) => a.agentId.localeCompare(b.agentId));
    },
    /** Test seam — clears the in-process maps. */
    _resetForTest(): void {
      inProcess.clear();
      refused.clear();
    },
  };
}

export function setAgentPackResolver(fn: AgentPackResolver): void {
  resolver = fn;
}
