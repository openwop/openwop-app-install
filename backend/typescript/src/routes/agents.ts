/**
 * Manifest-agent inventory + dispatch (RFC 0070).
 *
 * Namespace: host-extension under `/v1/host/openwop-app/*`; not part of the
 * normative wire contract (the RFC 0070 §Unresolved-questions entry tracks
 * whether `/v1/agents` should be promoted to normative).
 *
 * This is the registry-backed surface that replaces the prior 3-constant
 * placeholder: it lists the agent manifests this host actually loaded from
 * pack `agents[]` (RFC 0003) into the AgentRegistry, and dispatches one via
 * the RFC 0070 floor (`runAgentDispatch`). When the host advertises
 * `capabilities.agents.manifestRuntime`, these reflect real installed agents.
 */

import { randomUUID } from 'node:crypto';
import { v1 } from '../middleware/protocolVersion.js';
import { listNormativeRoster } from '../host/rosterService.js';
import type { Express, NextFunction, Request, Response } from 'express';
import { createLogger } from '../observability/logger.js';
import { recordProtocolVersion, type ServedProfile } from '../observability/metricSeams.js';
import {
  A2A_SUPPORTED_VERSIONS,
  A2A_VERSION_HEADER,
  LEGACY_A2A_PROTOCOL_VERSION,
  cardVersionFor,
  codecVersionFor,
  dispositionForA2AVersionHeader,
  a2aProfileIdFor,
} from '../host/a2aProfile.js';
import { buildA2aCard03, buildA2aCard10 } from '../host/a2aCard.js';
import { handleA2aRequest10 } from '../host/a2aServer10.js';
import { A2A_10_ERROR, errorData10 } from '../host/a2aCodec10.js';
import { sanitizeForErrorMessage } from '../middleware/sanitize.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../executor/agentRegistry.js';
import { runAgentDispatch, runAgentDispatchLive, AgentNotFoundError, type AgentDispatchRequest, type CallAi } from '../host/agentDispatch.js';
import { stampRunStartContext } from '../host/runStartContext.js';
import { readCompactionDecision } from '../executor/compaction.js';
import { createAiProvidersAdapter, assertModalitiesAdvertised, INPUT_MODALITIES, AiProviderError } from '../aiProviders/aiProvidersHost.js';
import type { AiCallRequest } from '../executor/types.js';
import { dispatchChat, type ChatMessage } from '../providers/dispatch.js';
import { getHostTestCompatEndpoint, COMPAT_PROVIDER_ID } from '../host/compatEndpoints.js';
import { assertSubscriptionScopeAllowed, assertSubscriptionStorageTenant, assertSubscriptionProviderPermitted, CLEARED_SUBSCRIPTION_PROVIDERS } from '../byok/subscriptionCredentialScope.js';
import { beginCopilotAuthorization, completeCopilotAuthorization, copilotReturnUrl, COPILOT_CALLBACK_ROUTE } from '../byok/copilotOAuth.js';
import { vendorTwin } from '../middleware/protocolVersion.js';
import { COPILOT_PROVIDER_ID } from '../aiProviders/copilotSubscription.js';
import { storeSubscriptionCredential, subscriptionCredentialRef } from '../byok/subscriptionCredential.js';
import { removeSecret } from '../byok/secretResolver.js';
import { personalTenantOf } from '../host/requestSubject.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../host/agentToolProvider.js';
import { buildFirewallHook, SENSITIVE_APPROVAL_TOOLS } from '../features/capability-firewall/firewallHook.js';
import { getCapabilityRules, getUnknownToolPolicy, getFirewallMode, getDefaultDenyVerdict, getPlatformRules } from '../features/capability-firewall/ruleStore.js';
import { advertisedCapabilitySet, mergeDegraded } from '../host/agentCapabilities.js';
import { projectMemoryDegradation, type MemoryDimension } from '../host/memoryDimensions.js';
import { gradeSuite, type EvalTask } from '../host/agentEvalGrader.js';
import { evalSuiteEnabled } from '../host/workforceEval.js';
import { createAgentMemoryPort, agentMemoryScope } from '../host/agentMemoryAdapter.js';
import { resolveAgentIdentity } from '../host/agentIdentity.js';
import { resolveAgentKnowledgeRetrieve } from '../host/agentKnowledgeComposition.js';
import { getBorrowedRecallResolver } from '../host/twinRecallSurface.js';
import { handleA2aRequest, type A2aJsonRpcRequest } from '../host/a2aServer.js';
import { createA2aSurface, getPublishedAgentCard, A2aVersionRefusedError, type A2aCallRecord } from '../host/a2aSurface.js';
import { traceContextFromHeaders } from '../host/traceContext.js';
import { startPeerAuthorityProbe, settlePeerAuthorityProbe } from '../host/a2aPeerAuthorityProbe.js';
import {
  getA2aTask,
  upsertA2aTask,
  setA2aTaskPushConfig,
  assertPushUrlAllowed,
  A2aPushUrlDeniedError,
} from '../host/a2aTaskStore.js';
import { startWorkflowRun } from '../host/runStarter.js';
import { requestOrigin } from '../host/requestOrigin.js';
import type { HostAdapterSuite } from '../host/index.js';
import type { Storage } from '../storage/storage.js';
import type { UserAgentRecord } from '../types.js';
import { agentVisibleToTenant, resolveAgentForTenant } from '../host/agentVisibility.js';
import { sendError } from '../middleware/errorEnvelope.js';

interface AgentRoutesDeps {
  /** When provided, `dispatch` with `live: true` makes a real model turn. */
  hostSuite?: HostAdapterSuite;
  /** When provided, the inventory list reads through to durable user-agent
   *  storage so a concrete-tenant caller on a cold instance (registry is
   *  boot-hydrated, not refreshed) still sees its seeded/user agents — keeping
   *  the chat `@`-mention list consistent across instances. */
  storage?: Storage;
}

interface AgentInventoryEntry {
  agentId: string;
  persona: string;
  label: string;
  description?: string;
  modelClass: string;
  packName: string;
  packVersion: string;
  toolAllowlist: string[];
  hasHandoffSchemas: boolean;
  memoryShape?: ResolvedAgentManifest['memoryShape'];
  confidenceThreshold?: number;
  degraded?: string[];
  /** RFC 0080 §C. Stamped iff the agent's `memoryShape` requests a §A dimension
   *  this host does not satisfy. Both fields OPTIONAL — §C-1: absent ⇒ memory
   *  fully satisfied. Computed by `host/memoryDimensions.ts`, the same module
   *  that builds the `capabilities.memory` advertisement. */
  memoryDegraded?: true;
  degradedMemoryDimensions?: MemoryDimension[];
}

function toEntry(a: ResolvedAgentManifest): AgentInventoryEntry {
  // RFC 0092 — surface capability keys the agent requires but this host does not
  // advertise as degraded, merged with any pack-declared degradation.
  const degraded = mergeDegraded(a.degraded, a.requiresCapabilities, advertisedCapabilitySet());
  return {
    // RFC 0080 §C — the memory degraded projection, spread FIRST so the explicit
    // fields below always win. Two adjacent-but-distinct degradation vocabularies
    // meet here: `degraded[]` carries host-SURFACE keys (RFC 0072/0092), this
    // carries the CLOSED RFC 0080 §A dimension enum. Neither substitutes for the
    // other, which is why both are projected.
    ...projectMemoryDegradation(a.memoryShape),
    agentId: a.agentId,
    persona: a.persona,
    label: a.label ?? a.persona,
    description: a.description,
    modelClass: a.modelClass,
    packName: a.packName,
    packVersion: a.packVersion,
    toolAllowlist: a.toolAllowlist ?? [],
    hasHandoffSchemas: Boolean(a.handoff?.taskSchema || a.handoff?.returnSchema),
    memoryShape: a.memoryShape,
    confidenceThreshold: a.confidence?.defaultThreshold,
    degraded,
  };
}

/** Project a durable user-agent record straight to the inventory shape — used by
 *  the list read-through (`listVisibleAgents`) for records that aren't yet in
 *  this instance's boot-hydrated registry. Mirrors `registerUserAgent`'s
 *  projection in `userAgents.ts` (synthetic `user:<tenant>` provenance). */
function userRecordToEntry(r: UserAgentRecord): AgentInventoryEntry {
  return {
    // RFC 0080 §C — the read-through lane takes the SAME projection. A
    // user-authored agent that declares `memoryShape.longTerm` on a host without
    // long-term durability is degraded for exactly the same reason a pack agent
    // is, and §C-2 makes a silent satisfied-looking entry non-conformant
    // regardless of where the row came from. Pinned by
    // `test/memory-degraded-projection-route.test.ts`.
    ...projectMemoryDegradation(r.memoryShape),
    agentId: r.agentId,
    persona: r.persona,
    label: r.label ?? r.persona,
    description: r.description,
    modelClass: r.modelClass,
    packName: `user:${r.tenantId}`,
    packVersion: '0',
    toolAllowlist: r.toolAllowlist ?? [],
    hasHandoffSchemas: false,
    memoryShape: r.memoryShape,
    confidenceThreshold: r.confidenceThreshold,
  };
}

