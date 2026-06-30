/**
 * /.well-known/openwop + /v1/openapi.json + Capabilities-Etag.
 *
 * Honest advertisement: only what this sample actually supports. Real
 * deployers update the capabilities block whenever they swap a stub
 * for a real implementation.
 */

import { createHash } from 'node:crypto';
import type { Express, Request } from 'express';
import { DEFAULT_SERVICE_DESCRIPTION, DEFAULT_SERVICE_VENDOR, type AppConfig } from '../index.js';
import { requestOrigin } from '../host/requestOrigin.js';
import { SUPPORTED_RUN_ENCODINGS } from '../host/restTransport.js';
import { a2uiDeltaTransportEnabled } from '../host/a2uiSurfaceDelta.js';
import { MAX_MULTI_PARTY_PARTICIPANTS } from '../host/multiPartyConversation.js';
import { channelPresenceEnabled } from '../features/channels/routes.js';
import { listCapabilities } from '../executor/runtimeCapabilities.js';
import { demoMode } from '../host/demoMode.js';
import { hostI18nEnabled, hostDefaultLocale, hostSupportedLocales } from '../host/i18n/index.js';
import type { Storage } from '../storage/storage.js';
import { listHostSurfaces } from '../bootstrap/hostSurfaceRegistry.js';
import { universalEnvelopeKinds } from '../host/envelopeAcceptor.js';
import { evalSuiteEnabled } from '../host/workforceEval.js';
import { MAX_INLINE_MEDIA_BYTES } from './mediaAssets.js';
import { INPUT_MODALITIES } from '../aiProviders/aiProvidersHost.js';
import { hostAdvertisedSelfHosted } from '../host/compatEndpoints.js';
import { imageGenerationAdvertised } from '../aiProviders/aiProvidersHost.js';
import { getFsSandboxRoot } from '../host/inMemorySurfaces.js';
import { samlConfigured } from '../host/auth/samlSso.js';
import { listLoadedConformanceFixtures } from '../host/index.js';
import { conformanceNodesEnabled } from '../bootstrap/conformanceMockAgent.js';
import { getPromptsHostConfig } from '../host/promptHostConfig.js';
import { getEnvelopeReasoningConfig } from '../host/envelopeReasoningConfig.js';
import { getModelCapabilityGateConfig } from '../host/modelCapabilityGateConfig.js';
import { getEnvelopeReliabilityConfig } from '../host/envelopeReliabilityConfig.js';
import { authorizationCapability } from '../host/protocolAuthorization.js';
import { registeredFeatureSurfaceIds } from '../host/featureSurfaces.js';
import { listArtifactTypes } from '../host/artifactTypes.js';
import { triggerIngestionEnabled, MAX_INGEST_BODY_BYTES } from '../host/triggerIngestionService.js';
import { activationMode as proposalsActivationMode } from '../features/proposals/proposalsService.js';
import { requiresBounds as goalsRequiresBounds } from '../features/goals/goalsService.js';
import { uiPluginsCapability } from '../host/uiPluginRpc.js';
import { dispatchCapability } from '../host/dispatchFanOut.js';
import { presentationEnabled } from '../host/hostProfile.js';

/**
 * Auth profiles this host actually SERVES (review finding #10 / ADR 0002 C1).
 * `openwop-auth-saml` / `openwop-auth-scim` are advertised ONLY when their seam
 * is actually reachable in this deployment — otherwise a client would read the
 * profile from discovery and get a 404 from the (unconfigured) seam, which is
 * exactly the advertised-but-unhonored posture C1 forbids. SAML is reachable
 * when a synthetic IdP is wired (`OPENWOP_TEST_SAML_IDP_URL`); SCIM when either
 * the real bearer-authed endpoints (`OPENWOP_SCIM_BEARER`) or the conformance
 * seam (`OPENWOP_TEST_SCIM_URL`) is configured.
 */
function advertisedAuthProfiles(): string[] {
  const profiles: string[] = [];
  // `openwop-auth-saml` is honored by either the conformance test seam OR a real
  // SAML SP wired to a production IdP (Okta/Azure…) via the OPENWOP_SAML_* env.
  if (process.env.OPENWOP_TEST_SAML_IDP_URL || samlConfigured()) profiles.push('openwop-auth-saml');
  if (process.env.OPENWOP_SCIM_BEARER || process.env.OPENWOP_TEST_SCIM_URL) profiles.push('openwop-auth-scim');
  return profiles;
}

/**
 * RFC 0040 §D — this host's stable cross-host-causation `hostId`. Advertised in
 * `crossHostCausation.hostId` and echoed by `GET /v1/runs/{runId}/ancestry`
 * (the two MUST match). A real multi-host deployment overrides via env.
 */
export const CROSS_HOST_CAUSATION_HOST_ID =
  process.env.OPENWOP_CROSS_HOST_CAUSATION_HOST_ID ?? 'openwop-workflow-engine';

/**
 * RFC 0040 Phase 3 gate. Single source of truth shared by the discovery
 * advertisement (`crossHostCausation` + `version >= 3`) and the
 * `GET /v1/runs/{runId}/ancestry` endpoint gate, so the two never drift. The
 * ladder is additive — `phase4` implies `phase3` (a `version: 4` host MUST
 * implement Phase 3 too, per `capabilities.schema.json §...version`).
 */
export function isPhase3Enabled(): boolean {
  return (
    process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_3 === 'true' ||
    process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4 === 'true'
  );
}

interface Deps {
  storage: Storage;
  config: AppConfig;
}

