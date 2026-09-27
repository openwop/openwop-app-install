/**
 * HostAdapterSuite — the 15 host-extension slots in one factory.
 *
 * Mirrors the MyndHyve `HostAdapterSuite` triage from
 * services/workflow-runtime/src/host/index.ts. Every slot has either a
 * real wrap, a minimal wrap, or a throw-on-use stub. Routes consume
 * adapters from this suite, never construct them inline.
 *
 * To replace a stub with a real implementation (e.g., wire OIDC
 * identity), swap the impl here. Route handlers stay unchanged.
 */

import { oauthAdvertisementSnapshot } from '../features/connections/oauthAdvertisement.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoDir } from './_repoPath.js';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';
import type { Principal } from '../types.js';
import { OpenwopError } from '../types.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { getRegisteredWorkflowAsync } from './workflowsRegistry.js';
import { getChainBackedWorkflow } from './chainBackedWorkflows.js';
import { getExampleWorkflow } from './exampleWorkflows.js';
import { getWorkflowTemplate } from './workflowTemplates.js';
import { createConnectorInvoker } from './connectorInvoker.js';
import { AGENT_MENTION_WORKFLOW_ID, agentMentionWorkflowDefinition } from './agentMentionWorkflows.js';
import { conformanceNodesEnabled } from '../bootstrap/conformanceMockAgent.js';
import { implementedMemoryActions } from '../bootstrap/conformanceMemoryProbe.js';

/**
 * Load conformance fixtures from the in-tree `conformance/fixtures/`
 * directory so the reference backend can stand in as a black-box conformance
 * target. Only fixtures whose typeIds are registered on this host
 * (chat-responder, demo-uppercase, mock-agent, core.*) are loadable;
 * everything else surfaces as "workflow not found" if a run requests it.
 *
 * Discovery (`routes/discovery.ts`) advertises the loaded fixtures via
 * `capabilities.fixtures` so capability-gated conformance scenarios
 * can detect what this host actually supports.
 */
function findConformanceFixturesDir(): string | null {
  // Robust upward walk via the shared `locateRepoDir` helper (same resolver the
  // schema + prompt loaders use) — finds the vendored `conformance-fixtures/`
  // dir from `src/host` (tsx dev), `lib/` (esbuild bundle), or `/app` (Docker),
  // with no hard-coded directory depths or monorepo-layout assumptions. Uses a
  // stable core fixture as the sentinel. Non-fatal: conformance fixtures are an
  // optional black-box-target feature, so a missing dir returns null (skip
  // loading) rather than throwing the way `locateRepoDir` does for required dirs.
  try {
    return locateRepoDir(
      dirname(fileURLToPath(import.meta.url)),
      'conformance-fixtures',
      'conformance-agent-identity.json',
    );
  } catch {
    return null;
  }
}

const conformanceFixtures = new Map<string, WorkflowDefinition>();
(function loadConformanceFixtures(): void {
  const dir = findConformanceFixturesDir();
  if (!dir) return;
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const parsed = JSON.parse(raw) as WorkflowDefinition & {
          id?: string;
          workflowId?: string;
          nodes?: ReadonlyArray<{ id?: string; nodeId?: string; typeId: string; config?: Record<string, unknown> }>;
        };
        const id = parsed.workflowId ?? parsed.id;
        if (typeof id !== 'string' || id.length === 0) continue;
        // Normalize `nodes[].id` (the conformance fixture authoring
        // shape, per `conformance/fixtures/*.json`) to
        // `nodes[].nodeId` (the executor's WorkflowDefinition shape,
        // per `executor/types.ts:264`). Both shapes carry the same
        // semantic identifier; only the field name differs because
        // the fixtures predate the executor's interface rename. The
        // scheduler's Kahn-algorithm topological sort consults
        // `nodeId` exclusively (`executor/scheduler.ts:101`) — without
        // this normalization every loaded fixture appears to the
        // scheduler as a graph of `undefined`-keyed nodes and the
        // cycle detector throws `cycle_detected` on the first run.
        const normalizedNodes = Array.isArray(parsed.nodes)
          ? parsed.nodes.map((n) => ({
              ...n,
              nodeId: n.nodeId ?? n.id ?? '',
            }))
          : [];
        conformanceFixtures.set(id, {
          ...parsed,
          workflowId: id,
          nodes: normalizedNodes,
        });
      } catch {
        /* skip malformed fixture */
      }
    }
  } catch {
    /* directory unreadable — reference backend just doesn't act as a conformance target */
  }
})();

