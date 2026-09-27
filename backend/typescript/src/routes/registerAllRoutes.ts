/**
 * Centralized route registration (white-label PRD §3: "a new domain can't
 * ship unregistered").
 *
 * Every backend domain registers here, in ONE ordered list, instead of as a
 * loose stack of calls in index.ts. Registration order is mount order in
 * Express, so the list order is semantic — keep ordering comments intact.
 * Boot-time side effects that must interleave with mounting (registry
 * hydration, host-ext persistence wiring, messaging bridge construction)
 * are list entries too, so the single ordered list is the whole story.
 *
 * The companion test (`test/register-all-routes.test.ts`) asserts that every
 * `register*Routes` export under `src/routes/` appears in this file — adding a
 * new route module without listing it here FAILS CI instead of 404ing in
 * production (the CoLabCare fork shipped exactly that bug).
 */
import type { Express } from 'express';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from '../host/index.js';
// Type-only import from the app entry — erased at compile time, so the
// index.ts → registerAllRoutes.ts → index.ts shape is NOT a runtime cycle.
import type { AppConfig } from '../index.js';
import { registerHealthRoutes } from './health.js';
import { registerSchemaRoutes } from './schemas.js';
import { registerDiscoveryRoutes } from './discovery.js';
import { registerRunRoutes } from './runs.js';
import { registerInterruptRoutes } from './interrupts.js';
// NOTE: notifications + pushSubscriptions migrated to the feature-package
// (src/features/notifications/) per ADR 0010 — composed via
// registerBackendFeatures() below, no longer in the core ROUTE_MODULES list.
import { registerStreamRoutes } from './streams.js';
import { registerWebhookRoutes } from './webhooks.js';
import { registerHostEventRoutes } from './hostEvents.js';
import { registerEffectSeamRoutes } from './effectSeams.js';
import { registerEventLogSeedSeam } from './eventLogSeedSeam.js';
import { registerWebhookReceiveSeam } from './webhookReceiveSeam.js';
import { registerFireEffectSeam } from './effectSeamFireSeam.js';
import { registerDurabilitySeam } from './durabilitySeam.js';
import { registerEffectTransportRetrySeam } from './effectTransportRetrySeam.js';
import { registerPackRoutes } from './packs.js';
import { registerPackTestRoutes } from './packs-test.js';
import { registerByokRoutes } from './byok.js';
import { registerUiPluginRoutes } from './uiPlugins.js';
import { presentationEnabled } from '../host/hostProfile.js';
import { registerDispatchFanOutRoutes } from './dispatchFanOut.js';
import { registerChainDeferredExpandSeamRoutes } from './chainDeferredExpandSeam.js';
import { registerWorkflowChainExpandSeamRoutes } from './workflowChainExpandSeam.js';
import { registerAnonSurfaceSeamRoutes } from './anonSurfaceSeam.js';
import { registerPurposePropagationSeamRoutes } from './purposePropagationSeam.js';
import { registerCompatEndpointRoutes } from './compatEndpoints.js';
import { registerChatSessionRoutes } from './chatSessions.js';
import { registerPromptRoutes } from './prompts.js';
import { registerMigrateRoute } from './migrate.js';
import { registerSubjectRekeyRoute } from './subjectRekey.js';
import { registerAccountRoutes } from './account.js';
import { registerClientSupportRoutes } from './clientSupport.js';
import { registerMemoryRoutes } from './memory.js';
import { registerMemoryCompactionSeamRoutes } from './memoryCompactionSeam.js';
import { registerWorkspaceRoutes } from './workspace.js';
import { registerConnectionPackSeamRoutes } from './connectionPackSeam.js';
import { registerReplayEffectCountSeamRoutes } from './replayEffectCountSeam.js';
import { registerEffectEscapeLedgerSeamRoutes } from './effectEscapeLedgerSeam.js';
import { registerCompensationSeamRoutes } from './compensationSeam.js';
import { registerWorkloadIdentitySeamRoutes } from './workloadIdentitySeam.js';
import { registerFormContentSeamRoutes } from './formContentSeam.js';
import { registerArtifactTypeSeamRoutes } from './artifactTypeSeam.js';
import { registerMediaAssetRoutes } from './mediaAssets.js';
import { registerPresentRemoteRoutes } from './presentRemote.js';
import { registerTestSeamRoutes } from './testSeam.js';
import { registerAuthTestSeamRoutes } from './authTestSeam.js';
import { registerSamlAuthRoutes } from './authSaml.js';
import { registerSamlSsoRoutes } from './authSamlSso.js';
import { registerScimAuthRoutes } from './authScim.js';
import { registerMcpServerRoutes } from './mcp.js';
import { registerMcpInvokeSeamRoutes } from './mcpInvokeSeam.js';
import { registerUcpRefMerchantRoutes } from './ucpRefMerchant.js';
import { registerToolCatalogRoutes } from './toolCatalog.js';
import { registerAdminRoutes } from './admin.js';
import { registerAdminVaultRoutes } from './adminVault.js';
import { registerBreakGlassRoutes } from './authBreakGlass.js';
import { registerWorkflowRoutes } from './workflows.js';
import { registerWorkflowDebugRoutes } from './workflowDebug.js';
import { registerWorkflowEvalRoutes } from './workflowEvals.js';
import { registerWorkflowBudgetRoutes } from './workflowBudgets.js';
import { registerNodeCatalogRoute } from './nodeCatalog.js';
import { registerExampleDataSummaryRoutes } from './exampleDataSummary.js';
import { registerDaemonStatusRoutes } from './daemonStatus.js';
import { registerAgentRoutes } from './agents.js';
import { registerRunnerSeamRoutes } from './runnerSeam.js';
import { registerUserAgentRoutes, loadUserAgentsIntoRegistry } from './userAgents.js';
import { registerAgentPackRegistryRoutes } from './agentPackRegistry.js';
import { registerSchedulerRoutes } from './scheduler.js';
import { registerRosterRoutes } from './roster.js';
import { registerAgentProfileRoutes } from './agentProfile.js';
import { registerOrgChartRoutes, registerOrgChartNormativeRoutes } from './orgChart.js';
import { registerMultiPartyConversationSeamRoutes } from './multiPartyConversationSeam.js';
import { registerWorkforceRoutes } from './workforces.js';
import { registerAccessControlRoutes } from './accessControl.js';
import { registerWorkspaceTenancyRoutes } from './workspaces.js';
import { registerKanbanRoutes } from './kanban.js';
import { registerAgentOpsRoutes } from './agentOps.js';
import { registerApprovalRoutes } from './approvals.js';
import { registerWorkflowProposalPolicyRoutes } from './workflowProposalPolicies.js';
import { registerApprovalDelegationRoutes } from './approvalDelegations.js';
import { registerApprovalDeliveryTeamsRoutes } from './approvalDeliveryTeams.js';
import { registerReviewRoutes } from './reviews.js';
import { registerUiStateRoutes } from './uiState.js';
import { registerGovernanceRoutes } from './governance.js';
import { registerTriggerBridgeRoutes } from './triggerBridge.js';
import { registerMessagingRoutes } from './messaging.js';
import { createSelfHttpBridge } from '../messaging/bridge.js';
import { resolveInternalToken } from '../subruns/subRunDispatcher.js';
import { resolveNotifyDelivererFromEnv } from '../messaging/notifyDeliverer.js';
import { initHostExtPersistence } from '../host/hostExtPersistence.js';
import { installEmailApprovalDelivery } from '../host/emailApprovalDelivery.js';
import { registerHostSubjectErasers } from '../host/hostSubjectErasers.js';
import { fetch as undiciFetch } from 'undici';
import { assertEgressSchemeAllowed, webhookEgressDispatcher } from '../host/webhookEgressGuard.js';
import { setA2aPushSink } from '../host/a2aTaskStore.js';
import { registerFeatureToggleRoutes } from './featureToggles.js';
import { registerAgentAllowlistRoutes } from './agentAllowlists.js';
import { registerSiteConfigRoutes } from './siteConfig.js';
import { registerAppBrandRoutes } from './appBrand.js';
import { ensureSystemSite } from '../host/systemSite.js';
import { ensureSystemBrand } from '../host/systemBrand.js';
import { ensureFeaturesPage } from '../host/featuresPage.js';
import { ensureComparisonPage } from '../host/comparisonPage.js';
import { ensureMarketingContentPages } from '../host/marketingContentPages.js';
import { ensureSystemSiteDocs } from '../host/systemSiteDocs.js';
import { registerBackendFeatures } from '../features/index.js';

