/**
 * openwop-workflow-engine — Cloud Run entry point.
 *
 * Express bootstrap mirroring the shape of myndhyve/services/workflow-runtime
 * but with neutral substitutes for everything product-specific:
 *   - sqlite (not Firestore) for storage
 *   - in-memory secret resolver (not KMS) for BYOK
 *   - synthetic Bearer principal (not Firebase Auth) for identity
 *   - inline dispatch (not Cloud Tasks) for run execution
 *
 * Each substitute is pluggable — see src/host/index.ts and src/storage/.
 */

import express, { type Express } from 'express';
import { createTracer, shutdownTracer } from './observability/tracer.js';
import { createMetrics, shutdownMetrics } from './observability/metrics.js';
import { createLogger } from './observability/logger.js';
import { APP_VERSION } from './version.js';
import { recordAppVersion } from './host/appVersion.js';
import { logWebhookEgressPosture } from './host/webhookEgressGuard.js';
import { initHostExtPersistence } from './host/hostExtPersistence.js';
import { loadPackTombstones } from './host/packTombstones.js';
import { loadPackRevocations } from './host/packRevocations.js';
import { logIsolationMemoryBudgetAtBoot } from './host/isolation/childProcessAdapter.js';
import { isEntryModule } from './host/entryModule.js';
import { traceContextMiddleware } from './middleware/traceContext.js';
import { httpMetricsMiddleware } from './middleware/httpMetrics.js';
import { authMiddleware, sessionSecretConfigError } from './middleware/auth.js';
import { workloadIdentityMiddleware } from './middleware/workloadIdentity.js';
import { wireAuthorityRunStamping } from './host/authorityContext.js';
import { ipRateLimitMiddleware } from './middleware/rateLimit.js';
import { a2aInterfaceErrorsMiddleware } from './middleware/a2aInterfaceErrors.js';
import { corsMiddleware } from './middleware/cors.js';
import { csrfOriginGuard } from './middleware/csrf.js';
import { customDomainMiddleware } from './middleware/customDomain.js';
import { protocolVersionMiddleware } from './middleware/protocolVersion.js';
import { registerConformanceSeamAlias } from './routes/conformanceSeams.js';
import { bodyParseErrorHandler } from './middleware/bodyParseError.js';
import { v2IdentityMiddleware } from './middleware/v2Identity.js';
import { attachCollabWebSocket } from './host/collab/collabServer.js';
import { errorEnvelopeMiddleware } from './middleware/errorEnvelope.js';
import { isSessionAuthorityRegistered } from './host/sessionAuthority.js';
import { subjectLinkRealmAlignment } from './host/auth/subjectLinkService.js';
import { requestTimeoutMiddleware } from './middleware/requestTimeout.js';
import { jsonGzipMiddleware } from './middleware/jsonGzip.js';
import { ensureNodesRegistered } from './bootstrap/nodes.js';
import { ensureSuspendManagerInstalled } from './bootstrap/suspend.js';
import { ensureEventLogInstalled } from './bootstrap/eventLog.js';
import { ensureInvocationLogInstalled } from './bootstrap/invocationLog.js';
import { ensureRuntimeCapabilityRegistryInstalled } from './bootstrap/runtimeCapabilityRegistry.js';
import { ensureNodePackResolverInstalled } from './bootstrap/nodePackResolver.js';
import { ensureAgentPackResolverInstalled } from './bootstrap/agentPackResolver.js';
import { ensureFeatureDefaultOrgs } from './host/featureDefaultOrgs.js';
import { setDefaultWorkspaceTargets } from './host/workspaceJoinLedger.js';
import { ensureRegistryPacksInstalled } from './bootstrap/installRegistryPacks.js';
import { featurePackRefs, featureDefaultOrgs } from './features/index.js';
import { ensureLocalPacksMounted } from './bootstrap/mountLocalPacks.js';
import { loadPromptPacks, defaultPromptPackRoots } from './host/promptPackLoader.js';
import { loadConnectionPacks, defaultConnectionPackRoots } from './features/connections/connectionPackLoader.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots } from './host/workflowChainPackLoader.js';
import { loadCanvasContentPacks, defaultCanvasContentPackRoots } from './host/canvasContentPackLoader.js';
import { loadFormContentPacks, defaultFormContentPackRoots } from './host/formContentPackLoader.js';
import { registerHostSurfacesV2Extension, seedDefaultHostSurfaces } from './bootstrap/hostSurfaceRegistry.js';
import { registerAiProvidersV2Extension } from './routes/discovery.js';
import { seedHostArtifactTypes } from './host/artifactTypes.js';
import { loadArtifactTypePacks, defaultArtifactTypePackRoots } from './host/artifactTypePackLoader.js';
import { seedShowcaseWorkforces } from './host/workforceService.js';
import { withinBootBudget } from './host/bootBudget.js';
import { demoMode } from './host/demoMode.js';
import { initInMemorySurfaces } from './host/inMemorySurfaces.js';
import { initDurableSurfaces } from './host/durable/durableKv.js';
import { registerS3BlobAdapter } from './host/blob/s3Blob.js';
import { registerOpenSearchAdapter } from './host/search/openSearchSearch.js';
import { registerPgVectorAdapter } from './host/vector/pgVectorVector.js';
import { registerPgSqlAdapter } from './host/sql/pgSql.js';
import { setChatStorage } from './host/chatSurface.js';
import { setKanbanTriggerDeliveryDeps } from './host/kanbanTriggerDelivery.js';
import { setWarehouseLoadStorage } from './features/destination-sync/warehouseLoadService.js';
import { openStorage } from './storage/index.js';
import type { Storage } from './storage/storage.js';
import { createHostAdapterSuite, type HostAdapterSuite } from './host/index.js';
import { startWebhookDeliveryWorker } from './host/webhookDeliveryWorker.js';
import { startRunDispatchSweeper } from './host/runDispatchSweeper.js';
import { registerCardRunRecovery } from './host/cardRunRecovery.js';
import { registerKanbanWorkItemLifecycle, startKanbanWorkItemDaemon } from './host/kanbanWorkItemDaemon.js';
import { startScheduleDaemon } from './host/scheduleDaemon.js';
import { backfillApprovalIndexes } from './host/approvalService.js';
import { pruneOrphanedConfigs } from './host/featureToggles/service.js';
import { startConnectionsRefreshDaemon } from './features/connections/refreshDaemon.js';
// WF-KB-3 / KSWF-1 — the recurring knowledge sync is now a per-source scheduler job
// firing the `knowledge-sync.run` workflow (the gmailSync twin); the bespoke daemon
// is deleted. `backfillKnowledgeSyncJobs` migrates pre-existing sources once at boot.
import { startTimerSweepDaemon } from './host/timerSweepDaemon.js';
import { startSegmentEntryDaemon } from './features/cdp/segmentEntryDaemon.js';
import { resolveAndResume } from './routes/interrupts.js';
import { startWorkGraphDaemon } from './features/ambient-work-graph/workGraphSweep.js';
import { backfillKnowledgeSyncJobs } from './features/knowledge-sync/knowledgeSyncService.js';
import { startCrmSnapshotDaemon } from './features/crm/snapshotDaemon.js';
import { startVerifierSampleDaemon } from './features/kicktodo-metrics/verifierSampleDaemon.js';
import { listCrmOrgScopes } from './features/crm/crmEntitiesService.js';
import { startRetentionSweepDaemon, idempotencyTtlDays } from './host/retentionSweepDaemon.js';
import { defaultRetentionDays } from './storage/runRetentionStamp.js';
import { startHeartbeatDaemon } from './host/heartbeatService.js';
import { listRosterTenants } from './host/rosterService.js';
import { getInstanceId } from './host/instanceId.js';
import { configureSecretResolver, loadSecretsFromEnv } from './byok/secretResolver.js';
import { registerOperatorMcpServer } from './host/mcpOperatorServer.js';
import { bootstrapKmsFromEnv } from './byok/kmsEncryption.js';
import { readDeployPosture, enterprisePostureStartupError } from './host/deployPosture.js';
import { workspaceReadinessStartupError, workspaceReadinessWarning } from './host/workspaceReadiness.js';
import { oidcTrustRootStartupError } from './host/oidcTrustGuard.js';
import {
  bootstrapManagedProvider,
  configureManagedProvider,
} from './providers/managedProvider.js';
import { configureMediaBudget } from './aiProviders/mediaBudget.js';
import { configureByokChatBudget } from './aiProviders/byokChatBudget.js';
import { getGovernancePolicy } from './host/governanceService.js';
import { markOwnProcess } from './host/processIdentity.js';
import { dirname, resolve as resolvePath } from 'node:path';
import { registerAllRoutes } from './routes/registerAllRoutes.js';

