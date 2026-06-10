/**
 * openwop-workflow-engine-sample — Cloud Run entry point.
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
import { createTracer } from './observability/tracer.js';
import { createLogger } from './observability/logger.js';
import { traceContextMiddleware } from './middleware/traceContext.js';
import { authMiddleware, sessionSecretConfigError } from './middleware/auth.js';
import { ipRateLimitMiddleware } from './middleware/rateLimit.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorEnvelopeMiddleware } from './middleware/errorEnvelope.js';
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
import { seedDefaultHostSurfaces } from './bootstrap/hostSurfaceRegistry.js';
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
import { dirname, resolve as resolvePath } from 'node:path';
import { registerAllRoutes } from './routes/registerAllRoutes.js';

const log = createLogger('workflow-engine');

/** Brand-neutral, protocol-accurate default for the OpenAPI discovery doc.
 *  A white-label host overrides it with OPENWOP_SERVICE_DESCRIPTION rather than
 *  inheriting a marketing string it didn't set. */
export const DEFAULT_SERVICE_DESCRIPTION =
  'An OpenWOP-compatible workflow and agent orchestration host.';

/** Vendor tag emitted in `service.vendor` of `/.well-known/openwop`. Defaults to
 *  the reference-sample lineage; a white-label host overrides it with
 *  OPENWOP_SERVICE_VENDOR so its discovery doc doesn't claim a vendor it isn't. */
export const DEFAULT_SERVICE_VENDOR = 'openwop-samples';

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
      process.env.OPENWOP_SERVICE_NAME, 'openwop-workflow-engine-sample', 'OPENWOP_SERVICE_NAME'),
    serviceVersion: boundServiceIdentity(
      process.env.OPENWOP_SERVICE_VERSION, '0.1.0', 'OPENWOP_SERVICE_VERSION'),
    // Surfaced in the OpenAPI discovery doc (`GET /v1/openapi.json`).
    serviceDescription: process.env.OPENWOP_SERVICE_DESCRIPTION || DEFAULT_SERVICE_DESCRIPTION,
    // Surfaced in `service.vendor` of `/.well-known/openwop`.
    serviceVendor: boundServiceIdentity(
      process.env.OPENWOP_SERVICE_VENDOR, DEFAULT_SERVICE_VENDOR, 'OPENWOP_SERVICE_VENDOR'),
    enableConsoleTracer: process.env.OPENWOP_OTEL_CONSOLE !== 'false',
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
  // / scripted-test setups). Runtime adds via POST /v1/host/sample/byok/secrets.
  await loadSecretsFromEnv();

  // Managed-provider key bootstrap. If MINIMAX_API_KEY (etc.) is set,
  // encrypt it with the BYOK master key and persist into byok_secrets
  // under `managed:<provider>`. Idempotent: rotates if the env value
  // changed, no-ops if unchanged. See providers/managedProvider.ts.
  configureManagedProvider({ storage, dataDir });
  await bootstrapManagedProvider();

  // Pre-register node modules + install singletons before the first
  // request lands. Mirrors the MyndHyve workflow-runtime boot order.
  // Seed host-surface registry with "supported=false" defaults so the
  // discovery + catalog routes can show the full surface list with
  // honest support flags. Phase-3 adapters call registerHostSurface()
  // again with `supported: true` once they're wired.
  seedDefaultHostSurfaces();

  // Wire host surfaces (kv/table/cache/blob/queue/fs/sql/vector/messaging
  // /observability) so pack-authored nodes delegating to ctx.storage / ctx.db
  // / ctx.fs / ctx.queueBus / ctx.observability actually execute. Each surface
  // resolves through the backend seam (host/surfaceBackends.ts): the default
  // 'memory' tier is demo-grade and process-local (restarts wipe it); set
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
  // host.chat writes the SAME chat tables the /v1/host/sample/chat routes + SPA
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

  // Fetch + verify + install registry packs the sample wants in the
  // builder palette. Non-blocking: install failures are logged and
  // the sample still serves the locally-registered nodes.
  //
  // Default: when the local mount found the workspace AND
  // OPENWOP_INSTALL_PACKS is unset, skip the network registry install
  // — every default-pack the sample wants is already on disk from the
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
  // in-tree `vendor.openwop.prompt-sample` pack auto-installs when
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
  app.use('/v1/host/sample/media', express.json({ limit: '12mb' }));
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
  } else {
    log.info('showcase_seed_skipped', { reason: 'OPENWOP_DEMO_MODE not true (clean install)' });
  }

  const webhookWorker = startWebhookDeliveryWorker(storage, `webhook-${getInstanceId()}`);
  const runSweeper = startRunDispatchSweeper({ storage, hostSuite });
  // Wall-clock scheduler: fires durable scheduled jobs on their cadence. Each
  // instance polls; per-fire claimIdempotency makes it fire-once across the
  // fleet (see scheduleDaemon.ts).
  const scheduleDaemon = startScheduleDaemon({ storage, hostSuite });
  // Autonomous agent heartbeat: members that opted into a cadence get their
  // "Check now" run automatically (fire-once across the fleet).
  const heartbeatDaemon = startHeartbeatDaemon({ storage, hostSuite }, listRosterTenants);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      webhookWorker.stop();
      runSweeper.stop();
      scheduleDaemon.stop();
      heartbeatDaemon.stop();
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
