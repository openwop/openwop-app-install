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
import { getOwned } from './workflowOwnership.js';
import { getRevision } from './workflowRevisions.js';
import { revisionHashOf } from './definitionHash.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('resolveLaunchWorkflow');

export interface LaunchResolvedWorkflow {
  workflowId: string;
  definition: WorkflowDefinition;
  launchResolved: 'published' | 'head';
}

export async function resolveLaunchWorkflow(
  catalog: { getWorkflow(workflowId: string): Promise<{ workflowId: string; definition: WorkflowDefinition } | null> },
  tenantId: string,
  workflowId: string,
  opts: { launch?: 'draft' | 'published' } = {},
): Promise<LaunchResolvedWorkflow | null> {
  const wf = await catalog.getWorkflow(workflowId);
  if (!wf) return null;
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