/**
 * Public — list loaded conformance fixture ids for `capabilities.fixtures`.
 *
 * A fixture whose graph references a `core.conformance.*` node is only RUNNABLE
 * when those nodes are registered (`conformanceNodesEnabled()` — off in the auth
 * deploy posture). Advertising it regardless is a dishonest advert with a nasty
 * failure mode: the suite's outer `isFixtureAdvertised` gate passes, the scenario
 * runs, the run fails because the typeId does not resolve, and a correctly
 * configured production host is reported NON-CONFORMANT for a fixture it never
 * offered. So the advert is filtered to what the host can actually run.
 *
 * Membership is DERIVED from each fixture's own node typeIds, not a hand-kept
 * list — a new conformance-node fixture is covered the day it lands, and one that
 * stops using such a node stops being filtered, with no second place to update.
 *
 * Found reviewing RFC 0140's `conformance-replay-side-effect`, which introduced a
 * fresh instance of the bug; the 14 pre-existing `core.conformance.mock-agent`
 * fixtures had it already and are fixed by the same predicate.
 */
function fixtureNeedsConformanceNodes(def: WorkflowDefinition): boolean {
  // H47: the `core.conformance.` prefix is now the WHOLE membership. It was not
  // always — `conformance-a2a-task-roundtrip` spelled its node `core.a2a.invoke`
  // and `conformance-mcp-tool-roundtrip` spelled its own `core.ai.callPrompt`,
  // and while the vendored fixture set carried those spellings a prefix-only
  // test would advertise both on a host with conformance nodes OFF and fail at
  // dispatch. The corpus renamed both to conformance-RESERVED ids (openwop#1028
  // and openwop#1060 / suite 1.136.0 S33) and this host now pins ^1.136.0 with
  // both fixtures re-vendored, so the extra membership clauses are gone with the
  // spellings that required them.
  //
  // CORRECTION 2026-08-17 (H48). "the `core.conformance.` prefix is now the
  // WHOLE membership" was FALSE, and had been since before H47 narrowed it.
  // `registerConformanceNodes()` (bootstrap/nodes.ts) — the function
  // `conformanceNodesEnabled()` gates — registers FIVE typeIds under the BARE
  // `conformance.` prefix, which `core.conformance.` does not match:
  //   conformance.requiresMissing, conformance.secret.echo,
  //   conformance.cost.emit, conformance.modelCapability.insufficient,
  //   conformance.effect.emit
  // Six vendored fixtures depend on them — four CANONICAL corpus ones
  // (`conformance-capability-missing`, `conformance-model-capability-insufficient`,
  // `openwop-smoke-byok-roundtrip`, `openwop-smoke-cost-emit`) plus the two
  // host-authored `conformance-replay-effect*`. All six were advertised
  // unconditionally, so a host with conformance nodes OFF — the production /
  // auth deploy posture this predicate exists to protect — advertised six
  // fixtures whose only real node is unregistered. That is precisely the
  // advertise-and-spuriously-fail failure described above, reached by a
  // spelling the predicate did not cover.
  //
  // Both prefixes are checked because both are real: `core.conformance.*` is the
  // corpus's reserved namespace, and bare `conformance.*` is what this host's own
  // conformance-only registrations have always used. Neither is a superset of the
  // other (`core.conformance.x` does not START WITH `conformance.`), so a single
  // `includes()` would be the wrong instrument — it would also match an unrelated
  // typeId that merely contains the word.
  return (def.nodes ?? []).some(
    (n) => n.typeId.startsWith('core.conformance.') || n.typeId.startsWith('conformance.'),
  );
}

