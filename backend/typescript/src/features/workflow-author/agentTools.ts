/**
 * Workflow Architect chat tools (CFP-1 repair; ADR 0308 D2 seam) — the REAL
 * grounding + governed-write tools behind the `feature.workflow-author.agents`
 * pack's Workflow Architect persona.
 *
 * Born of the CHAT-FIRST-PORT-AUDIT #1 finding (docs/chat-first-port/
 * b1-workflow-author.md): the agent pack allowlisted node typeIds
 * (`openwop:feature.workflow-author.nodes.{get,draft,validate,persist}`) that NO
 * host registrant provided, so `compileAgentTools` silently dropped them and the
 * Architect ran in the ONE chat with zero tools — the meta-workflow
 * `draft→validate→persist` pipeline was real for the HTTP/eval front door
 * (`POST .../workflow-author/draft`), but the CHAT persona could call nothing.
 *
 * These four nodes are SURFACE-backed (they need `ctx.features['workflow-author']`),
 * not pure compute, so the node-projection lane (`PROJECTABLE_COMPUTE_NODE_TYPE_IDS`)
 * is the wrong lane by construction — that lane synthesizes a minimal ctx with no
 * feature surfaces. This bridges the workflow-author SURFACE into chat via the
 * sanctioned `registerFeatureAgentTool` seam (the same path CRM / app-builder use),
 * keeping the node-typeId-shaped ids because they match declared nodes (the CRM
 * `feature.crm.nodes.*` precedent).
 *
 * In chat the ARCHITECT is the authoring LLM (the meta-workflow's `draft` node
 * runs the LLM for the eval/API path; in chat the agent loop IS the author + the
 * repair loop — the app-builder `catalog → author → validate/render` pattern):
 *   - `draft`    — read the closed-world node catalog (the legal building blocks
 *                  with schemas) the Architect drafts a WorkflowDefinition against.
 *   - `get`      — read an EXISTING registered workflow by id, or list the index,
 *                  so a revision grounds on the real definition (read-before-write).
 *   - `validate` — closed-world re-check of a candidate WITHOUT persisting; the
 *                  structured errors ARE the repair-loop feedback.
 *   - `persist`  — validate AND register through the SHARED validator/registry, so
 *                  the authored workflow can be opened in the builder (ADR 0596:
 *                  it is openable, not auto-opened — the builder's Create-with-AI
 *                  panel renders a link; nothing navigates on the model's word).
 *
 * Authority parity: every tool calls the SAME service helpers the routes call
 * (`buildAuthoringCatalog` with the `resolveDisabledPacks` curation the
 * `/catalog` route uses; `validateAuthoredWorkflow` / `persistAuthoredWorkflow`
 * the meta-workflow nodes call; the shared `workflowsRegistry` reads). The
 * feature is ALWAYS-ON (no toggle), so there is no `feature_disabled` gate — the
 * routes don't 404 either. Reads that touch the workflow registry (`get`) FAIL
 * EMPTY without an acting user; the `persist` write FAILS TYPED without one
 * (a chat write must be a human-initiated turn). Invalid model input is a TYPED
 * error the agent loop repairs from (never success-with-empty).
 *
 * Tenant isolation (Phase 2, CHAT-FIRST-PORT-AUDIT B1 / review HIGH-2): the
 * `get`/list reads and the `persist` write are scoped to the acting tenant
 * through the ADR 0163 ownership layer (`readAuthoredWorkflow` /
 * `listAuthoredWorkflows` / the ownership guard inside `persistAuthoredWorkflow`)
 * — the SAME isolation the `/v1/host/openwop-app/workflows` routes enforce. A
 * `get` sees only the tenant's own authored workflows + built-ins (a foreign id
 * is an indistinguishable miss, no existence oracle); `persist` never overwrites
 * a built-in or another tenant's workflow.
 *
 * @see docs/chat-first-port/b1-workflow-author.md
 * @see docs/adr/0072-ai-workflow-authoring.md
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveDisabledPacks } from '../../host/packVisibility.js';
import { toolFailLog } from '../../host/agentToolKit.js';
import { parseFieldContract, PRESERVABLE_FIELDS } from '../../host/preserveDroppedFields.js';
import { createLogger } from '../../observability/logger.js';
import { OpenwopError } from '../../types.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';

const wfaLog = createLogger('workflow-author.agent-tools');
import {
  buildAuthoringCatalog,
  validateAuthoredWorkflow,
  persistAuthoredWorkflow,
  readAuthoredWorkflow,
  listAuthoredWorkflows,
} from './workflowAuthorService.js';

export const WORKFLOW_AUTHOR_DRAFT_TOOL_ID = 'openwop:feature.workflow-author.nodes.draft';
export const WORKFLOW_AUTHOR_GET_TOOL_ID = 'openwop:feature.workflow-author.nodes.get';
export const WORKFLOW_AUTHOR_VALIDATE_TOOL_ID = 'openwop:feature.workflow-author.nodes.validate';
export const WORKFLOW_AUTHOR_PERSIST_TOOL_ID = 'openwop:feature.workflow-author.nodes.persist';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must be actionable (what failed, what to do next). */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function registerWorkflowAuthorAgentTools(): void {
  // ── draft: the closed-world node catalog the Architect authors against. ────
  // Non-sensitive (the same menu the builder palette shows), so — like the open
  // `/catalog` route — it needs no acting user. It is tenant-curated via
  // `resolveDisabledPacks` so the Architect never plans a node the palette hides.
  registerFeatureAgentTool({
    // TRUSTED: returns the CLOSED-WORLD node catalog — host-authored vocabulary.
    contentTrust: 'trusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: WORKFLOW_AUTHOR_DRAFT_TOOL_ID,
      description:
        'Begin a draft: returns the CLOSED-WORLD node catalog — every legal building block with its label, '
        + 'category, and config/input/output schemas — that your WorkflowDefinition must be composed from, plus the '
        + 'list of nodes withheld from this workspace (with reasons). The catalog is the law: NEVER use a `typeId` it '
        + 'does not list (an unknown typeId fails at run time). Call this BEFORE authoring, then compose an ACYCLIC '
        + 'node/edge graph — a cycle is REFUSED by both `validate` and `persist`; a single connected graph is '
        + 'PREFERRED but not required, and disconnected components run fine — then `validate` it and `persist` it. '
        + 'Returns { nodes, excluded }.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope: BundleScope) {
      const catalog = buildAuthoringCatalog({ disabledPacks: await resolveDisabledPacks(scope.tenantId) });
      return { content: JSON.stringify({ nodes: catalog.nodes, excluded: catalog.excluded }) };
    },
  });

  // ── get: read an existing registered workflow / list the index. ────────────
  // Touches the workflow registry ⇒ FAIL EMPTY without an acting user (a
  // scheduled/system turn with no human principal must not enumerate workflows).
  // UNTRUSTED while its draft/validate/persist siblings are trusted — this is the
  // only one that READS BACK stored state. A WorkflowDefinition carries user-authored
  // node labels/prompts, and a workflow instantiated from a chain pack carries
  // PACK-authored strings. Do not "fix" the inconsistency by matching the siblings.
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: WORKFLOW_AUTHOR_GET_TOOL_ID,
      description:
        'Read an EXISTING registered workflow by `workflowId` (returns its full WorkflowDefinition), or — with no '
        + '`workflowId` — list the registered-workflow index (id, nodeCount, name, description). When the user asks to '
        + 'CHANGE or EXTEND a workflow, call this FIRST and revise the real definition — never re-author from memory. '
        + 'Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: 'The workflow to fetch. Omit to list the registered-workflow index.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope: BundleScope) {
      if (!scope.actingUserId) {
        // Read tool, no human principal — fail EMPTY (not an error).
        return { content: JSON.stringify({ found: false, workflows: [] }) };
      }
      const workflowId = str(input.workflowId);
      // No id → the TENANT-SCOPED index (own authored workflows + built-ins,
      // never another tenant's — ADR 0163). By id → the IDOR read guard: a
      // foreign id is an indistinguishable miss.
      if (!workflowId) {
        return { content: JSON.stringify({ workflows: await listAuthoredWorkflows({ tenantId: scope.tenantId }) }) };
      }
      const got = await readAuthoredWorkflow(workflowId, { tenantId: scope.tenantId });
      return { content: JSON.stringify(got) };
    },
  });

  // ── validate: closed-world re-check WITHOUT persisting (stateless). ─────────
  registerFeatureAgentTool({
    // TRUSTED: verdicts over the model's OWN draft; echoes no stored text.
    contentTrust: 'trusted',
    def: {
      name: WORKFLOW_AUTHOR_VALIDATE_TOOL_ID,
      description:
        'Validate a candidate WorkflowDefinition against the closed-world node catalog + the shared registration '
        + 'contract WITHOUT persisting. Pass the full definition as `definition`. Returns { ok, errors }: when `ok` is '
        + 'false, fix every error listed and validate again before you persist. Use this to confirm a graph you '
        + 'composed before committing.',
      inputSchema: {
        type: 'object',
        properties: {
          definition: { type: 'object', description: 'The candidate WorkflowDefinition ({ workflowId, nodes, edges? }).' },
        },
        required: ['definition'],
      },
    },
    async run(input) {
      const definition = input.definition;
      if (!definition || typeof definition !== 'object') {
        return toolError('validation_error', 'Pass the candidate WorkflowDefinition as `definition` (an object).');
      }
      const v = validateAuthoredWorkflow(definition);
      return { content: JSON.stringify({ ok: v.ok, errors: v.errors }) };
    },
  });

  // ── persist: validate AND register through the shared path (a WRITE). ───────
  // FAIL TYPED without an acting user — persisting a runnable workflow must be a
  // human-initiated turn.
  registerFeatureAgentTool({
    // TRUSTED: host-minted id + ack.
    contentTrust: 'trusted',
    def: {
      name: WORKFLOW_AUTHOR_PERSIST_TOOL_ID,
      description:
        'Validate AND register a candidate WorkflowDefinition through the shared validator + registry, so it becomes '
        + 'runnable and can be opened on the builder canvas. Pass the full definition as `definition`. Returns '
        + '{ workflowId, nodeCount, url }. On a validation error the call fails with the closed-world defects — fix '
        + 'them and call again. NEVER persist a definition you have not validated. The graph MUST be acyclic; a cycle '
        + 'is refused here as well as by `validate`. After persisting, summarize the workflow for the user and give '
        + 'them its name and the returned `url` — it is READY TO OPEN, not already open, and nothing navigates on '
        + 'your behalf (ADR 0596). '
        // ADR 0595 §Correction 1 — the guard's EXIT, named where the caller can
        // reach it. Without this the preserve merge would be undeletable-by-
        // construction for a field this tool's definition shape cannot express.
        + 'Your definition shape cannot express some fields an existing workflow may carry (node `inputs`, node '
        + '`compensation`, `variables`, `configurableSchema`, `settings`), so omitting them is treated as "I could '
        + 'not express this", NOT "delete it", and the host keeps the existing values. When the user asks you to '
        + 'genuinely REMOVE one, list it in `clearFields` — that is the only way to delete it.',
      inputSchema: {
        type: 'object',
        properties: {
          definition: { type: 'object', description: 'The validated WorkflowDefinition to register.' },
          clearFields: {
            type: 'array',
            // The enum is the SSoT array, never a hand-copy — a model told about
            // a field the guard does not protect (or not told about one it does)
            // is being lied to, and the copy is where that starts.
            items: { type: 'string', enum: [...PRESERVABLE_FIELDS] },
            description:
              'Fields the user asked you to DELETE from the existing workflow. Omitting a field means "my definition '
              + 'cannot express it" and the host preserves it; listing it here means "delete it" and the host honours '
              + 'the omission. Leave empty unless a removal was explicitly requested.',
          },
        },
        required: ['definition'],
      },
    },
    async run(input, scope: BundleScope) {
      if (!scope.actingUserId) {
        return toolError('acting_user_required', 'A workflow can only be registered from a human-initiated turn.');
      }
      const definition = input.definition;
      if (!definition || typeof definition !== 'object') {
        return toolError('validation_error', 'Pass the WorkflowDefinition to register as `definition` (an object).');
      }
      // ADR 0595 §Correction 1 — the declaration, parsed by the SAME parser the
      // `x-openwop-field-contract` header uses (unknown tokens dropped, so a
      // model naming a field the host does not protect cannot silently disable
      // a protection it was never granted).
      const declaredFields = parseFieldContract(input.clearFields);
      try {
        const out = await persistAuthoredWorkflow(definition, {
          tenantId: scope.tenantId,
          ...(declaredFields ? { declaredFields } : {}),
        });
        return {
          content: JSON.stringify({
            workflowId: out.workflowId,
            nodeCount: out.nodeCount,
            url: `/builder/${encodeURIComponent(out.workflowId)}`,
            // ADR 0595 / ADR 0524 §5 — NOT SILENT. Your definition could not
            // express these fields; the host kept the ones the existing
            // workflow already had rather than deleting them. Say so.
            ...(out.preservedFields
              ? {
                preservedFields: out.preservedFields,
                preservedNote:
                    'Your definition omitted these fields entirely, so the host KEPT the values the existing '
                    + 'workflow already had rather than deleting them. Tell the user which ones were preserved. If '
                    + 'the user actually wants one REMOVED, call this tool again with that field named in '
                    + '`clearFields` — omitting it again will not delete it.',
              }
              : {}),
            // ADR 0596 (`WFAU-1`) — this used to say "it is open in the builder",
            // and nothing anywhere opened it: the panel had no navigation and the
            // authored id cannot even reach the browser through the chat
            // (`agent.toolReturned` carries no result payload). Telling the model
            // to assert a hand-off the product does not perform is the
            // "a model is being lied to" class, relayed straight to the user.
            note: 'Workflow registered. Tell the user its name and give them this `url` — it is READY TO OPEN on the builder canvas. Do NOT say it is already open; nothing navigates for them.',
          }),
        };
      } catch (err) {
        if (err instanceof OpenwopError) return toolError(err.code, err.message, err.details ?? undefined);
        return toolFailLog(wfaLog, 'openwop:workflow-author', err); // CFPT-6
      }
    },
  });
}