const log = createLogger('routes.registerAll');

export interface RouteDeps {
  app: Express;
  config: AppConfig;
  storage: Storage;
  hostSuite: HostAdapterSuite;
  startTimeMs: number;
}

interface RouteModule {
  name: string;
  register: (deps: RouteDeps) => void;
}

/** Mount order IS Express precedence order — append new domains where they
 *  belong semantically, and keep the ordering comments truthful. */
const ROUTE_MODULES: RouteModule[] = [
  { name: 'health', register: ({ app, storage }) => registerHealthRoutes(app, { storage }) },
  { name: 'discovery', register: ({ app, storage, config }) => registerDiscoveryRoutes(app, { storage, config }) },
  { name: 'schemas', register: ({ app }) => registerSchemaRoutes(app) },
  { name: 'runs', register: ({ app, storage, hostSuite }) => registerRunRoutes(app, { storage, hostSuite }) },
  { name: 'interrupts', register: ({ app, storage }) => registerInterruptRoutes(app, { storage }) },
  // notifications + pushSubscriptions are now a BackendFeature (ADR 0010),
  // registered via registerBackendFeatures() after this list.
  { name: 'streams', register: ({ app, storage }) => registerStreamRoutes(app, { storage }) },
  { name: 'webhooks', register: ({ app, storage }) => registerWebhookRoutes(app, { storage }) },
  // ADR 0208 — host-event bindings (record-change events → workflows) + the
  // dispatcher init (webhook fanout + shared run starter injected here).
  { name: 'hostEvents', register: ({ app, storage, hostSuite }) => registerHostEventRoutes(app, { storage, hostSuite }) },
  // RFC 0173 §C.1 — the effect-seam manifest. Canonical production surface, not
  // a test seam: the `replay` capability facet pins this exact path.
  { name: 'effectSeams', register: ({ app }) => registerEffectSeamRoutes(app) },
  // RFC 0176 — the era-2 event-log seed seam. Test-only (it plants runs);
  // 404s unless OPENWOP_TEST_SEAM_ENABLED, and the seams advert reads the same flag.
  { name: 'eventLogSeedSeam', register: ({ app, storage }) => registerEventLogSeedSeam(app, { storage }) },
  // RFC 0176 §D.2 — the inbound webhook verifier seam. Same signature module
  // the delivery worker signs with, so the witness covers both directions.
  { name: 'webhookReceiveSeam', register: ({ app }) => registerWebhookReceiveSeam(app) },
  // RFC 0173 §C.2 — fire one manifest row into the real Layer-2 ledger.
  { name: 'fireEffectSeam', register: ({ app, storage, hostSuite }) => registerFireEffectSeam(app, { storage, hostSuite }) },
  // RFC 0158 (ADR 0739) — the kill/bound durability seam. Answers 404 unless the
  // seam gate is on AND `main()` was the entry point: it SIGKILLs this process.
  { name: 'durabilitySeam', register: ({ app, storage, hostSuite }) => registerDurabilitySeam(app, { storage, hostSuite }) },
  // RFC 0173 §D.2 G4 — one effect, two transport attempts, one identity.
  { name: 'effectTransportRetrySeam', register: ({ app, storage }) => registerEffectTransportRetrySeam(app, { storage }) },
  { name: 'packs', register: ({ app, storage }) => registerPackRoutes(app, { storage }) },
  // RFC 0025 — isolated test-mode mirror namespace. Gated on
  // OPENWOP_PACKS_TEST_NAMESPACE_ENABLED=true; routes are not mounted when the
  // env-gate is unset, so production deploys default to "off".
  { name: 'packs-test', register: ({ app }) => registerPackTestRoutes(app) },
  { name: 'byok', register: ({ app }) => registerByokRoutes(app) },
  // RFC 0117 — front-end plugin packs. The ui-plugin/1 RPC witness seam; mounted
  // when the host presents uiPlugins (discovery.ts advertises it from the same gate).
  // ADR 0168 — left UNMOUNTED in OPENWOP_PROFILE=headless so advertise and serve stay
  // co-gated (a headless deploy serves no iframe-render RPC it doesn't advertise).
  { name: 'uiPlugins', register: ({ app }) => { if (presentationEnabled('uiPlugins')) registerUiPluginRoutes(app); } },
  // RFC 0118 — parallel sub-workflow fan-out. The dispatch/fanout witness seam; always
  // mounted because the host honestly advertises dispatch.fanOutSupported (discovery.ts).
  { name: 'dispatchFanOut', register: ({ app }) => registerDispatchFanOutRoutes(app) },
  { name: 'chainDeferredExpandSeam', register: ({ app }) => registerChainDeferredExpandSeamRoutes(app) },
  { name: 'workflowChainExpandSeam', register: ({ app }) => registerWorkflowChainExpandSeamRoutes(app) },
  // RFC 0132 (Draft) — anonymous-actor conformance witness seam. Always mounted;
  // each route 404s per-request unless OPENWOP_ANON_ACTOR_ENABLED (mirrors the
  // discovery advert). The anon surface is unauthenticated by construction
  // (PUBLIC_PATH_PREFIXES), so it needs no bearer.
  { name: 'anonSurfaceSeam', register: ({ app, storage }) => registerAnonSurfaceSeamRoutes(app, { storage }) },
  // RFC 0137 — the behavioral witness for `host.forms.contentPacks` (openwop#885).
  { name: 'formContentSeam', register: ({ app }) => registerFormContentSeamRoutes(app) },
  { name: 'artifactTypeSeam', register: ({ app, storage, hostSuite }) => registerArtifactTypeSeamRoutes(app, { storage, hostSuite }) },
  // RFC 0128 (Draft) — purpose-propagation conformance seam (flag-gated; 404 pre-flip).
  { name: 'purposePropagationSeam', register: ({ app }) => registerPurposePropagationSeamRoutes(app) },
  // RFC 0108 / ADR 0121 — compat (self-hosted/OpenAI-compatible) endpoint config.
  // Env-gated (OPENWOP_COMPAT_PROVIDER_ENABLED, default OFF); routes 404 when unset.
  { name: 'compat-endpoints', register: ({ app }) => registerCompatEndpointRoutes(app) },
  { name: 'chatSessions', register: ({ app, storage }) => registerChatSessionRoutes(app, { storage }) },
  {
    name: 'prompts',
    register: ({ app }) => registerPromptRoutes(app, {
      capability: { endpointsSupported: true, mutableLibrary: true },
    }),
  },
  { name: 'migrate', register: ({ app, storage }) => registerMigrateRoute(app, { storage }) },
  { name: 'subjectRekey', register: ({ app, storage }) => registerSubjectRekeyRoute(app, { storage }) },
  { name: 'account', register: ({ app, storage }) => registerAccountRoutes(app, { storage }) },
  { name: 'client-support', register: ({ app }) => registerClientSupportRoutes(app) }, // ADR 0413 host-side handshake (non-normative)
  { name: 'memory', register: ({ app }) => registerMemoryRoutes(app) },
  { name: 'memoryCompactionSeam', register: ({ app }) => registerMemoryCompactionSeamRoutes(app) },
  { name: 'workspace', register: ({ app, storage }) => registerWorkspaceRoutes(app, storage) },
  { name: 'connectionPackSeam', register: ({ app }) => registerConnectionPackSeamRoutes(app) },
  // RFC 0140 / ADR 0533 — the replay effect counter (`host-sample-test-seams.md`
  // §20). Reads the tally the ADR 0531 guard keeps on its allow branch.
  { name: 'replayEffectCountSeam', register: ({ app }) => registerReplayEffectCountSeamRoutes(app) },
  // ADR 0591 P3 — the per-identity sibling of the seam above. Separate route
  // because a per-run scalar and a per-identity count answer different
  // questions; see effectEscapeLedgerSeam.ts.
  { name: 'effectEscapeLedgerSeam', register: ({ app, storage }) => registerEffectEscapeLedgerSeamRoutes(app, { storage }) },
  // RFC 0151 / ADR 0554 P2 — the compensation unwind + replay drivers
  // (`host-sample-test-seams.md` §21). Drives the REAL executor and the real
  // unwind; §21 forbids a canned-event mock.
  { name: 'compensationSeam', register: ({ app, storage }) => registerCompensationSeamRoutes(app, { storage }) },
  // RFC 0154 §A/§B / ADR 0556 P3 — the workload-identity resolution driver
  // (`host-sample-test-seams.md` §20). Drives the REAL resolver the request
  // path consults; §20 forbids a canned-principal mock.
  { name: 'workloadIdentitySeam', register: ({ app }) => registerWorkloadIdentitySeamRoutes(app) },
  { name: 'mediaAssets', register: ({ app }) => registerMediaAssetRoutes(app) },
  { name: 'presentRemote', register: ({ app }) => registerPresentRemoteRoutes(app) },
  { name: 'testSeam', register: ({ app, storage }) => registerTestSeamRoutes(app, { storage }) },
  { name: 'authTestSeam', register: ({ app }) => registerAuthTestSeamRoutes(app) },
  { name: 'authSaml', register: ({ app }) => registerSamlAuthRoutes(app) },
  { name: 'authSamlSso', register: ({ app, storage }) => registerSamlSsoRoutes(app, { storage }) },
  { name: 'authScim', register: ({ app }) => registerScimAuthRoutes(app) },
  { name: 'mcp', register: ({ app, storage, hostSuite }) => registerMcpServerRoutes(app, { storage, hostSuite }) },
  // ADR 0553 P2 — host-sample-test-seams.md §23. Registered AFTER `testSeam`,
  // whose `app.use('/v1/host/sample', guardSeam)` only covers routes mounted
  // after it: an earlier mount would be an unguarded door onto the same handler.
  { name: 'mcpInvokeSeam', register: ({ app, storage }) => registerMcpInvokeSeamRoutes(app, { storage }) },
  { name: 'ucpRefMerchant', register: ({ app }) => registerUcpRefMerchantRoutes(app) }, // ADR 0260 — dev/demo reference UCP merchant (off by default)
  { name: 'toolCatalog', register: ({ app, storage }) => registerToolCatalogRoutes(app, { storage }) },
  { name: 'admin', register: ({ app }) => registerAdminRoutes(app) },
  { name: 'adminVault', register: ({ app }) => registerAdminVaultRoutes(app) }, // ADR 0389 P2 — superadmin secrets-vault projection
  { name: 'breakGlass', register: ({ app }) => registerBreakGlassRoutes(app) }, // ADR 0389 P3 — default-OFF operator last resort
  { name: 'workflows', register: ({ app, hostSuite, storage }) => registerWorkflowRoutes(app, { hostSuite, storage }) },
  // ADR 0475 — the debug loop (node-output pins + execute-from-step + bulk
  // redrive). Owner-gated host-ext routes; the debug run rides the shared
  // run seam. NOTE: `workflows/:id/pins` (node-output debug pins) is distinct
  // from `runs/:id/pin` above (the ADR 0371 retention pin).
  { name: 'workflowDebug', register: ({ app, hostSuite, storage }) => registerWorkflowDebugRoutes(app, { hostSuite, storage }) },
  // ADR 0477 — workflow evaluations (eval sets, assertion runs, results).
  { name: 'workflowEvals', register: ({ app, hostSuite, storage }) => registerWorkflowEvalRoutes(app, { hostSuite, storage }) },
  // ADR 0482 §3 — per-workflow daily budgets (owner-gated GET/PUT).
  { name: 'workflowBudgets', register: ({ app }) => registerWorkflowBudgetRoutes(app) },
  // ADR 0478 §2 — inject storage for the email approval-delivery lane (boot
  // side effect; the emitter chokepoint calls it without threading Storage).
  { name: 'emailApprovalDelivery', register: ({ storage }) => installEmailApprovalDelivery(storage) },
  { name: 'nodeCatalog', register: ({ app }) => registerNodeCatalogRoute(app) },
  { name: 'exampleDataSummary', register: ({ app, config }) => registerExampleDataSummaryRoutes(app, { config }) },
  { name: 'daemonStatus', register: ({ app, config, startTimeMs }) => registerDaemonStatusRoutes(app, { config, startTimeMs }) },
  // MUST precede `agents`: that module serves `GET /v1/agents/:agentId`, which
  // matches the literal `org-chart` segment and 404s it. Express resolves in
  // registration order, so registering the RFC 0087 §D normative reads after
  // `agents` makes them unreachable — and the 404 reads to the conformance
  // suite as "seam absent", i.e. it fails exactly like never having built them.
  // Pinned by `test/org-chart-normative-route.test.ts`.
  { name: 'orgChartNormative', register: ({ app }) => registerOrgChartNormativeRoutes(app) },
  { name: 'agents', register: ({ app, hostSuite, storage }) => registerAgentRoutes(app, { hostSuite, storage }) },
  { name: 'runnerSeam', register: ({ app }) => registerRunnerSeamRoutes(app) },
  { name: 'userAgents', register: ({ app, storage }) => registerUserAgentRoutes(app, { storage }) },
  { name: 'agentPackRegistry', register: ({ app }) => registerAgentPackRegistryRoutes(app) },
  {
    // Boot-time hydration of the AgentRegistry from persisted user-authored
    // rows (incl. the one-time `_anon`→`default` legacy-tenant migration).
    // Pack-installed agents are registered earlier in the pack loader; this
    // fold adds any user-authored ones so `GET /v1/agents` and the chat-tab
    // `@` picker both see them without per-request lookups.
    name: 'userAgents:hydrate',
    register: ({ storage }) => {
      void loadUserAgentsIntoRegistry(storage).catch((err) => {
        log.error('user_agents_load_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
  },
  {
    // Host-extension durability (RFC 0086/0087/0083 sample stores): wire the
    // kv persistence layer. The stores are read-through (every read/write hits
    // storage), so there is no boot-time hydrate step and no per-instance
    // cache to drift — a multi-instance deployment stays consistent.
    name: 'hostExt:persistence',
    register: ({ storage }) => initHostExtPersistence(storage),
  },
  {
    // ADR 0464 P2 — register every host-owned store's DSAR subject-eraser so a
    // data-subject `eraseSubject` reaches host state (kanban, canvas, schedules,
    // twin grants, ACL memberships, conversations, chat read-state/feedback/
    // reactions, subject memory/knowledge, runner dispatch residue), not just
    // feature stores. Idempotent-by-reference; after persistence so the erasers'
    // durable collections have their storage ref.
    name: 'hostExt:subjectErasers',
    register: () => registerHostSubjectErasers(),
  },
  {
    // ADR 0035 / RFC 0100 — wire the durable A2A Task push sink. A registered
    // push-config fires a `TaskStatusUpdateEvent` to the caller's target on the
    // terminal/blocking transitions; the default sink POSTs it through the same
    // RFC 0093 webhook-egress-guarded dispatcher every webhook delivery uses
    // (the URL was already SSRF-validated at register time; the dispatcher
    // re-validates the resolved address at connect time). Only wired when
    // durable Tasks are enabled. Best-effort — the sink never throws into the
    // state transition (a2aTaskStore swallows sink failures).
    name: 'a2a:pushSink',
    register: () => {
      if (process.env.OPENWOP_A2A_DURABLE_TASKS !== 'true') return;
      setA2aPushSink(async (config, event) => {
        // ADR 0607 — delivery-time scheme re-check, matching the webhook worker.
        // The comment above says the url "was already SSRF-validated at register
        // time"; that is the trust-the-other-layer pattern ADR 0606's delivery
        // arm exists to refuse. A push config stored before the registration arm
        // existed still reaches here, and this is the layer that decides what
        // leaves the process. `honorDevFlag: false` matches
        // `assertPushUrlAllowed` — the two layers MUST agree or the flag becomes
        // a way to deliver what registration refused.
        assertEgressSchemeAllowed(config.url, { honorDevFlag: false });
        await undiciFetch(config.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event),
          dispatcher: webhookEgressDispatcher(),
        });
      });
    },
  },
  // Feature toggles + multivariant testing — host-extension (non-normative).
  // Backend-authoritative resolution + superadmin admin surface. Stored in the
  // host-ext kv, so it must mount AFTER hostExt:persistence is wired.
  // See docs/adr/0001-feature-first-package-architecture.md §3.
  { name: 'featureToggles', register: ({ app }) => registerFeatureToggleRoutes(app) },
  // Agent tool-allowlist editor (ADR 0104) — superadmin override of an agent's
  // offered tools, applied at the dispatch seam. Host-ext kv, so after persistence.
  { name: 'agentAllowlists', register: ({ app }) => registerAgentAllowlistRoutes(app) },
  // Site config (ADR 0027) — runtime, superadmin-managed public front-page pointer.
  { name: 'siteConfig', register: ({ app }) => registerSiteConfigRoutes(app) },
  // ADR 0027: the system home page is edited through the standard CMS routes on
  // the reserved `host-site` org (a super admin reaches them via requireCmsScope)
  // — the bespoke /site-page route was retired when "Front page" collapsed into
  // the CMS Page Builder.
  { name: 'appBrand', register: ({ app }) => registerAppBrandRoutes(app) },
  // RFC 0103 `/v1/content/*` (delivery + admin ops) is registered by the cms
  // feature (`features/cms/contentProtocolRoutes.ts`, ADR 0748).
  { name: 'scheduler', register: ({ app, storage, hostSuite }) => registerSchedulerRoutes(app, { storage, hostSuite }) },
  // Standing agent roster — RFCS/0086 reference impl (named agent instances +
  // workflow portfolios). Registered before Kanban so a board can bind to a
  // roster member.
  { name: 'roster', register: ({ app }) => registerRosterRoutes(app) },
  // Rich agent profile (ADR 0031) — host-local "enterprise digital work twin"
  // config attached to a standing roster member. Mounts after roster since it
  // gates GET/PUT on roster-member ownership. Non-normative; never touches the
  // RFC 0003 manifest wire shape.
  { name: 'agentProfile', register: ({ app }) => registerAgentProfileRoutes(app) },
  // Agent org-chart — RFCS/0087 reference impl (departments/roles/reportsTo
  // over roster members; descriptive only, confers no authority).
  { name: 'orgChart', register: ({ app }) => registerOrgChartRoutes(app) },
  { name: 'multiPartyConversationSeam', register: ({ app }) => registerMultiPartyConversationSeamRoutes(app) },
  // Governed Workforce (EP0) — read-only entity + telemetry over the caller's
  // runs. Vendor-neutral host extension; no spec/wire change.
  { name: 'workforces', register: ({ app, storage }) => registerWorkforceRoutes(app, { storage }) },
  // Organizations / teams / members + role-based access — sample host-extension
  // (non-normative). Roles map to RFC 0049 scopes; a SEPARATE layer from the
  // descriptive org-chart above (org position still confers no authority).
  { name: 'accessControl', register: ({ app }) => registerAccessControlRoutes(app) },
  // Workspace lifecycle (ADR 0015 — workspace-as-tenant): list / create / switch.
  // Mounts after accessControl (the single owner of orgs/members/roles it builds on).
  { name: 'workspaces', register: ({ app }) => registerWorkspaceTenancyRoutes(app) },
  // Kanban boards — sample host-extension (non-normative). The card→run
  // trigger is the RFCS/0086 "named workflow agents" demo surface.
  { name: 'kanban', register: ({ app, storage, hostSuite }) => registerKanbanRoutes(app, { storage, hostSuite }) },
  // Agent-experience ops (PRD §14): idempotent demo seed + the agent heartbeat
  // "Check now" task-claim. After roster + kanban since it composes both.
  { name: 'agentOps', register: ({ app, storage, hostSuite }) => registerAgentOpsRoutes(app, { storage, hostSuite }) },
  // Approval inbox — the human side of "agents propose, humans dispose". After
  // agentOps since it resolves proposals agentOps creates.
  { name: 'approvals', register: ({ app, storage, hostSuite }) => registerApprovalRoutes(app, { storage, hostSuite }) },
  // ADR 0473 P5 — superadmin CRUD for the composed-workflow auto-approval
  // policies. New /workflow-proposals/admin prefix; no collision.
  { name: 'workflowProposalPolicies', register: ({ app, storage }) => registerWorkflowProposalPolicyRoutes(app, { storage }) },
  // Approval delegations (ADR 0198) — self-service out-of-office coverage for
  // approvers. New /approval-delegations prefix; no collision; consumed by the
  // single eligibility authority (approverResolution).
  { name: 'approvalDelegations', register: ({ app }) => registerApprovalDelegationRoutes(app) },
  // Teams approval-card delivery pref (ADR 0198 Phase B) — self-service; the
  // emitter's delivery leg reads it. New /approval-delivery prefix; no collision.
  { name: 'approvalDeliveryTeams', register: ({ app }) => registerApprovalDeliveryTeamsRoutes(app) },
  // Unified review inbox (ADR 0068) — a read-first projection over runtime
  // interrupts + pending approvals. After both owners; the /reviews prefix is new
  // (no collision). Dispatches actions to the SAME resolve paths (no second owner).
  { name: 'reviews', register: ({ app, storage, hostSuite }) => registerReviewRoutes(app, { storage, hostSuite }) },
  // Per-user durable UI-state (ADR 0071) — non-authoritative display prefs,
  // caller-scoped by the session subject. New /ui-state prefix; no collision.
  { name: 'uiState', register: ({ app, storage }) => registerUiStateRoutes(app, { storage }) },
  // Governance administration (ADR 0028) — superadmin policy + the audit read
  // view. The policy CONFIGURES existing seams (connections allowlist,
  // assistant action policy); enforcement never lives here.
  { name: 'governance', register: ({ app, storage }) => registerGovernanceRoutes(app, { storage }) },
  // RFC 0083 durable trigger bridge — the deferred reference durable-delivery
  // (subscription state machine + dedup/retry/dead-letter + the read surface).
  // The Kanban card→run firing routes through it.
  { name: 'triggerBridge', register: ({ app, storage, hostSuite }) => registerTriggerBridgeRoutes(app, { storage, hostSuite }) },
  // NOTE: the Widgets reference domain moved to the BackendFeature contract
  // (src/features/widgets.ts) — it is now composed via registerBackendFeatures()
  // below, the first surface migrated to the feature-package seam (ADR §6).
  {
    // Inbound chat → workflow run bridge. Binds inbound messages to a workflow
    // (default deterministic `openwop-app.uppercase`; override via
    // OPENWOP_MESSAGING_WORKFLOW_ID) and enqueues the reply as outbound egress.
    name: 'messaging',
    register: ({ app, storage, config }) => {
      // Defense-in-depth: warn loudly if a production deploy left the bridge
      // on the wildcard demo bearer instead of a scoped bridge token.
      if (process.env.NODE_ENV === 'production' && !process.env.OPENWOP_MESSAGING_BRIDGE_TOKEN) {
        log.warn('messaging_bridge_unscoped_credential', {
          detail: 'OPENWOP_MESSAGING_BRIDGE_TOKEN is unset; the inbound→run bridge is using the host bearer. Set a tenant-scoped credential for production.',
        });
      }
      registerMessagingRoutes(app, {
        storage,
        bridge: createSelfHttpBridge({
          storage,
          baseUrl: `http://127.0.0.1:${config.port}`,
          // Prefer a dedicated, tenant-scopable bridge credential; else fall
          // back to the shared service credential (which fails closed under
          // enforced auth instead of presenting a guessable literal). A real
          // multi-tenant host SHOULD set OPENWOP_MESSAGING_BRIDGE_TOKEN to a
          // scoped credential (the run's tenant still comes from the registered
          // device, not the message).
          bearer: process.env.OPENWOP_MESSAGING_BRIDGE_TOKEN ?? resolveInternalToken(),
          defaultWorkflowId: process.env.OPENWOP_MESSAGING_WORKFLOW_ID ?? 'openwop-app.uppercase',
        }),
        // Email/SMS delivery: a real webhook (OPENWOP_NOTIFY_WEBHOOK_URL) when
        // set, else the honest synthetic fallback.
        notifyDeliverer: resolveNotifyDelivererFromEnv(),
      });
    },
  },
];

/** Mount every registered domain, in declaration order, then compose the
 *  feature packages (ADR §2.2) — their routes + toggle defaults register after
 *  the core list so a separately-distributed feature is wired without editing
 *  the core ROUTE_MODULES. */
export function registerAllRoutes(deps: RouteDeps): void {
  for (const m of ROUTE_MODULES) {
    m.register(deps);
  }
  registerBackendFeatures(deps);
  // ADR 0027 — seed the host-level system home page at boot (idempotent,
  // fire-and-forget) so '/' serves a real editable page on first visit. Also
  // lazily ensured by the public-site-config route + the CMS routes on host-site.
  void ensureSystemSite().catch((err) => log.warn('system_site_seed_failed', { error: String(err) }));
  // ADR 0170 — seed the reserved app-brand record at boot (idempotent,
  // fire-and-forget) so the super-admin Appearance editor has a row immediately.
  // Also lazily ensured by the app-brand / public-brand routes.
  void ensureSystemBrand().catch((err) => log.warn('system_brand_seed_failed', { error: String(err) }));
  // ADR 0027 — the public host-global Features page (/p/features). Ensured at
  // boot so a redeploy that bumps featuresPage.ts SEED_VERSION actually refreshes
  // the live page (the documented contract) — it has no lazy public route of its
  // own to trigger the refresh, unlike the home page above.
  void ensureFeaturesPage().catch((err) => log.warn('features_page_seed_failed', { error: String(err) }));
  // ADR 0485 — the public host-global Comparison page (/p/compare): a capability
  // matrix across the competitive orchestration landscape. Ensured at boot for the
  // same reason as the Features page (SEED_VERSION refresh, no lazy public route).
  void ensureComparisonPage().catch((err) => log.warn('comparison_page_seed_failed', { error: String(err) }));
  // ADR 0486 follow-up — the real, PUBLISHED About + Roadmap marketing pages, so
  // the public nav's "Pages" group has genuine destinations (adopts the unedited
  // placeholder drafts; a human CMS edit freezes them).
  void ensureMarketingContentPages().catch((err) => log.warn('marketing_content_pages_seed_failed', { error: String(err) }));
  // ADR 0392 OQ-1 — the reference-docs corpus: real published docs-collection
  // pages on the system-site org (featuresPage sibling pattern; SEED_VERSION
  // refresh, never-clobber). Inert until the `docs` toggle is enabled.
  void ensureSystemSiteDocs().catch((err) => log.warn('system_site_docs_seed_failed', { error: String(err) }));
}
