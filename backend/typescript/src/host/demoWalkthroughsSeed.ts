/**
 * Demo seed for guided walkthroughs (ADR 0435).
 *
 * The two first-party SAMPLE walkthroughs (Campaign Studio "your first brief",
 * Chat "send your first message") used to be BUILTIN workflow definitions,
 * rendered by `/walkthroughs` from a hard-coded frontend `SAMPLE_TOURS` array
 * with only a Play button. That broke the app's seeding contract twice over:
 * demo content arrived un-asked-for (nothing on `/example-data` accounted for
 * it) and — because a builtin is host-owned, not tenant-owned — the cards could
 * be neither edited in the builder nor deleted.
 *
 * They are now ordinary DEMO DATA, seeded per tenant through this seeder like
 * every other demo surface: registered in the global by-id registry (so the id
 * resolves for run / `:fork` / replay) and recorded in the per-tenant OWNERSHIP
 * index, which is what makes them appear under "Your walkthroughs", open in the
 * builder, and delete like anything the tenant recorded itself.
 *
 * The walkthrough IDs are UNCHANGED (`walkthrough.campaign-studio.first-brief`,
 * `walkthrough.chat.first-message`) so the existing referrers keep resolving —
 * the `connect-your-ai` + `campaign-studio-first-brief` tutorials, manual test
 * CHAT-01, and the walkthrough-replay e2e — once the tenant has seeded.
 *
 * IDEMPOTENT + non-destructive, like every seeder here: deterministic ids mean a
 * re-seed upserts the same ownership rows (never a "-2" duplicate), and `clear`
 * removes ONLY these canonical ids — a walkthrough the tenant recorded or
 * authored itself is never touched. Because the ids are deterministic the
 * anon→user tenant fold collides instead of duplicating (see `seedWorkflows.ts`
 * for the same reasoning).
 *
 * @see docs/adr/0435-sample-walkthroughs-become-seeded-example-data.md
 * @see src/features/walkthroughs/feature.ts — the walkthrough ids + step nodes
 * @see src/host/seedWorkflows.ts — the deterministic owned-workflow pattern
 */

import type { WorkflowDefinition } from '../executor/types.js';
import { registerWorkflow, getRegisteredWorkflow, deleteRegisteredWorkflow } from './workflowsRegistry.js';
import { recordOwnership, getOwned, removeOwnership, isAuthoredByAnyTenant } from './workflowOwnership.js';
import { lifecycleOf, withLifecycle } from './workflowLifecycle.js';
import {
  CAMPAIGN_STUDIO_WALKTHROUGH_ID,
  CHAT_WALKTHROUGH_ID,
  WALKTHROUGH_STEP_TYPE_ID,
  WALKTHROUGH_CHECKPOINT_TYPE_ID,
} from '../features/walkthroughs/walkthroughIds.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.demoWalkthroughsSeed');

/**
 * The Campaign Studio reference walkthrough (originally ADR 0368 Phase 4 + its
 * OQ4 decision: it runs in the user's OWN workspace, and the HITL prompt
 * suggests the "[Walkthrough]" naming so walkthrough artifacts stay
 * recognizable). Narration strings are i18n KEYS in the frontend `walkthroughs`
 * namespace (resolved with a defaultValue fallback, so a tenant that edits a
 * step may put a literal there).
 */
const CAMPAIGN_STUDIO_WALKTHROUGH: WorkflowDefinition = {
  workflowId: CAMPAIGN_STUDIO_WALKTHROUGH_ID,
  metadata: { name: 'Campaign Studio: your first brief', walkthrough: true },
  nodes: [
    { nodeId: 't1', typeId: WALKTHROUGH_STEP_TYPE_ID, config: { actionId: 'campaign-studio.new-brief.click', narration: 'csWalkthroughNewBrief' } },
    { nodeId: 't2', typeId: WALKTHROUGH_STEP_TYPE_ID, config: { actionId: 'campaign-studio.brief-name.fill', narration: 'csWalkthroughNameBrief', hitl: true } },
    { nodeId: 't3', typeId: WALKTHROUGH_STEP_TYPE_ID, config: { actionId: 'campaign-studio.create-brief.click', narration: 'csWalkthroughCreate' } },
    { nodeId: 't4', typeId: WALKTHROUGH_CHECKPOINT_TYPE_ID, config: { expect: 'campaign-studio.brief-exists', narration: 'csWalkthroughCheckpoint' } },
    { nodeId: 't5', typeId: WALKTHROUGH_STEP_TYPE_ID, config: { actionId: 'campaign-studio.campaigns-tab.click', narration: 'csWalkthroughCampaignsTab' } },
  ],
  edges: [
    { edgeId: 'e1', sourceNodeId: 't1', targetNodeId: 't2' },
    { edgeId: 'e2', sourceNodeId: 't2', targetNodeId: 't3' },
    { edgeId: 'e3', sourceNodeId: 't3', targetNodeId: 't4' },
    { edgeId: 'e4', sourceNodeId: 't4', targetNodeId: 't5' },
  ],
};

