/**
 * Guided Walkthroughs (ADR 0368) — workflow-driven, watchable click-through
 * automation. Phase 1 registers the step NODES (`ui.walkthrough.step`,
 * `ui.walkthrough.checkpoint`); Phase 2 adds the catalog service + routes. The
 * engine is the workflow engine: a walkthrough is an ordinary workflow definition
 * whose steps suspend with `walkthrough-step` interrupts the FE player resolves.
 *
 * Toggle `walkthroughs` (OFF, tenant): the PLAYER surfaces gate on it;
 * node registration is process-wide (packs are toggle-decoupled by
 * convention — a registered node type in a disabled feature simply has no
 * launch surface).
 */
import type { BackendFeature } from '../types.js';
import { createLogger } from '../../observability/logger.js';
import { registerWalkthroughNodes } from './walkthroughNodes.js';
import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { CAMPAIGN_STUDIO_WALKTHROUGH_ID, LEGACY_CAMPAIGN_STUDIO_ID, WALKTHROUGH_STEP_TYPE_ID } from './walkthroughIds.js';
import { DEMO_WALKTHROUGHS } from '../../host/demoWalkthroughsSeed.js';
import { registerWalkthroughAuthorTool } from './walkthroughAuthorTool.js';
import type { WorkflowDefinition } from '../../executor/types.js';
import { requireFeatureEnabled, requireTenantScope } from '../featureRoute.js';
import { tenantOf, callerSubject } from '../../host/requestSubject.js';
import { OpenwopError } from '../../types.js';
import { buildWalkthroughsSurface } from './surface.js';
import { listWalkthroughProgress, putWalkthroughProgress } from './progressStore.js';

const log = createLogger('features.walkthroughs');

/**
 * ADR 0435 — the two SAMPLE walkthroughs (Campaign Studio "your first brief",
 * Chat "send your first message") are NO LONGER builtins. They were host-owned
 * definitions surfaced by a hard-coded frontend card list, so a tenant could
 * neither edit nor delete them and nothing on `/example-data` accounted for
 * them. They are now ordinary demo data owned by the tenant that seeds them —
 * definitions live in `host/demoWalkthroughsSeed.ts`, seeded through the
 * `demo-walkthroughs` step. Their ids are unchanged.
 *
 * Only the pre-rename LEGACY alias stays a builtin: it carries no user-facing
 * listing (it is filtered out of `listWalkthroughs`) and exists purely so runs
 * recorded before the ADR 0376 rename still resolve on replay / `:fork`.
 */
const CAMPAIGN_STUDIO_WALKTHROUGH_LEGACY: WorkflowDefinition = {
  ...DEMO_WALKTHROUGHS[0]!,
  workflowId: LEGACY_CAMPAIGN_STUDIO_ID,
};

/** ADR 0378 P4 — one-step "navigate + spotlight" walkthroughs backing the
 *  P0 render cases (AGENTS-01 / WF-01 / RUNS-01 / KEYS-01). The render-quality
 *  judgment stays HUMAN (manual tests are backed, never replaced). */
const pageWalkthrough = (id: string, name: string, actionId: string, narration: string): WorkflowDefinition => ({
  workflowId: id,
  metadata: { name, walkthrough: true },
  nodes: [{ nodeId: 't1', typeId: WALKTHROUGH_STEP_TYPE_ID, config: { actionId, narration } }],
  edges: [],
});
export const AGENTS_WALKTHROUGH = pageWalkthrough('walkthrough.agents.roster', 'Agents: meet the roster', 'agents.page.view', 'agentsWalkthroughRoster');
export const WORKFLOWS_WALKTHROUGH = pageWalkthrough('walkthrough.workflows.dashboard', 'Workflows: the dashboard', 'workflows.page.view', 'workflowsWalkthroughDashboard');
export const RUNS_WALKTHROUGH = pageWalkthrough('walkthrough.runs.index', 'Runs: the run history', 'runs.page.view', 'runsWalkthroughIndex');
export const KEYS_WALKTHROUGH = pageWalkthrough('walkthrough.keys.providers', 'Keys: provider credentials', 'keys.page.view', 'keysWalkthroughProviders');
export const FUNNELS_WALKTHROUGH = pageWalkthrough('walkthrough.funnels.list', 'Funnels: your sales funnels', 'funnels.page.view', 'funnelsWalkthroughList');
/** ADR 0488 P4 — backs the funnel tutorial's commerce step. The chain lives in
 *  the walkthroughs pack; this declaration is what REGISTERS it chain-backed at
 *  boot, so a pack chain missing from this list would silently never resolve. */
