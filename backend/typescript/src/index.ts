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
import { createLogger } from './observability/logger.js';
import { APP_VERSION } from './version.js';
import { recordAppVersion } from './host/appVersion.js';
import { initHostExtPersistence } from './host/hostExtPersistence.js';
import { traceContextMiddleware } from './middleware/traceContext.js';
import { authMiddleware, sessionSecretConfigError } from './middleware/auth.js';
import { ipRateLimitMiddleware } from './middleware/rateLimit.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorEnvelopeMiddleware } from './middleware/errorEnvelope.js';
import { requestTimeoutMiddleware } from './middleware/requestTimeout.js';
import { jsonGzipMiddleware } from './middleware/jsonGzip.js';
import { ensureNodesRegistered } from './bootstrap/nodes.js';
import { ensureSuspendManagerInstalled } from './bootstrap/suspend.js';
import { ensureEventLogInstalled } from './bootstrap/eventLog.js';
import { ensureInvocationLogInstalled } from './bootstrap/invocationLog.js';
import { ensureRuntimeCapabilityRegistryInstalled } from './bootstrap/runtimeCapabilityRegistry.js';
import { ensureNodePackResolverInstalled } from './bootstrap/nodePackResolver.js';
import { ensureAgentPackResolverInstalled } from './bootstrap/agentPackResolver.js';
import { ensureRegistryPacksInstalled } from './bootstrap/installRegistryPacks.js';
import { featurePackRefs } from './features/index.js';
import { ensureLocalPacksMounted } from './bootstrap/mountLocalPacks.js';
import { loadPromptPacks, defaultPromptPackRoots } from './host/promptPackLoader.js';
import { loadConnectionPacks, defaultConnectionPackRoots } from './features/connections/connectionPackLoader.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots } from './host/workflowChainPackLoader.js';
import { seedDefaultHostSurfaces } from './bootstrap/hostSurfaceRegistry.js';
import { seedHostArtifactTypes } from './host/artifactTypes.js';
import { loadArtifactTypePacks, defaultArtifactTypePackRoots } from './host/artifactTypePackLoader.js';
import { seedShowcaseWorkforces } from './host/workforceService.js';
import { demoMode } from './host/demoMode.js';
import { initInMemorySurfaces } from './host/inMemorySurfaces.js';
import { initDurableSurfaces } from './host/durable/durableKv.js';
import { registerS3BlobAdapter } from './host/blob/s3Blob.js';
import { registerOpenSearchAdapter } from './host/search/openSearchSearch.js';
import { registerPgVectorAdapter } from './host/vector/pgVectorVector.js';
import { registerPgSqlAdapter } from './host/sql/pgSql.js';
import { setChatStorage } from './host/chatSurface.js';
import { openStorage } from './storage/index.js';
import type { Storage } from './storage/storage.js';
import { createHostAdapterSuite, type HostAdapterSuite } from './host/index.js';
import { startWebhookDeliveryWorker } from './host/webhookDeliveryWorker.js';
import { startRunDispatchSweeper } from './host/runDispatchSweeper.js';
import { startScheduleDaemon } from './host/scheduleDaemon.js';
import { backfillApprovalIndexes } from './host/approvalService.js';
import { pruneOrphanedConfigs } from './host/featureToggles/service.js';
import { startConnectionsRefreshDaemon } from './features/connections/refreshDaemon.js';
import { startKnowledgeSyncDaemon } from './features/knowledge-sync/knowledgeSyncDaemon.js';
import { startWorkGraphDaemon } from './features/ambient-work-graph/workGraphSweep.js';
import { listSyncSourceTenants } from './features/knowledge-sync/knowledgeSyncService.js';
import { startRetentionSweepDaemon } from './host/retentionSweepDaemon.js';
import { startHeartbeatDaemon } from './host/heartbeatService.js';
import { listRosterTenants } from './host/rosterService.js';
import { getInstanceId } from './host/instanceId.js';
import { configureSecretResolver, loadSecretsFromEnv } from './byok/secretResolver.js';
import { bootstrapKmsFromEnv } from './byok/kmsEncryption.js';
import { readDeployPosture } from './host/deployPosture.js';
import {
  bootstrapManagedProvider,
  configureManagedProvider,
} from './providers/managedProvider.js';
import { configureMediaBudget } from './aiProviders/mediaBudget.js';
import { getGovernancePolicy } from './host/governanceService.js';
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

  const storage = await openStorage(config.storageDsn);
  // Wire the host-ext durability layer BEFORE app-tier migrations run — an
  // app migration may operate over host-ext `DurableCollection`s (e.g. the ADR
  // 0102 agent-profile permission backfill), which require the storage ref.
  // Idempotent: the route-module register hook calls this again with the same
  // storage. (initHostExtPersistence only sets a module-level ref.)
  initHostExtPersistence(storage);
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
        await setSecret('openwop-conformance-canary-secret', 'canary-value-CANARY-openwop-CONFORMANCE-NEVER-SECRET-' + Math.random().toString(36).slice(2, 8));
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

  // Pre-register node modules + install singletons before the first
  // request lands. Mirrors the MyndHyve workflow-runtime boot order.
  // Seed host-surface registry with "supported=false" defaults so the
  // discovery + catalog routes can show the full surface list with
  // honest support flags. Phase-3 adapters call registerHostSurface()
  // again with `supported: true` once they're wired.
  seedDefaultHostSurfaces();
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
  // host.canvas crossCanvasInvoke spawns a real child run via the same deps.
  const { setCanvasInvokeDispatcher } = await import('./host/canvasSurface.js');
  setCanvasInvokeDispatcher({
    storage,
    getWorkflow: (workflowId) => hostSuite.workflowCatalog.getWorkflow(workflowId) as Promise<{ definition: { variables?: unknown } } | null>,
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

  // Higher-limit JSON parser for /v1/packs/* publish payloads. MUST
  // register before the global 1mb parser; body-parser is no-op when
  // req._body is set, so registration order is precedence order.
  app.use('/v1/packs', express.json({ limit: '50mb' }));
  // Chat-attachment uploads (base64) ride a scoped parser sized to the
  // 8mb-base64 store cap in routes/mediaAssets.ts. Registered before the
  // global 1mb parser; body-parser is a no-op once req._body is set, so
  // registration order is precedence order.
  app.use('/v1/host/openwop-app/media', express.json({ limit: '12mb' }));
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
  app.use(express.json({ limit: '1mb' }));

  // CORS — MUST come before auth so OPTIONS preflight succeeds without
  // credentials per the CORS spec.
  app.use(corsMiddleware());

  // W3C traceparent → active OTel context. Mounted before route
  // registrations so handlers see the propagated context.
  app.use(traceContextMiddleware());

  // Bearer-token auth — stub: any non-empty token resolves to a synthetic
  // principal. Replace with Firebase / OIDC / your IdP for real deploys.
  app.use(authMiddleware());

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

  // Posture nudge (server-only). A non-sqlite storage DSN means a real durable
  // backend — almost always a deployment, not local dev. If NODE_ENV isn't
  // 'production' there, the production hardening silently stays OFF: the eager
  // secret check above no-ops, session cookies drop their Secure flag, and the
  // auth posture defaults to anonymous. Warn loudly but DON'T abort — a
  // developer MAY legitimately point at Postgres locally.
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
    try {
      const sc = await seedShowcaseWorkforces(storage, Date.now());
      if (sc.healed) log.info('showcase_workforces_seeded', { runs: sc.runs });
    } catch (err) {
      log.warn('showcase_seed_failed', { reason: err instanceof Error ? err.message : String(err) });
    }
    // ADR 0082 — the Insights Suite demo seeder was DELETED (it seeded a parallel read model
    // for a bespoke dashboard, both removed). Insights are now live workflow run outputs.
  } else {
    log.info('showcase_seed_skipped', { reason: 'OPENWOP_DEMO_MODE not true (clean install)' });
  }

  const webhookWorker = startWebhookDeliveryWorker(storage, `webhook-${getInstanceId()}`);
  const runSweeper = startRunDispatchSweeper({ storage, hostSuite });
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
  // instance polls; per-fire claimIdempotency makes it fire-once across the
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
  const retentionSweepDaemon = process.env.OPENWOP_RETENTION_SWEEP_ENABLED === 'true'
    ? startRetentionSweepDaemon({ storage })
    : null;
  // ADR 0107 Phase 3b — make a SyncSource's cadence actually fire (drive→KB sync).
  const knowledgeSyncDaemon = startKnowledgeSyncDaemon({ storage }, listSyncSourceTenants);
  // ADR 0137 — opt-in ambient work-graph sweep (env-gated; per-tenant toggle checked
  // inside; the GET route reads stored suggestions, an explicit refresh sweeps on demand).
  const workGraphDaemon = process.env.OPENWOP_WORKGRAPH_SWEEP_ENABLED === 'true'
    ? startWorkGraphDaemon({ storage }, listRosterTenants)
    : null;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      webhookWorker.stop();
      runSweeper.stop();
      scheduleDaemon.stop();
      heartbeatDaemon.stop();
      connectionsRefreshDaemon.stop();
      retentionSweepDaemon?.stop();
      knowledgeSyncDaemon.stop();
      workGraphDaemon?.stop();
      // Flush buffered OTel spans before exit (DATA-4). Best-effort; don't
      // block shutdown if the exporter is wedged.
      void shutdownTracer();
    });
  }

  app.listen(config.port, () => {
    log.info('workflow-engine listening', { port: config.port });
  });
}

// Only run main() when this file is the entry point (not when imported
// from tests). import.meta.url comparison is the ESM idiom.
const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  main().catch((err) => {
    log.error('fatal startup error', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
