/**
 * Manifest-agent inventory + dispatch (RFC 0070).
 *
 * Namespace: sample-extension under `/v1/host/sample/*`; not part of the
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
import type { Express, Request } from 'express';
import { getAgentRegistry, type ResolvedAgentManifest } from '../executor/agentRegistry.js';
import { runAgentDispatch, runAgentDispatchLive, AgentNotFoundError, type AgentDispatchRequest, type CallAi } from '../host/agentDispatch.js';
import { createAiProvidersAdapter, assertModalitiesAdvertised, INPUT_MODALITIES, AiProviderError } from '../aiProviders/aiProvidersHost.js';
import type { AiCallRequest } from '../executor/types.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../host/agentToolProvider.js';
import { advertisedCapabilitySet, mergeDegraded } from '../host/agentCapabilities.js';
import { gradeSuite, type EvalTask } from '../host/agentEvalGrader.js';
import { evalSuiteEnabled } from '../host/workforceEval.js';
import { createAgentMemoryPort, agentMemoryScope } from '../host/agentMemoryAdapter.js';
import { handleA2aRequest, type A2aJsonRpcRequest } from '../host/a2aServer.js';
import { getPublishedAgentCard } from '../host/a2aSurface.js';
import type { HostAdapterSuite } from '../host/index.js';
import type { Storage } from '../storage/storage.js';
import type { UserAgentRecord } from '../types.js';

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
}

function toEntry(a: ResolvedAgentManifest): AgentInventoryEntry {
  // RFC 0092 — surface capability keys the agent requires but this host does not
  // advertise as degraded, merged with any pack-declared degradation.
  const degraded = mergeDegraded(a.degraded, a.requiresCapabilities, advertisedCapabilitySet());
  return {
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
 *  (a tenant POSTed them via `/v1/host/sample/agents`) carry an
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
  if (!a.ownerTenant) return true;
  if (requestTenant === '*') return true;
  return a.ownerTenant === requestTenant;
}

interface AgentReqLike { tenantId?: string }

function tenantForInventory(req: Request): string {
  const requestedTenant = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
  const principalIsWildcard = (req.principal?.tenants ?? []).includes('*');
  if (principalIsWildcard && requestedTenant) return requestedTenant;
  return (req as AgentReqLike).tenantId ?? 'default';
}

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
  app.get('/v1/agents', async (req, res) => {
    const tenant = tenantForInventory(req);
    const agents = await listVisibleAgents(deps.storage, tenant);
    res.json({ agents, total: agents.length });
  });
  app.get('/v1/agents/:agentId', async (req, res) => {
    const tenant = tenantForInventory(req);
    // `resolve()` reads through to durable storage on a registry miss, so a
    // cold instance still serves a seeded/user agent it hasn't hydrated.
    const a = await getAgentRegistry().resolve(req.params.agentId);
    if (!a || !visibleTo(a, tenant)) {
      // Same 404 for "absent" and "not yours" — never leak that a
      // cross-tenant agent exists by returning a distinct status.
      res.status(404).json({ error: 'not_found', message: `agent '${req.params.agentId}' is not installed on this host` });
      return;
    }
    res.json(toEntry(a));
  });

  // Sample-extension aliases (RFC 0070 convenience; non-normative). The list
  // form additionally reports the host's runtime posture for the CLI.
  app.get('/v1/host/sample/agents', async (req, res) => {
    const tenant = tenantForInventory(req);
    const agents = await listVisibleAgents(deps.storage, tenant);
    res.json({ agents, total: agents.length, runtime: { manifestRuntime: true } });
  });
  app.get('/v1/host/sample/agents/:agentId', async (req, res) => {
    const tenant = tenantForInventory(req);
    const a = await getAgentRegistry().resolve(req.params.agentId);
    if (!a || !visibleTo(a, tenant)) {
      res.status(404).json({ error: 'not_found', message: `agent '${req.params.agentId}' is not installed on this host` });
      return;
    }
    res.json(toEntry(a));
  });

  // Dispatch one turn of a manifest agent (RFC 0070 floor). Deterministic by
  // default (replay-safe, conformance-stable); a real model turn when the body
  // sets `live: true` AND the host wired an AI adapter (deps.hostSuite). Live
  // turns default to the managed tier so no BYOK is required.
  app.post('/v1/host/sample/agents/:agentId/dispatch', async (req, res) => {
    const body = (req.body ?? {}) as Partial<AgentDispatchRequest> & { live?: boolean };
    const reqShape: AgentDispatchRequest = {
      agentId: req.params.agentId,
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
        const adapter = createAiProvidersAdapter({
          runId: `agent-dispatch:${randomUUID()}`,
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
        const toolProvider = createAgentToolProvider({ tenantId, runId: reqShape.agentId });
        const result = await runAgentDispatchLive(
          { ...reqShape, availableTools: reqShape.availableTools ?? [...builtinAgentToolIds()] },
          {
            callAI: adapter.callAI,
            callAIWithTools: adapter.callAIWithTools,
            resolveTool: toolProvider.resolveTool,
            executeTool: toolProvider.executeTool,
            // A4 — cross-run agent memory (RFC 0004). Injected unconditionally;
            // dispatch's `memoryEnabled` gate only reads/writes when the agent's
            // manifest declares `memoryShape.longTerm`, so agents without it are
            // unaffected. tenant-bound for CTI-1; per-agent namespace.
            memory: createAgentMemoryPort(tenantId),
            memoryScope: agentMemoryScope(reqShape.agentId),
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
      res.status(500).json({ error: 'dispatch_error', message: err instanceof Error ? err.message : String(err) });
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
  app.post('/v1/host/sample/agents/eval-run', (req, res) => {
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
  app.post('/v1/host/sample/ai/call', (req, res) => {
    const body = (req.body ?? {}) as { messages?: unknown; provider?: unknown; model?: unknown };
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ error: 'validation_error', message: 'messages[] (non-empty) is required' });
      return;
    }
    // Build the minimal AiCallRequest the guard inspects (it only reads `messages`).
    const callReq = {
      provider: typeof body.provider === 'string' ? body.provider : 'anthropic',
      model: typeof body.model === 'string' ? body.model : 'managed-default',
      messages: body.messages as AiCallRequest['messages'],
    } as AiCallRequest;
    try {
      assertModalitiesAdvertised(callReq);
    } catch (err) {
      if (err instanceof AiProviderError && err.code === 'unsupported_modality') {
        res.status(400).json({ error: { code: 'unsupported_modality', message: err.message, details: err.details } });
        return;
      }
      res.status(400).json({ error: { code: 'invalid_request', message: err instanceof Error ? err.message : String(err) } });
      return;
    }
    // Modalities all advertised → accepted (the RFC 0091 §A path). Report the
    // distinct modalities seen so the caller/steward can confirm the gate ran.
    const seen = new Set<string>();
    for (const m of callReq.messages) {
      if (typeof m.content === 'string') { seen.add('text'); continue; }
      for (const part of m.content) seen.add(part.type === 'file' ? 'document' : part.type);
    }
    res.status(200).json({ ok: true, accepted: true, advertised: INPUT_MODALITIES, modalities: [...seen] });
  });

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
  app.post('/v1/host/sample/agents/verify-run', async (req, res) => {
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
  // host.a2a advertisement flip); 404 when off. JSON-RPC only — no
  // `/.well-known/agent-card.json` (deferred to an a2a-integration discussion).
  app.post('/v1/host/sample/a2a', (req, res) => {
    if (process.env.OPENWOP_A2A_SERVER_ENABLED !== 'true') {
      res.status(404).json({ error: 'not_found', message: 'a2a server endpoint disabled (set OPENWOP_A2A_SERVER_ENABLED=true)' });
      return;
    }
    const tenantId = (req as AgentReqLike).tenantId ?? 'default';
    const agentCard = getPublishedAgentCard(tenantId) ?? synthesizeAgentCard(req);
    const rpc = handleA2aRequest(req.body as A2aJsonRpcRequest, {
      agentCard,
      availableTools: [...builtinAgentToolIds()],
    });
    // JSON-RPC transport is always HTTP 200; method/params errors live in the body.
    res.status(200).json(rpc);
  });
}

/** A7 — synthesize an A2A agent card from the installed manifest agents when the
 *  tenant hasn't published one, so `agent/getCard` returns a real surface (each
 *  installed agent becomes an A2A skill) rather than a dead stub. */
function synthesizeAgentCard(req: Request): unknown {
  const base = `${req.protocol}://${req.get('host') ?? 'localhost'}`;
  const skills = getAgentRegistry().list().map((a) => ({
    id: a.agentId,
    name: a.label ?? a.persona,
    description: a.description ?? `${a.persona} (modelClass ${a.modelClass})`,
    tags: [a.modelClass],
  }));
  return {
    name: 'openwop-reference-host',
    description: 'OpenWOP reference workflow-engine host exposing its installed manifest agents over A2A (RFC 0076).',
    url: `${base}/v1/host/sample/a2a`,
    version: '1.0.0',
    protocolVersion: '0.3',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
  };
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
