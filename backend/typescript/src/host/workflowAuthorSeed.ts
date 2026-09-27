/**
 * Demo seed for the AI Workflow Author (ADR 0072) — a small set of **showcase
 * workflows that look like authored output**, so a first-time visitor sees what
 * the "Create with AI" flow produces (and has something runnable to open in the
 * builder) without needing a configured AI provider.
 *
 * Built ENTIRELY from deterministic demo catalog nodes (`local.sample.demo.mock-ai`,
 * `core.approvalGate`) — the same posture as `exampleWorkflows.ts` — so every
 * seeded workflow runs end-to-end with NO BYOK and replays deterministically.
 * Each carries `metadata.showcase = true` + `metadata.authoring` provenance so
 * the UI can badge it illustrative (never passes synthetic output off as a real
 * authoring run).
 *
 * WFAWF-6 (ADR 0596 R2) — these used to be registered HOST-GLOBAL by id with no
 * ownership: the retired ADR 0472 hard-coded-workflow anti-pattern (invisible to
 * `/builder` + the `/` picker, which list only the tenant OWNERSHIP index, and
 * uneditable). They are now ordinary DEMO DATA seeded PER TENANT — the same
 * owned-in-tree-definition lane `demoWalkthroughsSeed.ts` uses (ADR 0435): the
 * shared def is registered in the global by-id registry (so the id resolves for
 * run / `:fork` / replay) and recorded in the per-tenant ownership index, which
 * is what makes each showcase appear in that tenant's builder gallery, open in
 * the builder, and delete like anything the tenant authored itself.
 *
 * The workflow IDs are UNCHANGED (`openwop-app.authored.lead-triage`,
 * `openwop-app.authored.doc-summary`) — a per-tenant deterministic id was
 * deliberately NOT used, because these ids carry no PII and keeping them stable
 * means a run stamped before this migration still re-resolves on replay/`:fork`.
 * (A chain-pack + per-tenant-minted-id migration was the route the WFAWF-6 row
 * originally sketched; the owned-in-tree-def lane is simpler, replay-safe, and
 * equally sanctioned — see ADR 0596 R2 for the reversal reasoning.)
 *
 * IDEMPOTENT + non-destructive, like every seeder here: deterministic ids mean a
 * re-seed upserts the same ownership rows (never a "-2" duplicate), and `clear`
 * removes ONLY this tenant's ownership of the canonical ids — a workflow the
 * tenant authored itself is never touched, and the shared def survives while any
 * OTHER tenant still owns it (so their historical runs keep replaying).
 *
 * TRADEOFF (inherited from the ADR 0435 owned-seed model, accepted): the DEFINITION
 * is one GLOBAL by-id row shared by every tenant that seeds it — only OWNERSHIP is
 * per-tenant. Keeping the id stable is what makes replay work, but it also means an
 * edit one tenant makes to a showcase in the builder rewrites the shared def the
 * others opened. That is acceptable for illustrative demo content built from
 * deterministic mock-ai nodes (no PII, no production semantics); the only way to
 * isolate per-tenant edits would be per-tenant minted ids, which is exactly the
 * from-chain route that strands pre-migration replay stamps (see ADR 0596 R2).
 *
 * @see docs/adr/0072-ai-workflow-authoring.md
 * @see docs/adr/0596-workflow-author-honesty-and-durable-writes.md (§ R2 — WFAWF-6)
 * @see src/host/demoWalkthroughsSeed.ts — the owned-in-tree-def seed pattern this mirrors
 * @see src/host/exampleWorkflows.ts — the deterministic-node posture this mirrors
 */

import type { WorkflowDefinition } from '../executor/types.js';
import { registerWorkflow, getRegisteredWorkflow, deleteRegisteredWorkflow } from './workflowsRegistry.js';
import { recordOwnership, getOwned, removeOwnership, isAuthoredByAnyTenant } from './workflowOwnership.js';
import { lifecycleOf, withLifecycle } from './workflowLifecycle.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.workflowAuthorSeed');

/** A showcase workflow + the natural-language intent it illustrates. */
interface ShowcaseSpec {
  intent: string;
  definition: WorkflowDefinition;
}

function showcase(name: string, intent: string, definition: WorkflowDefinition): ShowcaseSpec {
  return {
    intent,
    definition: {
      ...definition,
      metadata: {
        ...(definition.metadata ?? {}),
        name,
        showcase: true,
        source: 'workflow-author-demo',
        // Illustrative provenance — mirrors the real `metadata.authoring` the
        // draft node stamps, but flagged so the UI never reads it as a real run.
        authoring: { intent, model: 'demo', illustrative: true },
      },
    },
  };
}