/** The tenant-visible inventory: registry agents (pack + boot-hydrated user)
 *  filtered by `ownerTenant`, plus a read-through merge of durable user agents
 *  that this instance hasn't hydrated yet. Explicit wildcard/admin callers
 *  (`?tenantId=*`) see the full hydrated set, so the extra storage read is
 *  skipped. */
async function listVisibleAgents(
  storage: Storage | undefined,
  tenant: string | undefined,
): Promise<AgentInventoryEntry[]> {
  const entries = getAgentRegistry().list().filter((a) => visibleTo(a, tenant)).map(toEntry);
  if (storage && tenant && tenant !== '*') {
    const known = new Set(entries.map((e) => e.agentId));
    for (const r of await storage.listUserAgents(tenant)) {
      if (!known.has(r.agentId)) entries.push(userRecordToEntry(r));
    }
  }
  return entries;
}

/** Cross-tenant isolation filter for user-authored agents (phase E1,
 *  2026-05-28). Pack-installed agents (no `ownerTenant`) are
 *  tenant-agnostic — every tenant sees them. User-authored agents
 *  (a tenant POSTed them via `/v1/host/openwop-app/agents`) carry an
 *  `ownerTenant` and are only visible to that tenant.
 *
 *  `requestTenant` comes from `req.tenantId` populated by the auth
 *  middleware:
 *    - `anon:<sid>` for cookie-anon callers
 *    - `user:<hash>` for OIDC-signed-in callers
 *    - `default` for API-key Bearer callers without an explicit tenant override
 *      (bearer-shared demo posture).
 *    - `*` is the explicit wildcard from `?tenantId=*` overrides.
 *
 *  Wildcard sees everything only when requested explicitly — that's the admin
 *  escape hatch. Normal sessions and bearer-shared callers carry a concrete
 *  tenantId and only see their own user-authored agents. */
function visibleTo(a: ResolvedAgentManifest, requestTenant: string | undefined): boolean {
  return agentVisibleToTenant(a, requestTenant); // ADR 0379 P1 — the ONE rule
}

interface AgentReqLike { tenantId?: string }

function tenantForInventory(req: Request): string {
  const requestedTenant = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
  const principalIsWildcard = (req.principal?.tenants ?? []).includes('*');
  if (principalIsWildcard && requestedTenant) return requestedTenant;
  return (req as AgentReqLike).tenantId ?? 'default';
}

const log = createLogger('routes.agents');

