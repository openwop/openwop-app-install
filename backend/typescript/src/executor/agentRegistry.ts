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

import { canonicalAgentId } from './agentIdAliases.js';
import { isPackRevoked } from '../host/packRevocations.js';
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
  /** RFC 0081 §A — the pack's eval suite ref and its PARSED JSON (validated lazily
   *  by `host/evals/packSuites.ts`, ADR 0889 D2). Absent ⇒ the agent ships no suite. */
  evalSuiteRef?: string;
  evalSuite?: unknown;
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
  /** ADR 1055 D4 — core agent capabilities the agent's OWN pack activates for it
   *  by default, from the pack's `x-openwop-app.agentCapabilities` vendor
   *  extension (a sanctioned `^x-` key in the node-pack manifest schema, so no
   *  wire change). Host-internal, never serialized; only
   *  `PACK_DECLARABLE_AGENT_CAPABILITIES` survive the load. Merged with the
   *  tenant profile's `capabilities` by `agentHasCapability`. */
  hostCapabilities?: string[];
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
  /** ADR 0962 D8 — `false` keeps a PACK agent off the A2A 0.3 card and refuses it on
   *  `message/send` (both read `a2aListedAgents` / `isA2aDispatchable`). Absent = listed. */
  a2aExposed?: false;
}

/** A pre-compiled handoff-schema validator (closes over an Ajv ValidateFunction
 *  produced at load). Returns a structured result so the dispatch path can cite
 *  the violation without re-touching Ajv. */
export type AgentSchemaValidator = (value: unknown) => { ok: boolean; errors?: string };

type AgentPackResolver = (agentId: string, tenant?: string) => Promise<unknown>;

/** ADR 1014 D2 — loads `<packDir>/.versions/<packName>/<version>/` into the
 *  versioned map (`registerVersion`). Set by the bootstrap, like the pack resolver. */
type AgentArchiveResolver = (agentId: string, version: string, packName: string) => Promise<unknown>;

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

/** ADR 0775 P3d — when each user-agent entry was registered on THIS instance. A
 *  peer's delete or edit reaches here as an eviction message
 *  (`host/agentRegistryEviction.ts`); this is the backstop for a message that was
 *  missed (an instance restarting mid-publish, a dropped LISTEN connection). An
 *  entry older than the TTL is re-read from storage on its next `resolve()`, so a
 *  missed message costs at most one TTL of staleness, never "until restart". */