/**
 * True when a fixture leans on a `config.memoryAction` this host does not
 * currently EXECUTE (H49).
 *
 * The corpus expresses its memory scenarios not as a dedicated node type but as
 * a `core.identity` node carrying `config.memoryAction`, whose results the host
 * must surface as run variables. That makes the advert hazard above reachable by
 * a second, QUIETER route: no typeId fails to resolve, so an unimplemented
 * action does not error — `core.identity` simply runs the fixture as a
 * pass-through, the run reaches `completed`, and the variable bag stays empty.
 * The scenario then fails a correctly-configured host for a fixture it could
 * start but could not meaningfully execute.
 *
 * Membership is derived from the fixture's own graph (like the predicate above),
 * and the implemented-action set is derived from the handler map in
 * `bootstrap/conformanceMemoryProbe.ts` — NOT restated here. A hand-kept list
 * would be a second source of truth for one fact, and its failure mode is
 * silent and asymmetric: losing a handler while keeping its string makes the
 * host advertise a fixture it cannot run. `implementedMemoryActions()` also
 * reads the same `conformanceNodesEnabled()` switch the dispatch branch reads,
 * so the two cannot disagree under either deploy posture.
 *
 * H48 MEASURED THE HAZARD and is the reason this gate exists. Five vendored
 * fixtures declare a `memoryAction`; four
 * (`conformance-agent-memory-{roundtrip,redaction,ttl,cross-tenant}`) were
 * advertised falsely for as long as they had been vendored, hidden because every
 * one of their scenarios ALSO gates on the suite-side `hasLongTermMemory()` and
 * this host advertised no `agents.memoryBackends`. The fifth,
 * `conformance-agent-memory-injection-budget` (RFC 0113), gates root-first on
 * `memory.injectionBudget.supported` per RFC 0073 — which this host DOES
 * advertise, truthfully — so it had no such cover, and bringing the vendored tree
 * to parity with the pin made it execute for the first time and fail on
 * `fixture MUST echo the requested tokenBudget: expected undefined to be defined`
 * — the empty variable bag. H48 closed the advert with a deliberately EMPTY
 * action set; H49 supplied the driver and replaced that hand-kept set with the
 * derived one below, so the set can no longer disagree with the handlers.
 *
 * @see docs/adr/0533-replay-effect-counter-and-advert.md §"H49"
 */
function fixtureNeedsUnimplementedMemoryAction(def: WorkflowDefinition): boolean {
  const implemented = implementedMemoryActions();
  return (def.nodes ?? []).some((n) => {
    const action = n.config?.['memoryAction'];
    return typeof action === 'string' && !implemented.has(action);
  });
}

/**
 * The fixture ids a node's config hands to the executor as a CHILD workflow
 * (`core.subWorkflow` / `core.dispatch` carry it as `config.workflowId`). Only
 * ids that are themselves loaded fixtures count — a child resolved from the
 * workflow registry is not this advert's to judge.
 */
function childFixtureIds(def: WorkflowDefinition): string[] {
  return (def.nodes ?? [])
    .map((n) => n.config?.['workflowId'])
    .filter((id): id is string => typeof id === 'string' && conformanceFixtures.has(id));
}

/**
 * WS0 (2026-09-24) — the STRUCTURAL advert rule: a fixture is offered only if
 * the executor would find a module for EVERY node typeId in its graph, and
 * every child fixture it runs passes the same test.
 *
 * The two predicates above each derive one known hazard from the graph; this
 * one derives the general fact they are both instances of. It is what the
 * prefix predicate could not see: `conformance-artifact-emit`
 * (`conformance.artifact.emit`), `conformance-credential`
 * (`conformance.oauth.use`) and `conformance-mcp-client`
 * (`core.conformance.mcp-client`) name nodes this host has NEVER registered, in
 * either posture, so the prefix gate passed them whenever conformance nodes were
 * on; the two `conformance-wasm-pack-*` fixtures name pack nodes no installed
 * pack declares; and in the enterprise posture `conformance-prompt-*` name
 * `local.sample.demo.mock-ai`, which LEAK-3 deliberately leaves unregistered.
 * Every one of them was in `fixtures[]` and would fail at dispatch with
 * `node module not registered`.
 *
 * `isResolvable` answers from the same two lanes `registry.resolve()` walks
 * (in-process + the installed-pack index), so the advert cannot claim a node the
 * executor would miss nor hide one a pack provides. The env predicate above is
 * KEPT: registration is a boot snapshot, and the posture switch is re-read per
 * call. An empty registry (nothing bootstrapped yet) advertises nothing — the
 * fail-closed direction.
 */
