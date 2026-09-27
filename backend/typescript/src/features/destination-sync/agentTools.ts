/**
 * Destination-sync chat tools (CHAT-FIRST-PORT-AUDIT D7; ADR 0308 D2 seam) — the
 * lane that lets an agent READ the workspace's configured syncs, PREVIEW a
 * field-mapping, and IGNITE the (previously DARK) onward egress from the one
 * chat. Before this, the ADR 0289 onward-sync workflow (`onwardSyncWorkflow.ts`)
 * and the governed ADR 0292 `warehouseLoad` (`warehouseLoadService.ts`) had NO
 * igniter anywhere — registered but unreachable.
 *
 * Registered via `registerFeatureAgentTool` from `feature.ts` init. No agent
 * PACK exists for destination-sync yet (it is a CDP ops surface), so these tools
 * are resolvable + gated but not yet surfaced to a named persona — that is
 * deferred to the CDP ops-console work. The tools still flow through the SAME
 * projection + gating as every builtin (allowlist → firewall → executeTool).
 *
 * Authority parity (brief hard rule 1): the HTTP routes gate on the shared
 * `destination-sync` toggle (`requireFeatureEnabled`, routes.ts:33) with NO
 * per-user predicate beyond tenant. Each tool re-resolves that toggle per-tenant
 * (fail-closed) AND additionally fails on a missing acting human — the READ tool
 * fails EMPTY, the preview/action tools fail TYPED (a system/agent turn with no
 * human never drives egress). The warehouse action keeps its own approval gate:
 * `warehouseLoad` runs `evaluateWarehouseGate` (warehouseLoadService.ts:85) whose
 * `actionPolicyOf('warehouse.load')` default is `approval-required`
 * (warehouseLoadService.ts:94) — the insert (warehouseLoadService.ts:210) only
 * runs on an `approved` verdict, so igniting a warehouse sync from chat returns a
 * pending approval, never a silent write.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { claimIgnition, recordIgnitionRun, releaseIgnition, ignitionKey } from '../../host/ignitionGuard.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { createLogger } from '../../observability/logger.js';
import { ONWARD_SYNC_WORKFLOW_ID } from './onwardSyncWorkflow.js';
import { applyFieldMap, getDestinationSync, listDestinationSyncs } from './destinationSyncService.js';
import { warehouseLoad, warehouseLoadDeps } from './warehouseLoadService.js';

const log = createLogger('destination-sync.agent-tools');

const TOGGLE_ID = 'destination-sync';

export const DESTINATION_SYNC_LIST_TOOL_ID = 'openwop:destination-sync.list';
export const DESTINATION_SYNC_DRY_RUN_TOOL_ID = 'openwop:destination-sync.dry-run';
export const DESTINATION_SYNC_RUN_TOOL_ID = 'openwop:destination-sync.run';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — surfaced to the model verbatim, so it must be actionable. */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed —
 *  the tool's analog of the routes' `requireFeatureEnabled` (routes.ts:33). */
async function destinationSyncEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle(TOGGLE_ID, scope);
}

/** A compact, model-facing sync projection — enough to choose one to run without
 *  leaking the credential/peer coordinates the config row carries. */
function projectSync(s: Awaited<ReturnType<typeof listDestinationSyncs>>[number]): Record<string, unknown> {
  return {
    syncId: s.syncId,
    name: s.name,
    destinationKind: s.destinationKind,
    sourceObject: s.sourceObject,
    syncMode: s.syncMode,
    cursorField: s.cursorField,
    ...(s.cursor !== undefined ? { cursor: s.cursor } : {}),
    fieldCount: s.fieldMap.length,
    // The chat-drivable egress owners; anything else rides operator http nodes.
    ignitable: s.destinationKind === 'openwop-host' || s.destinationKind === 'warehouse',
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const recordsOf = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)) : [];

/**
 * READ — list the workspace's configured destination syncs. Fails EMPTY (brief
 * rule 1) without an acting human OR with the feature disabled — the read analog
 * of the route's 404, never a leak.
 */
export async function runListTool(_input: Record<string, unknown>, scope: BundleScope): Promise<ToolResult> {
  if (!scope.actingUserId) return { content: JSON.stringify({ syncs: [] }) };
  if (!(await destinationSyncEnabled(scope))) return { content: JSON.stringify({ syncs: [] }) };
  const syncs = await listDestinationSyncs(scope.tenantId);
  return { content: JSON.stringify({ syncs: syncs.map(projectSync) }) };
}

