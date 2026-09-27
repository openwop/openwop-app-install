/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT A10) — the Visualizer's REAL conversational
 * tools. The agent pack allowlisted the pack node typeId, which no provider
 * projects, so the Visualizer resolved zero tools and could produce nothing.
 *
 * `openwop:interactive-artifacts.render` drives the REAL pack node
 * (`feature.interactive-artifacts.nodes.render`, pure transform — the
 * `computeNodeTool` minimal-ctx pattern, ADR 0081 P3/ADR 0358) for the one
 * normalization gate, then persists through the run-artifact owner
 * (`persistRunArtifact`, insert-only CAS, deterministic key) so the artifact
 * lands in the SAME workbench/library lane as run-produced artifacts
 * (ADR 0083). Node validation failures return as structured `isError` results —
 * the agent loop's error feedback is the bounded repair loop.
 *
 * `openwop:interactive-artifacts.get` reads a stored artifact back
 * (read-before-write for revisions). Tenant-checked; reads fail EMPTY without
 * an acting user, the action fails TYPED (CLAUDE.md exchange rules).
 */
import { createHash } from 'node:crypto';
import { getNodeRegistry } from '../../executor/nodeRegistry.js';
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { persistRunArtifact, getRunArtifact, runArtifactKey } from '../../host/runArtifactStore.js';
import type { NodeContext } from '../../executor/types.js';

export const INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID = 'openwop:interactive-artifacts.render';
export const INTERACTIVE_ARTIFACTS_GET_TOOL_ID = 'openwop:interactive-artifacts.get';

const RENDER_NODE_TYPE_ID = 'feature.interactive-artifacts.nodes.render';

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

export function registerInteractiveArtifactAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID,
      description:
        'Render an interactive artifact into the chat artifact workbench. Input: { kind: "mermaid"|"chart"|"html"|"react", source?: string (raw mermaid/HTML/JSX text), chart?: { chartType, data, options? } (for kind "chart"), title?: string }. Validates through the real render node; returns { artifactId, artifactTypeId }. On a validation error, fix the input and retry once.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['mermaid', 'chart', 'html', 'react'] },
          source: { type: 'string' },
          chart: { type: 'object', additionalProperties: true },
          title: { type: 'string' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) {
        return { content: JSON.stringify({ error: 'auth_required', message: 'rendering requires an acting user' }), isError: true };
      }
      const node = await getNodeRegistry().resolve(RENDER_NODE_TYPE_ID);
      if (!node) {
        return { content: JSON.stringify({ error: 'node_unavailable', message: `node not available: ${RENDER_NODE_TYPE_ID}` }), isError: true };
      }
      // Deterministic per conversation+content: a retry of the SAME payload
      // replaces (persistRunArtifact CAS-dedupes per key); new content mints a
      // new artifact. Never a random id on a re-runnable path.
      // DATA-1 — the tenant MUST be part of the runId. `runArtifactKey` carries
      // no tenant and `getRunArtifact` has none on this path, so without it two
      // tenants rendering identical content through an empty scope (both
      // `chat-viz:undefined`) would collide onto one artifact row (tenant B gets
      // A's). The get tool below still re-checks `record.tenantId`, but the KEY
      // itself must not collapse across tenants in the first place.
      const runId = `chat-viz:${scope.tenantId}:${scope.conversationId ?? scope.actingUserId ?? 'adhoc'}`;
      const nodeId = `render:${contentHash({ k: input.kind, s: input.source, c: input.chart, t: input.title })}`;
      const ctx: NodeContext = {
        runId,
        nodeId,
        tenantId: scope.tenantId,
        inputs: input,
        config: {},
        configurable: {},
        attempt: 1,
        secrets: {},
        emit: async () => ({ eventId: '', sequence: 0 }),
      };
      const outcome = await node.execute(ctx);
      if (outcome.status !== 'success') {
        const err = outcome.status === 'failure' ? outcome.error : { code: 'node_unexpected_outcome' };
        return { content: JSON.stringify({ error: 'validation_error', detail: err }), isError: true };
      }
      const persisted = await persistRunArtifact({
        tenantId: scope.tenantId,
        runId,
        nodeId,
        role: 'deliverable',
        output: outcome.outputs,
        now: new Date().toISOString(),
      });
      if (!persisted) {
        return { content: JSON.stringify({ error: 'persist_failed', message: 'artifact could not be stored' }), isError: true };
      }
      const artifact = (outcome.outputs as { artifact?: { artifactTypeId?: string; title?: string } } | undefined)?.artifact;
      return {
        content: JSON.stringify({
          artifactId: persisted.artifactId,
          revisionId: persisted.revisionId,
          artifactKey: runArtifactKey(runId, nodeId),
          artifactTypeId: artifact?.artifactTypeId,
          title: artifact?.title,
        }),
      };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 review H4 — the READ-BEFORE-WRITE body of the `get-design`
    // family (`cad` / `drawings` / `campaign-studio` / `app-builder`, all
    // exempt); its own description is literally "read before revising", and
    // `render` OVERWRITES what it returns. Verified truncatable, not assumed:
    // for `kind:"chart"` the stored payload is the structured
    // `{chartType, data, options}` object (packs/…nodes/index.mjs), whose
    // `data` arrays elide under `lossy` — so the model revises a chart it was
    // shown only the ends of and silently drops the middle. (For the text
    // kinds the payload is a raw source STRING, which the kernel never
    // truncates; the chart case is what puts this tool in the class.)
    schemaCarrying: true,
    def: {
      name: INTERACTIVE_ARTIFACTS_GET_TOOL_ID,
      description:
        'Read back an interactive artifact you rendered earlier (read before revising). Input: { artifactKey: string } — the key returned by the render tool.',
      inputSchema: {
        type: 'object',
        properties: { artifactKey: { type: 'string' } },
        required: ['artifactKey'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // Read tool: fails EMPTY without an acting user (never leaks existence).
      if (!scope.actingUserId) return { content: JSON.stringify({ artifact: null }) };
      const key = typeof input.artifactKey === 'string' ? input.artifactKey : '';
      const record = key ? await getRunArtifact(key) : null;
      if (!record || record.tenantId !== scope.tenantId) {
        return { content: JSON.stringify({ artifact: null }) };
      }
      return {
        content: JSON.stringify({
          artifact: {
            artifactKey: record.artifactKey,
            artifactTypeId: record.artifactTypeId,
            title: record.title,
            content: record.content,
            createdAt: record.createdAt,
          },
        }),
      };
    },
  });
}
