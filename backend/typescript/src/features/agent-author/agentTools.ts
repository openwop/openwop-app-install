/**
 * Agent Author chat tools (ADR 0514 P1) — the four
 * `openwop:feature.agent-author.nodes.*` tools the Agent Author agent is
 * allowlisted to, on the ADR 0308 D2 feature-registered-builtin seam (same
 * lifecycle as the workflow-author tools; registration is process-wide,
 * acting-user honesty lives in each tool's run).
 *
 * Governance: `get` reads the roster/registry ⇒ FAIL EMPTY without an acting
 * user; `persist` WRITES the roster ⇒ a hard, model-actionable error without
 * one. Nothing here is in the ADR 0315 default-on baseline — the tools reach a
 * model only via the pack's explicit allowlist.
 *
 * @see docs/adr/0514-agent-author-describe-to-create.md
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import {
  buildAgentAuthorCatalog,
  validateAgentDraft,
  persistAgentDraft,
} from './agentAuthorService.js';
import { stashAgentDraft } from './draftStash.js';

export const AGENT_AUTHOR_GET_TOOL_ID = 'openwop:feature.agent-author.nodes.get';
export const AGENT_AUTHOR_DRAFT_TOOL_ID = 'openwop:feature.agent-author.nodes.draft';
export const AGENT_AUTHOR_VALIDATE_TOOL_ID = 'openwop:feature.agent-author.nodes.validate';
export const AGENT_AUTHOR_PERSIST_TOOL_ID = 'openwop:feature.agent-author.nodes.persist';

type ToolResult = { content: string; isError?: boolean };

function toolError(error: string, message: string): ToolResult {
  return { content: JSON.stringify({ error, message }), isError: true };
}

/** JSON Schema for the draft object, shared by draft/validate/persist inputs.
 *  Mirrors `AgentDraft` — the pack's schemas/*.json pin the same shape. */
const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    persona: { type: 'string', description: 'Display name for the agent — MUST be distinct from every roster persona in the catalog.' },
    agentId: { type: 'string', description: 'The backing agent — MUST be an agentId from the catalog’s `agents` list.' },
    label: { type: 'string' },
    description: { type: 'string' },
    roleKey: { type: 'string', description: 'Optional role slug (e.g. engineer, researcher).' },
    autonomyLevel: { type: 'string', enum: ['auto', 'guided', 'review'] },
    workflows: { type: 'array', items: { type: 'string' }, description: 'Workflow ids from the catalog’s `workflows` list only.' },
  },
  required: ['persona', 'agentId'],
  additionalProperties: false,
} as const;