/**
 * PREVIEW — field-map a single sample record for a sync WITHOUT sending anything
 * (mirrors `POST /:id/dry-run`, routes.ts:103). Fails TYPED (it computes on a
 * named sync + a required sample; an empty result would be an ambiguous
 * success-with-empty, brief rule 2).
 */
export async function runDryRunTool(input: Record<string, unknown>, scope: BundleScope): Promise<ToolResult> {
  if (!scope.actingUserId) return toolError('acting_user_required', 'Sync previews can only be run from a human-initiated turn.');
  if (!(await destinationSyncEnabled(scope))) {
    return toolError('feature_disabled', 'Destination Sync is not enabled for this workspace.');
  }
  const syncId = str(input.syncId);
  if (!syncId) return toolError('validation_error', '`syncId` is required (get one from `list`).');
  const sample = input.sample;
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
    return toolError('validation_error', '`sample` must be an object record to preview.');
  }
  const sync = await getDestinationSync(scope.tenantId, syncId);
  if (!sync) return toolError('not_found', 'Sync not found.', { syncId });
  return { content: JSON.stringify({ syncId, mapped: applyFieldMap(sample as Record<string, unknown>, sync.fieldMap) }) };
}

/**
 * ACTION — ignite the sync's onward egress from chat, through each destination
 * kind's SANCTIONED path (never a bespoke egress — ADR 0262 ruling #3):
 *
 *  - `openwop-host` → START the ADR 0289 onward-sync workflow
 *    (`ONWARD_SYNC_WORKFLOW_ID`) via `startWorkflowRun`, guarded by
 *    `claimIgnition` keyed on the syncId so a re-prompted/retrying model reuses
 *    the run it just started instead of minting another (HIGH-1).
 *  - `warehouse` → the GOVERNED `warehouseLoad` surface verb, whose
 *    `approval-required` gate (warehouseLoadService.ts:200) stays intact: this
 *    returns a `requires_approval` verdict for a human to decide, never a silent
 *    insert. `warehouseLoad` is self-idempotent (per-batch approval reuse,
 *    warehouseBatchKey) so it needs no separate ignition latch.
 *  - anything else → typed refusal: the non-OpenWOP field-map egress rides the
 *    operator's own http nodes and has no chat igniter.
 *
 * Fails TYPED throughout (action tool, brief rule 1). `deps` (the run-starter) is
 * closure-bound at registration; exposed as the first arg for direct testing.
 */