export function registerDiscoveryRoutes(app: Express, _deps: Deps): void {
  app.get('/.well-known/openwop', (req, res) => {
    const advertisement = buildAdvertisement(_deps.config, req);
    const etag = `"${createHash('sha256').update(JSON.stringify(advertisement)).digest('hex').slice(0, 16)}"`;
    res.set('Capabilities-Etag', etag);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(advertisement);
  });

  app.get('/v1/openapi.json', (_req, res) => {
    // Sample serves the published spec verbatim — points consumers at
    // the canonical openapi if they want full surface. Production hosts
    // ship a copy with their actual route subset.
    res.json({
      openapi: '3.1.0',
      info: {
        // Brand-driven, not hard-coded: title + description flow from the
        // service config (OPENWOP_SERVICE_NAME / OPENWOP_SERVICE_DESCRIPTION)
        // so a white-label host doesn't emit "openwop" strings it didn't set.
        title: _deps.config.serviceName,
        version: _deps.config.serviceVersion,
        description: _deps.config.serviceDescription ?? DEFAULT_SERVICE_DESCRIPTION,
      },
      paths: {
        '/v1/runs': { post: { summary: 'Create a run' } },
        '/v1/runs/{runId}': { get: { summary: 'Fetch run snapshot' } },
        '/v1/runs/{runId}/cancel': { post: { summary: 'Cancel a run' } },
        '/v1/runs/{runId}:fork': { post: { summary: 'Fork a run from a sequence' } },
        '/v1/runs/{runId}/events': { get: { summary: 'SSE event stream' } },
        '/v1/runs/{runId}/events/poll': { get: { summary: 'Poll events (long-poll alternative to SSE)' } },
        '/v1/runs/{runId}/interrupts/{nodeId}': { post: { summary: 'Resolve a node-scoped interrupt' } },
        '/v1/interrupts/{token}': { post: { summary: 'Resolve an interrupt by signed token' } },
        '/v1/webhooks': {
          get: { summary: 'List webhook subscriptions (refs only; no secret)' },
          post: { summary: 'Register a webhook subscription' },
        },
        '/v1/webhooks/{subscriptionId}': { delete: { summary: 'Delete a webhook subscription' } },
        '/v1/webhooks/{subscriptionId}/test': { post: { summary: 'Fire a signed test delivery to a webhook subscription' } },
        '/v1/packs': { get: { summary: 'List installed packs' } },

        // RFC 0028 — prompt library. The reference host serves all
        // six routes via `routes/prompts.ts`. capabilities.prompts.
        // endpointsSupported is advertised as true; mutableLibrary as
        // true. Read endpoints (GET /v1/prompts, GET /v1/prompts/{id},
        // POST /v1/prompts:render) are gated on endpointsSupported;
        // mutating endpoints (POST/PUT/DELETE) are additionally gated
        // on mutableLibrary.
        '/v1/prompts': {
          get: { summary: 'List prompt templates (RFC 0028 §A)' },
          post: { summary: 'Create a user-source prompt template (RFC 0028 §A; requires mutableLibrary)' },
        },
        '/v1/prompts/{templateId}': {
          get: { summary: 'Fetch a prompt template (RFC 0028 §A)' },
          put: { summary: 'Replace a user-source prompt template (RFC 0028 §A; requires mutableLibrary)' },
          delete: { summary: 'Delete a user-source prompt template (RFC 0028 §A; requires mutableLibrary)' },
        },
        '/v1/prompts:render': {
          post: { summary: 'Render a prompt template with supplied variable bindings (RFC 0028 §A)' },
        },

        // ── Host-extension routes (NOT part of the OpenWOP wire
        //    contract — vendor-prefixed per host-extensions.md) ──
        '/v1/host/openwop-app/byok/secrets': {
          get: { summary: 'List stored BYOK credentialRefs (refs only)', tags: ['host-extension'] },
          post: { summary: 'Store a BYOK credentialRef + value', tags: ['host-extension'] },
        },
        '/v1/host/openwop-app/byok/secrets/{credentialRef}': {
          delete: { summary: 'Remove a stored BYOK secret', tags: ['host-extension'] },
        },
        '/v1/host/openwop-app/runs/{runId}/interrupts': {
          get: { summary: 'List open interrupts for a run (authed; returns tokens)', tags: ['host-extension'] },
        },
        '/v1/host/openwop-app/example-data-summary': {
          get: { summary: 'Summarize app readiness for CLI and diagnostics', tags: ['host-extension'] },
        },
        '/v1/host/openwop-app/daemon-status': {
          get: { summary: 'Report backend pid / startTime / uptimeSeconds / lastHeartbeat for CLI lifecycle commands', tags: ['host-extension'] },
        },
        '/v1/host/openwop-app/scheduler/jobs': {
          get: { summary: 'List scheduled cron jobs (RFC 0052 sample CRUD)', tags: ['host-extension'] },
          post: { summary: 'Register a scheduled cron job; rejects beyond maxFutureHorizon with schedule_horizon_exceeded (RFC 0052 §B)', tags: ['host-extension'] },
        },
        '/v1/host/openwop-app/scheduler/jobs/{jobId}': {
          delete: { summary: 'Remove a scheduled cron job (RFC 0052 sample CRUD)', tags: ['host-extension'] },
        },
        '/v1/host/openwop-app/scheduler/jobs/{jobId}/trigger': {
          post: { summary: 'Fire a scheduled job once now (RFC 0052 §B.2 fire-once-per-tick)', tags: ['host-extension'] },
        },
        '/v1/host/openwop-app/chat/sessions': {
          get: { summary: 'List chat sessions for the calling tenant', tags: ['host-extension'] },
          post: { summary: 'Create a new chat session', tags: ['host-extension'] },
        },
        '/v1/host/openwop-app/chat/sessions/{sessionId}': {
          get: { summary: 'Fetch a chat session header', tags: ['host-extension'] },
          patch: { summary: 'Rename a chat session', tags: ['host-extension'] },
          delete: { summary: 'Delete a chat session (cascades to messages)', tags: ['host-extension'] },
        },
        '/v1/host/openwop-app/chat/sessions/{sessionId}/messages': {
          get: { summary: 'Load every message in a chat session', tags: ['host-extension'] },
          post: { summary: 'Append a message to a chat session', tags: ['host-extension'] },
        },
        '/v1/host/openwop-app/prompt/compose': {
          post: {
            summary: 'RFC 0027 §E compose seam — drives prompt-composed-* conformance scenarios (sample-only; NOT part of the canonical wire contract)',
            tags: ['host-extension'],
          },
        },
        '/v1/host/openwop-app/prompt/resolve': {
          post: {
            summary: 'RFC 0029 §A four-layer resolve seam — drives prompt-resolution-chain-* conformance scenarios (sample-only; NOT part of the canonical wire contract)',
            tags: ['host-extension'],
          },
        },
        '/v1/host/openwop-app/test/evaluate-model-capability-gate': {
          post: {
            summary: 'RFC 0031 §B model-capability gate seam — drives model-capability-{substituted,insufficient} conformance scenarios with synthetic input (sample-only; NOT part of the canonical wire contract)',
            tags: ['host-extension'],
          },
        },
        '/v1/host/openwop-app/test/emit-envelope-reliability': {
          post: {
            summary: 'RFC 0032 §B envelope-reliability event emission seam — drives envelope-{retry.*,refusal,truncated,nlToFormat.engaged,recovery.applied} conformance scenarios via synthetic test-event-log emission with defense-in-depth credentialRef/recoveredContent rejection (sample-only; NOT part of the canonical wire contract)',
            tags: ['host-extension'],
          },
        },
      },
      tags: [
        { name: 'host-extension', description: 'Sample-only routes outside the canonical OpenWOP v1 wire contract. Vendor-prefixed under /v1/host/openwop-app/* per spec/v1/host-extensions.md.' },
      ],
    });
  });
}