function fixtureIsAdvertisable(
  id: string,
  enabled: boolean,
  isResolvable: (typeId: string) => boolean,
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(id)) return true; // a cycle is judged on its other members
  seen.add(id);
  const def = conformanceFixtures.get(id);
  if (!def) return false;
  if (!enabled && fixtureNeedsConformanceNodes(def)) return false;
  if (fixtureNeedsUnimplementedMemoryAction(def)) return false;
  if (!(def.nodes ?? []).every((n) => isResolvable(n.typeId))) return false;
  return childFixtureIds(def).every((child) => fixtureIsAdvertisable(child, enabled, isResolvable, seen));
}

export function listLoadedConformanceFixtures(): readonly string[] {
  const enabled = conformanceNodesEnabled();
  const registry = getNodeRegistry();
  const memo = new Map<string, boolean>();
  const isResolvable = (typeId: string): boolean => {
    let hit = memo.get(typeId);
    if (hit === undefined) memo.set(typeId, (hit = registry.isResolvable(typeId)));
    return hit;
  };
  const advertised: string[] = [];
  for (const id of conformanceFixtures.keys()) {
    // RFC 0199 fixture opt-in (conformance/fixtures.md): `conformance-credential`
    // is advertised only while `oauth` is, with the suite's `synthetic` provider —
    // otherwise its node would run with no credential gate and prove nothing.
    if (id === 'conformance-credential' && !oauthAdvertisementSnapshot().providers.some((p) => p.id === 'synthetic')) continue;
    if (fixtureIsAdvertisable(id, enabled, isResolvable)) advertised.push(id);
    else reportWithheldFixture(id, isResolvable);
  }
  return advertised.sort();
}

/**
 * ADR 0755 (WIT-FIX-3) — a withheld fixture used to leave no trace, so an
 * operator watching `fixtures[]` shrink could not tell which node blocked it.
 * One line per (fixture, blocking typeIds) per process: this runs on every
 * discovery request, so an undeduped log would be a flood. Only the
 * unresolvable-node rule is named here; the two posture predicates are env
 * switches an operator set on purpose.
 */
const reportedWithheld = new Set<string>();
function reportWithheldFixture(id: string, isResolvable: (typeId: string) => boolean): void {
  const def = conformanceFixtures.get(id);
  const blocking = [...new Set((def?.nodes ?? []).map((n) => n.typeId).filter((t) => !isResolvable(t)))].sort();
  if (blocking.length === 0) return;
  const key = `${id}|${blocking.join(',')}`;
  if (reportedWithheld.has(key)) return;
  reportedWithheld.add(key);
  log.info('conformance_fixture_withheld', { fixtureId: id, unresolvableTypeIds: blocking });
}

const log = createLogger('host');

export interface HostAdapterSuite {
  // Real wraps (8)
  tenantResolver: TenantResolver;
  scopeResolver: ScopeResolver;
  workflowCatalog: WorkflowCatalog;
  principalAuthorizer: PrincipalAuthorizer;
  identityResolver: IdentityResolver;
  observabilitySink: ObservabilitySink;
  auditSink: AuditSink;
  secretResolver: SecretResolver;

  // Minimal wraps (3)
  artifactResolver: ArtifactResolver;
  contextProviderRegistry: ContextProviderRegistry;
  extensionManifestRegistry: ExtensionManifestRegistry;

  // Throw-on-use stubs (4)
  enterprisePolicyResolver: EnterprisePolicyResolver;
  environmentResolver: EnvironmentResolver;
  connectorInvoker: ConnectorInvoker;
  providerPolicyResolver: ProviderPolicyResolver;
}