export async function runRunTool(deps: StartRunDeps, input: Record<string, unknown>, scope: BundleScope): Promise<ToolResult> {
  if (!scope.actingUserId) return toolError('acting_user_required', 'A sync can only be run from a human-initiated turn.');
  if (!(await destinationSyncEnabled(scope))) {
    return toolError('feature_disabled', 'Destination Sync is not enabled for this workspace.');
  }
  const syncId = str(input.syncId);
  if (!syncId) return toolError('validation_error', '`syncId` is required (get one from `list`).');
  const sync = await getDestinationSync(scope.tenantId, syncId);
  if (!sync) return toolError('not_found', 'Sync not found.', { syncId });
  const records = recordsOf(input.records);

  if (sync.destinationKind === 'openwop-host') {
    if (!sync.peerIngestUrl) {
      return toolError('not_configured', 'This openwop-host sync has no peerIngestUrl configured.', { syncId });
    }
    // Ignition dedup keyed on the STABLE destination id (never a timestamp) so a
    // repeated call inside the window reuses the run already started.
    const key = ignitionKey('destination-sync.run', syncId);
    const claim = await claimIgnition(scope.tenantId, key);
    if (!claim.claimed) {
      return { content: JSON.stringify({ runId: claim.existingRunId ?? null, ignited: false, note: 'an identical sync run was started moments ago — reusing it' }) };
    }
    const runId = await startWorkflowRun(deps, {
      tenantId: scope.tenantId,
      workflowId: ONWARD_SYNC_WORKFLOW_ID,
      inputs: { syncId, records, peerIngestUrl: sync.peerIngestUrl },
      metadata: {
        actingUserId: scope.actingUserId,
        ...(scope.conversationId ? { chatSessionId: scope.conversationId } : {}),
        destinationSync: { syncId, destinationKind: sync.destinationKind },
      },
    }).catch((err) => {
      // DATA-4 — a startWorkflowRun THROW must also release the claim; coerce to
      // null so the shared failure handler below runs.
      log.warn('destination_sync_dispatch_threw', { tenantId: scope.tenantId, syncId, error: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (!runId) {
      // CFPT-2 / DATA-4 — the run never started (null OR a throw); release the claim
      // so an honest retry isn't blocked for the dedup window by a latch over a failure.
      await releaseIgnition(scope.tenantId, key);
      return toolError('dispatch_failed', 'The onward-sync workflow could not start.');
    }
    await recordIgnitionRun(scope.tenantId, key, runId);
    log.info('destination_sync_onward_dispatched', { tenantId: scope.tenantId, syncId, runId });
    return { content: JSON.stringify({ runId, syncId, destinationKind: sync.destinationKind, ignited: true }) };
  }

  if (sync.destinationKind === 'warehouse') {
    // The governed reverse-ETL load — the approval gate (warehouseLoadService.ts:200)
    // is INSIDE `warehouseLoad`; a `requires_approval` verdict means a human must
    // decide before any BigQuery insert. Never a silent write from chat.
    const result = await warehouseLoad(
      warehouseLoadDeps({ tenantId: scope.tenantId, ...(scope.runId ? { runId: scope.runId } : {}), actingUserId: scope.actingUserId }),
      { syncId, records },
    );
    log.info('destination_sync_warehouse_load', { tenantId: scope.tenantId, syncId, status: result.status });
    const note = result.status === 'requires_approval'
      ? 'A warehouse-load approval is pending — tell the user a person must approve it before anything is written to BigQuery.'
      : undefined;
    return { content: JSON.stringify({ syncId, destinationKind: sync.destinationKind, ...result, ...(note ? { note } : {}) }) };
  }

  return toolError(
    'unsupported_destination_kind',
    `A '${sync.destinationKind}' sync egresses through the operator's own http/connector nodes and has no chat igniter — only openwop-host and warehouse syncs run from here.`,
    { syncId, destinationKind: sync.destinationKind },
  );
}

/** Register the destination-sync chat tools. Called from `feature.ts` init with
 *  the run-starter deps (storage + host suite). */
export function registerDestinationSyncAgentTools(deps: StartRunDeps): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DESTINATION_SYNC_LIST_TOOL_ID,
      description:
        'List the workspace\'s configured destination syncs (name, destination kind, source object, sync mode, CDC '
        + 'cursor, field-map size, and whether it can be run from chat). Use it to ground which sync to preview or run. '
        + 'Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: runListTool,
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DESTINATION_SYNC_DRY_RUN_TOOL_ID,
      description:
        'Preview how a sync maps a SAMPLE record to its destination fields, WITHOUT sending anything. Pass the `syncId` '
        + '(from `list`) and a `sample` object record; returns the field-mapped payload. Use it to verify a mapping before running.',
      inputSchema: {
        type: 'object',
        properties: {
          syncId: { type: 'string', description: 'The destination sync to preview (from `list`).' },
          sample: { type: 'object', description: 'A sample source record to field-map.', additionalProperties: true },
        },
        required: ['syncId', 'sample'],
        additionalProperties: false,
      },
    },
    run: runDryRunTool,
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DESTINATION_SYNC_RUN_TOOL_ID,
      description:
        'Run a destination sync\'s onward egress. For an `openwop-host` sync this starts the onward-sync workflow that '
        + 'forwards the (purpose-labelled) records to the peer host; for a `warehouse` sync this runs the GOVERNED BigQuery '
        + 'reverse-ETL load, which requires a human approval before anything is written. Pass the `syncId` (from `list`) and '
        + 'optionally the `records` batch to forward. A warehouse run NEVER writes on its own — it returns a pending approval. '
        + 'Returns the started `runId` (openwop-host) or the load verdict (warehouse).',
      inputSchema: {
        type: 'object',
        properties: {
          syncId: { type: 'string', description: 'The destination sync to run (from `list`).' },
          records: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'The record batch to forward/load (CDC-filtered by the sync).' },
        },
        required: ['syncId'],
        additionalProperties: false,
      },
    },
    run: (input, scope) => runRunTool(deps, input, scope),
  });
}