const registeredAt = new Map<string, number>();
const USER_AGENT_TTL_MS = (() => {
  const n = Number(process.env.OPENWOP_USER_AGENT_REGISTRY_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60_000;
})();

/** ADR 0826 D5 — a PACK agent whose pack version is revoked is not dispatchable,
 *  from the moment the revocation reaches this instance (no restart): every
 *  lookup — `has`/`get`/`resolve` — and the dispatchable list treat it as absent.
 *  User-authored agents (`ownerTenant`) carry no pack provenance to revoke. */
function revoked(agent: ResolvedAgentManifest): boolean {
  return agent.ownerTenant === undefined && isPackRevoked(agent.packName, agent.packVersion);
}

/** ADR 1014 D2 — archived pack-agent versions, keyed `agentId@version`. Never the
 *  head: an id with no version (or the head's own version) reads `inProcess`. */
const versioned = new Map<string, ResolvedAgentManifest>();
let archiveResolver: AgentArchiveResolver | undefined;

export function setAgentArchiveResolver(r: AgentArchiveResolver | undefined): void {
  archiveResolver = r;
}

/** ADR 1014 P5 — loads a USER agent's stored revision into the versioned map. */
type UserRevisionResolver = (tenant: string, agentId: string, revision: string) => Promise<unknown>;
let userRevisionResolver: UserRevisionResolver | undefined;

export function setUserAgentRevisionResolver(r: UserRevisionResolver | undefined): void {
  userRevisionResolver = r;
}

/** The versioned-map key: a user agent's id repeats across tenants (ADR 0379), so its key carries the tenant. */
function versionKey(agentId: string, version: string, ownerTenant?: string): string {
  return ownerTenant !== undefined ? `${userKey(ownerTenant, agentId)}@${version}` : `${agentId}@${version}`;
}

/** The head, or `agentId@version` exactly: a caller that names a version never
 *  falls back to other code (ADR 1014 D2/D3). */
function lookupVersion(agentId: string, tenant: string | undefined, version: string | undefined): ResolvedAgentManifest | null {
  const head = lookup(agentId, tenant);
  if (version === undefined) return head;
  if (head && head.packVersion === version) return head;
  if (head?.ownerTenant !== undefined) return versioned.get(versionKey(head.agentId, version, head.ownerTenant)) ?? null;
  const id = canonicalAgentId(agentId);
  const hit = versioned.get(versionKey(id, version)) ?? (id !== agentId ? versioned.get(versionKey(agentId, version)) : undefined);
  return hit && !revoked(hit) ? hit : null;
}

function lookupExact(agentId: string, tenant?: string): ResolvedAgentManifest | null {
  const pack = inProcess.get(agentId);
  if (pack) return revoked(pack) ? null : pack;
  if (tenant !== undefined) return inProcess.get(userKey(tenant, agentId)) ?? null;
  return null;
}

/** ADR 0763 — THE alias choke point: `has`/`get`/`resolve` all read here. A
 *  legacy `feature.*.agents.*` id reaches the renamed agent when one is
 *  registered under its canonical id; otherwise the literal id is looked up
 *  exactly as before (inert until the rename). One-way: a canonical id never
 *  falls back to a legacy agent. */
function lookup(agentId: string, tenant?: string): ResolvedAgentManifest | null {
  const canonical = canonicalAgentId(agentId);
  if (canonical !== agentId) {
    const hit = lookupExact(canonical, tenant);
    if (hit) return hit;
  }
  return lookupExact(agentId, tenant);
}

export function getAgentRegistry() {
  return {
    /** Append-only install of a resolved manifest agent (RFC 0003). User
     *  agents key under their `ownerTenant`; pack agents under the bare id. */
    register(agent: ResolvedAgentManifest): void {
      inProcess.set(agent.ownerTenant ? userKey(agent.ownerTenant, agent.agentId) : agent.agentId, agent);
      if (agent.ownerTenant) registeredAt.set(userKey(agent.ownerTenant, agent.agentId), Date.now());
    },
    /** Drop one agent from the in-process registry. Returns true when
     *  a row was removed. The pack-loader path is append-only (RFC
     *  0003), so this is intended only for user-authored agents
     *  (`DELETE /v1/host/openwop-app/agents/:agentId`, phase E1 2026-05-28) —
     *  which is why `tenant` is REQUIRED here, unlike the lookups. */
    remove(agentId: string, tenant: string): boolean {
      registeredAt.delete(userKey(tenant, agentId));
      // ADR 1014 P5 — its cached revisions go too, so none can resolve after a delete.
      const prefix = `${userKey(tenant, agentId)}@`;
      for (const k of [...versioned.keys()]) if (k.startsWith(prefix)) versioned.delete(k);
      return inProcess.delete(userKey(tenant, agentId));
    },
    /** ADR 1014 D2 — an archived version, keyed `agentId@version` beside the head. */
    registerVersion(agent: ResolvedAgentManifest): void {
      versioned.set(versionKey(agent.agentId, agent.packVersion, agent.ownerTenant), agent);
    },
    has(agentId: string, tenant?: string, version?: string): boolean {
      return lookupVersion(agentId, tenant, version) !== null;
    },
    /** Synchronous get (in-process only). Tenant-less ⇒ pack agents only.
     *  With `version`: that version exactly, or null (ADR 1014 D2). */
    get(agentId: string, tenant?: string, version?: string): ResolvedAgentManifest | null {
      return lookupVersion(agentId, tenant, version);
    },
    /** Async resolve — falls through to the pack resolver on miss. As with
     *  the node registry, the resolver typically registers EVERY agent in
     *  the matching pack, so we re-read after it runs. */
    async resolve(agentId: string, tenant?: string, version?: string): Promise<ResolvedAgentManifest | null> {
      if (version !== undefined) {
        // ADR 1014 D2 — the head (resolved as usual) if it IS that version, else the
        // archive, else null. Never another version's code.
        const head = await this.resolve(agentId, tenant);
        if (head && head.packVersion === version) return head;
        const hit = lookupVersion(agentId, tenant, version);
        if (hit || !head) return hit;
        if (head.ownerTenant !== undefined) {
          if (!userRevisionResolver) return null;
          await userRevisionResolver(head.ownerTenant, head.agentId, version);
        } else {
          if (!archiveResolver) return null;
          await archiveResolver(head.agentId, version, head.packName);
        }
        return lookupVersion(agentId, tenant, version);
      }
      const direct = lookup(agentId, tenant);
      // ADR 0775 P3d — a user-agent copy past its TTL is re-read through the
      // resolver (storage): gone ⇒ null, edited ⇒ the new record. A read FAULT keeps
      // the copy (and restarts its clock): an outage must not unregister agents.
      // Synchronous `get()` does not refresh; it sees the next refreshed copy.
      if (direct?.ownerTenant !== undefined && resolver) {
        const key = userKey(direct.ownerTenant, direct.agentId);
        if (Date.now() - (registeredAt.get(key) ?? 0) > USER_AGENT_TTL_MS) {
          inProcess.delete(key);
          registeredAt.delete(key);
          try {
            await resolver(direct.agentId, direct.ownerTenant);
          } catch {
            inProcess.set(key, direct);
            registeredAt.set(key, Date.now());
            return direct;
          }
          return lookup(agentId, tenant);
        }
      }
      if (direct) return direct;
      if (resolver) {
        // ADR 0763 — hand the pack scan the canonical spelling first (it
        // matches manifests by exact agentId), then the literal one.
        const canonical = canonicalAgentId(agentId);
        for (const candidate of canonical !== agentId ? [canonical, agentId] : [agentId]) {
          await resolver(candidate, tenant);
          const reread = lookup(agentId, tenant);
          if (reread) return reread;
        }
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
      return Array.from(inProcess.values()).filter((a) => !revoked(a)).sort((a, b) => a.agentId.localeCompare(b.agentId));
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
      versioned.clear();
      registeredAt.clear();
      refused.clear();
    },
  };
}

export function setAgentPackResolver(fn: AgentPackResolver): void {
  resolver = fn;
}