// ── Slot interfaces ──

export interface TenantResolver {
  resolveTenant(tenantId: string): Promise<{ tenantId: string } | null>;
}

export interface ScopeResolver {
  resolveScope(tenantId: string, scopeId: string): Promise<{ scopeId: string; tenantId: string } | null>;
}

export interface WorkflowCatalog {
  getWorkflow(workflowId: string): Promise<{ workflowId: string; definition: WorkflowDefinition } | null>;
}

export interface PrincipalAuthorizer {
  authorize(principal: Principal, action: string, resource: { tenantId?: string; scopeId?: string }): Promise<boolean>;
}

export interface IdentityResolver {
  resolveFromBearer(token: string): Promise<Principal | null>;
}

export interface ObservabilitySink {
  emitEvent(name: string, attrs: Record<string, unknown>): void;
}

export interface AuditSink {
  record(input: {
    principalId?: string;
    action: string;
    resource?: string;
    outcome?: 'allow' | 'deny' | 'success' | 'failure';
    payload?: Record<string, unknown>;
  }): void;
}

export interface SecretResolver {
  /** Resolves `credentialRef` → raw secret string. Returns null when unknown. */
  resolve(credentialRef: string, scope: { tenantId?: string; principalId?: string; runId?: string }): Promise<string | null>;
}

export interface ArtifactResolver {
  resolve(uri: string): Promise<{ contents: Buffer; mediaType: string } | null>;
}

export interface ContextProviderRegistry {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
}

export interface ExtensionManifestRegistry {
  list(): Promise<readonly { name: string; version: string }[]>;
}

export interface EnterprisePolicyResolver {
  evaluate(input: unknown): Promise<{ allowed: boolean; reason?: string }>;
}

export interface EnvironmentResolver {
  resolve(name: string): Promise<string | null>;
}

export interface ConnectorInvoker {
  invoke(connectorId: string, args: unknown): Promise<unknown>;
}

/**
 * Four-mode AI provider policy per `spec/v1/capabilities.md:268-275`.
 * `disabled` blocks the provider entirely; `optional` (default) allows
 * any model; `required` mandates a BYOK credentialRef; `restricted`
 * limits the caller to a whitelist of model ids (empty list MUST fail
 * closed per `capabilities.md:285`).
 */
export type AiProviderPolicyMode = 'disabled' | 'optional' | 'required' | 'restricted';

export interface AiProviderPolicy {
  provider: string;
  mode: AiProviderPolicyMode;
  /** Glob list for `restricted`; ignored for other modes. */
  allowedModels?: readonly string[];
}

export interface ProviderPolicyResolver {
  /**
   * Returns one row per *known* provider. Absent provider → caller
   * defaults to `optional`. Per `capabilities.md:284`, resolver
   * outages fail open to `optional` — `aiProvidersHost.ts` enforces
   * the fail-open rule when this throws.
   */
  resolveForRun(input: { tenantId: string; scopeId?: string }): Promise<readonly AiProviderPolicy[]>;
}

// ── Throw-on-use stub helper ──

function throwOnUse<T extends object>(capability: string): T {
  return new Proxy({} as T, {
    get() {
      return () => {
        throw new OpenwopError(
          'host_capability_missing',
          `Host capability ${capability} is not provided by this sample. Implement src/host/index.ts to enable.`,
          501,
          { capability },
        );
      };
    },
  });
}

// ── Factory ──

