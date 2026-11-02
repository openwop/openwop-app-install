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
 * (read-before-write for revisions). Reads fail EMPTY without an acting user, the
 * action fails TYPED (CLAUDE.md exchange rules).
 *
 * ADR 1017:
 *  - D3: `render` runs the store's own typed-path check (`checkTypedArtifact`) BEFORE
 *    persisting, and reads the row back, so a payload the store would demote to an
 *    untyped blob is a typed failure, never "rendered".
 *  - D4: model text carries only `handle: "render:<sha12>"`. The artifact key names
 *    the tenant and the conversation, so it stays out of the model's context; `get`
 *    resolves the handle inside the caller's own chat bucket.
 *  - D4 (B3): `get` asks the Library's two questions (org read on the row's org, then
 *    conversation read for a chat row), not a tenant check: a key used to reach any
 *    workflow-run artifact in the tenant, including client orgs the caller cannot
 *    read. Asked through `canReadChatToolArtifact`, the one predicate the chat-turn
 *    artifact route uses too.
 *  - D2: the row is stamped with the chat turn's message id, so the turn shows it.
 */
import { createHash } from 'node:crypto';
import { getNodeRegistry } from '../../executor/nodeRegistry.js';
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { persistRunArtifact, getRunArtifact, runArtifactKey, checkTypedArtifact } from '../../host/runArtifactStore.js';
import { chatArtifactRunId } from '../../host/chatArtifactScope.js';
import { canReadChatToolArtifact } from '../../host/artifactProjection.js';
import type { NodeContext } from '../../executor/types.js';

export const INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID = 'openwop:interactive-artifacts.render';
export const INTERACTIVE_ARTIFACTS_GET_TOOL_ID = 'openwop:interactive-artifacts.get';

const RENDER_NODE_TYPE_ID = 'feature.interactive-artifacts.nodes.render';
/** The model-facing handle prefix: the node id the render tool persists under. */
const HANDLE_PREFIX = 'render:';

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

export function registerInteractiveArtifactAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'write',
    def: {
      name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID,
      description:
        'Render an interactive artifact; the chat shows it as a card under your reply that opens in the workbench. Input: { kind: "mermaid"|"chart"|"html"|"react", source?: string (raw mermaid/HTML/JSX text), chart?: { chartType: "bar"|"line", data: { labels?: string[], datasets: [{ label?: string, data: number[] }] }, options? } (for kind "chart"), title?: string }. Validates against the artifact type\'s schema; returns { handle, artifactTypeId, title? }. Pass `handle` to openwop:interactive-artifacts.get to read it back. On a validation error, fix the input and retry once.',
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
      // ADR 0996 — the ONE builder; readers gate on its bucket.
      const runId = chatArtifactRunId('chat-viz', scope);
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
      const artifact = (outcome.outputs as { artifact?: { artifactTypeId?: unknown; payload?: unknown; title?: unknown } } | undefined)?.artifact;
      const requestedType = typeof artifact?.artifactTypeId === 'string' ? artifact.artifactTypeId : '';
      // ADR 1017 D3 — the store's own typed-path rule, asked first. The node's checks are
      // a subset; the registered schema is the authority.
      const check = checkTypedArtifact(requestedType, artifact?.payload);
      if (!check.ok) {
        const error = check.code === 'too_large' ? 'too_large' : 'validation_error';
        return { content: JSON.stringify({ error, message: check.message, ...(check.errors?.length ? { errors: check.errors } : {}) }), isError: true };
      }
      const key = runArtifactKey(runId, nodeId);
      const persisted = await persistRunArtifact({
        tenantId: scope.tenantId,
        runId,
        nodeId,
        role: 'deliverable',
        output: outcome.outputs,
        now: new Date().toISOString(),
        ...(scope.turnMessageId ? { turnMessageId: scope.turnMessageId } : {}),
      });
      // Read back what was STORED: the tool reports that, never the node's claim.
      const stored = persisted ? await getRunArtifact(key) : null;
      if (!stored || stored.artifactTypeId !== requestedType) {
        return { content: JSON.stringify({ error: 'persist_failed', message: `the artifact was not stored as ${requestedType}` }), isError: true };
      }
      // ADR 1017 D4 — no key, artifact id or revision id: each names the tenant and the
      // conversation. The handle is the content hash, the same in every run. Nothing
      // that depends on store state either (a "reused" flag would read differently when
      // a replay fork re-runs this call, and change the next round's digest).
      return {
        content: JSON.stringify({
          handle: nodeId,
          artifactTypeId: stored.artifactTypeId,
          ...(typeof artifact?.title === 'string' && artifact.title ? { title: artifact.title } : {}),
        }),
      };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
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
        'Read back an interactive artifact you rendered earlier in this conversation (read before revising). Input: { artifactKey: string } — the `handle` the render tool returned.',
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
      const key = resolveRenderKey(typeof input.artifactKey === 'string' ? input.artifactKey.trim() : '', scope);
      const record = key ? await getRunArtifact(key) : null;
      // ADR 1017 D4 (B3) — the Library's questions, the run-lane way. Hidden reads
      // exactly like missing.
      if (!record || record.tenantId !== scope.tenantId || record.linkedArtifactId || !(await canReadChatToolArtifact(scope.tenantId, scope.actingUserId, record, { personalTenant: scope.personalTenant }))) {
        return { content: JSON.stringify({ artifact: null }) };
      }
      return {
        content: JSON.stringify({
          artifact: {
            ...(record.nodeId.startsWith(HANDLE_PREFIX) ? { handle: record.nodeId } : {}),
            artifactTypeId: record.artifactTypeId,
            title: record.title,
            content: record.content,
          },
        }),
      };
    },
  });
}

/**
 * The artifact key a `get` input names, or '' when it names nothing this caller's
 * chat could have rendered. A handle (`render:<sha12>`) resolves inside the
 * caller's OWN chat bucket. A full legacy key (transcripts from before ADR 1017)
 * is accepted only on the caller's own tenant's `chat-viz:` lane; the gate in
 * `get` still decides whether this caller may read it.
 */
function resolveRenderKey(value: string, scope: { tenantId: string; conversationId?: string | undefined; actingUserId?: string | undefined }): string {
  if (/^render:[0-9a-f]{12}$/.test(value)) return runArtifactKey(chatArtifactRunId('chat-viz', scope), value);
  return value.startsWith(`chat-viz:${scope.tenantId}:`) ? value : '';
}
