/**
 * ADR 0476 §4 — `openwop:runs.diagnose`: the GROUNDING tool for "explain this
 * failure". The model does the explaining; this tool does the reading — run
 * summary + classified error, the failing node's definition slice, the
 * failure-adjacent event excerpt, and next-action deep links (run detail +
 * the ADR 0475 debug-in-builder link, so the diagnosis composes the debug
 * loop). Read-only; never mutates.
 *
 * Access: the `loadReadableRun` posture without the HTTP request — the run
 * must belong to the caller's tenant, and (ADR 0308 discipline) a READ that
 * grounds a human conversation FAILS EMPTY without an acting user (system
 * runs get no diagnosis channel to leak through). Output re-passes the
 * free-text redaction even though event payloads are already
 * stripped-at-write (defense in depth on a model-facing surface).
 *
 * NOT in SCHEMA_READ_EXEMPT_TOOLS: the output is app-state, not schema text —
 * compaction is acceptable and the excerpts are size-capped here anyway.
 * docs/steward/LLM-EXCHANGE-AUDIT.md carries this tool's tracker row.
 */

import type { Storage } from '../storage/storage.js';
import { registerFeatureAgentTool } from './agentToolProvider.js';
import { toolEmpty, toolOk } from './agentToolKit.js';
import { getRegisteredWorkflowAsync } from './workflowsRegistry.js';
import { sanitizeFreeTextDeep } from '../byok/textRedaction.js';

export const RUN_DIAGNOSE_TOOL_ID = 'openwop:runs.diagnose';

/** Cap on any single excerpted payload (chars of JSON) — grounding, not a dump. */
const EXCERPT_MAX_CHARS = 4000;

function excerpt(value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  if (json.length <= EXCERPT_MAX_CHARS) return value ?? null;
  return { truncated: true, preview: json.slice(0, EXCERPT_MAX_CHARS) };
}

export function registerRunDiagnoseTool(deps: { storage: Storage }): void {
  registerFeatureAgentTool({
    // UNTRUSTED despite being a host DIAGNOSTIC: the result embeds the failed node's
    // error text and its PREDECESSORS' OUTPUTS verbatim. A predecessor can be
    // http.fetch, web research, or a form read, so those bytes are attacker-choosable.
    // Host-computed framing does not launder an embedded payload.
    contentTrust: 'untrusted',
    def: {
      name: RUN_DIAGNOSE_TOOL_ID,
      description:
        'Read the grounded failure context of a FAILED workflow run you can see: the classified error, the failing '
        + "node's definition slice, the failure-adjacent events (the failed node's error and its predecessors' outputs), "
        + 'run provenance (revision/debug/redrive), and deep links (run detail; open-in-builder with the run\'s outputs '
        + 'pinned for one-click reproduction). Read this BEFORE explaining a failure — never guess from the run id alone.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'The failed run to diagnose.' },
        },
        required: ['runId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // ADR 0308 — a human-grounding read fails EMPTY without an acting user.
      if (!scope.actingUserId) return toolEmpty({ note: 'Diagnosis is only available on a human-initiated turn.' });
      const runId = typeof input.runId === 'string' ? input.runId : '';
      if (!runId) return toolEmpty({ note: 'runId is required.' });

      const run = await deps.storage.getRun(runId);
      // The loadReadableRun posture: absent OR foreign tenant ⇒ indistinguishable empty.
      if (!run || run.tenantId !== scope.tenantId) {
        return toolEmpty({ note: 'No such run is visible to you.' });
      }
      if (run.status !== 'failed') {
        return toolOk({
          runId,
          status: run.status,
          note: 'This run has not failed — diagnosis applies to failed runs. For a running run, watch its events; for a completed run, read its outputs.',
        });
      }

      const meta = (run.metadata ?? {}) as Record<string, unknown>;
      const definition = await getRegisteredWorkflowAsync(run.workflowId);

      // Failure-adjacent events. Review H1: the EVENT LOG is the authority on
      // which node failed — `currentNodeId` is a start-time stamp that can
      // point at the last-STARTED node under parallel branches (now re-stamped
      // at failure, but the log stays the ground truth for old runs).
      const events = await deps.storage.listEvents(runId, { fromSeq: -1, limit: 100_000 });
      const nodeFailed = [...events].reverse().find((e) => e.type === 'node.failed' && e.nodeId);
      const failedNodeId = nodeFailed?.nodeId ?? run.currentNodeId;
      const failedNode = failedNodeId ? definition?.nodes.find((n) => n.nodeId === failedNodeId) : undefined;
      const predecessorIds = new Set(
        (definition?.edges ?? [])
          .filter((e) => failedNodeId && e.targetNodeId === failedNodeId)
          .map((e) => e.sourceNodeId),
      );
      // Review H2 — bounded in COUNT, not just per-excerpt size: keep only the
      // LATEST completion per predecessor (what the failing node actually
      // consumed — retries/loops re-complete), cap the list, and say when it
      // was cut. An unbounded fan-in must never flood the model context.
      const latestByPredecessor = new Map<string, unknown>();
      for (const e of events) {
        if (e.type === 'node.completed' && e.nodeId && predecessorIds.has(e.nodeId)) {
          latestByPredecessor.set(e.nodeId, (e.payload as { outputs?: unknown } | undefined)?.outputs);
        }
      }
      const PREDECESSORS_MAX = 8;
      const predecessorEntries = [...latestByPredecessor.entries()];
      const predecessorOutputs = predecessorEntries
        .slice(0, PREDECESSORS_MAX)
        .map(([nodeId, outputs]) => ({ nodeId, outputs: excerpt(outputs) }));
      const predecessorsTruncated = predecessorEntries.length > PREDECESSORS_MAX;

      const result = {
        runId,
        workflowId: run.workflowId,
        status: run.status,
        error: run.error ?? null,
        failedNodeId: failedNodeId ?? null,
        failedNode: failedNode
          ? { typeId: failedNode.typeId, name: (failedNode as { name?: string }).name ?? null, config: excerpt(failedNode.config ?? {}) }
          : null,
        failedEvent: nodeFailed ? excerpt(nodeFailed.payload) : null,
        predecessorOutputs,
        ...(predecessorsTruncated ? { predecessorsTruncated: true } : {}),
        provenance: {
          ...(typeof meta.definitionRevision === 'string' ? { definitionRevision: meta.definitionRevision } : {}),
          ...(meta.launch === 'draft' ? { launch: 'draft' } : {}),
          ...(meta.debug && typeof meta.debug === 'object' ? { debug: meta.debug } : {}),
          ...(typeof meta.redriveOf === 'string' ? { redriveOf: meta.redriveOf } : {}),
        },
        links: {
          runDetail: `/runs/${encodeURIComponent(runId)}`,
          // ADR 0475 — one click to reproduce: opens the builder with this
          // run's real outputs pinned (execute-from-step from the failure).
          debugInBuilder: `/builder/${encodeURIComponent(run.workflowId)}?debugRun=${encodeURIComponent(runId)}`,
        },
        startedAt: run.createdAt,
        completedAt: run.completedAt ?? null,
      };
      return toolOk(sanitizeFreeTextDeep(result) as Record<string, unknown>);
    },
  });
}