export function createHostAdapterSuite(deps: { storage: Storage }): HostAdapterSuite {
  const { storage } = deps;
  return {
    // ── tenant / scope (sqlite-backed; sample seeds nothing — every tenantId is implicitly valid)
    tenantResolver: {
      async resolveTenant(tenantId) {
        // Sample policy: every non-empty tenantId is valid. Real hosts
        // check membership in a tenants table.
        return tenantId ? { tenantId } : null;
      },
    },
    scopeResolver: {
      async resolveScope(tenantId, scopeId) {
        return scopeId ? { tenantId, scopeId } : null;
      },
    },

    // ── workflow catalog (sqlite-backed; falls back to a hard-coded sample workflow)
    workflowCatalog: {
      async getWorkflow(workflowId) {
        if (workflowId === 'openwop-app.uppercase') {
          return {
            workflowId,
            definition: {
              workflowId,
              nodes: [
                { nodeId: 'shout', typeId: 'local.openwop-app.uppercase' },
              ],
            },
          };
        }
        if (workflowId === 'openwop-app.approval-gate') {
          return {
            workflowId,
            definition: {
              workflowId,
              nodes: [
                { nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve this sample run?' } },
                { nodeId: 'shout', typeId: 'local.openwop-app.uppercase' },
              ],
            },
          };
        }
        // ADR 0051 Phase 3 — A2UI structured-clarification sample. The
        // `a2ui-clarify` node suspends with a `clarification` interrupt that
        // carries an A2UI surface (RFC 0102 `ui.a2ui-surface` shape); the chat
        // renders it as a real form (date / duration / reminder) instead of a
        // textarea, and the collected field values resume the run. Runs
        // end-to-end with no BYOK provider.
        if (workflowId === 'openwop-app.a2ui-clarify') {
          return {
            workflowId,
            definition: {
              workflowId,
              nodes: [
                { nodeId: 'clarify', typeId: 'local.openwop-app.a2ui-clarify', config: { question: 'When should the kickoff be?' } },
              ],
            },
          };
        }
        // Gap D-4 — web-research sample. Chains the `core.web.search`
        // node (core.openwop.web-search pack; deterministic stub in the
        // demo since the host does not advertise host.webSearch) into a
        // deterministic mock summarizer. Demonstrates the search-tool
        // family on the PROTOCOL layer (node pack), not a host-side exec.
        // Runs end-to-end with no BYOK provider and replays deterministically.
        if (workflowId === 'openwop-app.web.research') {
          return {
            workflowId,
            definition: {
              workflowId,
              nodes: [
                {
                  nodeId: 'search',
                  typeId: 'core.web.search',
                  config: { maxResults: 3 },
                  inputs: { query: { type: 'variable', variableName: 'query' } },
                },
                {
                  nodeId: 'summarize',
                  typeId: 'local.sample.demo.mock-ai',
                  outputRole: 'primary',
                },
              ],
              edges: [{ edgeId: 'e1', sourceNodeId: 'search', targetNodeId: 'summarize' }],
              variables: [
                {
                  name: 'query',
                  type: 'string',
                  description: 'The research question to search the web for.',
                  required: true,
                  defaultValue: 'open workflow orchestration protocol',
                },
              ],
            },
          };
        }
        // Per-turn chat (RFC 0005 predecessor). RETIRED as a live transport in
        // ADR 0067 Phase 6 — the frontend no longer creates these runs. The
        // definition is retained ONLY so historical/in-flight per-turn runs still
        // replay + `:fork` against their checkpoints (the OpenWOP wire contract);
        // deleting it would break replay of any run created before the cutover.
        if (workflowId === 'openwop-app.chat.turn') {
          return {
            workflowId,
            definition: {
              workflowId,
              nodes: [
                { nodeId: 'respond', typeId: 'vendor.openwop-app.chat-responder' },
              ],
            },
          };
        }
        // Wire-aligned multi-agent chat (RFC 0005) — the SOLE live chat transport.
        // One long-lived conversation run per chat session: the gate opens +
        // suspends, each user message is an `exchange`, "New chat" closes it.
        if (workflowId === 'openwop-app.conversation') {
          return {
            workflowId,
            definition: {
              workflowId,
              nodes: [
                { nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'Conversation started.' } },
              ],
            },
          };
        }
        // ADR 0089 Phase 4 (Option B) — the synthetic agent-mention workflow: a
        // one-node graph wrapping the gated agent-runner so a deep-investigation
        // @mentioned agent's tool loop runs as a standard persisted run, embedded
        // in chat as a `workflow_run` bubble. Resolved here in catalog source A
        // (like the other `openwop-app.*` synthetic workflows) so it is runnable on
        // every instance + survives restart/replay.
        if (workflowId === AGENT_MENTION_WORKFLOW_ID) {
          return { workflowId, definition: agentMentionWorkflowDefinition };
        }
        // Chain-backed workflows (ADR 0472 Phase 1 — the SANCTIONED replacement for
        // builtinWorkflows above). A feature registers these from a chain pack via
        // `registerChainBackedWorkflow(chainId)`; they resolve here in catalog
        // source A under the STABLE chainId so they run on every instance + survive
        // restart/replay, while the chain itself stays gallery-reachable + editable.
        const chainBacked = getChainBackedWorkflow(workflowId);
        if (chainBacked) return { workflowId, definition: chainBacked };
        // Built-in demo role-workflows (the "AI coworkers" roster portfolios).
        // Resolved here in catalog source A — NOT the in-memory builder
        // registry — so a roster portfolio id is runnable on every instance
        // and survives restart (host/exampleWorkflows.ts explains why).
        const demo = getExampleWorkflow(workflowId);
        if (demo) return { workflowId, definition: demo };
        // Shared work-twin template pack (ADR 0032 Phase 2.0) — a pinned
        // module constant (host/workflowTemplates.ts), resolved here in catalog
        // source A like the demo workflows so a twin portfolio that binds a
        // `tmpl.*` id (directly or via `core.subWorkflow`) is runnable on every
        // instance and survives restart/replay, NOT the in-memory builder
        // registry below.
        const template = getWorkflowTemplate(workflowId);
        if (template) return { workflowId, definition: template };
        // Builder-registered workflows. Resolved via the durable-backed
        // registry (ENG-3): a cache hit, else a storage read — so a run
        // re-dispatched by the sweeper on ANOTHER instance can still resolve a
        // workflow that was registered on the instance that crashed.
        const registered = await getRegisteredWorkflowAsync(workflowId);
        if (registered) {
          return { workflowId, definition: registered };
        }
        // Conformance fixtures loaded from in-tree `conformance/fixtures/`
        // at boot. Lets the reference backend answer black-box conformance runs
        // targeted at `/v1/runs` with a fixture workflowId, gated by
        // whichever fixture-specific typeIds this host has registered.
        const fixture = conformanceFixtures.get(workflowId);
        if (fixture) return { workflowId, definition: fixture };
        return null;
      },
    },

    // ── principal authorizer (sample: synthetic principal can act on any tenant it advertises)
    principalAuthorizer: {
      async authorize(principal, _action, resource) {
        if (!resource.tenantId) return true;
        return principal.tenants.includes(resource.tenantId) || principal.tenants.includes('*');
      },
    },

    // ── identity resolver: stub — any non-empty Bearer token resolves to a synthetic principal
    identityResolver: {
      async resolveFromBearer(token) {
        if (!token) return null;
        return {
          principalId: `sample-principal:${token.slice(0, 8)}`,
          tenants: ['*'],
          token,
        };
      },
    },

    // ── observability sink: log to structured logger
    observabilitySink: {
      emitEvent(name, attrs) {
        log.debug(name, attrs);
      },
    },

    // ── audit sink: persists to sqlite's audit_log table AND mirrors
    // to the structured logger. Real impls might also push to a SIEM
    // or to an append-only object store with hash-chain integrity per
    // openwop-audit-log-integrity profile.
    auditSink: {
      record(input) {
        const ts = new Date().toISOString();
        try {
          storage.appendAudit({
            timestamp: ts,
            principalId: input.principalId,
            action: input.action,
            resource: input.resource,
            outcome: input.outcome,
            payload: input.payload,
          });
        } catch (err) {
          log.warn('audit persistence failed', { error: err instanceof Error ? err.message : String(err) });
        }
        log.info('audit', { timestamp: ts, ...input });
      },
    },

    // ── secret resolver: in-memory map (sample only)
    secretResolver: createInMemorySecretResolver(),

    // ── minimal wraps
    artifactResolver: {
      async resolve(uri) {
        if (!uri.startsWith('local-fs:///')) return null;
        // Sample policy: refuses to read arbitrary fs paths. Real impl
        // would namespace under a per-tenant directory and verify
        // path traversal.
        return null;
      },
    },
    contextProviderRegistry: createInMemoryContextProviderRegistry(),
    extensionManifestRegistry: {
      async list() {
        return [];
      },
    },

    // ── throw-on-use stubs
    enterprisePolicyResolver: throwOnUse<EnterprisePolicyResolver>('host.enterprisePolicy'),
    environmentResolver: throwOnUse<EnvironmentResolver>('host.environment'),

    // ── connector invoker (ADR 0037): a real impl that delegates to the
    //   Connections broker + brokered egress — resolves the connector's provider
    //   Connection for the acting user, performs the audited egress call, fails
    //   closed when unconfigured. A pack declaring peerDependencies:["host.connectors"]
    //   now RESOLVES instead of host_capability_missing. `host.connectors` is
    //   advertised `supported:true` in discovery (capability honesty).
    connectorInvoker: createConnectorInvoker({ storage }),

    // ── provider policy resolver (env-var driven; best-effort global)
    //   OPENWOP_AI_POLICY_<PROVIDER>=disabled|optional|required|restricted[:model1,model2,...]
    // Real hosts persist per-tenant + per-scope policy in their tenants
    // table; the sample applies one policy set to every (tenantId,
    // scopeId) tuple. The full four-mode predicate from
    // `spec/v1/capabilities.md:246-289` is implemented — only the
    // *scoping* is best-effort.
    providerPolicyResolver: createEnvVarProviderPolicyResolver(),
  };
}