export function registerAgentRoutes(app: Express, deps: AgentRoutesDeps = {}): void {
  // RFC 0092 §B — seed a demo agent whose `requiresCapabilities` names a key this
  // host does not advertise, so the `agent-capability-degraded-projection`
  // behavioral conformance scenario is non-vacuous: it sets
  // OPENWOP_DEGRADED_CAPABILITY_AGENT_ID and GETs that agent, asserting the unmet
  // key surfaces in `degraded[]`. The env var both NAMES and TRIGGERS the agent,
  // so it exists with exactly that id when the scenario runs and never pollutes
  // the inventory otherwise.
  ensureDegradedDemoAgent();

  // RFC 0072 §A — NORMATIVE read-only inventory (matches agent-inventory-response.schema.json).
  // Auth-gated (registered after authMiddleware in index.ts). This host advertises
  // capabilities.agents.manifestRuntime UNCONDITIONALLY (discovery.ts), so the route
  // is always live; a host that gates the advertisement MUST 404 these endpoints when
  // it does not advertise the capability (RFC 0072 §A: "MUST serve iff advertised").
  app.get(v1('/agents'), async (req, res) => {
    const tenant = tenantForInventory(req);
    const agents = await listVisibleAgents(deps.storage, tenant);
    res.json({ agents, total: agents.length });
  });
  // RFC 0086 (Accepted) / `agent-roster.md` §B — discovery advertises
  // `agents.roster.supported`, and a host that does MUST serve this read.
  // REGISTERED HERE, BEFORE `/agents/:agentId`, and that ordering is the fix:
  // Express matches the first registrant, and the roster module registers after
  // this one, so `/agents/roster` used to fall into `:agentId` and answer
  // `404 "agent 'roster' is not installed"` while the capability was advertised —
  // a false claim on the live wire, caught by suite 2.42.3+ once its leg stopped
  // being unfailable. The data comes from the roster's ONE owner.
  app.get(v1('/agents/roster'), async (req, res, next) => {
    try {
      const roster = await listNormativeRoster(tenantForInventory(req));
      res.json({ roster, total: roster.length });
    } catch (err) {
      next(err);
    }
  });
  app.get(v1('/agents/:agentId'), async (req, res) => {
    const tenant = tenantForInventory(req);
    // `resolve()` reads through to durable storage on a registry miss, so a
    // cold instance still serves a seeded/user agent it hasn't hydrated.
    // ADR 0379 P2 — resolveAgentForTenant carries the tenant into the
    // (tenant, agentId)-keyed registry and handles the '*' admin wildcard.
    const a = await resolveAgentForTenant(req.params.agentId, tenant);
    if (!a) {
      // Same 404 for "absent" and "not yours" — never leak that a
      // cross-tenant agent exists by returning a distinct status.
      res.status(404).json({ error: 'not_found', message: `agent '${req.params.agentId}' is not installed on this host` });
      return;
    }
    res.json(toEntry(a));
  });

  // Host-extension aliases (RFC 0070 convenience; non-normative). The list
  // form additionally reports the host's runtime posture for the CLI.
  app.get('/v1/host/openwop-app/agents', async (req, res) => {
    const tenant = tenantForInventory(req);
    const agents = await listVisibleAgents(deps.storage, tenant);
    res.json({ agents, total: agents.length, runtime: { manifestRuntime: true } });
  });
  app.get('/v1/host/openwop-app/agents/:agentId', async (req, res) => {
    const tenant = tenantForInventory(req);
    const a = await resolveAgentForTenant(req.params.agentId, tenant);
    if (!a) {
      res.status(404).json({ error: 'not_found', message: `agent '${req.params.agentId}' is not installed on this host` });
      return;
    }
    res.json(toEntry(a));
  });

  // Dispatch one turn of a manifest agent (RFC 0070 floor). Deterministic by
  // default (replay-safe, conformance-stable); a real model turn when the body
  // sets `live: true` AND the host wired an AI adapter (deps.hostSuite). Live
  // turns default to the managed tier so no BYOK is required.
  app.post('/v1/host/openwop-app/agents/:agentId/dispatch', async (req, res) => {
    // CTI-1 (AGENTRT-2): gate dispatch on the SAME tenant visibility as the GET
    // routes. Without this a caller could INVOKE another tenant's user-authored
    // agent (its private manifest — system prompt, tool allowlist) by id even
    // though the GET-by-id route hides it. Resolve through storage, then 404 on
    // "not yours" with the same message as "absent" so cross-tenant existence is
    // never leaked. Built-in/pack agents (no ownerTenant) stay universally
    // dispatchable; an unresolved id falls through to AgentNotFoundError → 404.
    const dispatchTenant = tenantForInventory(req);
    // ADR 0379 P2 — the tenant-keyed resolve IS the gate: null covers absent
    // AND not-yours with the same 404 below (AgentNotFoundError path).
    const gateAgent = await resolveAgentForTenant(req.params.agentId, dispatchTenant);
    if (!gateAgent) {
      res.status(404).json({ error: 'not_found', message: `agent '${req.params.agentId}' is not installed on this host` });
      return;
    }
    const body = (req.body ?? {}) as Partial<AgentDispatchRequest> & { live?: boolean };
    const reqShape: AgentDispatchRequest = {
      agentId: req.params.agentId,
      // ADR 0379 P2 — the '*' wildcard resolves via the list scan above but a
      // dispatch needs the CONCRETE owner for the tenant-keyed registry get.
      tenantId: dispatchTenant === '*' ? gateAgent.ownerTenant : dispatchTenant,
      task: body.task,
      availableTools: Array.isArray(body.availableTools) ? body.availableTools : undefined,
      confidenceThreshold: typeof body.confidenceThreshold === 'number' ? body.confidenceThreshold : undefined,
      simulateConfidence: typeof body.simulateConfidence === 'number' ? body.simulateConfidence : undefined,
      validateHandoff: body.validateHandoff,
    };
    try {
      if (body.live === true && deps.hostSuite) {
        const tenantId = (req as AgentReqLike).tenantId ?? 'default';
        // Ad-hoc dispatch (not a persisted run): a synthetic scope, empty BYOK
        // secrets, no event-log emit. The managed tier needs none of these; a
        // pinned BYOK provider would fail byok_required (returned as a failed
        // turn), which is the honest outcome without a per-run vault.
        // RCL-3(b) — mint the dispatch id ONCE and share it between the provider
        // adapter and the borrowed-recall ctx below, so the twin.recall audit row
        // can correlate this (runless) dispatch instead of carrying no ref at all.
        const dispatchRunId = `agent-dispatch:${randomUUID()}`;
        const adapter = createAiProvidersAdapter({
          runId: dispatchRunId,
          nodeId: 'agent.dispatch',
          tenantId,
          attempt: 1,
          secrets: {},
          policyResolver: deps.hostSuite.providerPolicyResolver,
        });
        // A2 — wire the host's built-in tool catalog + executor so a tool-using
        // turn runs end-to-end. The host offers its built-in tool ids this turn
        // (intersected with the agent's toolAllowlist inside dispatch, §A14);
        // the caller MAY still pin a narrower `availableTools`.
        // ADR 0277 P2 — normalize once: the profile id scopes the knowledge
        // tools; the memory scope + knowledge composition key off it too.
        const dispatchIdentity = await resolveAgentIdentity(tenantId, reqShape.agentId, { allowReverseScan: true });
        const toolProvider = createAgentToolProvider({ tenantId, runId: reqShape.agentId, agentProfileId: dispatchIdentity.profileId });
        const memory = createAgentMemoryPort(tenantId);
        const memoryScope = agentMemoryScope(dispatchIdentity.profileId);
        // ADR 0038 Phase 3 — compose the agent's BOUND knowledge (cited KB docs +
        // private memory) into the turn, from host-owned primitives. `undefined`
        // (no `knowledge` capability / no binding) ⇒ dispatch is unchanged.
        // ADR 0442 P3 — this ad-hoc/runless dispatch has no acting participant, so
        // a default-scope agent recalls `agent:<profileId>` (unchanged) and a
        // `per-user` agent fails closed (chat is its surface, not this path).
        // ADR 0664 D6 — re-resolve the READER. ADR 0643 R3 left `PREAUTHORIZED_CALLER` on
        // lanes where no principal exists, and re-resolves "wherever a principal exists";
        // this lane HAS one (`req.userId`, used for the borrowed-recall gate 17 lines
        // below), so it belongs in the second group and was simply missed — it lives on a
        // different router than the four `agent-knowledge/routes.ts` reads that do it.
        // `actor` stays undefined: the per-user memory-scope posture above is unchanged.
        const knowledgeRetrieve = await resolveAgentKnowledgeRetrieve(
          tenantId, dispatchIdentity.profileId, memory, undefined,
          req.userId ? { subject: req.userId } : undefined,
        );
        // ADR 0044 Phase 2 — when this agent is a granted twin, compose its OWNER's
        // corpus (live grant gate via the host seam the `twin` feature fills). The
        // result is fenced STRUCTURALLY by dispatch (`borrowedRetrieve` → untrusted
        // block). Absent / not-granted / toggle-off ⇒ undefined ⇒ no cross read.
        const borrowedResolver = getBorrowedRecallResolver();
        // WF-TWIN-5 — the RESOLVED profile id, not the raw URL id. The resolver
        // keys on the ROSTER id (`getTwinLink` → `getRosterEntry`), and
        // `resolveAgentIdentity` returns `profileId = entry.rosterId ≠ id` on its
        // reverse-lookup branch — so a registry-id dispatch of a granted twin
        // silently recalled nothing. Every adjacent consumer on THIS lane already
        // uses `dispatchIdentity.profileId` (`:313`, `:315`, `:322`), and the other
        // two lanes pass the resolved id and say why in a comment
        // (`agentRunnerNode.ts:161-162`, `chatContext.ts:243-244`). This was the
        // odd one out. Fail-closed (capability loss, not leakage).
        // ADR 0589 §D2 — the acting human on this lane is the session's own user.
        // ADR 0666 D5 — its OWN catch, degrading rather than 500-ing.
        //
        // This await used to sit bare inside the route-wide `try`, whose catch returns a 500 —
        // so a transient consent-store read failure killed the whole request on this lane
        // while the other two degraded and told the model (`host/agentRunnerNode.ts` resolves a
        // fault sentinel; `host/chatContext.ts` pushes a degradation label). Three lanes, three
        // behaviours, for one fault.
        //
        // Deliberately a dedicated catch: moving the await elsewhere inside the route `try` is a
        // no-op, because that catch also fails the request — the same reasoning
        // `agentRunnerNode.ts` records where it made the identical fix for the run lane.
        let borrowedSource: Awaited<ReturnType<NonNullable<typeof borrowedResolver>>>;
        try {
          borrowedSource = borrowedResolver
            ? await borrowedResolver(tenantId, dispatchIdentity.profileId, {
                ...(req.userId ? { callerUserId: req.userId } : {}),
                // RCL-3(b) — the minted ad-hoc dispatch id (shared with the
                // adapter above) so the audit row carries a correlatable ref.
                // No `dispatchId` (F1): this runId is minted per dispatch, so it
                // already IS the dispatch identity — one dispatch, one row.
                runId: dispatchRunId,
              })
            : undefined;
        } catch (err) {
          log.warn('twin_recall_resolve_failed_degrading', {
            tenantId, agentId: dispatchIdentity.profileId, runId: dispatchRunId,
            error: err instanceof Error ? err.message : String(err),
          });
          // The fault SENTINEL, not `undefined`: a faulted authorization read must not present
          // as "not granted". The model is told the owner corpus could not be READ, and the
          // answer still happens. Fail-closed on content — no chunks.
          borrowedSource = { retrieve: async (_q, onSourceError) => { onSourceError?.('kb'); return []; }, ownerUserId: '' };
        }
        const borrowedRetrieve = borrowedSource?.retrieve;
        // ADR 0099 §residuals — this dispatch is RUNLESS (no run.metadata to read),
        // so resolve the compaction decision here via the SAME core run-start seam
        // (no feature import, no new seam) and pass it in. Toggle off ⇒ undefined ⇒
        // identity. Per-agent lossy only matches when the manifest agentId is also a
        // profile (roster) id; otherwise the tenant lossless default applies.
        // Cost: one toggle resolution per LIVE dispatch — negligible beside the
        // model round-trip this path is about to make.
        const compactionMeta = await stampRunStartContext({}, { tenantId, agentId: reqShape.agentId });
        const compaction = readCompactionDecision(compactionMeta);
        // CFP Phase-2 review HIGH-1 — this ad-hoc live-dispatch lane runs the SAME
        // real tool executor as chat/runs, so it takes the SAME ADR 0150 gate:
        // without it, an agent pack that allowlists a sensitive tool (code-exec,
        // files.write, http.fetch) executes it with no approval. Mirrors
        // agentRunnerNode's hook; an escalated result surfaces in the response.
        const [fwRules, fwUnknownPolicy, fwMode, fwDefaultDenyVerdict, fwPlatformRules] = await Promise.all([
          getCapabilityRules(tenantId),
          getUnknownToolPolicy(tenantId),
          getFirewallMode(tenantId),
          getDefaultDenyVerdict(tenantId),
          getPlatformRules(),
        ]);
        const firewall = buildFirewallHook({
          rules: fwRules,
          unknownToolPolicy: fwUnknownPolicy,
          requireApprovalTools: SENSITIVE_APPROVAL_TOOLS,
          bypassApproval: false,
          mode: fwMode,
          defaultDenyVerdict: fwDefaultDenyVerdict,
          platformRules: fwPlatformRules,
        });
        const result = await runAgentDispatchLive(
          {
            ...reqShape,
            availableTools: reqShape.availableTools ?? [...builtinAgentToolIds()],
            ...(compaction ? { compaction } : {}),
          },
          {
            callAI: adapter.callAI,
            callAIWithTools: adapter.callAIWithTools,
            resolveTool: toolProvider.resolveTool,
            executeTool: toolProvider.executeTool,
            // ADR 0102 — lets the tool loop resolve this standing agent's tool
            // permissions for the per-tool gate (shadow-logged until enabled).
            tenantId,
            // A4 — cross-run agent memory (RFC 0004). Injected unconditionally;
            // dispatch's `memoryEnabled` gate only reads/writes when the agent's
            // manifest declares `memoryShape.longTerm`, so agents without it are
            // unaffected. tenant-bound for CTI-1; per-agent namespace.
            memory,
            memoryScope,
            ...(knowledgeRetrieve ? { knowledgeRetrieve } : {}),
            ...(borrowedRetrieve ? { borrowedRetrieve } : {}),
            // RCL-6 — the owner's name labels the fenced borrowed block.
            ...(borrowedSource?.ownerName ? { borrowedOwnerName: borrowedSource.ownerName } : {}),
            firewall,
          },
        );
        res.status(200).json(result);
        return;
      }
      res.status(200).json(runAgentDispatch(reqShape));
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        res.status(404).json({ error: 'agent_not_found', message: err.message });
        return;
      }
      // API-1 / DATA-6: this inline error path bypasses the central
      // errorEnvelope sanitizer, so log the raw error server-side for triage
      // and return a credential-scrubbed message — a dispatch-internal
      // err.message must not become a secret-leak channel in the response body.
      const raw = err instanceof Error ? err.message : String(err);
      log.error('agent_dispatch_error', { error: raw });
      res.status(500).json({ error: 'dispatch_error', message: sanitizeForErrorMessage(raw) });
    }
  });

  // A8 — agent-eval grader seam (RFC 0081). Scores a batch of agent results
  // against typed criteria (golden/rubric/schema) via the deterministic
  // `gradeSuite` grader and returns the content-free `EvalSummary` (scalars +
  // per-task scores, NO result text — the `eval-summary-no-content-leak`
  // posture). Gated on `evalSuiteEnabled()`: a host that does not advertise
  // `agents.evalSuite` MUST NOT serve it, so we 404 when disabled (mirrors the
  // sandbox-MVP seam's gating in testSeam.ts). The request supplies parallel
  // `tasks[]` / `results[]` arrays — the runner produces the results, the host
  // grades them; the grader never makes a model call (replay-safe).
  app.post('/v1/host/openwop-app/agents/eval-run', (req, res) => {
    if (!evalSuiteEnabled()) {
      res.status(404).json({ error: 'not_found', message: 'agent eval suite disabled (set OPENWOP_AGENT_EVAL_SUITE_ENABLED=true)' });
      return;
    }
    const body = (req.body ?? {}) as { tasks?: unknown; results?: unknown };
    if (!Array.isArray(body.tasks) || !Array.isArray(body.results)) {
      res.status(400).json({ error: 'validation_error', message: 'tasks[] and results[] arrays are required' });
      return;
    }
    if (body.tasks.length !== body.results.length) {
      res.status(400).json({ error: 'validation_error', message: `tasks/results length mismatch (${body.tasks.length} vs ${body.results.length})` });
      return;
    }
    // Structural check of each task: a string taskId and a criterion with a
    // known `kind`. The grader is defensive about criterion internals (an
    // unknown kind scores 0), but a malformed envelope is a client error.
    for (const [i, t] of body.tasks.entries()) {
      const task = t as Partial<EvalTask>;
      if (typeof task?.taskId !== 'string' || !task.criterion || typeof (task.criterion as { kind?: unknown }).kind !== 'string') {
        res.status(400).json({ error: 'validation_error', message: `tasks[${i}] must have a string taskId and a criterion with a kind` });
        return;
      }
    }
    const summary = gradeSuite(body.tasks as EvalTask[], body.results);
    res.status(200).json(summary);
  });

  // RFC 0091 §A/§B — multimodal perception input on `callAI`. This seam exposes
  // the host's modality gate (`assertModalitiesAdvertised`, the SAME guard the
  // live `callAI` runs before dispatch) so the `callai-multimodal` behavioral
  // conformance scenario can prove it non-vacuously: a ContentPart whose modality
  // is advertised (`aiProviders.input.modalities`) is accepted; an unadvertised
  // one is rejected with `unsupported_modality` BEFORE any provider dispatch
  // (never silently dropped). Deterministic + replay-safe — the guard is pure, so
  // the seam needs no model call to prove the contract. A `string` content stays
  // valid forever (back-compat).
  const aiCallText = (messages: AiCallRequest['messages']): string => {
    const out: string[] = [];
    for (const m of messages) {
      if (typeof m.content === 'string') { out.push(m.content); continue; }
      for (const p of m.content) if (p.type === 'text') out.push(p.text);
    }
    return out.join('\n') || 'probe';
  };
  const aiCallSeam = async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as { messages?: unknown; provider?: unknown; model?: unknown };
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ error: 'validation_error', message: 'messages[] (non-empty) is required' });
      return;
    }
    const provider = typeof body.provider === 'string' ? body.provider : 'anthropic';
    const model = typeof body.model === 'string' ? body.model : 'managed-default';
    const callReq = { provider, model, messages: body.messages as AiCallRequest['messages'] } as AiCallRequest;
    try {
      assertModalitiesAdvertised(callReq);
    } catch (err) {
      if (err instanceof AiProviderError && err.code === 'unsupported_modality') {
        sendError(res, 400, 'unsupported_modality', err.message, err.details);
        return;
      }
      sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
      return;
    }
    // RFC 0108 / ADR 0121 — a dispatch against the advertised `compat` self-hosted
    // class MUST reach a real endpoint (succeed OR transport-error), never a
    // capability/provider-not-* error (§A.2). Routes to the configured
    // OPENWOP_TEST_COMPAT_ENDPOINT; the URL is never echoed (§D — the dispatcher
    // scrubs it from any error → `compat_transport_error`).
    if (provider === COMPAT_PROVIDER_ID || provider.startsWith(`${COMPAT_PROVIDER_ID}:`)) {
      const baseUrl = getHostTestCompatEndpoint();
      if (!baseUrl) {
        sendError(res, 502, 'compat_transport_error', 'compat_transport_error');
        return;
      }
      const messages: ChatMessage[] = [{ role: 'user', content: aiCallText(callReq.messages) }];
      try {
        const r = await dispatchChat({ provider: 'compat', model, apiKey: '', baseUrl, messages });
        res.status(200).json({ ok: true, accepted: true, provider: 'compat', completion: r.completion });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e); // §D-scrubbed
        sendError(res, 502, 'compat_transport_error', message);
      }
      return;
    }
    // Default (RFC 0091 §A modality gate): report the distinct modalities seen.
    const seen = new Set<string>();
    for (const m of callReq.messages) {
      if (typeof m.content === 'string') { seen.add('text'); continue; }
      for (const part of m.content) seen.add(part.type === 'file' ? 'document' : part.type);
    }
    res.status(200).json({ ok: true, accepted: true, advertised: INPUT_MODALITIES, modalities: [...seen] });
  };
  app.post('/v1/host/openwop-app/ai/call', aiCallSeam);
  app.post('/v1/host/sample/ai/call', aiCallSeam);

  // RFC 0121 §B.8 — the subscription-scope safety-rail bind seam. The
  // `aiproviders-subscription-scope` conformance scenario POSTs { provider, mode,
  // scope } and asserts a `subscription`-mode credential binding is REJECTED at
  // tenant/workspace scope with the canonical `credential_scope_forbidden` code
  // (the `subscription-credential-user-scope-only` invariant), and permitted only
  // at `user` scope. The scenario soft-skips on 404, so the route is really wired.
  //
  // ADR 0180 (AT-OWN-RISK un-park) extends the ADR 0179 rail: a user-scope bind
  // that carries a credential `value` is an ACQUISITION and REQUIRES explicit
  // consent (`acknowledgedRisk:true`) naming the ToS/account-suspension risk; on
  // consent the value is stored at USER scope (never echoed). A user-scope bind
  // with NO value stays the acquisition-free scope-rail probe (the conformance
  // witness) → 200 { bound, scope }. §B.8 is UNCONDITIONAL: tenant/workspace →
  // `credential_scope_forbidden`/403 regardless of consent. Registered under BOTH
  // the app-canonical prefix and the spec-canonical `/v1/host/sample/*` path.
  const credentialsBindSeam = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as { provider?: unknown; mode?: unknown; scope?: unknown; acknowledgedRisk?: unknown; value?: unknown };
      if (typeof body.provider !== 'string' || body.provider.trim().length === 0) {
        res.status(400).json({ error: 'validation_error', message: '`provider` (non-empty string) is required.' });
        return;
      }
      if (typeof body.mode !== 'string' || typeof body.scope !== 'string') {
        res.status(400).json({ error: 'validation_error', message: 'Fields `mode` and `scope` (strings) are required.' });
        return;
      }
      // This seam is subscription-scope-only for now (the safety-rail witness);
      // any other mode is not acquirable here.
      if (body.mode !== 'subscription') {
        res.status(400).json({ error: 'validation_error', message: 'This seam only binds `mode: "subscription"` (RFC 0121 §B.8 scope rail).' });
        return;
      }
      // §B.8 UNCONDITIONAL (checked BEFORE consent): a tenant/workspace scope
      // throws credential_scope_forbidden/403 → canonical envelope via next(err).
      assertSubscriptionScopeAllowed(body.scope);
      // scope === 'user' from here.
      const value = typeof body.value === 'string' ? body.value : '';
      if (value.length === 0) {
        // Acquisition-free scope-rail probe (the conformance witness): resolves NO
        // credential, stores NOTHING, echoes NO secret. Unchanged from the rail.
        res.status(200).json({ bound: true, scope: 'user' });
        return;
      }
      // ADR 0756 — a provider whose terms PROHIBIT third-party routing through its
      // consumer plans is never stored, consent or not. Checked before consent so
      // no acknowledgement can override it; the empty-value probe above stays
      // provider-agnostic because it stores nothing.
      assertSubscriptionProviderPermitted(body.provider);
      // ADR 0757 — a CLEARED provider's credential comes ONLY from its OAuth
      // connect flow (least scope is guaranteed by our registration); a pasted
      // token of unknown scope is refused.
      if (CLEARED_SUBSCRIPTION_PROVIDERS.has(body.provider)) {
        res.status(400).json({
          error: 'validation_error',
          message: `'${body.provider}' is connected through its sign-in flow, not a pasted token (POST /host/openwop-app/subscription/${body.provider}/authorize).`,
        });
        return;
      }
      // A credential IS supplied → an AT-OWN-RISK acquisition (ADR 0180). REQUIRE
      // explicit consent naming the ToS/account-suspension risk.
      if (body.acknowledgedRisk !== true) {
        res.status(400).json({
          error: 'validation_error',
          message: 'Binding a subscription credential requires acknowledgedRisk:true — reusing your personal subscription may violate the provider’s terms of service and risk account suspension (RFC 0121 at-own-risk).',
        });
        return;
      }
      // UNPARK-1 — a credential-STORING path MUST fail closed. Store "at USER scope"
      // is meaningless without an authenticated principal to own it: an anon/`default`
      // bind would silently share one credential across every unauthenticated caller
      // of the tenant (the very cross-user sharing §B.8 exists to prevent). Require a
      // resolved principal BEFORE writing. (The empty-value witness probe above stores
      // NOTHING, so it stays reachable unauthenticated for the conformance scenario.)
      const actorId = req.principal?.principalId;
      if (!actorId) {
        res.status(401).json({
          error: 'unauthenticated',
          message: 'Binding a subscription credential requires an authenticated principal to own it at user scope (RFC 0121 §B.8).',
        });
        return;
      }
      // Store at USER scope = the caller's OWN personal tenant (`user:<hash>`), NEVER
      // `req.tenantId`. Per ADR 0015 `req.tenantId` is the ACTIVE workspace and may be a
      // shared `ws:<uuid>`; writing a personal subscription there shares one member's
      // token across the whole workspace — the cross-user sharing §B.8 forbids. Fail
      // closed unless the personal tenant is a durable `user:`-scoped account. NEVER
      // echo the secret — return only the ref NAME + scope.
      const tenantId = personalTenantOf(req);
      assertSubscriptionStorageTenant(tenantId);
      const { credentialRef } = await storeSubscriptionCredential({
        provider: body.provider,
        value,
        scope: { tenantId, actorId },
      });
      res.status(200).json({ bound: true, scope: 'user', credentialRef });
    } catch (err) {
      next(err);
    }
  };
  app.post('/v1/host/openwop-app/credentials/bind', credentialsBindSeam);
  app.post('/v1/host/sample/credentials/bind', credentialsBindSeam);

  // ADR 0757 — GitHub Copilot connect (RFC 0121 cleared provider). POST returns
  // the consent URL for the SPA to navigate to; the callback is the fixed
  // redirect URI registered with the GitHub OAuth App. Host-internal routes: no
  // wire label names the mechanism (RFC 0121 gap G2).
  app.post(vendorTwin(`/subscription/${COPILOT_PROVIDER_ID}/authorize`), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as { returnTo?: unknown };
      const { authorizeUrl } = await beginCopilotAuthorization({
        principalId: req.principal?.principalId,
        personalTenant: personalTenantOf(req),
        reqOrigin: `${req.protocol}://${req.get('host') ?? 'localhost'}`,
        returnTo: body.returnTo,
      });
      res.status(200).json({ authorizeUrl });
    } catch (err) {
      next(err);
    }
  });
  app.get(COPILOT_CALLBACK_ROUTE, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const reqOrigin = `${req.protocol}://${req.get('host') ?? 'localhost'}`;
      const outcome = await completeCopilotAuthorization({
        state: req.query['state'],
        code: req.query['code'],
        error: req.query['error'],
        principalId: req.principal?.principalId,
        personalTenant: personalTenantOf(req),
        reqOrigin,
      });
      res.redirect(302, copilotReturnUrl(reqOrigin, outcome));
    } catch (err) {
      next(err);
    }
  });
  app.post(vendorTwin(`/subscription/${COPILOT_PROVIDER_ID}/disconnect`), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenantId = personalTenantOf(req);
      assertSubscriptionStorageTenant(tenantId);
      await removeSecret(subscriptionCredentialRef(COPILOT_PROVIDER_ID), { tenantId, ...(req.principal?.principalId ? { actorId: req.principal.principalId } : {}) });
      res.status(200).json({ disconnected: true });
    } catch (err) {
      next(err);
    }
  });

  // RFC 0105 §A/§C — speech-synthesis conformance seam. The published
  // `speech-synthesis-roundtrip` scenario POSTs the LOCKED envelope
  // ({ text, voiceId }) and expects { audio: { url XOR base64, mimeType,
  // voiceId (echoed), ... }, ... }. This thin seam calls the SAME
  // `ctx.callSpeechSynthesizer` adapter the product route uses, over an
  // ad-hoc managed scope (no persisted run, empty BYOK secrets — the managed
  // MiniMax tier needs none), so the scenario proves the contract
  // non-vacuously. Registered under BOTH the app-canonical prefix and the
  // spec-canonical `/v1/host/sample/ai/*` the vendored suite drives.
  const callSpeechSynthesizerSeam = async (req: Request, res: Response): Promise<void> => {
    if (!deps.hostSuite) {
      res.status(404).json({ error: 'not_found', message: 'aiProviders adapter not wired' });
      return;
    }
    const body = (req.body ?? {}) as { text?: unknown; voiceId?: unknown; stream?: unknown };
    const text = typeof body.text === 'string' ? body.text : '';
    const voiceId = typeof body.voiceId === 'string' ? body.voiceId : '';
    if (text.length === 0) {
      sendError(res, 400, 'invalid_request', 'text (non-empty string) required');
      return;
    }
    if (voiceId.length === 0) {
      sendError(res, 400, 'invalid_request', 'voiceId (non-empty string) required');
      return;
    }
    // RFC 0106 §C streaming arm (ADR 0109 P3): collect the `voice.synthesis_chunk`
    // metadata-only run-events so the gated `voice-synthesis-streaming` scenario can
    // assert them non-vacuously. Only attached to the response when stream:true, so
    // the RFC 0105 speech-synthesis-roundtrip (no stream) is byte-for-byte unchanged.
    const wantStream = body.stream === true;
    const events: Array<{ type: string; payload: unknown }> = [];
    let seq = 0;
    const tenantId = (req as AgentReqLike).tenantId ?? 'default';
    const adapter = createAiProvidersAdapter({
      runId: `speech-seam:${randomUUID()}`,
      nodeId: 'ai.call-speech-synthesizer',
      tenantId,
      attempt: 1,
      secrets: {},
      policyResolver: deps.hostSuite.providerPolicyResolver,
      ...(wantStream ? { emit: async (type: string, payload: unknown) => { seq += 1; events.push({ type, payload }); return { eventId: `speech-seam-evt-${seq}`, sequence: seq }; } } : {}),
    });
    try {
      // In the conformance harness (test seam ON, no managed MiniMax key) route
      // to the deterministic `mock` TTS path so the roundtrip runs non-vacuously;
      // prod (test seam OFF) routes to the real managed MiniMax provider.
      const useMockTts = process.env.OPENWOP_TEST_SEAM_ENABLED === 'true';
      const result = await adapter.callSpeechSynthesizer({ text, voiceId, ...(wantStream ? { stream: true } : {}), ...(useMockTts ? { provider: 'mock' as const } : {}) });
      res.status(200).json(wantStream ? { ...result, events } : result);
    } catch (err) {
      if (err instanceof AiProviderError) {
        // ADR 0106 — a budget/quota exhaustion is a 429 (retry after the daily
        // reset), NOT a 502 (which would falsely read as a provider outage).
        if (err.code === 'media_budget_exceeded') {
          sendError(res, 429, err.code, err.message, err.details);
          return;
        }
        const clientError = err.code === 'invalid_request' || err.code === 'content_too_long' || err.code === 'speech_synthesis_unsupported';
        sendError(res, clientError ? 400 : 502, err.code, err.message, err.details);
        return;
      }
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  };
  app.post('/v1/host/openwop-app/ai/call-speech-synthesizer', callSpeechSynthesizerSeam);
  app.post('/v1/host/sample/ai/call-speech-synthesizer', callSpeechSynthesizerSeam);

  // RFC 0106 §B (ADR 0109 P1) — the `ctx.callTranscriber` test seam. Exercises
  // the same per-node adapter `ctx.callTranscriber` uses, with a COLLECTING
  // `emit` so the behavioral conformance can assert the canonical `voice.*`
  // taxonomy + `contentTrust:'untrusted'` non-vacuously. Registered under both
  // the app-canonical prefix and the spec-canonical `/v1/host/sample/ai/*`.
  const callTranscriberSeam = async (req: Request, res: Response): Promise<void> => {
    if (!deps.hostSuite) {
      res.status(404).json({ error: 'not_found', message: 'aiProviders adapter not wired' });
      return;
    }
    const body = (req.body ?? {}) as { audio?: { streamRef?: unknown; url?: unknown }; languageCode?: unknown };
    const streamRef = typeof body.audio?.streamRef === 'string' ? body.audio.streamRef : '';
    const url = typeof body.audio?.url === 'string' ? body.audio.url : '';
    if (streamRef.length === 0 && url.length === 0) {
      sendError(res, 400, 'invalid_request', 'audio.streamRef OR audio.url (non-empty string) required');
      return;
    }
    const tenantId = (req as AgentReqLike).tenantId ?? 'default';
    const events: Array<{ type: string; payload: unknown }> = [];
    let seq = 0;
    const adapter = createAiProvidersAdapter({
      runId: `transcriber-seam:${randomUUID()}`,
      nodeId: 'ai.call-transcriber',
      tenantId,
      attempt: 1,
      secrets: {},
      policyResolver: deps.hostSuite.providerPolicyResolver,
      emit: async (type, payload) => {
        seq += 1;
        events.push({ type, payload });
        return { eventId: `transcriber-seam-evt-${seq}`, sequence: seq };
      },
    });
    try {
      const useMock = process.env.OPENWOP_TEST_SEAM_ENABLED === 'true';
      const audio = streamRef.length > 0 ? { streamRef } : { url };
      const result = await adapter.callTranscriber({
        audio,
        ...(typeof body.languageCode === 'string' ? { languageCode: body.languageCode } : {}),
        ...(useMock ? { provider: 'mock' as const } : {}),
      });
      // RFC 0106 §B: the seam response IS the settled TranscriptResult
      // (`finalText`/`atMs`/`language`) at the TOP LEVEL, with the durable
      // `voice.*` run-events alongside as `events` — the shape the gated
      // `voice-transcription-streaming` / `voice-streamref-tenant-bound`
      // conformance scenarios read (`res.json.finalText`, `res.json.events`).
      res.status(200).json({ ...result, events });
    } catch (err) {
      if (err instanceof AiProviderError) {
        const clientError = err.code === 'invalid_request' || err.code === 'transcription_unsupported';
        sendError(res, clientError ? 400 : 502, err.code, err.message, err.details);
        return;
      }
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  };
  app.post('/v1/host/openwop-app/ai/call-transcriber', callTranscriberSeam);
  app.post('/v1/host/sample/ai/call-transcriber', callTranscriberSeam);

  // RFC 0106 §D/§F (ADR 0109 P4) — the barge-in / cancellation seam. A live mic
  // SESSION is host-internal per RFC 0106 §E, but the WIRE CONTRACT the
  // `realtimeVoice.bargeIn` capability promises is demonstrable deterministically:
  // assistant playback (voice.synthesis_chunk) → user speech overlaps → the host
  // emits `voice.barge_in`, CANCELS the in-flight synthesis (stops emitting chunks),
  // and emits `voice.cancelled` — with NO `voice.synthesis_chunk` after the cancel.
  // That is the §F `voice-bargein-no-partial-leak` invariant, shown non-vacuously
  // (the dropped chunks are halted, never leaked). The same lifecycle is what the
  // mic-on-chat session (P5) emits over a real stream. No secrets, no tenant data,
  // no side effects — a pure scripted demonstration of the cancellation semantics.
  const voiceBargeInSeam = (req: Request, res: Response): void => {
    const body = (req.body ?? {}) as { chunks?: unknown; bargeInAtSeq?: unknown };
    const totalChunks = typeof body.chunks === 'number' && body.chunks > 0 ? Math.min(Math.floor(body.chunks), 16) : 4;
    const bargeAt = typeof body.bargeInAtSeq === 'number' && body.bargeInAtSeq >= 0 ? Math.min(Math.floor(body.bargeInAtSeq), totalChunks - 1) : 1;
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const emit = (type: string, payload: Record<string, unknown>): void => { events.push({ type, payload }); };

    // Assistant playback up to (and including) the moment the user cuts in.
    for (let seq = 0; seq <= bargeAt; seq += 1) {
      emit('voice.synthesis_chunk', { seq, mimeType: 'audio/mpeg', durationMs: 240, url: `https://host/v1/host/openwop-app/assets/turn-chunk-${seq}` });
    }
    // User speech overlaps playback → probable barge-in.
    emit('voice.barge_in', { atMs: 1000 + bargeAt * 240 });
    // The host CANCELS the in-flight synthesis: chunks bargeAt+1..totalChunks-1 are
    // halted (NOT emitted, NOT leaked) → cancelled. No partial output crosses the wire.
    emit('voice.cancelled', { atMs: 1010 + bargeAt * 240, reason: 'barge_in' });

    res.status(200).json({ events, droppedChunks: totalChunks - 1 - bargeAt });
  };
  app.post('/v1/host/openwop-app/voice/barge-in', voiceBargeInSeam);
  app.post('/v1/host/sample/voice/barge-in', voiceBargeInSeam);

  // RFC 0090 §B — verifier turn + gating. This seam runs the host's real RFC 0090
  // commit gate (host/agentDispatch.ts runVerifier, verifierGating) over a
  // deterministic candidate result with a caller-simulated verdict, so the
  // `verifier-gating` behavioral conformance scenario can prove it non-vacuously:
  //   - a `pass` verdict commits  → status 'completed' (committed)
  //   - a `fail` (or `revise`) verdict on a gating host BLOCKS the commit
  //     → status NOT 'completed' (withheld), and `agent.verified` is emitted
  //       content-free either way (the verifier-no-content-leak invariant).
  // Gated on OPENWOP_AGENT_VERIFIER_GATING (mirrors the discovery advertisement
  // of multiAgent.executionModel.verifier{supported,gating} + version 6) — 404
  // when the host does not advertise the verifier, so the scenario soft-skips.
  app.post('/v1/host/openwop-app/agents/verify-run', async (req, res) => {
    if (process.env.OPENWOP_AGENT_VERIFIER_GATING !== 'true') {
      res.status(404).json({ error: 'not_found', message: 'verifier gating disabled (set OPENWOP_AGENT_VERIFIER_GATING=true)' });
      return;
    }
    const body = (req.body ?? {}) as { simulateVerdict?: unknown; task?: unknown };
    const verdict: 'pass' | 'fail' | 'revise' =
      body.simulateVerdict === 'fail' ? 'fail' : body.simulateVerdict === 'revise' ? 'revise' : 'pass';
    // A dedicated harness agent so the gate runs over a real dispatch without a
    // model call (deterministic, replay-safe). Registered idempotently here so it
    // exists only on a verifier-gating host.
    ensureVerifyHarnessAgent();
    const deterministicCallAI: CallAi = async () => ({ content: 'candidate result' });
    const result = await runAgentDispatchLive(
      { agentId: VERIFY_HARNESS_AGENT_ID, task: typeof body.task === 'string' ? body.task : 'verify this', validateHandoff: false },
      { callAI: deterministicCallAI, verifier: async () => ({ verdict }), verifierGating: true },
    );
    const committed = result.status === 'completed';
    res.status(200).json({
      status: result.status,
      committed,
      outcome: committed ? 'committed' : 'withheld',
      verdict,
      // Content-free agent.verified events only (verifier-no-content-leak).
      events: result.events.filter((e) => e.type === 'agent.verified'),
    });
  });

  // A7 / RFC 0076 §A — live A2A (Agent-to-Agent) SERVER endpoint. Turns the host
  // from "A2A client only / server stubs" into one that answers as an A2A agent:
  // a peer can `agent/getCard` to discover it and `message/send` a task, routed
  // to a real manifest-agent dispatch (handleA2aRequest → runAgentDispatch). The
  // served card is the tenant's PUBLISHED card (ctx.a2a.publishAgentCard), falling
  // back to a registry-synthesized card so a tenant that hasn't published one
  // still discovers a real agent surface (not a dead stub). Env-gated
  // (OPENWOP_A2A_SERVER_ENABLED, mirrors the MCP-server seam + the honest
  // host.a2a advertisement flip); 404 when off. JSON-RPC `agent/getCard` AND a
  // GET-able static card at `/.well-known/agent-card.json` (below) both serve
  // the v0.3 AgentCard.
  app.post('/v1/host/openwop-app/a2a', (req, res) => {
    if (process.env.OPENWOP_A2A_SERVER_ENABLED !== 'true') {
      res.status(404).json({ error: 'not_found', message: 'a2a server endpoint disabled (set OPENWOP_A2A_SERVER_ENABLED=true)' });
      return;
    }
    void handleA2aPost(req, res);
  });

  /** ADR 0552 P2 — one route, TWO codecs, chosen by the `A2A-Version` header. */
  const handleA2aPost = async (req: Request, res: Response): Promise<void> => {
    // RFC 0152 §B / ADR 0552 P1 — version negotiation, BEFORE any dispatch.
    // "A host MUST NOT silently downgrade an authenticated request." A peer that
    // explicitly asks for a version this host does not serve is refused here; it
    // does not get 0.3 semantics under a 1.0 request and no notice that the
    // contract it asked for was not the one it received.
    //
    // A request with NO header is a 0.3-era peer (§B places the send obligation
    // on the 1.0 sender) and is served unchanged — see
    // `dispositionForA2AVersionHeader`.
    //
    // Refusal rides the JSON-RPC error body, not an HTTP status, because that is
    // this endpoint's contract for every other request error (the transport is
    // always 200 here). The `supportedVersions` ErrorInfo metadata is what makes the refusal
    // actionable rather than merely negative — the peer learns what to retry with.
    const version = dispositionForA2AVersionHeader(req.headers[A2A_VERSION_HEADER]);
    // ADR 0556 P1 — the negotiation disposition, NOT the requested version: a
    // peer picks that string, so labelling with it hands an unbounded dimension
    // to anyone who can reach this route. `absent` is a real signal here rather
    // than a gap — RFC 0152 §B says a 0.3-era peer sends no header, so the
    // absent count IS the pre-1.0 population an operator needs before dropping
    // the compatibility path.
    // ADR 0552 P4 (2026-08-18) — plus the profile this host SERVED, derived from
    // the same disposition (`codecVersionFor`: `absent` IS a 0.3 request per §B's
    // receiver rule, `unsupported` serves nothing). Without it the disposition
    // alone cannot answer the only question the 2027-03-12 retirement asks —
    // "is anyone still on 0.3?" — because `absent` and `served` both span both
    // profiles. It is a closed two-value set here, not peer-supplied, so it adds
    // no unbounded dimension.
    const servedVersion = codecVersionFor(version);
    recordProtocolVersion(
      'a2a',
      version.kind,
      servedVersion === null ? 'none' : (a2aProfileIdFor(servedVersion) as ServedProfile),
    );
    if (version.kind === 'unsupported') {
      // The §B audit event, deliberately CONTENT-FREE: the requested version and
      // the outcome, never the request body. A negotiation failure is not a
      // reason to log a peer's payload.
      log.warn('a2a_version_refused', { requested: version.requested, served: [...A2A_SUPPORTED_VERSIONS] });
      res.status(200).json({
        jsonrpc: '2.0',
        id: (req.body as { id?: string | number } | undefined)?.id ?? 0,
        // ADR 0744 — `VersionNotSupportedError` (-32009, A2A 1.0.1 §3.3.2 /
        // `a2a-integration.md` §B), not the generic -32600 this answered
        // before. `data` is the §9.5 `Any[]`; `ErrorInfo.metadata` is
        // `map<string,string>`, so the list travels comma-joined (openwop
        // TODO.md decision D1) and a client falls back to the card's
        // `supportedInterfaces[].protocolVersion` when it is absent.
        error: {
          code: A2A_10_ERROR.VERSION_NOT_SUPPORTED.code,
          message: `unsupported A2A protocol version: ${version.requested}`,
          data: errorData10(A2A_10_ERROR.VERSION_NOT_SUPPORTED.reason, {
            supportedVersions: A2A_SUPPORTED_VERSIONS.join(','),
          }),
        },
      });
      return;
    }
    const tenantId = (req as AgentReqLike).tenantId ?? 'default';
    const codecVersion = codecVersionFor(version);
    try {
      // ADR 0552 P2 — the codec split. `codecVersionFor` resolves an absent
      // header to 0.3 (the upstream receiver rule), so a legacy peer keeps
      // reaching the legacy codec byte-for-byte, and only an explicit
      // `A2A-Version: 1.0` reaches the new one.
      if (codecVersion === '1.0') {
        const rpc10 = await handleA2aRequest10(req.body as A2aJsonRpcRequest, {
          agentCard: buildA2aCard10(requestOrigin(req)),
          principal: {
            tenantId,
            // §E — the tenant of record and the peer principal both come from
            // the authenticated identity. `anon` is the honest name for an
            // unauthenticated peer, not a shared bucket to bind tasks into: an
            // unauthenticated caller can still only read its own tenant's rows.
            principalId: req.principal?.principalId ?? 'anon',
            protocolVersion: codecVersion,
          },
          // At 1.0 a Task IS a run, so the codec needs real storage. Without it
          // every durable operation answers UnsupportedOperationError rather
          // than minting a task id that resolves to no run.
          deps: deps.storage && deps.hostSuite ? { storage: deps.storage, hostSuite: deps.hostSuite } : null,
        });
        res.status(200).json(rpc10);
        return;
      }
      const agentCard = getPublishedAgentCard(tenantId) ?? buildA2aCard03(requestOrigin(req));
      // ADR 0035 / RFC 0100 — durable Tasks (persist + tasks/get/resubscribe +
      // push) are wired on the same env-gated server when
      // OPENWOP_A2A_DURABLE_TASKS=true; otherwise the synchronous core (today's
      // behavior, no task store). The `a2a.durableTasks` capability is advertised
      // only when this is set (discovery.ts), so the advertisement never outruns
      // the wiring.
      const rpc = await handleA2aRequest(req.body as A2aJsonRpcRequest, {
        agentCard,
        availableTools: [...builtinAgentToolIds()],
        durableTasks: process.env.OPENWOP_A2A_DURABLE_TASKS === 'true',
        tenantId,
      });
      // JSON-RPC transport is always HTTP 200; method/params errors live in the body.
      res.status(200).json(rpc);
    } catch (err) {
      // JSON-RPC internal error: scrub the raw message before returning it
      // (it crosses the wire in the body even though the HTTP status is 200).
      const raw = err instanceof Error ? err.message : String(err);
      log.error('a2a_jsonrpc_internal_error', { error: raw });
      res
        .status(200)
        .json({ jsonrpc: '2.0', id: (req.body as { id?: string | number })?.id ?? 0, error: { code: -32603, message: sanitizeForErrorMessage(raw) } });
    }
  };

  // RFC 0076/0100/0152 — GET-able A2A AgentCard at the standard discovery path
  // (unchanged in 1.0: `a2a-integration.md` §A, "the version is discovered
  // *inside* the card, not from its path"). The `a2a.agentCardUrl`
  // advertisement (discovery.ts) points HERE, so the honesty bar holds: a
  // cross-host peer can plain-GET the card without a credential (this path is
  // in auth.ts PUBLIC_PATH_PREFIXES). Gated on OPENWOP_A2A_SERVER_ENABLED — 404
  // when the host is not exposing itself as an A2A agent, mirroring the slot.
  //
  // ADR 0552 P2 (CORRECTED 2026-08-16) — the SHAPE follows `A2A-Version` on the
  // GET, and a header-less GET is 0.3 for as long as `a2a-0.3-legacy` is
  // advertised, exactly as for OPERATIONS. `host/a2aProfile.ts cardVersionFor`
  // owns the rule and carries the reversed decision's reasoning.
  app.get('/.well-known/agent-card.json', (req, res) => {
    if (process.env.OPENWOP_A2A_SERVER_ENABLED !== 'true') {
      res.status(404).json({ error: 'not_found', message: 'a2a server endpoint disabled (set OPENWOP_A2A_SERVER_ENABLED=true)' });
      return;
    }
    const asked = dispositionForA2AVersionHeader(req.headers[A2A_VERSION_HEADER]);
    const era = cardVersionFor(asked);
    const tenantId = (req as AgentReqLike).tenantId ?? 'default';
    // A tenant-PUBLISHED card (ctx.a2a.publishAgentCard) is a 0.3-era artifact —
    // it is whatever a workflow handed us, and 1.0 removed the fields it is
    // built around. Serving it under a 1.0 request would emit "a card with both
    // shapes", which §C says "is neither". So it overrides the legacy card only.
    if (era === LEGACY_A2A_PROTOCOL_VERSION) {
      res.status(200).json(getPublishedAgentCard(tenantId) ?? buildA2aCard03(requestOrigin(req)));
      return;
    }
    res.status(200).json(buildA2aCard10(requestOrigin(req)));
  });

  // ── RFC 0100 §2/§4 — durable A2A Task host-sample conformance seams ──────────
  // Non-normative seams that drive the REAL durable-task store (a2aTaskStore —
  // ADR 0035), not a parallel stub: `tasks/start` starts a genuine
  // approval-gated run and binds taskId==runId; `tasks/{id}` reads the persisted
  // DurableCollection projection; `push-config` runs the caller URL through the
  // same RFC 0093 egress guard the push path uses. Gated on
  // `OPENWOP_A2A_DURABLE_TASKS` (the same flag that flips the
  // `a2a.durableTasks`/`pushNotifications` advertisement in discovery.ts, so the
  // seam is served iff the capability is advertised); 404 otherwise — the
  // conformance behavioral legs soft-skip on 404/403.
  //
  // Each handler is mounted at BOTH the app-canonical
  // `/v1/host/openwop-app/a2a/*` prefix AND the spec-canonical
  // `/v1/host/sample/a2a/*` prefix the vendored 1.34.0 conformance driver hits
  // literally (`driver.post('/v1/host/sample/a2a/tasks/start')` …) — mirroring
  // the RFC 0106 transcriber dual-mount above. Same handler, two paths.

  // ── RFC 0152 §B/§E — the `invoke` negotiation + peer-authority seam ──────────
  // `host-sample-test-seams.md` §22. §B is entirely about what this host puts on
  // the wire TOWARD a peer — the `A2A-Version` header, and whether a downgrade
  // was explicit — which no black-box request to this host's own API can
  // observe. This seam makes the host call a peer of the suite's choosing so the
  // peer can capture the headers.
  //
  // NON-VACUITY (§22's own requirement): it drives `createA2aSurface` — the same
  // client `ctx.a2a.*` uses in a workflow — and passes the suite's knobs through
  // `negotiation`. A seam that hand-wrote `A2A-Version` would prove nothing
  // about production, which is the whole reason the contract says so.
  const a2aInvokeSeam = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true' || process.env.OPENWOP_A2A_SERVER_ENABLED !== 'true') {
        res.status(404).json({ error: 'not_found', message: 'a2a invoke seam disabled (set OPENWOP_TEST_SEAM_ENABLED=true OPENWOP_A2A_SERVER_ENABLED=true)' });
        return;
      }
      const body = (req.body ?? {}) as {
        peerUrl?: string;
        authenticated?: boolean;
        peerOffersOnly?: string;
        requestVersion?: string;
        scenario?: string;
      };
      if (typeof body.peerUrl !== 'string' || body.peerUrl === '') {
        res.status(400).json({ error: 'validation_error', message: 'Field `peerUrl` is required.' });
        return;
      }
      const tenantId = (req as AgentReqLike).tenantId ?? 'default';
      const calls: A2aCallRecord[] = [];
      const negotiation = {
        ...(body.authenticated === true ? { authenticated: true } : {}),
        ...(body.peerOffersOnly ? { peerOffersOnly: body.peerOffersOnly } : {}),
        ...(body.requestVersion ? { requestVersion: body.requestVersion } : {}),
        onCall: (c: A2aCallRecord) => calls.push(c),
      };
      // RFC 0207 §B — the seam drives the REAL A2A client, so it must supply the
      // one input the production path gets from the run row: the trace context
      // to continue. Here that is the seam request's own `traceparent`, which is
      // what the suite sets when it drives this seam. Threading it is what keeps
      // the §22 non-vacuity clause true for the carrier too — a seam that
      // omitted it would prove nothing about the `Message.metadata.openwop` /
      // HTTP-header construction it exists to exercise. Correlation only.
      const seamTrace = traceContextFromHeaders((n) => req.header(n) ?? undefined);
      const surface = createA2aSurface({ tenantId, ...(seamTrace ? { traceContext: seamTrace } : {}) });

      // The §E scenario needs a REAL approval gate to fail to advance. Started
      // BEFORE the peer is called so `approvalAdvanced` compares two live reads
      // of the same run rather than a constant.
      const probe =
        body.scenario === 'peer-asserts-authority' && deps.storage && deps.hostSuite
          ? await startPeerAuthorityProbe({ storage: deps.storage, hostSuite: deps.hostSuite }, tenantId)
          : null;

      let reply: unknown;
      try {
        reply = await surface.sendMessage({
          baseUrl: body.peerUrl,
          message: { text: 'openwop a2a negotiation seam', role: 'ROLE_USER', parts: [{ kind: 'text', text: 'openwop a2a negotiation seam' }] },
          negotiation,
        });
      } catch (err) {
        if (err instanceof A2aVersionRefusedError) {
          // §B — the canonical OpenWOP envelope, never the upstream body. A raw
          // upstream error would leave the caller parsing a foreign protocol to
          // learn its own request was rejected.
          sendError(
            res,
            400,
            'interop_version_unsupported',
            err.message,
            { retriable: false, protocol: 'a2a', requested: err.requested, supported: [...err.supported] },
          );
          return;
        }
        throw err;
      }
      const negotiatedVersion = calls.filter((c) => c.method === 'POST').at(-1)?.version ?? calls.at(-1)?.version;
      if (!probe) {
        res.status(200).json({ negotiatedVersion });
        return;
      }
      const peerAuthority = await settlePeerAuthorityProbe(deps.storage!, probe, reply, calls);
      // A null report means the peer asserted nothing — the block is OMITTED so
      // the suite records `blocked`, never a `false` nobody measured.
      res.status(200).json({ negotiatedVersion, ...(peerAuthority ? { peerAuthority } : {}) });
    } catch (err) {
      next(err);
    }
  };
  app.post('/v1/host/openwop-app/a2a/invoke', a2aInvokeSeam);
  app.post('/v1/host/sample/a2a/invoke', a2aInvokeSeam);

  // Start a backing run paused at a HITL approval gate and persist its durable
  // Task projection (`input-required`/approval), so a later `tasks/get` returns
  // live state after the original connection is gone (RFC 0100 §2).
  const a2aTasksStartSeam = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!durableTasksEnabled() || !deps.storage || !deps.hostSuite) {
        res.status(404).json({ error: 'not_found', message: 'a2a durable tasks disabled (set OPENWOP_A2A_SERVER_ENABLED=true OPENWOP_A2A_DURABLE_TASKS=true)' });
        return;
      }
      const tenantId = (req as AgentReqLike).tenantId ?? 'default';
      const scenario = (req.body as { scenario?: string })?.scenario ?? 'paused-at-approval';
      if (scenario !== 'paused-at-approval') {
        res.status(400).json({ error: 'validation_error', message: 'Only scenario `paused-at-approval` is supported by this sample seam.' });
        return;
      }
      // A real approval-gated run — it suspends at `core.approvalGate`, which the
      // forward projection maps to input-required/approval (a2a-integration.md
      // §"State projection (forward)"). taskId == runId (RFC 0100 §2).
      const runId = await startWorkflowRun(
        { storage: deps.storage, hostSuite: deps.hostSuite },
        { tenantId, workflowId: 'openwop-app.approval-gate' },
      );
      if (!runId) {
        res.status(500).json({ error: 'internal', message: 'sample approval-gate workflow did not resolve' });
        return;
      }
      await upsertA2aTask({ taskId: runId, runId, state: 'input-required', interruptKind: 'approval' });
      res.status(201).json({ taskId: runId });
    } catch (err) {
      next(err);
    }
  };
  app.post('/v1/host/openwop-app/a2a/tasks/start', a2aTasksStartSeam);
  app.post('/v1/host/sample/a2a/tasks/start', a2aTasksStartSeam);

  // Read the persisted durable Task projection (RFC 0100 §2 / §3 `tasks/get`).
  // Returns the A2ATaskState record shape (top-level `state` + `runId`).
  const a2aTasksGetSeam = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!durableTasksEnabled()) {
        res.status(404).json({ error: 'not_found', message: 'a2a durable tasks disabled (set OPENWOP_A2A_SERVER_ENABLED=true OPENWOP_A2A_DURABLE_TASKS=true)' });
        return;
      }
      const rec = await getA2aTask(req.params.taskId);
      if (!rec) {
        res.status(404).json({ error: 'not_found', message: 'durable task not found' });
        return;
      }
      // The persisted record is already the a2a-task-state.schema.json shape
      // (taskId, runId, contextId?, state, interruptKind?, updatedAt, pushConfig?).
      res.status(200).json(rec);
    } catch (err) {
      next(err);
    }
  };
  app.get('/v1/host/openwop-app/a2a/tasks/:taskId', a2aTasksGetSeam);
  app.get('/v1/host/sample/a2a/tasks/:taskId', a2aTasksGetSeam);

  // Register a push-config (RFC 0100 §4). The caller URL MUST pass the RFC 0093
  // webhook-egress SSRF guard before any push — a private/loopback target is
  // refused with 400 (a2a-push-egress-ssrf), before the task lookup.
  const a2aPushConfigSeam = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!durableTasksEnabled()) {
        res.status(404).json({ error: 'not_found', message: 'a2a durable tasks disabled (set OPENWOP_A2A_SERVER_ENABLED=true OPENWOP_A2A_DURABLE_TASKS=true)' });
        return;
      }
      const body = (req.body ?? {}) as { taskId?: string; url?: string; tokenFingerprint?: string };
      if (typeof body.taskId !== 'string' || typeof body.url !== 'string') {
        res.status(400).json({ error: 'validation_error', message: 'Fields `taskId` and `url` are required.' });
        return;
      }
      try {
        assertPushUrlAllowed(body.url); // throws A2aPushUrlDeniedError for a denied target
      } catch (err) {
        if (err instanceof A2aPushUrlDeniedError) {
          res.status(400).json({ error: 'a2a_push_egress_denied', message: err.message });
          return;
        }
        throw err;
      }
      const updated = await setA2aTaskPushConfig(body.taskId, {
        url: body.url,
        ...(typeof body.tokenFingerprint === 'string' ? { tokenFingerprint: body.tokenFingerprint } : {}),
      });
      if (!updated) {
        res.status(404).json({ error: 'not_found', message: 'durable task not found' });
        return;
      }
      res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  };
  app.post('/v1/host/openwop-app/a2a/tasks/push-config', a2aPushConfigSeam);
  app.post('/v1/host/sample/a2a/tasks/push-config', a2aPushConfigSeam);
}