/**
 * The chat first-message walkthrough (originally ADR 0378 P4) — backs manual
 * test CHAT-01, the P0 blocker case. ONE HITL step (the user composes + sends;
 * no synthetic sends — the model call is the user's choice) plus a patient
 * response checkpoint.
 */
const CHAT_WALKTHROUGH: WorkflowDefinition = {
  workflowId: CHAT_WALKTHROUGH_ID,
  metadata: { name: 'Chat: send your first message', walkthrough: true },
  nodes: [
    { nodeId: 't1', typeId: WALKTHROUGH_STEP_TYPE_ID, config: { actionId: 'chat.composer.send-message', narration: 'chatWalkthroughCompose', hitl: true } },
    { nodeId: 't2', typeId: WALKTHROUGH_CHECKPOINT_TYPE_ID, config: { expect: 'chat.response-received', narration: 'chatWalkthroughResponse' } },
  ],
  edges: [{ edgeId: 'e1', sourceNodeId: 't1', targetNodeId: 't2' }],
};

/** The canonical demo walkthroughs, in seed order. */
export const DEMO_WALKTHROUGHS: readonly WorkflowDefinition[] = [CAMPAIGN_STUDIO_WALKTHROUGH, CHAT_WALKTHROUGH];

const nameOf = (def: WorkflowDefinition): string =>
  typeof def.metadata?.name === 'string' && def.metadata.name ? def.metadata.name : def.workflowId;

/**
 * How many of the canonical demo walkthroughs this tenant currently has LIVE.
 *
 * Archived rows do not count. The walkthroughs page's Remove verb archives (the
 * workflows-dashboard lifecycle), so counting a removed walkthrough as "present"
 * would make `/example-data` report 2 for a page showing 1 — and, worse, make a
 * re-seed a no-op with no way back short of Clear. Verified live: that exact
 * mismatch appeared before this rule existed.
 */
export async function countDemoWalkthroughs(tenantId: string): Promise<number> {
  const owned = await Promise.all(DEMO_WALKTHROUGHS.map((d) => getOwned(tenantId, d.workflowId)));
  return owned.filter((r) => r && !r.archivedAt).length;
}

/**
 * Seed the demo walkthroughs for `tenantId` — register the shared global def
 * if missing, then record per-tenant ownership. Idempotent: a walkthrough the
 * tenant already has LIVE is re-upserted (same key) and NOT counted as created.
 *
 * A previously REMOVED (archived) sample re-seeds as a fresh create: ownership
 * is re-recorded without `archivedAt` and the definition's lifecycle is
 * un-archived, so "Load example walkthroughs" brings back exactly what Remove
 * took away. Without this, Remove was a one-way door — the only recovery was
 * Clear-then-Load.
 *
 * Non-destructive by design: the global def is only re-registered when ABSENT
 * or archived, so a tenant that edited its copy keeps the edited steps (the
 * registry is by-id; a re-seed must never clobber authored content).
 */
export async function seedDemoWalkthroughs(tenantId: string): Promise<{ created: number; details: Record<string, unknown> }> {
  let created = 0;
  const seeded: string[] = [];
  for (const def of DEMO_WALKTHROUGHS) {
    try {
      const registered = getRegisteredWorkflow(def.workflowId);
      if (!registered) registerWorkflow(def);
      else if (lifecycleOf(registered).archivedAt) registerWorkflow(withLifecycle(registered, { archivedAt: undefined }));
      const live = getRegisteredWorkflow(def.workflowId) ?? def;
      const prior = await getOwned(tenantId, def.workflowId);
      const wasLive = Boolean(prior) && !prior?.archivedAt;
      await recordOwnership(tenantId, def.workflowId, { name: nameOf(live), nodeCount: live.nodes.length });
      if (!wasLive) { created += 1; seeded.push(def.workflowId); }
    } catch (err) {
      log.warn('seed_walkthrough_skipped', { tenantId, workflowId: def.workflowId, error: String(err) });
    }
  }
  return { created, details: { seeded } };
}

/**
 * Drop this tenant's ownership of the canonical demo walkthroughs. The global
 * registry def is removed only once NO tenant owns it any more — another
 * tenant's seeded copy (and the replay of its historical runs) must survive
 * this tenant's clear.
 */
export async function clearDemoWalkthroughs(tenantId: string): Promise<{ cleared: number; details: Record<string, unknown> }> {
  let cleared = 0;
  for (const def of DEMO_WALKTHROUGHS) {
    if (await removeOwnership(tenantId, def.workflowId)) cleared += 1;
    if (!(await isAuthoredByAnyTenant(def.workflowId))) deleteRegisteredWorkflow(def.workflowId);
  }
  return { cleared, details: { walkthroughIds: DEMO_WALKTHROUGHS.map((d) => d.workflowId) } };
}