export const COMMERCE_WALKTHROUGH = pageWalkthrough('walkthrough.commerce.catalog', 'Commerce: your product catalog', 'commerce.page.view', 'commerceWalkthroughCatalog');
export const MODELS_WALKTHROUGH = pageWalkthrough('walkthrough.models.hub', 'Models: pick your models', 'models.page.view', 'modelsWalkthroughHub');
// P4 continuation — the remaining P0 render-case spotlights (one-step defs).
export const BOARDS_WALKTHROUGH = pageWalkthrough('walkthrough.boards.kanban', 'Boards: the kanban', 'boards.page.view', 'boardsWalkthrough');
export const WORKFORCES_WALKTHROUGH = pageWalkthrough('walkthrough.workforces.gallery', 'Workforces: the gallery', 'workforces.page.view', 'workforcesWalkthrough');
export const INBOX_WALKTHROUGH = pageWalkthrough('walkthrough.inbox.notifications', 'Inbox: notifications', 'inbox.page.view', 'inboxWalkthrough');
export const PROJECTS_WALKTHROUGH = pageWalkthrough('walkthrough.projects.list', 'Projects: your projects', 'projects.page.view', 'projectsWalkthrough');
export const AGENT_TEMPLATES_WALKTHROUGH = pageWalkthrough('walkthrough.agent-templates.list', 'Agents: templates', 'agent-templates.page.view', 'agentTemplatesWalkthrough');
export const ROSTER_WALKTHROUGH = pageWalkthrough('walkthrough.roster.orgchart', 'Roster: the org chart', 'roster.page.view', 'rosterWalkthrough');
export const MEDIA_WALKTHROUGH = pageWalkthrough('walkthrough.media.library', 'Media: the library', 'media.page.view', 'mediaWalkthrough');
export const CMS_WALKTHROUGH = pageWalkthrough('walkthrough.cms.pages', 'CMS: your pages', 'cms.page.view', 'cmsWalkthrough');
export const PUBLISHING_WALKTHROUGH = pageWalkthrough('walkthrough.publishing.settings', 'Publishing: settings', 'publishing.page.view', 'publishingWalkthrough');
export const PROMPTS_WALKTHROUGH = pageWalkthrough('walkthrough.prompts.library', 'Prompts: the library', 'prompts.page.view', 'promptsWalkthrough');
export const MEMORY_WALKTHROUGH = pageWalkthrough('walkthrough.memory.ledger', 'Memory: the ledger', 'memory.page.view', 'memoryWalkthrough');
export const CAPABILITIES_WALKTHROUGH = pageWalkthrough('walkthrough.capabilities.panel', 'Capabilities: the panel', 'capabilities.page.view', 'capabilitiesWalkthrough');
export const CLI_WALKTHROUGH = pageWalkthrough('walkthrough.cli.quickstart', 'CLI: quickstart', 'cli.page.view', 'cliWalkthrough');
export const FEATURE_TOGGLES_WALKTHROUGH = pageWalkthrough('walkthrough.feature-toggles.list', 'Feature toggles', 'feature-toggles.page.view', 'featureTogglesWalkthrough');
export const ORGS_WALKTHROUGH = pageWalkthrough('walkthrough.orgs.list', 'Orgs: your workspaces', 'orgs.page.view', 'orgsWalkthrough');
export const USERS_WALKTHROUGH = pageWalkthrough('walkthrough.users.list', 'Users: members', 'users.page.view', 'usersWalkthrough');
export const CONNECTIONS_WALKTHROUGH = pageWalkthrough('walkthrough.connections.list', 'Connections: providers', 'connections.page.view', 'connectionsWalkthrough');
export const EXAMPLE_DATA_WALKTHROUGH = pageWalkthrough('walkthrough.example-data.dashboard', 'Example data', 'example-data.page.view', 'exampleDataWalkthrough');

// Walkthrough progress store + accessors now live in `progressStore.ts` (P6d — the ONE
// owner, shared by these routes and the ctx.features.walkthroughs surface).