const log = createLogger('workflow-engine');

/** Brand-neutral, protocol-accurate default for the OpenAPI discovery doc.
 *  A white-label host overrides it with OPENWOP_SERVICE_DESCRIPTION rather than
 *  inheriting a marketing string it didn't set. */
export const DEFAULT_SERVICE_DESCRIPTION =
  'An OpenWOP-compatible workflow and agent orchestration host.';

/** Vendor tag emitted in `service.vendor` of `/.well-known/openwop`. Defaults to
 *  the reference-app lineage; a white-label host overrides it with
 *  OPENWOP_SERVICE_VENDOR so its discovery doc doesn't claim a vendor it isn't. */
export const DEFAULT_SERVICE_VENDOR = 'openwop-app';

export interface AppConfig {
  port: number;
  storageDsn: string;
  serviceName: string;
  serviceVersion: string;
  /** Optional so existing inline test configs stay valid; `loadConfigFromEnv`
   *  always populates it, and the discovery route falls back to the default. */
  serviceDescription?: string;
  /** Optional for the same reason as `serviceDescription`; surfaced in
   *  `service.vendor` of the `/.well-known/openwop` advertisement. */
  serviceVendor?: string;
  enableConsoleTracer: boolean;
}

/** Max length the reference host will emit for an identity field.
 *  `name`/`version`/`vendor` are shipped verbatim in the `/.well-known/openwop`
 *  advertisement, which every client fetches + caches. The spec leaves them free
 *  strings (vendors need naming freedom), so rather than tighten the wire schema
 *  for all hosts, the reference host bounds its OWN output. White-label hosts
 *  should apply the same discipline to operator-supplied identity. */
const MAX_SERVICE_IDENTITY_LEN = 128;

/** Normalize an operator-supplied identity field: blank/whitespace → the default;
 *  an over-long value is capped (and logged) rather than emitted wholesale into
 *  the discovery doc. Keeps a misconfigured deploy from advertising a degenerate
 *  (empty or multi-KB) identity. */
function boundServiceIdentity(raw: string | undefined, fallback: string, envVar: string): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return fallback;
  if (trimmed.length > MAX_SERVICE_IDENTITY_LEN) {
    log.warn('service_identity_truncated', { envVar, length: trimmed.length, max: MAX_SERVICE_IDENTITY_LEN });
    return trimmed.slice(0, MAX_SERVICE_IDENTITY_LEN);
  }
  return trimmed;
}

export function loadConfigFromEnv(): AppConfig {
  return {
    port: Number(process.env.PORT) || 8080,
    storageDsn: process.env.OPENWOP_STORAGE_DSN || 'sqlite://./data/workflow-engine.db',
    serviceName: boundServiceIdentity(
      process.env.OPENWOP_SERVICE_NAME, 'openwop-workflow-engine', 'OPENWOP_SERVICE_NAME'),
    // ADR 0052 §D4 — the app version SSoT (`APP_VERSION`, mirrored from /VERSION)
    // is the default; an operator MAY still override the advertised version via
    // OPENWOP_SERVICE_VERSION (e.g. a white-label vendor build).
    serviceVersion: boundServiceIdentity(
      process.env.OPENWOP_SERVICE_VERSION, APP_VERSION, 'OPENWOP_SERVICE_VERSION'),
    // Surfaced in the OpenAPI discovery doc (`GET /v1/openapi.json`).
    serviceDescription: process.env.OPENWOP_SERVICE_DESCRIPTION || DEFAULT_SERVICE_DESCRIPTION,
    // Surfaced in `service.vendor` of `/.well-known/openwop`.
    serviceVendor: boundServiceIdentity(
      process.env.OPENWOP_SERVICE_VENDOR, DEFAULT_SERVICE_VENDOR, 'OPENWOP_SERVICE_VENDOR'),
    // Console span export is opt-IN (DATA-3): on by default it floods prod
    // stdout with one line per span and adds synchronous per-span flush
    // latency. Dev/debug enables it with OPENWOP_OTEL_CONSOLE=true.
    enableConsoleTracer: process.env.OPENWOP_OTEL_CONSOLE === 'true',
  };
}