function buildAdvertisement(config: AppConfig, req?: Request): Record<string, unknown> {
  // Honest advertise/enforce parity (capabilities.md): seam-only capabilities
  // are advertised ONLY when their (test-seam) implementation is reachable. A
  // default deploy claims only the production-wired surface — runTimeoutMs +
  // workspace (real executor wiring / real CRUD endpoints). This mirrors the
  // existing multiAgent/sandbox env-gating convention (a not-fully-wired
  // capability OMITS itself by default rather than over-claim in
  // /.well-known/openwop).
  const seamEnabled = process.env.OPENWOP_TEST_SEAM_ENABLED === 'true';
  const compactionEnabled = process.env.OPENWOP_TEST_TRIGGER_COMPACTION === 'true';
  const phase5 = process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5 === 'true';
  // RFC 0090 — execution-model version 6 (verifier turn + convergence). Additive
  // on the ladder: v6 implies v1..v5, so it requires phase5 (the stateful loop)
  // to be honest. Gated on OPENWOP_AGENT_VERIFIER_GATING; when set, the host runs
  // the RFC 0090 verifier as a commit gate (host/agentDispatch.ts runVerifier) and
  // serves POST /v1/host/openwop-app/agents/verify-run.
  const phase6 = phase5 && process.env.OPENWOP_AGENT_VERIFIER_GATING === 'true';
  const advertisement = {
    protocolVersion: '1.1',
    implementation: {
      name: config.serviceName,
      version: config.serviceVersion,
      vendor: config.serviceVendor ?? DEFAULT_SERVICE_VENDOR,
    },
    // Host-extension feature surfaces a workflow node can call via
    // `ctx.features.<id>` (ADR 0014). Non-normative (`host.sample.*`); advertised
    // at the document root (RFC 0073) so a client/pack can discover them. Honest:
    // only surfaces actually composed by an enabled-by-default-or-not feature
    // appear (derived from the live feature-surface registry). Per-tenant
    // register-time refusal (toggle off ⇒ refuse a workflow needing it) is the
    // enforcement counterpart and rides the existing peerDependency machinery.
    hostExtensions: {
      featureSurfaces: registeredFeatureSurfaceIds().map((id) => `host.sample.${id}`),
    },
    // Per spec/v1/capabilities.md §3 — REQUIRED top-level fields.
    // `supportedEnvelopes` is the AI Envelope kind catalog per RFC 0021
    // (NOT the transport list — that's `supportedTransports` below).
    // The 4 universal kinds are always advertised because the host
    // implements the AIEnvelopeAcceptor (host/envelopeAcceptor.ts) which
    // validates them against schemas/envelopes/<kind>.schema.json.
    // RFC 0055 §C: the three OPTIONAL media.* kinds are advertised because
    // the host ships their per-kind schemas + serves their assets
    // (routes/mediaAssets.ts). They are NOT universal (not in
    // universalEnvelopeKinds()) — a consumer that doesn't recognize them
    // falls back to raw rendering.
    // RFC 0102: `ui.a2ui-surface` is advertised because the host ships its
    // per-kind schema (schemas/envelopes/ui.a2ui-surface.schema.json, byte-
    // identical to core) AND the chat renderer actually renders the day-1
    // catalog v0.9.1 (frontend/react/src/chat/a2ui/) — honest-advertisement
    // per host-capabilities.md §"A2UI surface support" (fails closed under
    // OPENWOP_REQUIRE_BEHAVIOR=true otherwise). Like media.*, it is NOT
    // universal — an unrecognizing consumer falls back to store-without-render.
    supportedEnvelopes: [...universalEnvelopeKinds(), 'media.image', 'media.audio', 'media.file', 'ui.a2ui-surface'],
    schemaVersions: {
      runEvent: 1,
      capabilities: 1,
      // RFC 0021 §C: schemaVersions[<universal-kind>] MUST be 1 when the
      // host implements the per-kind schemas. The reference acceptor
      // ships v1 of all 4 universals.
      'clarification.request': 1,
      'schema.request': 1,
      'schema.response': 1,
      error: 1,
      // RFC 0055 §C media kinds (v1).
      'media.image': 1,
      'media.audio': 1,
      'media.file': 1,
      // RFC 0102 A2UI surface kind (v1).
      'ui.a2ui-surface': 1,
    },
    limits: {
      // Per capabilities.md §3 (CapabilityLimiter shape) — non-negative integers.
      clarificationRounds: 5,
      schemaRounds: 3,
      envelopesPerTurn: 32,
      maxNodeExecutions: 1000,
      // RFC 0058 — wall-clock ceiling per run; upper bound for
      // RunOptions.configurable.runTimeoutMs. Breach emits
      // cap.breached{kind:'run-duration'} + error run_timeout. MUST equal
      // RUN_DURATION_CEILING_MS in executor/executor.ts (advertise/enforce
      // must agree).
      maxRunDurationMs: 600_000,
      // RFC 0058 + RFC 0061 — ceiling on agent-loop iterations (orchestrator
      // turns). Advertised ONLY under phase5, when host/agentLoop.ts's
      // re-entrant loop (the surface that actually counts turns + breaches
      // cap.breached{kind:'loop-iterations'}) is advertised. The linear-walk
      // executeRun path does not count orchestrator turns, so claiming this
      // unconditionally would over-advertise an unenforced bound.
      ...(phase5 ? { maxLoopIterations: 100 } : {}),
      // RFC 0094 §H — maximum REST request body size the host accepts.
      // MUST equal the express.json default limit in src/index.ts
      // (`express.json({ limit: '1mb' })` ⇒ 1 MiB; advertise/enforce must
      // agree). The /v1/packs (50mb) and sample media (12mb) mounts are
      // larger vendor-scoped carve-outs; the canonical surface enforces this
      // value.
      maxRequestBodyBytes: 1_048_576,
    },
    // RFC 0064 — per-tool authorization + rate-limit + content-free audit.
    // This host demonstrates the contract through the
    // `POST /v1/host/openwop-app/toolhooks/invoke` seam (host/toolHooks.ts); the
    // live MCP `tools/call` path is not yet hooked. So advertise ONLY when
    // the seam is reachable (OPENWOP_TEST_SEAM_ENABLED) — never over-claim
    // toolHooks on a production deploy where no path emits the events.
    ...(seamEnabled
      ? {
          toolHooks: {
            supported: true,
            prePostEvents: true,
            perToolAuthorization: true,
            perToolRateLimit: true,
          },
        }
      : {}),
    // RFC 0052 — time-based run initiation. The once-per-tick + missed-tick
    // policy is demonstrated through the deterministic-clock
    // `POST /v1/host/openwop-app/scheduling/tick` seam (host/schedulingService.ts);
    // no clock yet fires real runs from the trigger node. Advertise ONLY when
    // the seam is reachable. `delayed`/`calendar` honestly absent.
    ...(seamEnabled
      ? {
          scheduling: {
            supported: true,
            cron: true,
            maxFutureHorizon: 'P30D',
          },
        }
      : {}),
    // RFC 0059 — durable, {tenant, workspace}-scoped file layer (host/
    // workspaceStore.ts). §C CRUD + If-Match/etag + maxFileBytes, §E WCT-1
    // owner isolation + WSR-1 SR-1 redaction. Not `versioned` (latest-only).
    workspace: {
      supported: true,
      maxFileBytes: 65_536,
    },
    // Kanban boards — sample host-extension (non-normative). Demonstrates
    // the RFCS/0086 "named workflow agents" work surface: a card landing
    // in a trigger column starts a workflow run (RFC 0086 §E keeps the
    // board itself a host/vendor extension, not a normative protocol
    // surface). Routes under `/v1/host/openwop-app/kanban/*`.
    kanban: {
      supported: true,
      features: ['boards', 'columns', 'cards', 'card-move-trigger'],
    },
    // RFC 0117 — front-end plugin packs. Advertised at the discovery ROOT (§6).
    // `isolation` is a schema const: `cross-origin-iframe` (in-process is a
    // protocol-tier MUST NOT). `supported: true` is HONEST because the host serves
    // the ui-plugin/1 RPC witness seam (POST /v1/host/openwop-app/ui-plugin/rpc) and
    // honors the closed allowlist + version-token concurrency. Read from the single
    // source of truth (host/uiPluginRpc.ts) so advertise/serve can't drift.
    // ADR 0168 — a CLIENT-PRESENTATION surface; withheld in OPENWOP_PROFILE=headless
    // (co-gated with the RPC seam mount in registerAllRoutes.ts), so a no-rendering-
    // client deploy doesn't advertise an iframe-render capability it won't serve.
    ...(presentationEnabled('uiPlugins') ? { uiPlugins: uiPluginsCapability() } : {}),
    // RFC 0118 — parallel sub-workflow fan-out + join. Advertised at the discovery ROOT
    // (§document-root). `fanOutSupported: true` + `"parallel"` in `fanOutPolicies` is HONEST
    // because the host serves the dispatch/fanout witness seam (POST /v1/host/openwop-app/
    // dispatch/fanout) running the real RFC 0118 join-fold + bounded-concurrency coordinator.
    // Read from the single source of truth (host/dispatchFanOut.ts) so advertise/serve can't drift.
    dispatch: dispatchCapability(),
    // RFC 0083 durable trigger bridge (the deferred reference durable-delivery).
    // The host runs the §B four-state machine + §C delivery model (dedup →
    // retry → dead-letter → causation) for `queue`-source subscriptions — the
    // Kanban card→run firing routes through it, emitting `trigger.delivery.
    // attempted` on the delivered run (with `causationId` = the delivery id).
    // Honest-advertisement note: the demo's run event log is run-scoped, so a
    // run-LESS `trigger.subscription.state.changed` (operator pause, retry-
    // exhaustion dead-letter — neither of which has a run) is recorded on the
    // subscription + surfaced via `GET /v1/trigger-subscriptions[/{id}]`
    // rather than emitted as a RunEvent. State + delivery attempts are durable
    // (survive restart) per `hostExtPersistence`.
    // RFC 0099 §F.3 — when external-event ingestion is wired (default; gate off
    // via OPENWOP_TRIGGER_INGESTION_ENABLED=false), the host ALSO ingests
    // webhook/email/form events → run (the `ingestion` sub-block + the widened
    // `sources[]`). The sub-block is the honesty gate: a source listed in
    // `ingestion.externalSources[]` MUST actually accept an external event,
    // normalize it to a `TriggerEvent`, and start a run (`triggerIngestionService`).
    // Absent ⇒ schedule/queue ingestion only (today's RFC 0083 behavior).
    triggerBridge: {
      supported: true,
      subscriptionStates: ['active', 'paused', 'failed', 'dead-lettered'],
      dedup: true,
      retryPolicy: { maxAttempts: 3, backoff: 'fixed' },
      sources: triggerIngestionEnabled() ? ['queue', 'webhook', 'email', 'form'] : ['queue'],
      ...(triggerIngestionEnabled()
        ? {
            ingestion: {
              externalSources: ['webhook', 'email', 'form'],
              maxBodyBytes: MAX_INGEST_BODY_BYTES,
              verification: ['webhook-signature', 'email-dmarc', 'form-origin'],
              registrationEndpoint: true,
            },
          }
        : {}),
    },
    supportedTransports: ['rest', 'sse'],
    stream: { modes: ['values', 'updates', 'messages', 'debug'] },
    // Conformance fixtures loaded from in-tree `conformance/fixtures/`
    // at boot. Each fixture id here is a workflowId the host can run
    // via `POST /v1/runs { workflowId }` — the openwop conformance
    // suite reads this top-level `fixtures` array (per
    // `conformance/src/lib/fixtures.ts:80` — `c.fixtures`) at suite
    // init to decide which fixture-gated scenarios apply to this
    // host. Mirrors the SQLite reference host's discovery shape.
    fixtures: listLoadedConformanceFixtures(),
    // Host extension: is this the public SHOWCASE deployment (vs a clean /
    // white-label install)? Drives the frontend's auto-seed gating + the
    // "Showcase data" badge. Default false — clean out of the gate.
    demoMode: demoMode(),
    capabilities: {
      // `openwop-auth-saml` (RFC 0050): the host validates SAML 2.0 assertions
      // via its real ACS (`host/auth/samlValidationService`) over the
      // `auth/saml/validate` seam — the full §A MUST list incl. the XSW
      // signature-wrapping defense is honored (proven non-vacuously by
      // `test/auth-saml.test.ts`), so the claim is honest (ADR 0002 finding C1).
      // The live behavioral conformance leg gates on an operator-supplied
      // synthetic IdP (`OPENWOP_TEST_SAML_IDP_URL`) and soft-skips otherwise.
      //
      // `openwop-auth-scim` (RFC 0050 §B): the host exposes SCIM `/scim/v2/{Users,
      // Groups}` + the `auth/scim/provision` seam (`routes/authScim`), upserting
      // RFC 0048 principals / group memberships and FAIL-CLOSED deactivation
      // (a deactivated principal no longer resolves — proven by
      // `test/auth-scim.test.ts`). Behavioral leg gates on `OPENWOP_TEST_SCIM_URL`.
      //
      // Advertised ONLY when the seam is actually reachable (review finding #10).
      auth: { profiles: advertisedAuthProfiles() },
      // RFC 0049 (`Draft`) role→scope authorization (ADR 0006 Phase 3).
      // `supported` tracks ACTUAL enforcement on the protocol surface
      // (runs/artifacts) + the `/v1/host/openwop-app/authorization/decide` seam —
      // both gated on `OPENWOP_AUTHORIZATION_ENFORCEMENT`. Advertised
      // `supported: true` ONLY when the host fail-closes on RFC 0049 scopes,
      // so the claim is never a false authorization-oracle (the conformance leg
      // `authorization-fail-closed.test.ts` runs non-vacuously iff this is on).
      authorization: authorizationCapability(),
      secrets: {
        supported: true,
        scopes: ['tenant', 'user', 'run'],
        resolution: 'host-managed',
      },
      // RFC 0095 §C — connection-pack support. `packsSupported` advertises that
      // the host installs `kind:"connection"` packs and resolves an RFC 0045/0047
      // `provider` string against installed `provider.id` values (the boot-time
      // connectionPackLoader). The built-in ADR 0024 provider registry is the
      // fallback catalog. The OAuth client secret stays host-side (ADR 0024 §7).
      connections: {
        supported: true,
        packsSupported: true,
      },
      // Spec-shaped per `spec/v1/capabilities.md:126-163` + `host-capabilities.md §host.aiProviders`.
      // Sample host wires three providers via raw fetch (see
      // `providers/dispatch.ts`); each requires BYOK. Tool-calling is
      // Anthropic-only for v1 (the only provider with a wired
      // tool_use loop in `providers/dispatchAnthropicTools.ts`).
      // Embeddings + image/video generation are NOT implemented — honestly
      // advertised so packs that depend on those sub-caps don't load.
      aiProviders: {
        // RFC 0108 §A.1: `selfHosted` ⊆ `supported`, so the opaque `compat` class
        // joins `supported` exactly when it is advertised (dark/[] otherwise).
        supported: ['anthropic', 'openai', 'google', 'minimax', ...hostAdvertisedSelfHosted()],
        byok: ['anthropic', 'openai', 'google'],
        // RFC 0108 §A — self-hosted / OpenAI-compatible provider class. DARK by
        // default; lights up (`['compat']`) only when OPENWOP_COMPAT_PROVIDER_ENABLED
        // + a reachable endpoint backs it (the §A.2 honesty rule). The id is opaque
        // and non-URL (§A.3); the endpoint location never appears here (§D).
        selfHosted: hostAdvertisedSelfHosted(),
        policies: {
          modes: ['disabled', 'optional', 'required', 'restricted'],
          scopes: ['workspace', 'project', 'canvas-type'],
          errorCode: 'provider_policy_denied',
        },
        toolCalling: { supported: true, providers: ['anthropic', 'openai', 'google'] },
        embeddings: { supported: true },
        // RFC 0116 — prompt-prefix cache. PROVIDER-SCOPED + key-gated: the host's
        // ADR 0148 A2 ephemeral prefix caching is Anthropic-specific, and is only
        // honestly advertisable where a real Anthropic provider is wired (a
        // managed ANTHROPIC_API_KEY, or the test-seam witness env). On the
        // MiniMax managed deployment neither is set ⇒ DARK (advertising Anthropic
        // prefix-caching on a MiniMax host would be the dishonest claim). The
        // cache is keyed by (tenant, cachePrefixId) for cross-tenant isolation;
        // cachePrefixId is a cost hint only (replay-invariant).
        ...(process.env.ANTHROPIC_API_KEY || process.env.OPENWOP_TEST_SEAM_ENABLED === 'true'
          ? { promptPrefixCache: { supported: true, providers: ['anthropic'] as const } }
          : {}),
        // Derived from the single source of truth `INPUT_MODALITIES`
        // (aiProvidersHost.ts) so the advertisement can never drift from what
        // assertModalitiesAdvertised() actually accepts (ADR 0085 Phase 1 —
        // kills the two-sources-of-truth honesty hazard). `audio` is advertised
        // here exactly because the host accepts an `{type:'audio'}` ContentPart.
        input: { modalities: [...INPUT_MODALITIES] },
        imageGeneration: { supported: imageGenerationAdvertised() }, // ADR 0115 — true only when a provider is configured
        videoGeneration: { supported: false },
        // RFC 0105 §B — speech synthesis (text-to-speech). The const string
        // "supported" (the locked shape, parallel to imageGeneration); routable
        // TTS providers are discovered via aiProviders.supported[] (minimax),
        // NOT a sub-field. Host routes via the managed MiniMax T2A path.
        speechSynthesis: 'supported',
        // RFC 0106 §A — real-time voice. Advertised because the methods/events are
        // WIRED (advertise+accept-in-lockstep — the ADR 0085 discipline), so the claim
        // stays honest under OPENWOP_REQUIRE_BEHAVIOR. `transcription: "streaming"`
        // = `ctx.callTranscriber` (P1/P2). `synthesis: "streaming"` (P3, requires
        // `speechSynthesis: supported`) = `callSpeechSynthesizer({stream:true})` →
        // `voice.synthesis_chunk` (§C). `turnDetection: "semantic"` (P1/P2) =
        // callTranscriber emits `voice.endpoint_candidate` DISTINCT from
        // `voice.turn_commit`. `bargeIn: "supported"` (P4) = the host emits the
        // `voice.barge_in` → `voice.cancelled` lifecycle and cancels in-flight
        // synthesis with NO partial leak (RFC 0106 §F `voice-bargein-no-partial-leak`),
        // demonstrated by the barge-in seam (a live mic SESSION is host-internal per §E).
        // HONESTY NOTE (updated ADR 0138): the `voice` feature now provides a PRODUCTION
        // voice loop (`/v1/host/openwop-app/voice/session/*` → `callTranscriber`/`/speak`/
        // `/barge-in`), so `bargeIn`/`transcription`/`synthesis` are exercised end-to-end, not
        // only by the reference seam. `turnDetection: 'semantic'` reflects the emitted
        // `voice.endpoint_candidate` event-taxonomy (the RFC 0106 §D wire shape) — NOT a
        // server-side semantic VAD: the current transport commits a turn on the client's
        // endpoint signal (utterance-buffered). A word-level streaming-ASR provider with real
        // semantic endpointing (ADR 0138 W7a, e.g. Deepgram Flux) makes the detection real
        // while keeping the same advertised shape. Survives OPENWOP_REQUIRE_BEHAVIOR — the
        // gated scenarios drive the taxonomy non-vacuously.
        // ADR 0168 — a CLIENT-PRESENTATION surface (browser mic capture); withheld in
        // OPENWOP_PROFILE=headless (co-gated with the voice-feature route mount), so a
        // no-rendering-client deploy doesn't advertise a mic capability it won't serve.
        ...(presentationEnabled('realtimeVoice')
          ? { realtimeVoice: { transcription: 'streaming', synthesis: 'streaming', turnDetection: 'semantic', bargeIn: 'supported' } }
          : {}),
        // RFC 0055 §C rule 2 — inline-vs-URL cap for media.* envelope payloads.
        // Assets above this size are served by a tenant-scoped URL
        // (GET /v1/host/openwop-app/assets/{token}) rather than inlined.
        maxInlineMediaBytes: MAX_INLINE_MEDIA_BYTES,
      },
      // RFC 0005 (MAS Phase 4) — the host implements `core.conversationGate`
      // (open/exchange/close) + honors the `conversation.*` suspend variants.
      // Advertising obligates the full contract (capabilities.md §conversationPrimitive).
      conversationPrimitive: true,
      // RFC 0101 (ADR 0040 Phase 6) — multi-party group conversation. This host
      // HONORS the normative shape on the existing RFC 0005 wire: a board-group
      // conversation carries a participant ROSTER (the `agent:<id>` members of its
      // `ConversationMeta`, snapshotted at `@@`-summon), every `role:'agent'` turn
      // carries an explicit `speakerId` (the agent instance id;
      // host/conversationExchange.ts), and a turn from a non-participant is
      // rejected fail-closed (host/multiPartyConversation.ts). `supported:true` is
      // an HONEST claim only because (2)+(3) are enforced — advertising it without
      // honoring would fail OPENWOP_REQUIRE_BEHAVIOR=true. `maxParticipants` is the
      // advisory-board cohort cap (ADR 0040 § fan-out caps).
      multiPartyConversation: { supported: true, maxParticipants: MAX_MULTI_PARTY_PARTICIPANTS },
      // RFC 0109 (ADR 0124 Phase 2d) — the host stamps `agent.model` ({provider, model})
      // on the answering agent's conversation turn (conversationExchange `makeTurn`).
      // `supported:true` is HONEST: the stamp ships (conversation-exchange resolves the
      // provider/model and writes it non-secret; verbatim on :fork). RFC 0109 is Accepted.
      conversationTurnModelProvenance: { supported: true },
      // RFC 0110 (ADR 0126 Phase 4) — channel presence. HONEST gate: advertised ONLY when
      // the operator opts in (`OPENWOP_CHANNEL_PRESENCE_ENABLED`) on a topology that can
      // honor it; the host then emits the ephemeral `channel.presence` event over the
      // membership-gated presence SSE. Default OFF ⇒ no advertisement (the demo's
      // multi-instance default; per-instance presence would be correct-but-partial).
      channelPresence: { supported: channelPresenceEnabled() },
      // RFC 0103 / i18n.md (ADR 0064) — the host negotiates Accept-Language →
      // Content-Language on its localizable content responses (the CMS read).
      // OPERATOR-CONFIGURED (OPENWOP_I18N_LOCALES): a host that hasn't enabled
      // localization advertises NOTHING here (advertise only what is honored).
      // Per RFC 0103 §A, i18n.defaultLocale == the content baseLocale and the
      // resolvable content locales are ⊆ i18n.supportedLocales.
      ...(hostI18nEnabled()
        ? { i18n: { supported: true, defaultLocale: hostDefaultLocale(), supportedLocales: hostSupportedLocales() } }
        : {}),
      // RFC 0103 §A — localized CONTENT delivery (ADR 0064 Phase 3). The host
      // serves GET /v1/content/pages/{slug} (the system-site projection),
      // negotiated. content.supported ⇒ i18n.supported; content.baseLocale ==
      // i18n.defaultLocale; ({base} ∪ content.supportedLocales) ⊆ i18n.supportedLocales;
      // baseLocale ∉ content.supportedLocales. Same operator gate as i18n.
      ...(hostI18nEnabled()
        ? { content: { supported: true, baseLocale: hostDefaultLocale(), supportedLocales: hostSupportedLocales().filter((l) => l !== hostDefaultLocale()) } }
        : {}),
      interrupts: {
        supported: true,
        kinds: ['approval', 'clarification', 'refinement', 'cancellation', 'external-event', 'conversation.start', 'conversation.exchange', 'conversation.close'],
        // `interrupt-profiles.md` (FINAL v1) catalogs optional
        // interrupt profiles. Sample claims only the profiles its
        // implementation actually backs end-to-end today:
        //
        //   - `openwop-interrupt-parent-child` — cancel cascade is
        //     wired in `routes/runs.ts` (walks `parentRunId`, cancels
        //     children + invalidates their open interrupts) and the
        //     `core.subWorkflow` node surfaces the child's open
        //     interrupt as a parent-side suspension. Conformance
        //     scenario `interrupt-parent-child-cascade.test.ts`
        //     passes; INTEROP-MATRIX row updated to match.
        //   - `openwop-interrupt-external-event` — `core.externalEvent`
        //     typeId + `interrupts/{token}` correlation matching are
        //     implemented; the `interrupt-external-event-correlation`
        //     scenario passes.
        //   - `openwop-interrupt-quorum` — multi-approver vote-counting
        //     to `requiredApprovals` + `rejectionPolicy: 'majority'`,
        //     backed by the durable `review:decision` ledger (ADR 0070;
        //     identity from the authenticated user where present, else
        //     the RFC 0093 capability-token `voter`; per-subject dedup).
        //     The `interrupt-quorum-resolution` conformance scenario
        //     passes against this host (3 accepts → completed; 2-of-3
        //     reject → terminal non-completed), verified under
        //     `OPENWOP_REQUIRE_BEHAVIOR=true`.
        //
        // Profiles NOT claimed (despite partial implementation):
        // `openwop-interrupt-auth-required` (auth path bears it via Bearer
        // enforcement but no signed-callback-token scoping yet).
        //
        // NOTE: the spec profile id for parent-cancel cascade is
        // `openwop-interrupt-cascade-cancel` (per `interrupt-profiles.md
        // §"openwop-interrupt-cascade-cancel"`). The conformance fixture
        // happens to use a `parent-child-cancel` slug but the canonical
        // profile id is the cascade-cancel one.
        profiles: [
          'openwop-interrupt-cascade-cancel',
          'openwop-interrupt-external-event',
          'openwop-interrupt-quorum',
        ],
      },
      // ADR 0075 / RFC 0104 (Active) — portable HITL approver routing. This host
      // resolves BOTH group and role approver refs (accessControl) against the
      // run's fail-closed org and targets notifications (`audience` default =
      // resolved eligibility union), enforced at resolve time exactly as
      // `approversList` (interrupt.md §"Portable approver routing"). Advertise only
      // the ref kinds actually honored — both, here.
      interrupt: { approverRouting: { supported: true, refKinds: ['group', 'role'], audience: true } },
      // `replay` mode (full deterministic re-execution from seq 0) IS
      // supported: the engine re-executes the workflow and the host compares
      // the observable run/node sequence against the source, emitting
      // `replay.diverged` on a mismatch (replay.md §"Failure surfaces").
      // `modes` is REQUIRED alongside `supported: true` (profiles.md
      // §`openwop-replay-fork`; pinned by replayDeterminism.test.ts) and
      // lists only `replay` — `branch` (re-execution from an arbitrary
      // `fromSeq` checkpoint with an overlay) is NOT advertised because the
      // sample doesn't reconstruct the executor's resume position, so a
      // partial-checkpoint branch would double-emit the prefix. The same
      // limit applies to mid-sequence replay: `POST :fork {mode:'replay'}`
      // refuses `fromSeq > 0` with 501 (routes/runs.ts). Honest split;
      // `fork: false` is the legacy spelling of that limitation, kept for
      // existing consumers.
      replay: { supported: true, modes: ['replay'], fork: false },
      // RFC 0115 — Run Transport Economy. The host emits a strong,
      // sequence-derived ETag and honors If-None-Match/304 on
      // GET /v1/runs/{runId}, and negotiates Content-Encoding on run reads.
      // `contentEncodings` is RUNTIME-DETECTED via the SAME constant the
      // run-read handler uses (host/restTransport.ts), so the advert can never
      // claim an encoding this Node build cannot serve (honest-witness rule).
      // On Node < 22.15 (no zstd in node:zlib) this advertises `["gzip"]`.
      restTransport: {
        conditionalRunGet: true,
        contentEncodings: SUPPORTED_RUN_ENCODINGS,
      },
      // RFC 0114 — A2UI surface delta transport. The recorded ui.a2ui-surface
      // envelope stays FULL (unchanged schema); the host delivers RFC 6902 delta
      // frames over the run-event stream to `?a2uiDelta=1` subscribers, full
      // materialized otherwise. Advertised iff the host actually serves it —
      // `a2uiDeltaTransportEnabled()` is the SINGLE gate shared with streams.ts
      // (no advert/serving drift). Default OFF (dark in prod until an operator
      // sets OPENWOP_A2UI_DELTA_TRANSPORT, or the test seam drives the witness).
      ...(a2uiDeltaTransportEnabled() ? { a2uiSurface: { deltaTransport: true } } : {}),
      // RFC 0056 — run feedback / annotations. The sample persists annotations
      // in a per-run side-store and serves POST/GET /v1/runs/{runId}/annotations
      // with secret-pattern + SR-1 redaction of correction/note.
      feedback: {
        supported: true,
        targets: ['run', 'event', 'node'],
        signals: ['rating', 'correction', 'label', 'flag'],
      },
      // Phase 1 of the multi-agent shift + RFC 0024 streaming. Sample
      // host emits both `agent.reasoned` (closing) AND
      // `agent.reasoning.delta` (streaming) events from the chat-responder
      // (`vendor.openwop-app.chat-responder`) for managed-provider
      // turns. Per-run override via `RunOptions.configurable.reasoningVerbosity`.
      agents: {
        supported: true,
        reasoning: { verbosity: 'full', tokenLimit: 512, streaming: true },
        // RFC 0070 — this host loads pack `agents[]` into an AgentRegistry
        // (RFC 0003 installAgents) and dispatches a manifest agent via the
        // floor seam (`POST /v1/host/openwop-app/agents/{agentId}/dispatch`),
        // enforcing toolAllowlist (§A14) + handoff schema validation (§D).
        manifestRuntime: { supported: true, handoffValidation: true },
        // RFCS/0086 reference impl — standing agent roster (named agent
        // instances owning a workflow portfolio). Sample host-extension
        // under `/v1/host/openwop-app/roster`; tenant-scoped. Non-normative
        // until RFC 0086 reaches Active.
        roster: { supported: true, installScope: 'tenant' },
        // RFCS/0087 reference impl — agent org-chart (departments/roles/
        // reportsTo over roster members + responsibility roll-up). DESCRIPTIVE
        // ONLY: an org edge confers no authority (org-position-no-authority-
        // escalation). Sample host-extension under `/v1/host/openwop-app/org-chart`;
        // tenant-scoped. Non-normative until RFC 0087 reaches Active.
        orgChart: { supported: true, installScope: 'tenant', departmentNesting: true, responsibilityView: true },
        // RFC 0096 reviewable-learning proposals — host-sample seam under
        // `/v1/host/openwop-app/proposals`. Advertised ONLY when
        // `OPENWOP_PROPOSALS_ENABLED=true` (advertise/enforce parity). `apply`
        // installs the stored byte image (no re-synthesis) and is fail-closed on
        // `packs:publish` (proven non-vacuously by `proposal-reviewable-learning`).
        // `rule` was dropped from the kind enum pre-Active; dup-detection not yet
        // implemented (honest default-false).
        ...(process.env.OPENWOP_PROPOSALS_ENABLED === 'true'
          ? {
              proposals: {
                artifactKinds: ['agent-pack', 'workflow-chain-pack', 'prompt-template', 'automation'],
                duplicationDetection: false,
                activation: proposalsActivationMode(),
              },
            }
          : {}),
        // RFC 0097 standing goals — host-sample seam under `/v1/host/openwop-app/goals`.
        // Advertised when `OPENWOP_GOALS_ENABLED=true`. Judge = `verifier` (this
        // host's verifier turn; `host` judge honest-omitted). Continuation modes
        // honored: schedule/commitment/manual (`heartbeat` omitted — no goal-
        // retrigger beat). `requiresBounds` true ⇒ create without RFC 0058 bounds
        // is 422 (`goal-standing-continuation`, non-vacuous).
        ...(process.env.OPENWOP_GOALS_ENABLED === 'true'
          ? {
              goals: {
                judge: 'verifier',
                continuation: ['schedule', 'commitment', 'manual'],
                requiresBounds: goalsRequiresBounds(),
              },
            }
          : {}),
      },
      // RFC 0098 portability — TOP-LEVEL capability (sibling of `agents`, not
      // nested). Host-sample seam `GET /v1/host/openwop-app/export` + `POST
      // /v1/host/openwop-app/import[?dryRun=]`. Advertised when
      // `OPENWOP_PORTABILITY_ENABLED=true`. openwop-app is the `import:true`
      // non-vacuous graduation witness (RFC 0098 Active→Accepted): import
      // rejects 422 a bundle carrying a literal credential value BEFORE applying
      // (`export-bundle-no-credential-material`), and `dryRun:true` makes zero
      // writes. `import:true ⟹ dryRun:true` (the schema if/then).
      ...(process.env.OPENWOP_PORTABILITY_ENABLED === 'true'
        ? {
            portability: {
              export: true,
              import: true,
              kinds: ['agent', 'pack', 'prompt-template', 'connection-ref', 'schedule', 'roster', 'org-chart'],
              dryRun: true,
            },
          }
        : {}),
      // RFC 0026 — `provider.usage` event support. Reference host emits
      // one `provider.usage` event per real LLM dispatch from
      // `aiProvidersHost.ts` (callAI / callAIWithTools / callAIManaged).
      // `costEstimates: true` because the dispatcher attaches advisory
      // `costEstimateUsd` for models in its static rate-table snapshot;
      // `currency: 'USD'` matches what `usageEmitter.ts` stamps.
      providerUsage: {
        supported: true,
        costEstimates: true,
        currency: 'USD',
      },
      // RFC 0027 — prompt-template resolution. Reference host loads
      // host-resident PromptTemplate fixtures from
      // `conformance-fixtures/prompt-templates/` (vendored from
      // `conformance/fixtures/prompt-templates/` by `sync-fixtures.sh`)
      // and exposes a `POST /v1/host/openwop-app/prompt/compose` test seam
      // that drives the conformance suite's `prompt.composed`
      // assertions. observability: 'full' is advertised so the
      // capability-gated scenarios `prompt-composed-secret-redaction`
      // and `prompt-composed-trust-marker` activate. The composed body
      // redaction + trust-marker invariants are enforced by
      // `composePromptTemplate()` in `host/promptCompose.ts`; the
      // SECURITY invariants `prompt-composed-secret-redaction` and
      // `prompt-composed-trust-marker` in `SECURITY/invariants.yaml`
      // gate the conformance assertions.
      // Sourced from `host/promptHostConfig.ts` so the discovery
      // advertisement and the dispatch-time compose+resolve calls in
      // `bootstrap/nodes.ts` can't drift apart. Production hosts
      // override the single config module rather than editing two
      // call sites.
      prompts: { ...getPromptsHostConfig() },
      // RFC 0030 envelope-track advertisement. The universal-kind payload
      // schemas (`schemas/envelopes/*.schema.json`) carry the OPTIONAL
      // `reasoning` field per RFC 0030 §A. The reference host injects a
      // system-prompt directive instructing the model to populate it when
      // the dispatched `responseSchema` declares a top-level `reasoning`
      // property — implemented by `host/envelopeDirective.ts` and wired
      // into `aiProviders/aiProvidersHost.ts` `dispatchStructured()`.
      // Default posture is `"advisory"` (suggestive); operators override
      // via `OPENWOP_ENVELOPE_REASONING_DIRECTIVE` ∈ {`off`, `advisory`,
      // `mandatory`}. The advertisement reads through the same accessor
      // (`host/envelopeReasoningConfig.ts`) so what the host advertises
      // and what it actually injects stay in lockstep.
      //
      // `tierOneSubsetCompliance: "warn"` is honest — the universal-kind
      // schemas use OpenAI-strict-incompatible constraints (minLength /
      // maxLength / minItems) that pre-date RFC 0030; the strict-mode
      // static scenario surfaces violations under `"strict"` advertisement
      // but soft-skips under `"warn"`. A future RFC may bring the
      // universal-kind schemas into Tier-1 strict compliance.
      envelopes: {
        reasoning: (() => {
          const cfg = getEnvelopeReasoningConfig();
          return { supported: cfg.supported, promptDirective: cfg.promptDirective };
        })(),
        tierOneSubsetCompliance: 'warn',
        // RFC 0032 §C envelope-reliability event vocabulary. The reference
        // host emits four events end-to-end from `dispatchStructured()`'s
        // retry loop (per-attempt failure classification → emit →
        // truncation-routing-aware retry per RFC 0033 §A/§B/§C):
        //   - envelope.retry.attempted (per RFC 0032 §B.1, on attempt ≥ 2)
        //   - envelope.retry.exhausted (MUST-tier per RFC 0032 §C)
        //   - envelope.refusal (MUST-tier per RFC 0032 §C)
        //   - envelope.truncated (SHOULD-tier per RFC 0032 §B.4)
        // The MAY-tier `envelope.recovery.applied` event IS advertised:
        // dispatchStructured tries lenient parsing (markdown-fence
        // strip, balanced-brace walker) before declaring a parse-error
        // and emits the event when a recovery path engages (RFC 0032
        // §B.6 + `envelopeReliabilityEmit.ts:tryLenientParse`). The
        // remaining MAY-tier event (`envelope.nlToFormat.engaged`) is
        // OMITTED until NL-to-Format fallback lands — that recovery
        // strategy isn't implemented yet. The seam still accepts both
        // for conformance shape assertions.
        //
        // RFC 0033 §E `distinguishesTruncation: true` — the retry loop
        // inspects `finishReason: 'length'` and routes truncation through
        // a budget-multiplied retry per `OPENWOP_ENVELOPE_RELIABILITY_
        // TRUNCATION_MULTIPLIER` (default 2) WITHOUT applying the schema-
        // correction fragment. Schema-violation continues to retry with
        // the corrective fragment + unchanged budget per RFC 0033 §C.
        //
        // Operator circuit-breaker: `OPENWOP_ENVELOPE_RELIABILITY_END_TO_END
        // =false` falls back to legacy undifferentiated retry (no events,
        // no truncation routing) — the advertisement honors the toggle.
        reliability: (() => {
          const rel = getEnvelopeReliabilityConfig();
          if (!rel.endToEndEnabled) {
            return {
              supported: true,
              events: [],
              maxRetryAttempts: rel.maxRetryAttempts,
              completion: {
                distinguishesTruncation: false,
                truncationBudgetMultiplier: rel.truncationBudgetMultiplier,
              },
            };
          }
          return {
            supported: true,
            events: [
              'envelope.retry.attempted',
              'envelope.retry.exhausted',
              'envelope.refusal',
              'envelope.truncated',
              'envelope.recovery.applied',
              'envelope.nlToFormat.engaged',
            ],
            maxRetryAttempts: rel.maxRetryAttempts,
            completion: {
              distinguishesTruncation: true,
              truncationBudgetMultiplier: rel.truncationBudgetMultiplier,
            },
          };
        })(),
      },
      // RFC 0031 §E. The executor evaluates `NodeModule.requiredModelCapabilities`
      // at dispatch-time against the host's configured default provider AND
      // emits `model.capability.{substituted,insufficient}` events per
      // RFC 0031 §D. `substitutionSupported: false` by default — the
      // sample's `dispatchPlain()` doesn't yet intercept per-call provider
      // selection; operators that wire the interception set
      // OPENWOP_MODEL_CAPABILITY_SUBSTITUTION=true. `advertised[]` is the
      // union of capabilities the host knows each provider in
      // `aiProviders.supported[]` offers (per `host/modelCapabilityProbe.ts`).
      modelCapabilities: (() => {
        const cfg = getModelCapabilityGateConfig();
        return {
          supported: cfg.supported,
          advertised: cfg.advertised,
          substitutionSupported: cfg.substitutionSupported,
        };
      })(),
      // `supported: false` — no standard four-op MemoryAdapter; this demo
      // only does host-internal run-summary writes + the read-side
      // (GET /v1/host/openwop-app/memory). RFC 0057: it DOES attribute those
      // writes via the content-free `memory.written` event, so it advertises
      // attribution independently of the adapter contract.
      // RFC 0012 — compaction. The host distills its internal longTerm
      // entries into one SR-1-redacted archive + emits `memory.compacted`,
      // but the ONLY trigger is the `/v1/test/memory/{seed,compact}` seam
      // (gated on OPENWOP_TEST_TRIGGER_COMPACTION) — there is no automatic
      // host-managed or production client trigger. So advertise compaction
      // ONLY when that seam is reachable, never on a default deploy.
      memory: {
        supported: false,
        attribution: { supported: true, emitsWriteEvents: true },
        ...(compactionEnabled ? { compaction: { supported: true, trigger: 'both' } } : {}),
        // RFC 0113 — the memory read (`GET /v1/host/openwop-app/memory`) honors a
        // `tokenBudget` that bounds the cumulative SIZE of the returned set
        // (over-budget entries omitted whole, never truncated; ≥1 kept), reusing
        // the ADR 0148 A4 `budgetByChars` primitive. The unit is content CHARS,
        // declared honestly as `tokenCounter: "chars"` (this host counts chars,
        // not BPE tokens). Ranking is recency-only — `memory.search` semantic
        // (`modes:["semantic"]`) is NOT advertised, so per RFC 0113 `rank:"relevance"`
        // is not offered.
        injectionBudget: { supported: true, tokenCounter: 'chars' as const },
      },
      // RFC 0023 §B.2 — capabilities.conformance.mockAgent. Advertised
      // only when the conformance-only nodes are actually registered
      // (conformanceNodesEnabled() — on for dev/test/conformance, off by
      // default under NODE_ENV=production unless explicitly enabled). The
      // registration in bootstrap/nodes.ts reads the SAME switch, so the
      // advertisement can never claim a typeId the host didn't register.
      conformance: { mockAgent: conformanceNodesEnabled() },
      // RFC 0025 — test-mode mirror namespace advertisement. The
      // /v1/packs-test/* routes (routes/packs-test.ts) only mount when
      // OPENWOP_PACKS_TEST_NAMESPACE_ENABLED=true; we advertise the
      // capability only when the seam is mounted, so a conformance
      // suite that finds the advertisement is guaranteed to find
      // serving endpoints. The reference impl persists test-mode packs
      // to a module-scoped in-memory Map distinct from the production
      // catalog (which the reference doesn't even ship — production
      // pack storage is delegated to packs.openwop.dev), so the §C
      // isolation guarantee holds trivially. `catalogResetEndpoint`
      // points at POST /v1/packs-test/reset for suite teardown.
      ...(process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED === 'true'
        ? {
            packs: {
              testMode: {
                supported: true,
                isolated: true,
                catalogResetEndpoint: '/v1/packs-test/reset',
                scopes: ['core', 'vendor', 'community'] as const,
              },
            },
          }
        : {}),
      // capabilities.schema.json §webhooks: full register/deliver surface —
      // HMAC-signed deliveries (scheme `v1` per webhooks.md §"Signature
      // algorithm versioning"), durable retry queue NOT advertised as the
      // RFC 0083 trigger-bridge `durable` mode (the host's internal retry
      // queue is best-effort-plus, not the four-state subscription model).
      webhooks: { supported: true, signed: true, signatureAlgorithms: ['v1'], durable: false },
      // RFC 0100 §1 — the `a2a` capability slot. Advertised ONLY when this host
      // actually exposes itself as an A2A agent (OPENWOP_A2A_SERVER_ENABLED) —
      // otherwise a cross-host caller would feature-detect an A2A surface that
      // 404s. `durableTasks`/`pushNotifications` are honest only when
      // the durable wiring (ADR 0035 / a2aTaskStore) is on
      // (OPENWOP_A2A_DURABLE_TASKS); with it off this is the synchronous
      // round-trip already specified — no regression, the async conformance
      // subtests soft-skip. `streaming` is DECOUPLED from `durableTasks` onto its
      // own `OPENWOP_A2A_STREAMING` flag (default off) so it advertises
      // `false` here: openwop-conformance 1.34.0 ships no `tasks/resubscribe`
      // gated subtest ("resubscribe" is comment-only), so `streaming:true` would
      // be a vacuous claim that also commits us to a resubscribe re-attach we
      // don't serve. The JSON-RPC server still serves resubscribe; flip the flag
      // (a clean zero-witness follow-on) once that conformance subtest ships.
      // `agentCardUrl` points at the GET-able static v0.3 AgentCard at
      // `/.well-known/agent-card.json` (agents.ts) — a plain GET resolves it
      // without a credential (public path), the honesty bar a JSON-RPC-only
      // (POST `agent/getCard`) pointer can't meet. The base MUST be a cross-host-reachable
      // backend origin (else `supported:true` is a dishonest advertisement —
      // capabilities.md advertise-honestly): a dedicated
      // `OPENWOP_A2A_PUBLIC_BASE_URL` override (custom-domain backends), else the
      // forwarded request origin the caller actually reached us on. We do NOT
      // reuse `OPENWOP_PUBLIC_BASE_URL` — that is the SPA/OAuth origin
      // (oauthFlow.ts), and the SPA host only routes `/api/**` to this backend,
      // not the bare `/v1/...` A2A path.
      ...(process.env.OPENWOP_A2A_SERVER_ENABLED === 'true'
        ? (() => {
            const durable = process.env.OPENWOP_A2A_DURABLE_TASKS === 'true';
            const override = process.env.OPENWOP_A2A_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
            const base = override || (req ? requestOrigin(req) : 'http://localhost:8080');
            return {
              a2a: {
                supported: true,
                agentCardUrl: `${base}/.well-known/agent-card.json`,
                streaming: process.env.OPENWOP_A2A_STREAMING === 'true',
                pushNotifications: durable,
                durableTasks: durable,
              },
            };
          })()
        : {}),
      observability: {
        otel: { namespace: 'openwop' },
        // RFC 0034 — OTel collector test seam advertisement. The two test
        // endpoints (GET /v1/host/openwop-app/test/otel/spans and POST
        // /v1/host/openwop-app/test/debug-bundle/export) live in routes/testSeam.ts
        // and only mount when OPENWOP_TEST_SEAM_ENABLED=true. We advertise the
        // capability only when the seam is mounted, so a conformance suite
        // that finds the advertisement is guaranteed to find serving endpoints.
        // Hosts that don't enable the seam advertise nothing here; the
        // envelope-reasoning-secret-redaction scenario's downstream-projection
        // assertions then soft-skip per spec/v1/observability.md §"OTel
        // collector test seam (RFC 0034)".
        ...(process.env.OPENWOP_TEST_SEAM_ENABLED === 'true'
          ? { testSeams: { otelScrape: true, debugBundleExport: true } }
          : {}),
      },
      // RFC 0035 — sandbox-vm MVP advertisement. The node:vm-based
      // sandbox executes synthetic misbehaving packs via the
      // POST /v1/host/openwop-app/test/sandbox-{load,invoke} seams in
      // routes/testSeam.ts. Advertised only when OPENWOP_TEST_SANDBOX_MVP=true
      // is set — the MVP is conformance-only (production deployments use
      // wasmtime/nsjail for real isolation).
      //
      // The MVP proves 5 of 8 RFC 0035 §B failure-mode invariants by
      // construction:
      //   - host-fs-escape, host-env-leak, network-escape, host-process-escape
      //     (node:vm context omits these globals → access throws)
      //   - sandbox-timeout (vm.runInNewContext timeout option)
      // The other 3 invariants either require a JS-runtime-specific test
      // (sandbox-no-eval), graduate by construction (cross-pack-mutation —
      // each invocation gets a fresh context), or need the host's
      // allowedHostCalls config (capability-gate-respected — implemented
      // via the Proxy host object).
      ...(process.env.OPENWOP_TEST_SANDBOX_MVP === 'true'
        ? {
            sandbox: {
              supported: true,
              isolationModel: 'vm' as const,
              wallClockLimitMs: 1000,
              memoryLimitBytes: 16 * 1024 * 1024,
              allowedHostCalls: ['fetch'] as const,
            },
          }
        : {}),
      // RFC 0037 Phase 1 — multi-agent execution model + handoff state
      // machine. Env-gated so the reference workflow-engine advertises
      // the capability only when the operator opts in; otherwise the
      // existing RFC 0007/0022 dispatch loop runs without emitting
      // `core.workflowChain.event` records (preserving the
      // pre-RFC-0037 wire surface for back-compat). When advertised,
      // every supervisor-driven `core.dispatch` invocation emits the
      // 7 handoff state-machine transition events per
      // `spec/v1/multi-agent-execution.md` §"Handoff state machine".
      // RFC 0037 Phase 1 = version 1; RFC 0039 Phase 2 = version 2. Operator
      // env-flags select the implemented ceiling: setting
      // OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2=true requires
      // OPENWOP_MULTI_AGENT_EXECUTION_MODEL=true too (Phase 2 builds on Phase
      // 1). The confidenceEscalationFloor advertisement defaults to 0.5
      // (the spec floor) and can be tightened via
      // OPENWOP_MULTI_AGENT_CONFIDENCE_FLOOR=<n> per RFC 0039 §A.
      // When NEITHER phase env-flag is set, the `multiAgent` block is
      // OMITTED entirely — advertising `{supported: false, version: 1}` is
      // honest-but-confusing ("version 1 of an unimplemented feature"); the
      // capabilities.schema.json makes the block optional precisely so
      // non-implementers can stay silent. Capability-gated conformance
      // scenarios soft-skip on absence per the existing convention.
      ...(process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL === 'true'
        ? (() => {
            // RFC 0061 — version 5 (stateful agent-loop lifecycle). Ladder is
            // additive: phase5 ⇒ phase4 ⇒ … ⇒ phase1. A `version: 5`
            // advertisement is only honest when the re-entrant loop with the
            // observable per-turn `iteration` counter (host/agentLoop.ts) +
            // statefulResume are implemented.
            // `phase5` is hoisted at the buildAdvertisement scope (also gates
            // limits.maxLoopIterations); reuse it here.
            const phase4 = process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4 === 'true' || phase5;
            // The execution-model ladder is ADDITIVE: a host advertising
            // version N MUST implement phases 1..N (capabilities.schema.json
            // §multiAgent.executionModel.version). So a higher phase implies
            // every lower phase — phase4 ⇒ phase3 ⇒ phase2 ⇒ phase1. RFC 0040
            // Phase 3 (cross-host causation) is the rung between confidence
            // escalation (Phase 2) and replay determinism (Phase 4); a
            // `version: 4` advertisement is only honest when Phase 3 is
            // implemented too (the ancestry endpoint + crossHostCausation).
            const phase3 = isPhase3Enabled();
            const phase2 = process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2 === 'true' || phase3;
            const floorRaw = process.env.OPENWOP_MULTI_AGENT_CONFIDENCE_FLOOR;
            const floor = (() => {
              const parsed = floorRaw === undefined ? 0.5 : Number(floorRaw);
              if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 1.0) return 0.5;
              return parsed;
            })();
            // Version advertisement is the ceiling of phases the host
            // implements per RFCS/0037-multi-agent-execution-model.md §"Phases".
            const version = phase6 ? 6 : phase5 ? 5 : phase4 ? 4 : phase3 ? 3 : phase2 ? 2 : 1;
            return {
              multiAgent: {
                executionModel: {
                  supported: true,
                  version,
                  ...(phase2 ? { confidenceEscalationFloor: floor } : {}),
                  // RFC 0040 §D — cross-host causation. A host advertising
                  // version >= 3 MUST advertise this sub-block with
                  // `supported: true` + a stable `hostId`; this host also
                  // serves `GET /v1/runs/{runId}/ancestry` (Phase-3 §C).
                  ...(phase3
                    ? {
                        crossHostCausation: {
                          supported: true,
                          hostId: CROSS_HOST_CAUSATION_HOST_ID,
                          ancestryEndpointSupported: true,
                        },
                      }
                    : {}),
                  // RFC 0041 §D — replayDeterminism advertisement. Hosts
                  // advertising `version: 4` MUST advertise this sub-block
                  // with `supported: true` and
                  // `refusalDivergenceEmission: true`. The LLM cache-key
                  // recipe is the spec-canonical
                  // `spec-rfc-0041` for the reference impl.
                  ...(phase4
                    ? {
                        replayDeterminism: {
                          supported: true,
                          llmCacheKeyRecipe: 'spec-rfc-0041',
                          refusalDivergenceEmission: true,
                        },
                      }
                    : {}),
                  // RFC 0061 §A/§D — version 5: a clarify/escalate suspend
                  // resumes the loop at the same iteration with the snapshot
                  // lineage + iteration counter intact (host/agentLoop.ts).
                  ...(phase5 ? { statefulResume: true } : {}),
                  // RFC 0090 §B — verifier turn + gating. A host advertising
                  // `version: 6` MUST advertise this block; `gating: true` means a
                  // `fail` verdict blocks the commit (merge/terminate) — the host
                  // serves POST /v1/host/openwop-app/agents/verify-run to prove it.
                  ...(phase6 ? { verifier: { supported: true, gating: true } } : {}),
                },
              },
            };
          })()
        : {}),
      runtimeCapabilities: listCapabilities(),
      // Host surface registry — what `ctx.*` surfaces this host wires.
      // The catalog endpoint cross-references this to mark each node
      // as runnable-here or "needs host.X".
      hostSurfaces: listHostSurfaces(),
      // RFC 0014 — host.fs capability block (canonical spec shape).
      // Mirrors the host-surface-registry advertisement so generic
      // openwop clients can read the standard shape from
      // `capabilities.fs.{supported,sandboxRoot,maxFileSizeBytes}`.
      fs: (() => {
        const root = getFsSandboxRoot();
        if (!root) return { supported: false };
        return {
          supported: true,
          sandboxRoot: root,
          maxFileSizeBytes: 50 * 1024 * 1024, // 50 MiB
        };
      })(),
      // RFC 0015 — host.kvStorage. In-memory adapter advertises full
      // surface; restart wipes state.
      kvStorage: {
        supported: true,
        maxKeyBytes: 1024,
        maxValueBytes: 1024 * 1024, // 1 MiB
        maxTtlSeconds: 7 * 24 * 60 * 60, // 7 days
        atomicIncrement: true,
        compareAndSwap: true,
      },
      // RFC 0016 — host.tableStorage.
      tableStorage: {
        supported: true,
        maxRowsPerTable: 100000,
        maxColumnsPerRow: 128,
        indexable: false,
        fullTextSearch: false,
      },
      // RFC 0017 — host.queueBus. Demo backend; in-memory pub/sub.
      queueBus: {
        supported: true,
        backends: ['in-memory'] as const,
        deadLetterSupported: true,
        stream: { supported: false, fromBeginning: false },
      },
      // RFC 0018 — host.sql via sqlite-in-memory.
      sql: {
        supported: true,
        transactions: true,
        drivers: ['sqlite'] as const,
      },
      // RFC 0018 — host.vectorStore via brute-force cosine over in-memory Map.
      vectorStore: {
        supported: true,
        backends: ['in-memory'] as const,
      },
      // RFC 0019 — host.blobStorage. presign() returns a synthetic data: URL.
      blobStorage: {
        supported: true,
        presignSupported: true,
        maxObjectBytes: 50 * 1024 * 1024, // 50 MiB
      },
      // RFC 0071/0075 — host artifact-type registry (ADR 0055). Host-native types
      // only in v1; schemas served at the schemaEndpoint; per-type export facets.
      artifactTypes: {
        supported: true,
        schemaEndpoint: '/schemas/artifacts',
        types: listArtifactTypes().map((t) => ({
          artifactTypeId: t.artifactTypeId,
          title: t.title,
          schemaUrl: `/schemas/artifacts/${t.artifactTypeId}.schema.json`,
          export: t.export,
          registrationSource: t.registrationSource,
        })),
      },
      // RFC 0019 — host.cache.
      cache: {
        supported: true,
        maxValueBytes: 1024 * 1024, // 1 MiB
        maxTtlSeconds: 24 * 60 * 60, // 24 hours
      },
      // RFC 0020 — host-side MCP server composition. Sample host
      // exposes workflows as MCP tools/resources/prompts when
      // OPENWOP_MCP_SERVER_ENABLED=true. Endpoint:
      // POST /v1/host/openwop-app/mcp (sample-vendor-namespaced).
      //
      // Wire shape (per spec/v1/mcp-integration.md §"Conformance +
      // interop"): a top-level `mcp` slot with `supported: boolean`
      // and (when supported) `serverUrls: string[]`. Sample-specific
      // detail (transports, sampling/elicitation bridges) lives
      // under `mcp.serverMount` so it's namespaced without breaking
      // the canonical discoverability contract.
      mcp: process.env.OPENWOP_MCP_SERVER_ENABLED === 'true'
        ? {
            supported: true,
            serverUrls: ['/v1/host/openwop-app/mcp'],
            serverMount: {
              supported: true,
              transports: ['streamable-http'] as const,
              samplingBridge: true,
              elicitationBridge: true,
            },
          }
        : {
            supported: false,
            serverUrls: [],
            serverMount: { supported: false },
          },
      // RFC 0078 — the read-only `GET /v1/tools` + `/v1/tools/{toolId}` portable
      // tool-catalog projection (ADR 0087). Advertised ONLY when the MCP server is
      // mounted (the catalog projects the `mcp` source — e.g. the notebook tools);
      // the endpoints 404 + this is absent otherwise (honest, OPENWOP_REQUIRE_BEHAVIOR
      // clean). `sources: ['mcp']` because that is the only source this host projects.
      ...(process.env.OPENWOP_MCP_SERVER_ENABLED === 'true'
        ? {
            toolCatalog: {
              supported: true,
              sources: ['mcp'] as const,
              // RFC 0112 — compact tool projection (`GET /v1/tools?view=compact`).
              // The route ships ready, but the capability is advertised ONLY when
              // OPENWOP_TOOLCATALOG_COMPACTVIEW=true — held dark until RFC 0112 is
              // Accepted (honest-advert rule; the steward flips it on Accepted +
              // the published 1.39.0 conformance scenario).
              ...(process.env.OPENWOP_TOOLCATALOG_COMPACTVIEW === 'true'
                ? { compactView: true }
                : {}),
            },
          }
        : {}),
    },
    extensions: {
      // Sample-namespace extensions block. Clients tolerate absence.
      'openwop-app.notes': 'This is the openwop reference application sample. Not production-hardened.',
    },
    // Governed-workforce surface (EP0) — EXPERIMENTAL host extension under the
    // canonical `x-host-<host>-<key>` prefix (host-extensions.md). NOT a spec
    // capability: it advertises the demo's read-only Workforce entity +
    // telemetry, gated so the published SDK/conformance never depend on it
    // until the `openwop-workforce-governance` profile RFC lands. Booleans are
    // honest against what the host actually implements today.
    'x-host-openwop-workforce': {
      tier: 'experimental',
      workforces: { supported: true, readOnly: true },
      governance: { policyTags: true, refusalBoundaries: true, approvalGates: true },
      // replay is genuinely supported (see `replay` family above). `evals` is an
      // EXPERIMENTAL host-ext (a `live-shadow` eval of the workforce supervisor,
      // POST …/workforces/:id/eval), gated on OPENWOP_AGENT_EVAL_SUITE_ENABLED —
      // NOT the normative RFC 0081 `agents.evalSuite` surface (mode:"eval" run
      // projection + GET /v1/runs/:id/eval-summary), which is a follow-up. So
      // this stays under the experimental host-ext tier and does not set the
      // normative `agents.evalSuite` capability. shadow-mode wire is honestly absent.
      assurance: { replay: true, evals: evalSuiteEnabled(), shadow: false },
      ...(evalSuiteEnabled()
        ? {
            eval: {
              supported: true,
              surface: 'host-ext',
              mode: 'live-shadow',
              suiteId: 'openwop-app.evals.invoice-exception',
            },
          }
        : {}),
      autonomyTiers: ['review', 'guided', 'auto'],
    },
  };
  // RFC 0073 — capability families are document-root properties of the
  // discovery response (capabilities.schema.json roots agents/secrets/etc.;
  // there is no `capabilities` wrapper property). Emit them at the root
  // canonically, and retain the nested `capabilities` object as a DEPRECATED
  // backward-compat mirror for the v1.x migration window (removed once
  // consumers migrate — see spec/v1/capabilities.md §"Document-root layout").
  // No family key collides with a root field, so the spread is order-safe.
  return { ...advertisement, ...advertisement.capabilities };
}