// Page-spotlight walkthroughs stay pinned builtins (restart-safe, cross-instance,
// catalog-resolved): they are TEST INFRASTRUCTURE, not sample content — the
// manual-test runner launches them by id per P0 render case, so they must
// resolve for every tenant whether or not it seeded demo data. Being builtins
// is also their first-party marker: `listWalkthroughs` treats builtins as
// system walkthroughs visible to every tenant, and the tenant-scoped half
// never touches the global registry (ADR 0163 R1 — no cross-tenant leak).
// The two SAMPLE walkthroughs are deliberately absent — ADR 0435 moved them
// to the `demo-walkthroughs` seeder so a tenant can edit and delete them.
// ADR 0472 Phase 3 — the `BackendFeature.builtinWorkflows` field is gone; this
// exported array is now pinned from the barrel's LEGACY_PINNED_WORKFLOWS quarantine.
export const WALKTHROUGH_WORKFLOWS: readonly WorkflowDefinition[] = [CAMPAIGN_STUDIO_WALKTHROUGH_LEGACY, AGENTS_WALKTHROUGH, WORKFLOWS_WALKTHROUGH, RUNS_WALKTHROUGH, KEYS_WALKTHROUGH, FUNNELS_WALKTHROUGH, COMMERCE_WALKTHROUGH, MODELS_WALKTHROUGH, BOARDS_WALKTHROUGH, WORKFORCES_WALKTHROUGH, INBOX_WALKTHROUGH, PROJECTS_WALKTHROUGH, AGENT_TEMPLATES_WALKTHROUGH, ROSTER_WALKTHROUGH, MEDIA_WALKTHROUGH, CMS_WALKTHROUGH, PUBLISHING_WALKTHROUGH, PROMPTS_WALKTHROUGH, MEMORY_WALKTHROUGH, CAPABILITIES_WALKTHROUGH, CLI_WALKTHROUGH, FEATURE_TOGGLES_WALKTHROUGH, ORGS_WALKTHROUGH, USERS_WALKTHROUGH, CONNECTIONS_WALKTHROUGH, EXAMPLE_DATA_WALKTHROUGH];

/** ADR 0472 P4 — register the 25 SYSTEM walkthroughs CHAIN-BACKED (from
 *  `examples/workflow-chain-packs/walkthroughs/`), under their original ids so the
 *  FE player + replay resolve unchanged. Re-marks `metadata.walkthrough=true` + the
 *  name (fragment can't carry workflow-level metadata) so the walkthroughs surface
 *  lists them. WALKTHROUGH_WORKFLOWS stays the readable id/name source (+ test
 *  fixture); it is NO LONGER a builtin (out of LEGACY_PINNED). */
export function registerWalkthroughWorkflows(): void {
  for (const wf of WALKTHROUGH_WORKFLOWS) {
    const name = typeof wf.metadata?.name === 'string' ? wf.metadata.name : wf.workflowId;
    registerChainBackedWorkflow(wf.workflowId, {
      postProcess: (def) => { def.metadata = { ...(def.metadata ?? {}), name, walkthrough: true }; },
    });
  }
}

