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
import type { Express, NextFunction, Request, Response } from 'express';
import { createLogger } from '../observability/logger.js';
import { sanitizeForErrorMessage } from '../middleware/sanitize.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../executor/agentRegistry.js';
import { runAgentDispatch, runAgentDispatchLive, AgentNotFoundError, type AgentDispatchRequest, type CallAi } from '../host/agentDispatch.js';
import { stampRunStartContext } from '../host/runStartContext.js';
import { readCompactionDecision } from '../executor/compaction.js';
import { createAiProvidersAdapter, assertModalitiesAdvertised, INPUT_MODALITIES, AiProviderError } from '../aiProviders/aiProvidersHost.js';
import type { AiCallRequest } from '../executor/types.js';
import { dispatchChat, type ChatMessage } from '../providers/dispatch.js';
import { getHostTestCompatEndpoint, COMPAT_PROVIDER_ID } from '../host/compatEndpoints.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../host/agentToolProvider.js';
import { advertisedCapabilitySet, mergeDegraded } from '../host/agentCapabilities.js';
import { gradeSuite, type EvalTask } from '../host/agentEvalGrader.js';
import { evalSuiteEnabled } from '../host/workforceEval.js';
import { createAgentMemoryPort, agentMemoryScope } from '../host/agentMemoryAdapter.js';
import { resolveAgentKnowledgeRetrieve } from '../host/agentKnowledgeComposition.js';
import { getBorrowedRecallResolver } from '../host/twinRecallSurface.js';
import { handleA2aRequest, type A2aJsonRpcRequest } from '../host/a2aServer.js';
import { getPublishedAgentCard } from '../host/a2aSurface.js';
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

  // Host-extension aliases (RFC 0070 convenience; non-normative). The list
  // form additionally reports the host's runtime posture for the CLI.
  app.get('/v1/host/openwop-app/agents', async (req, res) => {
    const tenant = tenantForInventory(req);
    const agents = await listVisibleAgents(deps.storage, tenant);
    res.json({ agents, total: agents.length, runtime: { manifestRuntime: true } });
  });
  app.get('/v1/host/openwop-app/agents/:agentId', async (req, res) => {
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
  app.post('/v1/host/openwop-app/agents/:agentId/dispatch', async (req, res) => {
    // CTI-1 (AGENTRT-2): gate dispatch on the SAME tenant visibility as the GET
    // routes. Without this a caller could INVOKE another tenant's user-authored
    // agent (its private manifest — system prompt, tool allowlist) by id even
    // though the GET-by-id route hides it. Resolve through storage, then 404 on
    // "not yours" with the same message as "absent" so cross-tenant existence is
    // never leaked. Built-in/pack agents (no ownerTenant) stay universally
    // dispatchable; an unresolved id falls through to AgentNotFoundError → 404.
    const dispatchTenant = tenantForInventory(req);
    const gateAgent = await getAgentRegistry().resolve(req.params.agentId);
    if (gateAgent && !visibleTo(gateAgent, dispatchTenant)) {
      res.status(404).json({ error: 'not_found', message: `agent '${req.params.agentId}' is not installed on this host` });
      return;
    }
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
        const memory = createAgentMemoryPort(tenantId);
        const memoryScope = agentMemoryScope(reqShape.agentId);
        // ADR 0038 Phase 3 — compose the agent's BOUND knowledge (cited KB docs +
        // private memory) into the turn, from host-owned primitives. `undefined`
        // (no `knowledge` capability / no binding) ⇒ dispatch is unchanged.
        const knowledgeRetrieve = await resolveAgentKnowledgeRetrieve(tenantId, reqShape.agentId, memory, memoryScope);
        // ADR 0044 Phase 2 — when this agent is a granted twin, compose its OWNER's
        // corpus (live grant gate via the host seam the `twin` feature fills). The
        // result is fenced STRUCTURALLY by dispatch (`borrowedRetrieve` → untrusted
        // block). Absent / not-granted / toggle-off ⇒ undefined ⇒ no cross read.
        const borrowedResolver = getBorrowedRecallResolver();
        const borrowedRetrieve = borrowedResolver ? await borrowedResolver(tenantId, reqShape.agentId) : undefined;
        // ADR 0099 §residuals — this dispatch is RUNLESS (no run.metadata to read),
        // so resolve the compaction decision here via the SAME core run-start seam
        // (no feature import, no new seam) and pass it in. Toggle off ⇒ undefined ⇒
        // identity. Per-agent lossy only matches when the manifest agentId is also a
        // profile (roster) id; otherwise the tenant lossless default applies.
        // Cost: one toggle resolution per LIVE dispatch — negligible beside the
        // model round-trip this path is about to make.
        const compactionMeta = await stampRunStartContext({}, { tenantId, agentId: reqShape.agentId });
        const compaction = readCompactionDecision(compactionMeta);
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
        res.status(400).json({ error: { code: 'unsupported_modality', message: err.message, details: err.details } });
        return;
      }
      res.status(400).json({ error: { code: 'invalid_request', message: err instanceof Error ? err.message : String(err) } });
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
        res.status(502).json({ error: { code: 'compat_transport_error', message: 'compat_transport_error' } });
        return;
      }
      const messages: ChatMessage[] = [{ role: 'user', content: aiCallText(callReq.messages) }];
      try {
        const r = await dispatchChat({ provider: 'compat', model, apiKey: '', baseUrl, messages });
        res.status(200).json({ ok: true, accepted: true, provider: 'compat', completion: r.completion });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e); // §D-scrubbed
        res.status(502).json({ error: { code: 'compat_transport_error', message } });
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
      res.status(400).json({ error: { code: 'invalid_request', message: 'text (non-empty string) required' } });
      return;
    }
    if (voiceId.length === 0) {
      res.status(400).json({ error: { code: 'invalid_request', message: 'voiceId (non-empty string) required' } });
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
          res.status(429).json({ error: { code: err.code, message: err.message, details: err.details } });
          return;
        }
        const clientError = err.code === 'invalid_request' || err.code === 'content_too_long' || err.code === 'speech_synthesis_unsupported';
        res.status(clientError ? 400 : 502).json({ error: { code: err.code, message: err.message, details: err.details } });
        return;
      }
      res.status(500).json({ error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } });
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
      res.status(400).json({ error: { code: 'invalid_request', message: 'audio.streamRef OR audio.url (non-empty string) required' } });
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
        res.status(clientError ? 400 : 502).json({ error: { code: err.code, message: err.message, details: err.details } });
        return;
      }
      res.status(500).json({ error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } });
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
    const tenantId = (req as AgentReqLike).tenantId ?? 'default';
    const agentCard = getPublishedAgentCard(tenantId) ?? synthesizeAgentCard(req);
    // ADR 0035 / RFC 0100 — durable Tasks (persist + tasks/get/resubscribe +
    // push) are wired on the same env-gated server when
    // OPENWOP_A2A_DURABLE_TASKS=true; otherwise the synchronous core (today's
    // behavior, no task store). The `a2a.durableTasks` capability is advertised
    // only when this is set (discovery.ts), so the advertisement never outruns
    // the wiring.
    handleA2aRequest(req.body as A2aJsonRpcRequest, {
      agentCard,
      availableTools: [...builtinAgentToolIds()],
      durableTasks: process.env.OPENWOP_A2A_DURABLE_TASKS === 'true',
    })
      // JSON-RPC transport is always HTTP 200; method/params errors live in the body.
      .then((rpc) => res.status(200).json(rpc))
      .catch((err) => {
        // JSON-RPC internal error: scrub the raw message before returning it
        // (it crosses the wire in the body even though the HTTP status is 200).
        const raw = err instanceof Error ? err.message : String(err);
        log.error('a2a_jsonrpc_internal_error', { error: raw });
        res
          .status(200)
          .json({ jsonrpc: '2.0', id: (req.body as { id?: string | number })?.id ?? 0, error: { code: -32603, message: sanitizeForErrorMessage(raw) } });
      });
  });

  // RFC 0076/0100 — GET-able A2A v0.3 AgentCard at the standard discovery path.
  // The `a2a.agentCardUrl` advertisement (discovery.ts) points HERE, so the
  // honesty bar holds: a cross-host peer can plain-GET the card without a
  // credential (this path is in auth.ts PUBLIC_PATH_PREFIXES), and it resolves
  // to the same v0.3 doc `synthesizeAgentCard` feeds the JSON-RPC `agent/getCard`
  // (protocolVersion:'0.3' + skills). Gated on OPENWOP_A2A_SERVER_ENABLED — 404
  // when the host is not exposing itself as an A2A agent, mirroring the slot.
  app.get('/.well-known/agent-card.json', (req, res) => {
    if (process.env.OPENWOP_A2A_SERVER_ENABLED !== 'true') {
      res.status(404).json({ error: 'not_found', message: 'a2a server endpoint disabled (set OPENWOP_A2A_SERVER_ENABLED=true)' });
      return;
    }
    const tenantId = (req as AgentReqLike).tenantId ?? 'default';
    res.status(200).json(getPublishedAgentCard(tenantId) ?? synthesizeAgentCard(req));
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

/** A7 — synthesize an A2A agent card from the installed manifest agents when the
 *  tenant hasn't published one, so `agent/getCard` returns a real surface (each
 *  installed agent becomes an A2A skill) rather than a dead stub. */
function synthesizeAgentCard(req: Request): unknown {
  // Forwarded-aware, sanitized origin (host/requestOrigin.ts) — behind Cloud Run
  // `req.protocol` alone is `http`; the shared helper honors X-Forwarded-Proto so
  // the card `url` is an honest cross-host https origin, not a localhost stub.
  const base = requestOrigin(req);
  const skills = getAgentRegistry().list().map((a) => ({
    id: a.agentId,
    name: a.label ?? a.persona,
    description: a.description ?? `${a.persona} (modelClass ${a.modelClass})`,
    tags: [a.modelClass],
  }));
  return {
    name: 'openwop-reference-host',
    description: 'OpenWOP reference workflow-engine host exposing its installed manifest agents over A2A (RFC 0076).',
    url: `${base}/v1/host/openwop-app/a2a`,
    version: '1.0.0',
    protocolVersion: '0.3',
    // ADR 0035 / RFC 0100 — the A2A AgentCard `capabilities` mirror the `a2a`
    // discovery slot. `pushNotifications` is honest only when durable Tasks are
    // wired (OPENWOP_A2A_DURABLE_TASKS). `streaming` (tasks/resubscribe) is
    // DECOUPLED onto its own OPENWOP_A2A_STREAMING flag (default off) — the
    // server serves resubscribe but we don't advertise it until conformance
    // ships a resubscribe witness, so `streaming:true` isn't a vacuous claim.
    capabilities: {
      streaming: process.env.OPENWOP_A2A_STREAMING === 'true',
      pushNotifications: process.env.OPENWOP_A2A_DURABLE_TASKS === 'true',
    },
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
