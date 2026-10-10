/**
 * ADR 0474 P1b — published-launch resolution (the n8n 2.0 semantic): once a
 * workflow is PROMOTED, production launches execute the PUBLISHED revision
 * even while the owner keeps editing the head. The builder's test-run opts
 * back into the head with the host-local `metadata.launch = 'draft'` request
 * convention (request metadata is an open map — no wire-shape change; the
 * knob only bypasses the CALLER'S OWN published pin, so it grants nothing).
 *
 * Resolution: head via the catalog funnel → the launching tenant's ownership
 * row → if `publishedRevision` is set AND differs from the head's revision
 * hash, substitute the published revision row. A missing row (pruned — the
 * published revision is prune-spared, so only manual interference) falls back
 * to head, honestly stamped `launchResolved: 'head'`.
 */

import type { WorkflowDefinition } from '../executor/types.js';
import { getOwned, isWorkflowForeignTo } from './workflowOwnership.js';
import { getRevision } from './workflowRevisions.js';
import { revisionHashOf } from './definitionHash.js';
import { createLogger } from '../observability/logger.js';
import { assertWorkflowFeatureLaunchable, type LaunchSubject } from './workflowFeatureGate.js';

const log = createLogger('resolveLaunchWorkflow');

export interface LaunchResolvedWorkflow {
  workflowId: string;
  definition: WorkflowDefinition;
  launchResolved: 'published' | 'head';
}

type WorkflowCatalogLike = { getWorkflow(workflowId: string): Promise<{ workflowId: string; definition: WorkflowDefinition } | null> };

/**
 * ADR 0823 D2 — the HEAD of `workflowId` as `tenantId` may execute it, or `null`.
 * The catalog is a global by-id resolver; this is the tenant boundary over it. A
 * workflow another tenant owns resolves exactly like an unknown id, so every
 * launcher's existing not-found is also its refusal and leaks no existence.
 *
 * Use this (not `catalog.getWorkflow`) wherever a caller-chosen id becomes a
 * definition: `adr0823-launch-ownership-ratchet.test.ts` fails on a new direct
 * catalog read. `resolveLaunchWorkflow` adds the published pin on top.
 *
 * `operator` (D6) — a wildcard (`tenants:['*']`) principal at an HTTP launch: it
 * already operates under ANY tenant, so running a definition across tenants
 * grants it nothing it lacks (the M7 read guard exempts it the same way). Only
 * a route that holds the principal may set it; internal launchers never do.
 */
export async function resolveTenantWorkflow(
  catalog: WorkflowCatalogLike,
  tenantId: string,
  workflowId: string,
  opts: { operator?: boolean } = {},
): Promise<{ workflowId: string; definition: WorkflowDefinition } | null> {
  // The predicate runs whether or not the catalog hits, so a foreign id and an
  // unknown one cost the same reads (no timing oracle on derivable ids).
  const foreign = opts.operator === true ? false : await isWorkflowForeignTo(tenantId, workflowId);
  const wf = await catalog.getWorkflow(workflowId);
  if (!wf) return null;
  if (foreign) {
    // Server-side only — the caller still answers an indistinguishable not-found.
    // `wf.sub.*` / `wf.cadence.*` ids are derivable, so probing shows up here.
    log.warn('workflow_launch_refused_foreign', { tenantId, workflowId });
    return null;
  }
  return wf;
}

export async function resolveLaunchWorkflow(
  catalog: WorkflowCatalogLike,
  tenantId: string,
  workflowId: string,
  opts: { launch?: 'draft' | 'published'; operator?: boolean; subject?: LaunchSubject } = {},
): Promise<LaunchResolvedWorkflow | null> {
  const wf = await resolveTenantWorkflow(catalog, tenantId, workflowId, { operator: opts.operator });
  if (!wf) return null;
  // ADR 0820 §7 / G6 — the run-start gate by OWNING FEATURE, at the one funnel
  // every launcher shares (API runs, schedules, triggers, kanban, MCP, CRM,
  // sub-workflow children). AFTER the ownership predicate (a foreign id stays a
  // plain not-found) and BEFORE anything is minted or counted: a refused launch
  // throws the typed `WorkflowFeatureRefusedError` and consumes nothing. The
  // wildcard `operator` exemption is an OWNERSHIP exemption only; the plan
  // exemption is `subject.planExempt` (the listed operator, `toggleSubjectOf`).
  await assertWorkflowFeatureLaunchable(tenantId, workflowId, wf.definition, opts.subject);
  if (opts.launch === 'draft') return { workflowId, definition: wf.definition, launchResolved: 'head' };
  // The published pin is a LAUNCH SEMANTIC, not a security boundary (ADR 0474
  // P1b decision F4) — so an unreadable ownership/revision store degrades to
  // the head, it never blocks the launch. Concretely: executor-arm tests (and
  // any embedding that skips initHostExtPersistence) dispatch sub-workflow
  // children through this resolver; a thrown "persistence not initialized"
  // here silently zeroed every child (the P1b regression this guard fixes).
  try {
    const owned = await getOwned(tenantId, workflowId);
    const published = owned?.publishedRevision;
    if (!published || revisionHashOf(wf.definition) === published) {
      return { workflowId, definition: wf.definition, launchResolved: 'head' };
    }
    const row = await getRevision(workflowId, published);
    if (!row || row.tenantId !== tenantId) {
      return { workflowId, definition: wf.definition, launchResolved: 'head' };
    }
    return { workflowId, definition: row.definition, launchResolved: 'published' };
  } catch (err) {
    // Review M5 — the head fallback is deliberate (F4), but a store error in
    // production silently changes WHICH definition a published launch runs;
    // operators need the signal even though the launch proceeds.
    log.warn('published-pin resolution failed — launching the HEAD', {
      workflowId, tenantId, error: err instanceof Error ? err.message : String(err),
    });
    return { workflowId, definition: wf.definition, launchResolved: 'head' };
  }
}