export const walkthroughsFeature: BackendFeature = {
  id: 'walkthroughs',
  requiredPacks: [{ name: 'feature.walkthroughs.nodes', version: '1.0.0' }], // NP-WALK-1 (ctx reads; the ui.walkthrough.* step nodes stay host-registered by design)
  // ADR 0368 P6d — the honest `ctx.features.walkthroughs` READ surface (no
  // launch; a run can read walkthrough state to gate a branch). Toggle-gated by the
  // feature registry (surface id = toggle id).
  surface: { id: 'walkthroughs', build: buildWalkthroughsSurface },
  registerRoutes: ({ app, storage }) => {
    registerWalkthroughNodes();
    registerWalkthroughWorkflows();
    registerWalkthroughAuthorTool();

    app.get('/v1/host/openwop-app/walkthroughs/progress', (req, res, next) => {
      void (async () => {
        try {
          await requireFeatureEnabled(req, 'walkthroughs', 'Walkthroughs');
          const tenantId = tenantOf(req);
          // ADR 0378 P3 — the caller's own rows ∪ legacy tenant-level fallback.
          const rows = await listWalkthroughProgress(tenantId, callerSubject(req));
          res.json({ progress: rows.map(({ walkthroughId, status, runId, updatedAt }) => ({ walkthroughId, status, runId, updatedAt })) });
        } catch (err) { next(err); }
      })();
    });

    app.post('/v1/host/openwop-app/walkthroughs/progress', (req, res, next) => {
      void (async () => {
        try {
          await requireFeatureEnabled(req, 'walkthroughs', 'Walkthroughs');
          const tenantId = tenantOf(req);
          const body = (req.body ?? {}) as { walkthroughId?: unknown; status?: unknown; runId?: unknown };
          if (typeof body.walkthroughId !== 'string' || !body.walkthroughId
            || (body.status !== 'started' && body.status !== 'completed')
            || typeof body.runId !== 'string' || !body.runId) {
            throw new OpenwopError('validation_error', 'walkthroughId, status (started|completed), and runId are required.', 400, {});
          }
          const userId = callerSubject(req); // server-stamped — never client-supplied
          await putWalkthroughProgress({
            tenantId,
            ...(userId ? { userId } : {}),
            walkthroughId: body.walkthroughId,
            status: body.status,
            runId: body.runId,
            updatedAt: new Date().toISOString(),
          });
          res.json({ ok: true });
        } catch (err) { next(err); }
      })();
    });

    // ADR 0378 P3 — the honest funnel: run-status counts + a stall-step
    // distribution for ONE walkthrough, derived from the runs the engine
    // already records (NO second analytics store). Bounded: one tenant-scoped
    // listRuns (limit 100, in-memory workflowId filter) + a point
    // listOpenInterrupts per NON-completed run — the open interrupt's nodeId
    // is where that run stalled. The ADR 0371 retention window (default 30d)
    // bounds the horizon; the FE states that honestly. On-demand only (the
    // page never fans this out per row — the per-IP rate-limit gotcha).
    app.get('/v1/host/openwop-app/walkthroughs/funnel', (req, res, next) => {
      void (async () => {
        try {
          await requireFeatureEnabled(req, 'walkthroughs', 'Walkthroughs');
          // §Correction (grade-code `WT-17`) — THIS ROUTE HAD NO MEMBERSHIP GATE.
          // `requireFeatureEnabled` checks the toggle + the ADR 0419 paid-bundle
          // entitlement; it does NOT check that the caller belongs to the tenant.
          // Unlike the sibling progress routes — which are per-subject by
          // construction — this one returns TENANT-WIDE aggregates computed over
          // every member's runs, so it needs the read scope explicitly.
          // `requireTenantScope` is fail-closed (a non-member resolves to zero
          // scopes) and short-circuits for the implicit personal-workspace owner,
          // so a solo user is unaffected. This is the exact shape ADR 0434
          // catalogued: five packages that gated on "feature enabled + identified
          // caller" only, letting any authenticated co-tenant read tenant metrics.
          await requireTenantScope(req, 'workspace:read');
          const tenantId = tenantOf(req);
          const walkthroughId = typeof req.query.walkthroughId === 'string' ? req.query.walkthroughId : '';
          if (!walkthroughId) throw new OpenwopError('validation_error', 'walkthroughId is required.', 400, {});
          // Grade-pass: pre-rename runs carry the LEGACY builtin id (runs are
          // immutable for replay) — union it so the funnel doesn't undercount.
          const ids = new Set([walkthroughId]);
          if (walkthroughId === CAMPAIGN_STUDIO_WALKTHROUGH_ID) ids.add(LEGACY_CAMPAIGN_STUDIO_ID);
          // NOTE: the limit caps the SCAN (newest 100 tenant runs), not the
          // match count — a very busy tenant's funnel is a recent-window view.
          const SCAN_LIMIT = 100;
          const scannedRuns = await storage.listRuns({ tenantId, limit: SCAN_LIMIT });
          const runs = scannedRuns.filter((r) => ids.has(r.workflowId));
          // §Correction (grade-data `WALK-2`): the response reported `window` =
          // the MATCHED count, so a busy tenant whose newest 100 runs contain no
          // walkthroughs got `window:0, skipped:0` — indistinguishable from
          // "nobody ran it". `scanned` + `truncated` let the client say "of the
          // last 100 runs" instead of implying the whole history was read.
          const scanned = scannedRuns.length;
          const truncated = scanned >= SCAN_LIMIT;
          const counts = { started: runs.length, completed: 0, cancelled: 0, failed: 0, active: 0 };
          const stalledByNode: Record<string, number> = {};
          const nonCompleted = runs.filter((r) => r.status !== 'completed');
          counts.completed = runs.length - nonCompleted.length;
          // Grade-pass: parallel point lookups (was a sequential N+1 loop).
          // WALK-8: per-run tolerance — ONE failed interrupt read must not 500
          // the whole funnel; the miss is logged (observability) and that run
          // simply contributes no stall row.
          const opens = await Promise.all(nonCompleted.map((r) =>
            storage.listOpenInterrupts(r.runId).catch((err) => {
              log.warn('funnel interrupt read failed', { runId: r.runId, error: err instanceof Error ? err.message : String(err) });
              return [];
            })));
          nonCompleted.forEach((r, i) => {
            if (r.status === 'failed') counts.failed += 1;
            else if (r.status === 'cancelled') counts.cancelled += 1;
            else counts.active += 1;
            const node = opens[i]?.[0]?.nodeId;
            if (node) stalledByNode[node] = (stalledByNode[node] ?? 0) + 1;
          });
          /**
           * ADR 0489 OQ1 (WALK-A1) — SKIPS get their own bucket.
           *
           * An `already-satisfied` checkpoint resolves its step as DONE, so
           * without this a skip is indistinguishable from a completion and the
           * funnel cannot answer the question the feature exists to raise:
           * "how often do learners already know this?" A phase most learners
           * skip is a phase to cut, and that signal was invisible.
           *
           * READ PATH — the one that actually works. The skip lives in the
           * interrupt's `resolvedValue`, but NO storage read returns resolved
           * interrupts: `listOpenInterrupts` is open-only and
           * `getInterruptByNode` filters `resolved_at IS NULL` (verified in the
           * postgres + sqlite adapters). Resolve, however, COMPLETES the node
           * with the resume value as its outputs, and `node.completed` carries
           * `payload.outputs` — so the run's own event log already holds it.
           * One `listEvents` per run: the same order as the `listOpenInterrupts`
           * fan-out above, with no storage-interface change and no N+1 over
           * nodes (which this app has a recorded connection-exhaustion incident
           * for).
           */
          const eventsPerRun = await Promise.all(runs.map((r) =>
            // Same per-read tolerance as the stall fan-out (WALK-8): one bad
            // read contributes nothing rather than 500-ing the whole funnel.
            storage.listEvents(r.runId, { limit: 200 }).catch((err) => {
              log.warn('funnel event read failed', { runId: r.runId, error: err instanceof Error ? err.message : String(err) });
              return [];
            })));
          const skippedByNode: Record<string, number> = {};
          for (const events of eventsPerRun) {
            for (const ev of events) {
              if (ev.type !== 'node.completed' || !ev.nodeId) continue;
              // The resume path wraps the resume value on the node's `output`
              // port (`executor.ts` — `const outputs = { output: safeResumeValue }`),
              // so the skip sits at `outputs.output.skipped`. The unwrapped shape
              // is accepted too, so a future resume style that returns the value
              // directly keeps counting rather than silently reporting zero.
              const outputs = (ev.payload as { outputs?: Record<string, unknown> } | undefined)?.outputs;
              const value = (outputs?.output ?? outputs) as { skipped?: unknown } | undefined;
              if (value?.skipped === true) skippedByNode[ev.nodeId] = (skippedByNode[ev.nodeId] ?? 0) + 1;
            }
          }
          const skipped = Object.values(skippedByNode).reduce((a, b) => a + b, 0);

          res.json({ walkthroughId, window: runs.length, scanned, truncated, ...counts, skipped, stalledByNode, skippedByNode });
        } catch (err) { next(err); }
      })();
    });
  },
  toggleDefault: {
    id: 'walkthroughs',
    label: 'Guided walkthroughs',
    description:
      'Watchable click-through automation: Play drives the app through a real multi-step flow — an animated cursor performs each step while a caption narrates — pausing for human-in-the-loop steps (like choosing a file) and resuming when you act. Walkthroughs are ordinary workflows; every run is durable and replayable. OFF by default.',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'walkthroughs',
  },
};