/** Durable A2A tasks are wired iff the A2A server is on AND durable tasks are
 *  enabled — the same predicate that flips the `a2a.durableTasks` /
 *  `pushNotifications` advertisement (discovery.ts), so the seam is served iff
 *  the capability is advertised (advertise/enforce parity). */
function durableTasksEnabled(): boolean {
  return process.env.OPENWOP_A2A_SERVER_ENABLED === 'true' && process.env.OPENWOP_A2A_DURABLE_TASKS === 'true';
}

/** The RFC 0090 verifier-gating seam dispatches a real turn over this harness
 *  agent so the gate runs end-to-end without a model call. Idempotent register. */
const VERIFY_HARNESS_AGENT_ID = 'core.openwop.verify.harness';
function ensureVerifyHarnessAgent(): void {
  const registry = getAgentRegistry();
  if (registry.get(VERIFY_HARNESS_AGENT_ID)) return;
  registry.register({
    agentId: VERIFY_HARNESS_AGENT_ID,
    persona: 'Verifier Harness',
    modelClass: 'general',
    systemPrompt: 'Produce a candidate result for verification.',
    packName: 'core.openwop.verify',
    packVersion: '0',
    toolAllowlist: [],
    confidence: { defaultThreshold: 0.5 },
  });
}

/** RFC 0092 §B — the capability key the degraded-demo agent requires but no host
 *  advertises (advertised keys are supported host surfaces; this synthetic vendor
 *  key never is), guaranteeing a non-empty `degraded[]` projection. */
const DEGRADED_DEMO_UNMET_KEY = 'vendor.demo.unmet-capability';
function ensureDegradedDemoAgent(): void {
  const id = process.env.OPENWOP_DEGRADED_CAPABILITY_AGENT_ID;
  if (!id) return;
  const registry = getAgentRegistry();
  if (registry.get(id)) return;
  registry.register({
    agentId: id,
    persona: 'Degraded Capability Demo',
    modelClass: 'general',
    systemPrompt: 'Demo agent that requires a capability this host does not advertise.',
    packName: 'core.openwop.demo',
    packVersion: '0',
    toolAllowlist: [],
    confidence: { defaultThreshold: 0.5 },
    requiresCapabilities: [DEGRADED_DEMO_UNMET_KEY],
  });
}