export const WORKFLOW_AUTHOR_SHOWCASE: ReadonlyArray<ShowcaseSpec> = [
  showcase(
    'AI-authored · Lead triage & notify',
    'When a new high-value lead arrives, summarize it, hold for a quick human review, then notify the deal owner.',
    {
      workflowId: 'openwop-app.authored.lead-triage',
      nodes: [
        { nodeId: 'summarize', typeId: 'local.sample.demo.mock-ai' },
        { nodeId: 'review', typeId: 'core.approvalGate', config: { prompt: 'Route this lead to the deal owner?' } },
        { nodeId: 'notify', typeId: 'local.sample.demo.mock-ai', outputRole: 'primary' },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'summarize', targetNodeId: 'review' },
        { edgeId: 'e2', sourceNodeId: 'review', targetNodeId: 'notify' },
      ],
    },
  ),
  showcase(
    'AI-authored · Document extract & summarize',
    'Extract the key points from an uploaded document and produce a one-paragraph summary.',
    {
      workflowId: 'openwop-app.authored.doc-summary',
      nodes: [
        { nodeId: 'extract', typeId: 'local.sample.demo.mock-ai' },
        { nodeId: 'summarize', typeId: 'local.sample.demo.mock-ai', outputRole: 'primary' },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'extract', targetNodeId: 'summarize' }],
    },
  ),
];

const nameOf = (def: WorkflowDefinition): string =>
  typeof def.metadata?.name === 'string' && def.metadata.name ? def.metadata.name : def.workflowId;

/**
 * How many of the canonical showcase workflows this tenant currently has LIVE.
 * Archived rows do not count (a re-seed brings an archived showcase back), so the
 * count matches what the builder gallery shows — the same rule as
 * `countDemoWalkthroughs`.
 */
export async function countWorkflowAuthorShowcase(tenantId: string): Promise<number> {
  const owned = await Promise.all(WORKFLOW_AUTHOR_SHOWCASE.map((s) => getOwned(tenantId, s.definition.workflowId)));
  return owned.filter((r) => r && !r.archivedAt).length;
}

/**
 * Seed the showcase workflows for `tenantId` — register the shared global def if
 * missing (or un-archive it), then record per-tenant ownership so it lists in the
 * builder gallery. Idempotent: a showcase the tenant already has LIVE is
 * re-upserted (same key) and NOT counted as created. A previously REMOVED
 * (archived) showcase re-seeds as a fresh create. Non-destructive: the global def
 * is only re-registered when ABSENT or archived, so a tenant that edited its copy
 * keeps the edited graph (the registry is by-id; a re-seed must never clobber
 * authored content). `registerWorkflow` is paired with `recordOwnership` in this
 * function — the sanctioned owned-seed lane, not the retired unowned pin site.
 */
export async function seedWorkflowAuthorShowcase(tenantId: string): Promise<{ created: number; details: Record<string, unknown> }> {
  let created = 0;
  const seeded: string[] = [];
  for (const s of WORKFLOW_AUTHOR_SHOWCASE) {
    try {
      const id = s.definition.workflowId;
      const registered = getRegisteredWorkflow(id);
      if (!registered) registerWorkflow(s.definition);
      else if (lifecycleOf(registered).archivedAt) registerWorkflow(withLifecycle(registered, { archivedAt: undefined }));
      const live = getRegisteredWorkflow(id) ?? s.definition;
      const prior = await getOwned(tenantId, id);
      const wasLive = Boolean(prior) && !prior?.archivedAt;
      await recordOwnership(tenantId, id, { name: nameOf(live), nodeCount: live.nodes.length });
      if (!wasLive) { created += 1; seeded.push(id); }
    } catch (err) {
      log.warn('seed_showcase_skipped', { tenantId, workflowId: s.definition.workflowId, error: String(err) });
    }
  }
  return { created, details: { seeded } };
}

/**
 * Drop THIS tenant's ownership of the canonical showcase workflows. The global
 * registry def is removed only once NO tenant owns it any more — another tenant's
 * seeded copy (and the replay of its historical runs) must survive this tenant's
 * clear. Never touches a workflow the tenant authored itself.
 */
export async function clearWorkflowAuthorShowcase(tenantId: string): Promise<{ cleared: number; details: Record<string, unknown> }> {
  let cleared = 0;
  for (const s of WORKFLOW_AUTHOR_SHOWCASE) {
    const id = s.definition.workflowId;
    if (await removeOwnership(tenantId, id)) cleared += 1;
    if (!(await isAuthoredByAnyTenant(id))) deleteRegisteredWorkflow(id);
  }
  return { cleared, details: { workflows: WORKFLOW_AUTHOR_SHOWCASE.map((s) => s.definition.workflowId) } };
}