// ── Provider policy resolver ──

const KNOWN_PROVIDERS: readonly string[] = ['anthropic', 'openai', 'google'];

function createEnvVarProviderPolicyResolver(): ProviderPolicyResolver {
  return {
    async resolveForRun(_input) {
      const out: AiProviderPolicy[] = [];
      for (const provider of KNOWN_PROVIDERS) {
        const raw = process.env[`OPENWOP_AI_POLICY_${provider.toUpperCase()}`];
        if (!raw) {
          out.push({ provider, mode: 'optional' });
          continue;
        }
        const parsed = parseEnvPolicy(provider, raw);
        if (parsed) out.push(parsed);
      }
      return out;
    },
  };
}

function parseEnvPolicy(provider: string, raw: string): AiProviderPolicy | null {
  const trimmed = raw.trim();
  if (!trimmed) return { provider, mode: 'optional' };
  const [modeRaw, modelsRaw] = trimmed.split(':');
  const mode = (modeRaw ?? '').toLowerCase() as AiProviderPolicyMode;
  if (mode !== 'disabled' && mode !== 'optional' && mode !== 'required' && mode !== 'restricted') {
    log.warn('invalid OPENWOP_AI_POLICY mode; treating as optional', { provider, raw });
    return { provider, mode: 'optional' };
  }
  if (mode === 'restricted') {
    const models = (modelsRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { provider, mode, allowedModels: models };
  }
  return { provider, mode };
}

// ── In-memory secret resolver (sample-only impl) ──

function createInMemorySecretResolver(): SecretResolver {
  // Reads OPENWOP_BOOT_SECRETS env var as JSON: {"credRef": "value", ...}
  // and serves matching credentialRef requests. Real deployers swap for KMS.
  // (Legacy alias OPENWOP_SAMPLE_SECRETS still honored for existing deploys.)
  let secrets: Record<string, string> = {};
  try {
    const rawSecrets = process.env.OPENWOP_BOOT_SECRETS ?? process.env.OPENWOP_SAMPLE_SECRETS;
    if (rawSecrets) {
      secrets = JSON.parse(rawSecrets);
    }
  } catch (err) {
    log.warn('OPENWOP_BOOT_SECRETS parse failed; secrets disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    async resolve(credentialRef) {
      return secrets[credentialRef] ?? null;
    },
  };
}

function createInMemoryContextProviderRegistry(): ContextProviderRegistry {
  const map = new Map<string, unknown>();
  return {
    get(name) {
      return map.get(name);
    },
    set(name, value) {
      map.set(name, value);
    },
  };
}