export async function createApp(config: AppConfig): Promise<Express> {
  // Captured at boot so the daemon-status route can report a stable
  // start time even if process.uptime() drifts under heavy load.
  const startTimeMs = Date.now();
  // OTel must initialize before any spans are created downstream.
  createTracer({
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    consoleExporter: config.enableConsoleTracer,
  });
  // ADR 0556 P0 — the metric half, initialised alongside the trace half so an
  // operator configures ONE endpoint. With `OTEL_EXPORTER_OTLP_ENDPOINT` unset
  // the provider carries zero readers: instruments are real, nothing is
  // collected or shipped, and a dev box or test run pays nothing.
  createMetrics({ serviceName: config.serviceName, serviceVersion: config.serviceVersion });
  // WHD-19 — state any webhook egress relaxation (the blanket
  // OPENWOP_WEBHOOK_ALLOW_PRIVATE, or the exact-origin
  // OPENWOP_WEBHOOK_ALLOW_ORIGINS, or its fail-closed rejection) at CONSTRUCTION,
  // so an embedder such as the conformance lane logs it too. Silent by default.
  logWebhookEgressPosture();

  const storage = await openStorage(config.storageDsn);
  // Wire the host-ext durability layer BEFORE app-tier migrations run — an
  // app migration may operate over host-ext `DurableCollection`s (e.g. the ADR
  // 0102 agent-profile permission backfill), which require the storage ref.
  // Idempotent: the route-module register hook calls this again with the same
  // storage. (initHostExtPersistence only sets a module-level ref.)
  initHostExtPersistence(storage);
  // ADR 0535 P2/P3 — a card the work loop parked in Working returns to To Do
  // when its run dies. This belongs to app CONSTRUCTION, not the process
  // lifecycle: registering it beside the daemons in `main()` meant it only ran
  // when this module was the entry point, so every `createApp` embedder (and
  // every test) silently lost recovery while the unit tests stayed green.
  // Keyed, so a repeat boot overwrites rather than accumulating handlers.
  registerCardRunRecovery(storage);
  // ADR 0738 P4 — generic WorkItems reconcile normal workflow terminal events
  // into their shared board-card projections. This registers at app
  // construction so embedders/tests retain the same lifecycle guarantee.
  registerKanbanWorkItemLifecycle(storage);
  // ADR 0052 §D4 — record the running app version (and detect a fresh install
  // vs an upgrade-from-prior) once the schema migrations have run.
  await recordAppVersion(storage);
  const hostSuite = createHostAdapterSuite({ storage });

  // Wire BYOK to sqlite + AES-256-GCM-at-rest. Master key resolution:
  // env (OPENWOP_BYOK_ENCRYPTION_KEY) → data/.byok-master-key (auto-
  // generated 0600 on first boot). See src/byok/encryption.ts for the
  // honest security boundary discussion.
  const dataDir = config.storageDsn.startsWith('sqlite://')
    ? dirname(resolvePath(config.storageDsn.slice('sqlite://'.length)))
    : resolvePath('./data');
  configureSecretResolver({ storage, dataDir });
  // Conformance-only canary secret. When OPENWOP_TEST_SEAM_ENABLED is
  // set (we're running the conformance suite, not production), pre-
  // provision the canary used by `byok-roundtrip.test.ts` via
  // `conformance.secret.echo`. Production deployments NEVER hit this
  // path. Skipped if a real secret with the same id already exists.
  if (process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
    void (async () => {
      try {
        const { setSecret } = await import('./byok/secretResolver.js');
        const canary = 'canary-value-CANARY-openwop-CONFORMANCE-NEVER-SECRET-' + Math.random().toString(36).slice(2, 8);
        // Provision under BOTH keys the flat path can be asked for. Since the
        // 2026-07 M3 fix, a scoped resolve reads `${tenantId}::${ref}` with NO
        // bare-key fallback (falling back would leak host-global secrets to a
        // tenant), so the scopeless row alone is invisible to the fixture run:
        // `conformance.secret.echo` resolves with the RUN's tenant scope, and a
        // credential-less `POST /v1/runs` lands on tenant 'default'
        // (routes/runs.ts). The scopeless row stays for scope-free consumers.
        await setSecret('openwop-conformance-canary-secret', canary);
        await setSecret('openwop-conformance-canary-secret', canary, { tenantId: 'default' });
      } catch { /* swallow — best-effort */ }
    })();
  }

  // KMS envelope encryption for signed-in (`user:*`) tenants. When
  // OPENWOP_BYOK_KMS_KEY is set, every signed-in tenant secret gets
  // KMS-wrapped DEK encryption per src/byok/kmsEncryption.ts. Anon
  // tenants stay on the ephemeral in-memory path. Local dev / sqlite
  // boots without KMS — signed-in secrets are simply rejected with a
  // logged warning until the env is supplied.
  const kmsConfigured = bootstrapKmsFromEnv();
  // Fail-closed in the production auth posture: signed-in tenants store real
  // BYOK credentials, so KMS envelope encryption is mandatory there. Refuse to
  // boot rather than fall back to the ephemeral/plaintext path (SECURITY:
  // threat-model-secret-leakage; SR-1). Other postures (anon cookie / shared
  // bearer / local dev) may run without KMS.
  if (!kmsConfigured && readDeployPosture() === 'auth') {
    throw new Error(
      'OPENWOP_DEPLOY_POSTURE=auth requires BYOK secret encryption: set OPENWOP_BYOK_KMS_KEY ' +
        '(KMS envelope key). Refusing to boot in the auth posture without it — signed-in tenant ' +
        'secrets would otherwise use the ephemeral in-memory store.',
    );
  }

  // Pre-seed BYOK from env (kept for backward-compat with conformance
  // / scripted-test setups). Runtime adds via POST /v1/host/openwop-app/byok/secrets.
  await loadSecretsFromEnv();

  // Managed-provider key bootstrap. If MINIMAX_API_KEY (etc.) is set,
  // encrypt it with the BYOK master key and persist into byok_secrets
  // under `managed:<provider>`. Idempotent: rotates if the env value
  // changed, no-ops if unchanged. See providers/managedProvider.ts.
  configureManagedProvider({ storage, dataDir });
  await bootstrapManagedProvider();
  // ADR 0106 — inject the durable store + the per-org budget override resolver
  // (the DI seam: mediaBudget consults the governance policy without importing it).
  // No-op accounting unless an env default OR a per-org override is set.
  configureMediaBudget({
    storage,
    resolveOverride: async (tenantId) => (await getGovernancePolicy(tenantId))?.mediaBudget ?? null,
  });
  // ADR 0173 — the BYOK-chat sibling of the media budget: inject the same durable
  // store + a per-org override resolver (the DI seam: byokChatBudget consults the
  // governance policy without importing it). No-op accounting unless an env default
  // (OPENWOP_BYOK_DAILY_TOKEN_CAP) OR a per-org override is set.
  configureByokChatBudget({
    storage,
    resolveOverride: async (tenantId) => (await getGovernancePolicy(tenantId))?.byokChatBudget ?? null,
  });

  // Pre-register node modules + install singletons before the first
  // request lands. Mirrors the MyndHyve workflow-runtime boot order.
  // Seed host-surface registry with "supported=false" defaults so the
  // discovery + catalog routes can show the full surface list with
  // honest support flags. Phase-3 adapters call registerHostSurface()
  // again with `supported: true` once they're wired.
  seedDefaultHostSurfaces();
  // ADR 0730 C.2 — the v2 root is closed, so this host's own surface inventory
  // travels under `extensions['openwop-app.host-surfaces']`. Registered AFTER
  // the seed so the record's function sees the real registry, and it reads it
  // live at each discovery read (adapters flip `supported` later in this boot).
  registerHostSurfacesV2Extension();
  // ADR 0730 C.3a — the per-provider subscription map the corpus `aiProviders`
  // family cannot carry (its `authModes` is a flat vocabulary).
  registerAiProvidersV2Extension();
  seedHostArtifactTypes(); // ADR 0055 — host-native artifact types (RFC 0071/0075)

  // Wire host surfaces (kv/table/cache/blob/queue/fs/sql/vector/messaging
  // /observability) so pack-authored nodes delegating to ctx.storage / ctx.db
  // / ctx.fs / ctx.queueBus / ctx.observability actually execute. Each surface
  // resolves through the backend seam (host/surfaceBackends.ts): the default
  // 'memory' tier is non-durable and process-local (restarts wipe it); set
  // OPENWOP_SURFACE_<KEY> / OPENWOP_SURFACE_BACKEND to a registered real-backend
  // adapter for production durability. The surface shapes don't change either
  // way. initInMemorySurfaces() refuses to boot if a selected backend is unwired.
  // Register real-backend surface adapters BEFORE the in-memory init runs its
  // boot guard. The durable adapter (Phase 2) backs host.kv with the shared
  // Storage (sqlite or Postgres), so OPENWOP_SURFACE_KV=durable survives
  // restarts and is consistent across instances. See host/durable/durableKv.ts.
  initDurableSurfaces(storage, { sqlDir: resolvePath(dataDir, 'host-sql') });
  // host.blob over any S3-compatible object store (OPENWOP_SURFACE_BLOB=s3) —
  // real presigned URLs, direct-to-bucket. Fails fast at boot if selected but
  // unconfigured. See host/blob/s3Blob.ts.
  registerS3BlobAdapter();
  // Optional scale engines: real full-text (OPENWOP_SURFACE_SEARCH=opensearch)
  // and vector (OPENWOP_SURFACE_VECTOR=pgvector). Each registers its adapter and
  // fails fast at boot if selected-but-unconfigured. See host/search, host/vector.
  registerOpenSearchAdapter();
  registerPgVectorAdapter();
  registerPgSqlAdapter();
  initInMemorySurfaces({ dataDir });
  // host.chat writes the SAME chat tables the /v1/host/openwop-app/chat routes + SPA
  // read, so it needs the app Storage (not a host-ext singleton). Inject it here.
  setChatStorage(storage);
  // The Kanban surface is built per-run from a tenant-only BundleScope. Bind
  // its one durable trigger delivery adapter here so moves from a workflow use
  // the exact RFC 0083 path as moves from the HTTP board route.
  setKanbanTriggerDeliveryDeps({ storage, hostSuite });
  // ADR 0292 / CDP-D §6 — the destination-sync `warehouseLoad` surface verb runs the
  // governed BigQuery insert through brokeredEgress, which types a `Storage`; a feature
  // surface is built from a BundleScope with no storage handle, so inject it here
  // (the setChatStorage precedent).
  setWarehouseLoadStorage(storage);

  // RFC 0027 + RFC 0028 — boot-time prompt-store init. Loads the
  // host-built-in PromptTemplate fixtures shipped under
  // `conformance-fixtures/prompt-templates/` so
  // node configs that reference `prompt:templateId@version` can resolve
  // via the four-layer chain (RFC 0029 §A). Idempotent.
  const { ensurePromptStoreInitialized } = await import('./host/promptStore.js');
  ensurePromptStoreInitialized();

  ensureNodesRegistered();
  // Wire the subWorkflow dispatcher dependency injection. The node
  // registered above is a thin shim; the actual spawn-and-wait logic
  // calls back into executeRun (recursive child run). The dispatcher
  // module holds the late-bound deps so the node doesn't need direct
  // access to storage or the catalog.
  const { setSubWorkflowDispatcher } = await import('./executor/subWorkflowDispatcher.js');
  const { executeRun } = await import('./executor/executor.js');
  setSubWorkflowDispatcher({ storage, hostSuite, executeRun: executeRun as never });
  // ADR 0554 P2 — the compensation unwind needs a SUB-RUN's definition to read
  // its RFC 0151 §B declarations, and the workflow catalog lives on the host
  // suite rather than on Storage. Late-bound here for the same reason the
  // subWorkflow dispatcher is.
  const { setCompensationDefinitionResolver, registerCompensationApprovalEligibility } =
    await import('./host/compensationRuntime.js');
  setCompensationDefinitionResolver(
    async (child) => (await hostSuite.workflowCatalog.getWorkflow(child.workflowId))?.definition ?? null,
  );
  // RFC 0151 §E separation of duties, at the ONE decision choke every decide
  // path funnels through. Registered at boot, not lazily on the first unwind —
  // an eligibility check that installs itself when the gate is first needed is
  // absent for exactly the request that needed it.
  registerCompensationApprovalEligibility();
  // host.canvas crossCanvasInvoke spawns a real child run via the same deps.
  const { setCanvasInvokeDispatcher } = await import('./host/canvasSurface.js');
  setCanvasInvokeDispatcher({
    storage,
    getWorkflow: (workflowId) => hostSuite.workflowCatalog.getWorkflow(workflowId),
    executeRun: executeRun as never,
  });
  ensureSuspendManagerInstalled(storage);
  ensureEventLogInstalled(storage);
  // Notifications: the emit-backend install + Web-Push config moved into the
  // notifications BackendFeature (ADR 0010 — the feature owns its infra). They
  // now run from registerBackendFeatures() (still at boot, before any run).
  ensureInvocationLogInstalled(storage);
  ensureRuntimeCapabilityRegistryInstalled();
  ensureNodePackResolverInstalled(storage);

  // ADR 0194 Phase 4 — load pack tombstones BEFORE the pack loaders, so a
  // removed pack is not resurrected at boot (mount + registry install both
  // consult the cached set). Storage is already initialized above.
  await loadPackTombstones();

  // ADR 0555 P0 — load pack REVOCATIONS in the same slot, and for a sharper
  // reason. `host/packTrust.ts` reads the revocation cache SYNCHRONOUSLY from
  // the pack loaders. If this await lands after the first pack load, a revoked
  // pack executes once per instance and only then starts refusing: a real
  // bypass, self-healing within seconds, and effectively unreproducible from a
  // bug report. Revocation must fail CLOSED from the first dispatch, so this
  // line stays above the mount. (Distinct from tombstones above — a tombstoned
  // pack still runs; a revoked one never does. See packRevocations.ts.)
  const revocationCount = await loadPackRevocations();
  if (revocationCount > 0) {
    log.warn('pack revocations active — these packs will not dispatch', { count: revocationCount });
  }

  // ADR 0555 P2 — does the pack-isolation memory configuration fit the instance?
  //
  // Checked HERE, at boot, and not only at the first dispatch. An over-budget
  // configuration does not fail a pack: N isolate heaps are charged to the
  // CONTAINER, so exceeding the instance OOM-kills the whole service. That
  // presents as the backend restarting under load — a symptom an operator reads
  // as a platform fault or a traffic spike, never as a pack-isolation knob. A
  // deploy-time line is what makes it attributable. It refuses rather than
  // throws: declining to isolate is a smaller outage than a host that will not
  // boot, and the dispatch path refuses from the same function.
  logIsolationMemoryBudgetAtBoot();

  // Dev mount first: symlink every `core.openwop.*` pack from the
  // repo's `packs/` tree into the pack dir. When the backend boots
  // inside the workspace (most dev runs), this gives the builder
  // palette every pack in the repo with zero network calls.
  // Opt out with OPENWOP_MOUNT_LOCAL_PACKS=false. See
  // mountLocalPacks.ts for the trust-model discussion.
  const mountResult = ensureLocalPacksMounted();

  // Fetch + verify + install registry packs the app wants in the
  // builder palette. Non-blocking: install failures are logged and
  // the sample still serves the locally-registered nodes.
  //
  // Default: when the local mount found the workspace AND
  // OPENWOP_INSTALL_PACKS is unset, skip the network registry install
  // — every default-pack the app wants is already on disk from the
  // local mount. Explicit `OPENWOP_INSTALL_PACKS=<list>` or running
  // outside the workspace (e.g., Docker / Cloud Run) still triggers
  // the registry fetch.
  const localMountServedDefaults =
    !mountResult.disabled &&
    (mountResult.mounted.length + mountResult.skipped.length + mountResult.shadowed.length) > 0;
  if (!process.env.OPENWOP_INSTALL_PACKS && localMountServedDefaults) {
    process.env.OPENWOP_INSTALL_PACKS = 'none';
  }
  // Feature-declared packs (BackendFeature.requiredPacks → featurePackRefs) are
  // always honored — even under the `none` short-circuit above — so a feature
  // that requires a registry-distributed pack gets it (ADR 0014 Phase 0; in-tree
  // packs already on disk from the local mount are skipped by the installer).
  await ensureRegistryPacksInstalled(featurePackRefs());

  // ADR 0684 phase 1 — provision feature-declared default orgs + shared
  // workspaces. Same declare-here/consume-at-boot shape as the packs above, and
  // idempotent, so a redeploy is a no-op. Runs BEFORE any seeding so a seeder
  // targeting a declared workspace finds its org already present.
  await ensureFeatureDefaultOrgs(featureDefaultOrgs());
  // ADR 0684 §7 — hand the declarations to the auto-join path. Pushed DOWN from
  // boot rather than imported UP by the feature: `features/users/authRoutes.ts`
  // importing the registry is a cycle.
  setDefaultWorkspaceTargets(featureDefaultOrgs());

  // H21 / ADR 0553 — an operator-configured outbound MCP server
  // (`OPENWOP_MCP_SERVER_URL`) is registered as a curated `reach:'mcp'`
  // Connections provider, so it resolves through the SAME pipeline as every
  // other MCP peer (governance → credential → RFC 0093 dispatcher → untrusted
  // marker). No-op when unconfigured.
  registerOperatorMcpServer();

  // RFC 0070: load pack-declared manifest agents into the AgentRegistry
  // (the RFC 0003 `installAgents` step). Runs after local mount + registry
  // install so every on-disk pack's `agents[]` is resolvable. Agent-only
  // packs (nodes: []) have no node typeId to lazily trigger, so this eager
  // pass is what makes them dispatchable + visible in the inventory.
  ensureAgentPackResolverInstalled(storage);

  // RFC 0028 §B prompt-pack boot-time loader. Scans the in-tree
  // `examples/packs/` plus any operator-managed dir
  // (`OPENWOP_PROMPT_PACKS_DIR`) for `kind: "prompt"` packs and
  // registers each pack's templates with the PromptStore. The
  // in-tree `vendor.openwop.prompt-example` pack auto-installs when
  // the backend boots inside the workspace.
  const promptPackResults = loadPromptPacks({ roots: defaultPromptPackRoots() });
  if (promptPackResults.length > 0) {
    log.info('prompt_packs_loaded', {
      count: promptPackResults.length,
      packs: promptPackResults.map((r) => ({
        name: r.packName,
        version: r.packVersion,
        templates: r.templatesInstalled,
      })),
    });
  }

  // RFC 0095 §B.6 connection-pack boot-time loader. Scans for `kind:"connection"`
  // packs and registers each pack's provider into the ADR 0024 registry, so a
  // connector's `auth.provider` resolves against installed packs. No-op when no
  // pack roots exist (the built-in providers remain the catalog).
  // ADR 0055 Phase 3 — register kind:'artifact-type' packs (after mount, so the
  // repo's vendored packs are symlinked into the pack dir). Registers through the
  // SAME host registry as native types.
  const artifactTypePackResults = loadArtifactTypePacks({ roots: defaultArtifactTypePackRoots() });
  if (artifactTypePackResults.registered.length > 0) log.info('artifact_type_packs_registered', { count: artifactTypePackResults.registered.length });

  // ADR 0347 5a — kind:'canvas-content' kits (multi-frame templates + typed
  // variables) for canvas-type editors. Host-private kind; a normative
  // promotion is an RFC first (the ADR 0342 watch-item).
  const canvasContentResults = loadCanvasContentPacks({ roots: defaultCanvasContentPackRoots() });
  if (canvasContentResults.installed.length > 0) log.info('canvas_content_packs_loaded', { count: canvasContentResults.installed.length, packs: canvasContentResults.installed });
  if (canvasContentResults.errors.length > 0) log.error('canvas_content_packs_rejected', { errors: canvasContentResults.errors });
  // ADR 0516 — form templates, the same host-private content-pack pattern.
  const formContentResults = loadFormContentPacks({ roots: defaultFormContentPackRoots() });
  if (formContentResults.installed.length > 0) log.info('form_content_packs_loaded', { count: formContentResults.installed.length, packs: formContentResults.installed });
  if (formContentResults.errors.length > 0) log.error('form_content_packs_rejected', { errors: formContentResults.errors });

  const connectionPackResults = loadConnectionPacks({ roots: defaultConnectionPackRoots() });
  if (connectionPackResults.installed.length > 0) {
    log.info('connection_packs_loaded', {
      count: connectionPackResults.installed.length,
      packs: connectionPackResults.installed.map((r) => ({ name: r.pack, provider: r.providerId, version: r.version, overrodeBuiltin: r.overrodeBuiltin })),
    });
  }
  if (connectionPackResults.errors.length > 0) {
    // A rejected pack is skipped, not fatal — surface it so the operator notices.
    log.error('connection_packs_rejected', {
      count: connectionPackResults.errors.length,
      packs: connectionPackResults.errors.map((e) => ({ name: e.pack, code: e.code })),
    });
  }

  // ADR 0152 — register kind:'workflow-chain' packs (RFC 0013). Vendored chains
  // become available for edit-time expansion; a chain is expanded once (frozen)
  // and persisted via the existing builder registry to run. No new catalog source.
  const chainPackResults = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  if (chainPackResults.installed.length > 0) {
    log.info('workflow_chain_packs_loaded', {
      count: chainPackResults.installed.length,
      packs: chainPackResults.installed.map((r) => ({ name: r.packName, version: r.packVersion, chains: r.chainIds })),
    });
  }
  if (chainPackResults.errors.length > 0) {
    log.error('workflow_chain_packs_rejected', {
      count: chainPackResults.errors.length,
      packs: chainPackResults.errors.map((e) => ({ name: e.pack, code: e.code })),
    });
  }

  const app = express();

  // Firebase Hosting → Cloud Run rewrite preserves the `/api` source
  // prefix when proxying (e.g. browser hits `/api/v1/runs`, backend
  // receives `/api/v1/runs`). Strip the prefix here so the rest of
  // the routes (`/v1/*`, `/.well-known/openwop`, `/health`) work
  // without per-route `/api`-prefixed clones. Local dev + bearer
  // callers without the prefix are unaffected — the strip is a no-op
  // when the path doesn't start with `/api/`.
  app.use((req, _res, next) => {
    if (req.url.startsWith('/api/')) {
      req.url = req.url.slice(4) || '/';
    } else if (req.url === '/api') {
      req.url = '/';
    }
    next();
  });
  // The negotiator mounts HERE — before every body parser — so the version
  // header exists on a response the parser itself produces (a malformed body),
  // and so a major-2 URL is already rewritten onto its `/v1` twin when the
  // `/v1/...`-scoped parsers decide whether they apply. MEASURED 2026-09-05:
  // mounted after the parsers, `POST /runs {` under major 2 was a 500 with no
  // header, and `/packs` under major 2 missed the 50mb `/v1/packs` parser.
  // (Corrected placement — see middleware/bodyParseError.ts.)
  // ADR 0744 — mounted BEFORE the negotiator so its wrapper is the innermost:
  // it sees the final envelope any later layer (the negotiator's own refusals,
  // the body parser, auth, the rate limiter) writes on the A2A 1.0 interface
  // URL, and re-renders it as a JSON-RPC error on the same status.
  app.use(a2aInterfaceErrorsMiddleware());
  app.use(protocolVersionMiddleware());

  // RFC 0168 §C.1 — the v2 address of the conformance seam surface, mounted
  // beside the negotiator because it is the same KIND of thing: an address
  // translation, not a handler. It must precede every router — Express matches
  // in registration order, so an alias registered inside the route table runs
  // AFTER the routers it is meant to feed and rewrites a URL nobody will look
  // at again (measured: all nine served operations answered 404). Being first
  // also puts it ahead of `testSeam`'s `app.use('/v1/host/sample', guardSeam)`,
  // so a seam caller meets the same auth guard a v1 caller does.
  registerConformanceSeamAlias(app);

  // Higher-limit JSON parser for /v1/packs/* publish payloads. MUST
  // register before the global 1mb parser; body-parser is no-op when
  // req._body is set, so registration order is precedence order.
  app.use('/v1/packs', express.json({ limit: '50mb' }));
  // Chat-attachment uploads (base64) ride a scoped parser sized to the
  // 8mb-base64 store cap in routes/mediaAssets.ts. Registered before the
  // global 1mb parser; body-parser is a no-op once req._body is set, so
  // registration order is precedence order.
  app.use('/v1/host/openwop-app/media', express.json({ limit: '12mb' }));
  // ADR 0334 4b-3 — DOCX import carries a base64 .docx (~10mb cap enforced in the
  // route); the default 1mb parser would reject it. Scoped to document-editor so
  // the larger limit doesn't widen every route.
  app.use('/v1/host/openwop-app/document-editor', express.json({ limit: '12mb' }));
  // Inbound provider webhooks (ADR 0024 §6) need the EXACT raw bytes to verify a
  // provider HMAC, so this scoped parser stashes them on `req.rawBody` before the
  // global parser consumes the stream. Registered first; body-parser no-ops once
  // req._body is set, so this wins for the inbound prefix.
  app.use('/v1/host/openwop-app/connections-inbound', express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // ADR 0394 — Twilio (WhatsApp BSP) delivers `application/x-www-form-urlencoded`,
  // which the json parser above skips; same raw-bytes capture, same prefix.
  app.use('/v1/host/openwop-app/connections-inbound', express.urlencoded({
    extended: false,
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // App-builder inbound sync webhook (ADR 0393 Phase 2) — GitHub signs the EXACT
  // raw body (X-Hub-Signature-256), so it needs the same raw-bytes capture.
  // 1mb: a push payload carries a commits[] array (GitHub truncates at 2048,
  // we only read head_commit/ref/after, but the envelope must parse).
  app.use('/v1/host/openwop-app/app-builder-sync/webhook', express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // Stripe billing webhook (ADR 0176) — Stripe signs the EXACT raw body, so it needs
  // the same raw-bytes capture. Scoped to the public webhook path only.
  app.use('/v1/host/openwop-app/billing/webhook', express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // Commerce Stripe webhook (ADR 0177 deferred P3) — same raw-body capture.
  app.use('/v1/host/openwop-app/commerce/webhook', express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // Email bounce/complaint webhook (ADR 0241) — the provider (SendGrid/Postmark)
  // signs the EXACT raw body, so capture it before the global parser. 2mb bounds
  // a provider event batch (the route also caps event count).
  app.use('/v1/host/openwop-app/public-email/events', express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // Notebooks audio/video SOURCE upload (ADR 0085) carries base64-encoded media
  // up to the ~32 MiB decoded transcription cap. 32 MiB decoded is ≈ 42.7 MB of
  // base64, so the body limit is 48mb — comfortably above the cap so the route's
  // own decoded-size 413 guard is REACHABLE (not co-incident with this parser
  // limit, the way an under-sized cap becomes dead code). Scoped to the
  // `/sources/audio` sub-route only — every other notebook route keeps the small
  // global limit. Registered before the global parser; body-parser no-ops once
  // req._body is set, so registration order is precedence order.
  const notebooksAudioJson = express.json({ limit: '48mb' });
  app.use('/v1/host/openwop-app/notebooks', (req, res, next) =>
    req.method === 'POST' && /\/sources\/audio$/.test(req.path) ? notebooksAudioJson(req, res, next) : next(),
  );
  // KB FILE UPLOAD (text/PDF/DOCX → extracted text): document/source-ingest POSTs
  // carry base64 file bytes up to the ~32 MiB decoded ingest cap (≈42.7 MB base64),
  // so they get the same 48mb parser as audio. Scoped to the ingest endpoints only
  // (paths ending `/documents` or `/sources`); every other route keeps the 1mb
  // global limit. Registered before the global parser (body-parser no-ops once
  // req._body is set, so order = precedence).
  const fileUploadJson = express.json({ limit: '48mb' });
  app.use('/v1/host/openwop-app', (req, res, next) =>
    req.method === 'POST' && /\/(documents|sources)$/.test(req.path) ? fileUploadJson(req, res, next) : next(),
  );
  // CDP-G batch/CSV import (ADR 0298) — a CSV body up to the route's 10k-row hard
  // cap can exceed the 1mb global limit, which would 413 BEFORE the cap is reached
  // (making the cap dead code). An 8mb parser keeps the row-count cap the binding
  // guard. Scoped to the single import route; registered before the global parser
  // (body-parser no-ops once req._body is set, so order = precedence).
  app.use('/v1/host/openwop-app/cdp/collect/import', express.json({ limit: '8mb' }));
  // Canvas editor docs (ADR 0333 grade pass DATA-D1/CODE-D2) — the drawing
  // schema legally holds far more than 1mb (2000 shapes × 600-point spines);
  // ~60 full ink strokes crosses the global limit and every save 413s BEFORE
  // the schema cap binds, stranding unsaved work. An 8mb parser on the canvas
  // editor families keeps the schema the binding guard. Scoped + registered
  // before the global parser (body-parser no-ops once req._body is set).
  app.use([
    '/v1/host/openwop-app/drawings',
    '/v1/host/openwop-app/cad',
    '/v1/host/openwop-app/slides',
    '/v1/host/openwop-app/campaign-studio',
    '/v1/host/openwop-app/app-builder',
    '/v1/host/openwop-app/canvas-packs',
  ], express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(bodyParseErrorHandler());

  // CORS — MUST come before auth so OPTIONS preflight succeeds without
  // credentials per the CORS spec.
  app.use(corsMiddleware());

  // OpenWOP v2 front door (`spec/v2/core/versioning.md` §1.3–§1.5, §5) — decide
  // the major, stamp `OpenWOP-Version` on every response, refuse an unlisted
  // major / a `/v1/` key carrying another major / a client below the floor, and
  // rewrite the unversioned v2 path keys onto their `/v1` twin.
  //
  // BEFORE auth, deliberately: the rewrite must land before the public-path
  // allowlist and the CSRF origin guard read `req.path`, so a request under
  // major 2 is authorized exactly like its v1 twin rather than under a second,
  // divergent set of gates. AFTER CORS so a preflight still answers without
  // being negotiated.

  // ADR 0295 — the custom-domain host guard: a LIVE customer hostname is
  // pinned to its org + the public-only allowlist, fail-closed; the platform
  // origin passes through untouched. Before auth (the admitted surface is
  // anonymous-public by design).
  app.use(customDomainMiddleware());

  // W3C traceparent → active OTel context. Mounted before route
  // registrations so handlers see the propagated context.
  app.use(traceContextMiddleware());

  // ADR 0556 P1 — HTTP latency + status class, by route TEMPLATE. Before auth
  // and the rate limiter on purpose: a 401 and a 429 are traffic, and an
  // availability metric that counts only the requests which got past the gates
  // reports a host as healthy while it is refusing everyone.
  app.use(httpMetricsMiddleware());

  // Bearer-token auth — stub: any non-empty token resolves to a synthetic
  // principal. Replace with Firebase / OIDC / your IdP for real deploys.
  app.use(authMiddleware());

  // RFC 0154 §A / ADR 0556 P3 — bind a presented workload credential to the
  // request. AFTER auth (a workload may call on a human principal's behalf, and
  // `onBehalfOf` is only meaningful beside the principal auth resolved) and
  // BEFORE every route, because §A requires the identity to be resolved to a
  // principal *before* authorization rather than by whichever handler looks.
  // No-op for a request that presents no workload credential.
  app.use(workloadIdentityMiddleware());
  // v2 charter Phase 4 (P4-D) — the major-2 identity gate: the tenant segment of
  // a tenant-bound run id and the `Idempotency-Key` grammar
  // (`spec/v2/core/identity.md` §5, `spec/v2/core/idempotency.md` §Layer 1).
  // MUST sit after `authMiddleware()`: both rules bind the AUTHENTICATED tenant,
  // and both are no-ops under major 1.
  app.use(v2IdentityMiddleware());

  // ADR 0556 P3 — freeze the acting authority into every new run's metadata.
  // `stampRunStartContext` merges without overwriting, so a `:fork`-copied
  // `authority` wins: a replay re-executes under the authority the ORIGINAL run
  // recorded, which is the ADR's "replay uses the recorded authority facts and
  // does not remint broader authority" falling out of the merge rather than
  // being re-checked at each call site.
  wireAuthorityRunStamping();

  // CSRF Origin guard (2026-07 vuln-scan M4). AFTER auth so the public-path bypass
  // + principal are settled; guards cookie-authed unsafe methods against the CORS
  // origin allowlist. No-op in dev (reflect-any) + for bearer/public/webhook callers.
  app.use(csrfOriginGuard());

  // Per-IP request bucket. Applies to every authed route. Per-session
  // run-quota is mounted directly on POST /v1/runs in routes/runs.ts
  // (it needs the principal to scope by session).
  app.use(ipRateLimitMiddleware());

  // API-4: stream-safe per-request timeout. Bounds non-streaming requests
  // (SSE routes flush headers first, so it no-ops on them); the canonical
  // backstop below Cloud Run's outer timeout. Disable with
  // OPENWOP_REQUEST_TIMEOUT_MS=0.
  app.use(requestTimeoutMiddleware());

  // ADR 0148 A6 — gzip JSON responses (res.json only; SSE/media untouched).
  // Installed before the routes so the res.json wrapper is in place. No-op unless
  // OPENWOP_CONTEXT_ECONOMY[_TRANSPORT] is on (off by default).
  app.use(jsonGzipMiddleware());

  // Expose storage + hostSuite so the server entry (main) can start the
  // background workers (durable webhook delivery + run-dispatch crash-recovery
  // sweeper) against them. Tests build the app via createApp WITHOUT polling
  // workers and drive the queue/sweep deterministically via the exported
  // processDueWebhookDeliveries() / sweepOrphanedRuns(); only the long-lived
  // server polls.
  app.locals.storage = storage;
  app.locals.hostSuite = hostSuite;

  // Every domain mounts through the ONE ordered module list (white-label PRD
  // §3): add new domains in routes/registerAllRoutes.ts, never here. The
  // companion test fails CI if a routes/ module isn't listed.
  registerAllRoutes({ app, config, storage, hostSuite, startTimeMs });

  // ADR 0621 § Boundaries — the session-authority seam has NO permissive
  // default, so a host that boots without the users feature registering it
  // would refuse EVERY durable-user session with a 503. `BACKEND_FEATURES`
  // always includes `users` (always-on since 2026-06-11), so this is a hard
  // boot-time assertion, not a warning: a silent mis-registration here is a
  // total sign-in outage that only shows up as per-request 503s.
  if (!isSessionAuthorityRegistered()) {
    throw new Error('ADR 0621: no session authority registered after feature registration — the users feature must call registerSessionAuthority at init.');
  }

  // USERS-13 (ADR 0613 / RFC 0159) + RFC 0164 (ADR 0623) — the combined leaver
  // contract needs the production SAML SP and every SCIM lane to key the
  // subject-link deny on ONE tenant. When both are configured and the realms
  // differ, the link can never fire. RFC 0164 makes the leaver contract MANDATORY
  // whenever both profiles are advertised, so discovery does NOT quietly withhold
  // only `subjectLinking`: it DROPS `openwop-auth-scim` from the advert entirely,
  // so the host never advertises both profiles without the leaver guarantee. This
  // names the misconfiguration at boot so an operator sees it before a leaver does.
  {
    const scimConfigured = Boolean(process.env.OPENWOP_SCIM_BEARER || process.env.OPENWOP_TEST_SCIM_URL);
    const align = subjectLinkRealmAlignment();
    if (scimConfigured && align.samlRealm !== null && !align.aligned) {
      log.error('subject_link_realms_misaligned', {
        samlTenant: align.samlRealm,
        scimTenant: align.scimRealm,
        hint: 'RFC 0159 requires OPENWOP_SAML_TENANT == OPENWOP_SCIM_TENANT; a SCIM leaver will NOT deny the linked SAML login until they match. Because the realms differ, capabilities.auth.subjectLinking is withheld AND openwop-auth-scim is dropped from discovery, so the host never advertises both profiles without the leaver guarantee (RFC 0164).',
      });
    }
  }

  // Express 4 catch-all (no path string — avoids path-to-regexp v6 issue).
  app.use((_req, res) => {
    res.status(404).json({
      error: 'not_found',
      message: 'No route matches this request.',
    });
  });

  // Final canonical error envelope shape; runs after every other handler.
  app.use(errorEnvelopeMiddleware());

  return app;
}

async function main(): Promise<void> {
  // ADR 0739 D1 — only a host that IS its own process may expose the RFC 0158
  // kill seam; `createApp` inside a harness never reaches this line.
  markOwnProcess();
  const config = loadConfigFromEnv();

  // Fail fast at startup on a production misconfiguration rather than lazily at
  // the first cookie mint (i.e. the first user login). This mirrors the
  // frontend's build-time guard: refuse to boot a deploy that would mint
  // sessions with a weak / ephemeral secret. `sessionSecretConfigError()` only
  // returns non-null when NODE_ENV=production, so local dev boots unaffected.
  const secretError = sessionSecretConfigError();
  if (secretError) {
    log.error('startup_config_error', { error: secretError });
    process.exit(1);
  }

  // Enterprise-posture startup guard (DUR-1 + DUR-5, ADR 0195). In the auth
  // posture the deployment MUST be coherent — NODE_ENV=production (else the
  // session-secret guard, Secure cookies, and dev-token withdrawal silently
  // stay OFF) and a durable control-plane DSN (else runs/BYOK/approvals are
  // lost on restart, and the 'durable' host surfaces riding this store are a
  // lie). Fail closed with a loud, explicit escape hatch per requirement.
  // Server-only (main(), not createApp): tests boot in-process apps with test
  // env by design and must not pay server-deployment guards.
  const postureError = enterprisePostureStartupError(config.storageDsn);
  if (postureError) {
    log.error('startup_config_error', { error: postureError });
    process.exit(1);
  }

  // ADR 0551 P2 — workspace readiness. Two outcomes, and which one you get is
  // an operator decision rather than this host's guess:
  //   • OPENWOP_WORKSPACE_REQUIRE_DURABLE=true on a non-durable DSN is a FATAL
  //     misconfiguration — the deployment asked for a capability its storage
  //     cannot back.
  //   • otherwise the capability is simply withheld from /.well-known/openwop
  //     (routes/discovery.ts) and this warn says so once. Refusing to boot every
  //     `memory://` dev box would be hostile, and a gate people route around is
  //     not a gate.
  // The workspace ENDPOINTS are unaffected either way; only the claim moves.
  // ADR 0745 D4 — a Cloud Run service never trusts the conformance harness's
  // OIDC issuer (an auth bypass, not a test posture). No escape hatch.
  const trustRootError = oidcTrustRootStartupError();
  if (trustRootError) {
    log.error('startup_config_error', { error: trustRootError });
    process.exit(1);
  }

  const workspaceError = workspaceReadinessStartupError(config.storageDsn);
  if (workspaceError) {
    log.error('startup_config_error', { error: workspaceError });
    process.exit(1);
  }
  const workspaceWarning = workspaceReadinessWarning(config.storageDsn);
  if (workspaceWarning) log.warn('workspace_capability_withheld', { reason: workspaceWarning });

  // Posture nudge (server-only, non-auth postures). A non-sqlite storage DSN
  // means a real durable backend — almost always a deployment, not local dev.
  // If NODE_ENV isn't 'production' there, the production hardening silently
  // stays OFF. Warn loudly but DON'T abort — a developer MAY legitimately
  // point at Postgres locally. (In the auth posture this is the hard error
  // above, not a warning.)
  if (process.env.NODE_ENV !== 'production' && !config.storageDsn.startsWith('sqlite://')) {
    log.warn('demo_posture_with_durable_storage', {
      storage: config.storageDsn.split('://')[0],
      hint:
        'durable storage but NODE_ENV!=production — the session-secret guard and ' +
        'Secure cookie flag are OFF. Set NODE_ENV=production for a real deploy.',
    });
  }

  const app = await createApp(config);

  // Background workers (server-only): drain the durable webhook-delivery queue,
  // and re-dispatch runs orphaned by a crashed instance. Both lease their work
  // to this instance id so a crash lets another instance re-claim it.
  const storage = app.locals.storage as Storage;
  const hostSuite = app.locals.hostSuite as HostAdapterSuite;

  // Demo-deployment showcase: self-healing boot seed of the read-only
  // `__showcase__` tenant the workforce dashboards fall back to. GATED on
  // OPENWOP_DEMO_MODE (demoMode.ts) — a clean / white-label install seeds
  // NOTHING at boot (production-grade out of the gate); only the public demo
  // opts in. Server-only (NOT in createApp, so tests don't pay it). Idempotent —
  // a cheap no-op once complete; best-effort so a seed failure never blocks boot.
  if (demoMode()) {
    // BOUNDED (bootBudget.ts): a full heal is 1,090 sequential run inserts and
    // outran the 4-minute startup probe on 2026-09-21, so no instance could
    // boot. Settlement is logged on the promise itself, so it is reported even
    // when the step outlives the budget.
    const seeding = seedShowcaseWorkforces(storage, Date.now()).then(
      (sc) => { if (sc.healed) log.info('showcase_workforces_seeded', { runs: sc.runs }); },
      (err) => { log.warn('showcase_seed_failed', { reason: err instanceof Error ? err.message : String(err) }); },
    );
    const budgetMs = 20_000;
    const outcome = await withinBootBudget(seeding, budgetMs);
    if (!outcome.settled) log.warn('showcase_seed_deferred', { budgetMs, note: 'boot continues; the seed is idempotent and a later boot re-heals' });
    // ADR 0082 — the Insights Suite demo seeder was DELETED (it seeded a parallel read model
    // for a bespoke dashboard, both removed). Insights are now live workflow run outputs.
  } else {
    log.info('showcase_seed_skipped', { reason: 'OPENWOP_DEMO_MODE not true (clean install)' });
  }

  const webhookWorker = startWebhookDeliveryWorker(storage, `webhook-${getInstanceId()}`);
  const runSweeper = startRunDispatchSweeper({ storage, hostSuite });
  const kanbanWorkItemDaemon = startKanbanWorkItemDaemon({ storage, hostSuite });
  // ADR 0029 (T8) — index approval rows written before the (tenant,status)
  // index existed, so pre-upgrade pending approvals stay visible. Fire-and-
  // forget: a failure degrades stale rows to invisible-until-touched, never
  // blocks boot.
  void backfillApprovalIndexes().catch((err) =>
    log.warn('approval index backfill failed', { error: err instanceof Error ? err.message : String(err) }),
  );
  // Drop stored toggle configs for features that GRADUATED off their toggle
  // (users/connections/assistant/profiles) — without this their admin-saved row
  // lingers in the store and reappears as a live toggle. Fire-and-forget.
  void pruneOrphanedConfigs()
    .then((n) => { if (n > 0) log.info('pruned orphaned feature-toggle configs', { count: n }); })
    .catch((err) => log.warn('toggle-config prune failed', { error: err instanceof Error ? err.message : String(err) }));
  // Wall-clock scheduler: fires durable scheduled jobs on their cadence. Each
  // instance polls; per-fire claimOnce makes it fire-once across the
  // fleet (see scheduleDaemon.ts).
  const scheduleDaemon = startScheduleDaemon({ storage, hostSuite });
  // Autonomous agent heartbeat: members that opted into a cadence get their
  // "Check now" run automatically (fire-once across the fleet).
  const heartbeatDaemon = startHeartbeatDaemon({ storage, hostSuite }, listRosterTenants);
  // Connections warm-refresh (ADR 0024 Phase B): proactively refresh oauth2
  // tokens before expiry so a run never pays the mint latency and a broken
  // connection surfaces as `needs-reconsent` ahead of use (fire-once per slot).
  const connectionsRefreshDaemon = startConnectionsRefreshDaemon(storage);
  // ADR 0077 P3 — retention sweep. DESTRUCTIVE, so gate the START behind an env flag
  // (default OFF); other daemons start unconditionally.
  // ONE retention loop (ADR 0077 governance + ADR 0371 runs + ADR 0380 size
  // hygiene) — starts when ANY half is enabled; each self-gates inside the
  // tick. The 0380 idempotency TTL defaults ON (cache hygiene, not user data),
  // so in practice the loop always starts unless explicitly disabled.
  const retentionSweepDaemon = (process.env.OPENWOP_RETENTION_SWEEP_ENABLED === 'true' || defaultRetentionDays() > 0 || idempotencyTtlDays() > 0)
    ? startRetentionSweepDaemon({ storage })
    : null;
  // ADR 0107 Phase 3b / WF-KB-3 / KSWF-1 — a SyncSource's cadence fires as a
  // per-source scheduler job running the `knowledge-sync.run` workflow (the
  // gmailSync twin), on the ONE host scheduler. The bespoke `knowledgeSyncDaemon`
  // is DELETED (the parallel infra KSWF-1 named). Backfill migrates pre-existing
  // sources (registering a job + owned workflow for any without a `jobId`) once at
  // boot — after the chain packs are loaded (line ~509). Best-effort: a backfill
  // failure must not fail the boot; the per-tenant spend gate (WF-KB-4) now lives
  // in the `knowledge-sync` surface, fail-closed, so a disabled tenant's fired job
  // does zero egress.
  void backfillKnowledgeSyncJobs().catch((err) =>
    log.warn('knowledge_sync_backfill_failed', { error: err instanceof Error ? err.message : String(err) }),
  );
  // ADR 0267 / CDP-E — self-advancing timed waits: resolve due `timer` interrupts
  // by RESUMING their runs (the injected `resolveAndResume` continuation). Unblocks
  // "wait N days then send" journeys; CAS-guarded fire-once across the fleet.
  const timerSweepDaemon = startTimerSweepDaemon({
    storage,
    resume: (interrupt) => resolveAndResume(storage, hostSuite, interrupt.interruptId, { elapsed: true, reason: 'timer' }),
  });
  // ADR 0267 / CDP-E — segment-entered trigger: diff watched-segment membership
  // and emit `crm.segment.entered` per newly-entered contact (fires bound journeys
  // via the existing HostEventBinding path — no parallel trigger source).
  const segmentEntryDaemon = startSegmentEntryDaemon({ storage });
  // ADR 0137 — opt-in ambient work-graph sweep (env-gated; per-tenant toggle checked
  // inside; the GET route reads stored suggestions, an explicit refresh sweeps on demand).
  const workGraphDaemon = process.env.OPENWOP_WORKGRAPH_SWEEP_ENABLED === 'true'
    ? startWorkGraphDaemon({ storage }, listRosterTenants)
    : null;
  // ADR 0210 §2 — weekly CRM pipeline snapshots (env-gated; default OFF like
  // the other opt-in sweep daemons above).
  const crmSnapshotDaemon = process.env.OPENWOP_CRM_SNAPSHOT_ENABLED === 'true'
    ? startCrmSnapshotDaemon({ storage }, listCrmOrgScopes)
    : null;
  // ADR 0432 P3 (chat-first-port G9) — the verifier-sample igniter: monthly,
  // mint a deterministic sample of goal verdicts as `metrics-verifier-sample`
  // approvals so the FP/FN metric has a denominator. Per-tenant kicktodo-metrics
  // toggle checked inside the pass; env-gated START (default OFF) like the other
  // opt-in sweep daemons.
  const verifierSampleDaemon = process.env.OPENWOP_KICKTODO_VERIFIER_SAMPLING_ENABLED === 'true'
    ? startVerifierSampleDaemon({ storage }, listRosterTenants)
    : null;
  // SHUTDOWN-1 — this handler used to stop the daemons and drain the pool but
  // never close the HTTP server and never exit, so the `app.listen` handle held
  // the event loop open forever: after SIGTERM the process stayed ALIVE, still
  // LISTENING, still answering /health 200 (measured). Every `scripts/e2e-routes.sh`
  // run leaked a backend — eight orphans accumulated in one session — and a
  // container run anywhere hangs until its supervisor's SIGKILL.
  //
  // What this is NOT: an outage. Cloud Run stops routing to an instance before it
  // sends SIGTERM, and `pool.end()` waits for active clients rather than aborting
  // them, so the drain below has been doing its job. The cost of never exiting is
  // that shutdown is never CLEAN — the platform always has to SIGKILL us at the
  // grace deadline, and `shutdownTracer()`'s span flush races that kill.
  //
  // Order is deliberate: stop ACCEPTING first, then stop the daemons (they issue
  // queries — stopping them before `storage.close()` is why they never meet a
  // closing pool), then drain, then let the loop end.
  // Must fit inside the platform's grace period (Cloud Run ~10s) or forcing is
  // pointless — the SIGKILL would land first. Env-tunable for operators on a
  // platform with a different budget (k8s `terminationGracePeriodSeconds`).
  const SHUTDOWN_GRACE_MS = Number(process.env.OPENWOP_SHUTDOWN_GRACE_MS) > 0
    ? Number(process.env.OPENWOP_SHUTDOWN_GRACE_MS)
    : 8_000;
  // `once`, deliberately. I changed this to `on` with a re-entry guard, claiming
  // the old code "silently ignored" a second signal — that was WRONG, and the
  // sabotage probe caught it: with `once` the handler is REMOVED after the first
  // signal, so a second SIGTERM hits Node's default disposition and terminates
  // the process immediately. The behaviour I set out to add was already there.
  // Reverted rather than kept, because `on` also needs a re-entry guard to avoid
  // draining the pool twice — complexity bought with a false premise.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      log.info('shutdown: draining', { signal: sig });

      // Stop accepting new connections (and new WS upgrades). Existing requests
      // are allowed to finish; `closeAllConnections()` below is the backstop.
      server.close();

      webhookWorker.stop();
      runSweeper.stop();
      kanbanWorkItemDaemon.stop();
      scheduleDaemon.stop();
      heartbeatDaemon.stop();
      connectionsRefreshDaemon.stop();
      retentionSweepDaemon?.stop();
      timerSweepDaemon.stop();
      segmentEntryDaemon.stop();
      workGraphDaemon?.stop();
      crmSnapshotDaemon?.stop();
      verifierSampleDaemon?.stop();
      // Flush buffered OTel spans before exit (DATA-4). Best-effort; don't
      // block shutdown if the exporter is wedged.
      void shutdownTracer();
      // ADR 0556 P0 — flush metrics too. A reader batches by interval, so an
      // un-flushed exit loses up to a full interval of counts, which reads as a
      // phantom traffic dip at exactly the moment an operator is watching a
      // deploy. Same best-effort posture as the span flush: never block the
      // grace deadline.
      void shutdownMetrics();
      // Drain the storage pool so Postgres backends close cleanly on SIGTERM
      // instead of lingering server-side as zombies until TCP keepalive reaps
      // them. Without this, every Cloud Run scale-down/deploy leaks the
      // instance's pool connections, which accumulate across churn and pin the
      // db-f1-micro `max_connections` ceiling (→ intermittent 500/503 storms
      // when the pool can no longer acquire a connection). Best-effort.
      void storage.close();

      // BOUNDED FORCE-EXIT — the backstop, not the mechanism.
      //
      // Every daemon timer above is `unref()`'d ("so it never holds the process
      // open"), so once the server and the pool are closed the loop drains and
      // the process exits on its own. Two things can prevent that, and neither
      // is hypothetical:
      //   - a live collab WebSocket. `server.close()` refuses new connections but
      //     WAITS for existing ones, and an upgraded socket can stay open for
      //     hours. The `wss` is a local const inside `attachCollabWebSocket`, so
      //     there is no handle to close clients individually — hence
      //     `closeAllConnections()`, which is why the grace exists at all: it
      //     gives Yjs clients a window to flush before the socket is yanked.
      //   - a driver that does not release a handle on close.
      //
      // The budget must fit INSIDE the platform's grace period or it buys
      // nothing: Cloud Run allows ~10s before SIGKILL, so force at 8s. Exit 0
      // either way — a non-zero code makes Cloud Run and Kubernetes report a
      // crash for what is an ordinary shutdown. Log which path was taken instead.
      // `.unref()` so this timer is itself never the reason we stay alive.
      const forceTimer = setTimeout(() => {
        log.warn('shutdown: still alive after grace — forcing', { graceMs: SHUTDOWN_GRACE_MS });
        server.closeAllConnections?.();
        // One tick for the socket teardown to land, then go regardless.
        setTimeout(() => process.exit(0), 250).unref();
      }, SHUTDOWN_GRACE_MS);
      forceTimer.unref();
    });
  }

  // ── Last-resort process guards (Cloud Run `Container called exit(1)`) ───────
  //
  // Node 22 TERMINATES on an unhandled rejection. That is right for a script and
  // wrong for a long-running server: it turns any missing `.catch()` into an
  // outage, and the platform log is a bare stack with no service context. It has
  // already happened here — 2026-08-04 11:07 and 11:24 on revision 00612-2pn:
  //
  //   Error: timeout exceeded when trying to connect      (pg-pool)
  //     at async Object.appendEvent → append → emit
  //
  // A TRANSIENT Cloud SQL pool timeout on an event append killed the container.
  // In-flight requests died with it, and nothing said which run or tenant.
  //
  // We do NOT swallow: continuing after an unhandled rejection risks running on
  // inconsistent state, and the real fix is always the missing `.catch()`. What
  // this adds is (1) a structured, greppable record of WHAT rejected, so the next
  // one is diagnosable from logs alone, and (2) a DRAIN instead of an abrupt
  // death — raising SIGTERM re-uses the shutdown path above verbatim rather than
  // duplicating it, so in-flight requests finish and the pg pool closes cleanly
  // (an abrupt exit leaks server-side connections, the documented
  // pg-connection-exhaustion hazard).
  //
  // `once` per signal: a second fault while draining hits Node's default
  // disposition and dies immediately, which is the correct floor.
  const fatal = (kind: 'unhandledRejection' | 'uncaughtException', err: unknown): void => {
    const e = err instanceof Error ? err : new Error(String(err));
    log.error('fatal: draining then exiting', {
      kind,
      errorName: e.name,
      errorMessage: e.message,
      stack: e.stack,
    });
    // Re-use the SIGTERM drain rather than re-implementing it.
    process.kill(process.pid, 'SIGTERM');
    // Backstop: if the drain wedges, still go — non-zero, because unlike an
    // ordinary shutdown this genuinely IS a crash and should be reported as one.
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS + 1_000).unref();
  };
  process.once('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
  process.once('uncaughtException', (err) => fatal('uncaughtException', err));

  const server = app.listen(config.port, () => {
    log.info('workflow-engine listening', { port: config.port });
  });
  // ADR 0335 Phase 1 — attach the collaboration WebSocket to the http.Server
  // (createApp returns Express and doesn't expose the Server). Dormant until the
  // `realtime-collab` toggle is enabled for a tenant; auth-on-connect only.
  attachCollabWebSocket(server);
}

// Only run main() when this file is the entry point (not when imported
// from tests).
//
// This used to be `import.meta.url === \`file://${process.argv[1]}\``, which is
// the widely-copied ESM idiom and is WRONG through a symlink: `import.meta.url`
// is realpath-resolved while `argv[1]` is not, so launching via macOS's
// `/tmp` -> `/private/tmp` made this false and the process exited 0 having done
// NOTHING — a silent success with an empty log. See `host/entryModule.ts` for
// the measurement and the second (percent-encoding) defect in the same line.
const isEntry = isEntryModule(import.meta.url, process.argv[1]);
if (isEntry) {
  main().catch((err) => {
    log.error('fatal startup error', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