export function registerAgentAuthorAgentTools(): void {
  // ── get: the closed world + read-before-write roster. Reads the roster ⇒
  // fail EMPTY without a human principal. ─────────────────────────────────────
  // UNTRUSTED unlike its draft/validate/persist siblings: `roster` returns EXISTING
  // personas, whose names/descriptions are user-authored (and pack-authored for
  // installed agent packs). The ids alone would be trusted; the personas are not.
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: AGENT_AUTHOR_GET_TOOL_ID,
      description:
        'Read the CLOSED WORLD for agent authoring: `agents` (the only legal `agentId` values), `workflows` (the only '
        + 'legal portfolio ids), `roster` (existing personas — a duplicate persona is rejected), and `autonomyLevels`. '
        + 'Call this FIRST, before drafting; never invent an agentId or workflow id it does not list. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope: BundleScope) {
      if (!scope.actingUserId) {
        return { content: JSON.stringify({ agents: [], workflows: [], roster: [], autonomyLevels: [] }) };
      }
      return { content: JSON.stringify(await buildAgentAuthorCatalog({ tenantId: scope.tenantId })) };
    },
  });

  // ── draft: echo-validate a candidate so the model iterates cheaply before
  // validate/persist. Stateless; no roster read beyond validation, but the
  // validation READS the roster/registry ⇒ same fail-empty guard. ────────────
  registerFeatureAgentTool({
    // TRUSTED: returns the CLOSED WORLD (legal ids + autonomy enums) — host-authored.
    contentTrust: 'trusted',
    def: {
      name: AGENT_AUTHOR_DRAFT_TOOL_ID,
      description:
        'Shape-check a candidate agent draft against the closed world WITHOUT creating anything. Returns '
        + '{ ok, errors, draft } — on errors, fix EXACTLY what each message says and retry ONCE. '
        + 'Fields: persona (required, distinct), agentId (required, from the catalog), label, description, roleKey, '
        + 'autonomyLevel (auto|guided|review), workflows[] (catalog ids only).',
      inputSchema: { type: 'object', properties: { draft: DRAFT_SCHEMA }, required: ['draft'], additionalProperties: false },
    },
    async run(input, scope: BundleScope) {
      if (!scope.actingUserId) return toolError('no_acting_user', 'Agent authoring requires a signed-in user turn.');
      const v = await validateAgentDraft((input as { draft?: unknown }).draft, { tenantId: scope.tenantId });
      return { content: JSON.stringify(v) };
    },
  });

  // ── validate: alias semantics kept distinct for prompt-flow clarity (the
  // Architect trio precedent: draft → validate → persist reads as a pipeline).
  registerFeatureAgentTool({
    // TRUSTED: verdicts over the model's OWN draft; echoes no stored text.
    contentTrust: 'trusted',
    def: {
      name: AGENT_AUTHOR_VALIDATE_TOOL_ID,
      description:
        'Final pre-persist check of the agent draft against the closed world. Returns { ok, errors }. '
        + 'Persist ONLY after ok:true.',
      inputSchema: { type: 'object', properties: { draft: DRAFT_SCHEMA }, required: ['draft'], additionalProperties: false },
    },
    async run(input, scope: BundleScope) {
      if (!scope.actingUserId) return toolError('no_acting_user', 'Agent authoring requires a signed-in user turn.');
      const v = await validateAgentDraft((input as { draft?: unknown }).draft, { tenantId: scope.tenantId });
      return { content: JSON.stringify({ ok: v.ok, errors: v.errors }) };
    },
  });

  // ── persist: WRITES the roster — hard error without an acting user. The
  // OQ1 draft mode stashes a VALIDATED draft for the wizard instead (no
  // roster write) — used when the user wants to finish in the wizard. ────────
  registerFeatureAgentTool({
    // TRUSTED: host-minted id + ack.
    contentTrust: 'trusted',
    def: {
      name: AGENT_AUTHOR_PERSIST_TOOL_ID,
      description:
        'Create the agent through the SAME path the manual wizard uses. The agent is created DISABLED — tell the user '
        + 'to review and enable it in its workspace (link them to /agents). Returns { rosterId, persona }. '
        + 'A duplicate persona fails with a conflict — revise the persona and retry once. '
        + 'When the user prefers to REVIEW AND FINISH IN THE WIZARD instead of creating now, pass mode:"draft" — the '
        + 'validated draft is handed to the wizard as a prefill and NOTHING is created; tell them to open the create '
        + 'wizard (/agents/new) and apply the draft.',
      inputSchema: {
        type: 'object',
        properties: {
          draft: DRAFT_SCHEMA,
          mode: { type: 'string', enum: ['create', 'draft'], description: 'create (default) writes the roster; draft stashes the validated draft for the wizard prefill.' },
        },
        required: ['draft'],
        additionalProperties: false,
      },
    },
    async run(input, scope: BundleScope) {
      if (!scope.actingUserId) return toolError('no_acting_user', 'Creating an agent requires a signed-in user turn — it writes the roster.');
      const { draft, mode } = input as { draft?: unknown; mode?: unknown };
      if (mode === 'draft') {
        // Stash ONLY a closed-world-valid draft (the doctrine: model output
        // reaches durable state through validation) — invalid drafts return
        // the validator's actionable errors for the bounded repair.
        const v = await validateAgentDraft(draft, { tenantId: scope.tenantId });
        if (!v.ok) return toolError('validation_error', v.errors.join(' '));
        await stashAgentDraft(scope.tenantId, scope.actingUserId, v.draft);
        return { content: JSON.stringify({ stashed: true, persona: v.draft.persona, wizardPath: '/agents/new' }) };
      }
      try {
        const out = await persistAgentDraft(draft, { tenantId: scope.tenantId });
        return { content: JSON.stringify({ ...out, enabled: false, reviewPath: '/agents' }) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolError('persist_failed', msg);
      }
    },
  });
}
