/**
 * Research Notebooks — the `notebooks.transform` built-in workflow (ADR 0084
 * Transformations T2). Applies a reusable transformation TEMPLATE (Summary / Key
 * Concepts / Methodology / Takeaways / Open Questions) to a source: an LLM run
 * writes the result as a **Document** owned by the notebook subject. A 2-node graph
 * (mirrors summarizeWorkflow.ts; the read step is done route-side here — the route
 * supplies the full `messages` array as a run input):
 *
 *   generate (core.ai.chatCompletion)              BYOK LLM applies the template's
 *        │  content                                 systemPrompt to the source text
 *        │                                          (messages come from the run input
 *        ▼                                           variable `messages`)
 *   write (feature.notebooks.nodes.write-transformation)  persists the result as a
 *                                                   Document owned by project:<notebook>
 *                                                   (the strategy create-board-memo
 *                                                   precedent — write to Documents, the
 *                                                   single owner of stored artifacts).
 *
 * Wiring uses the executor's port model: the `messages` workflow VARIABLE feeds the
 * chatCompletion `messages` input (the route puts the template's systemPrompt in
 * `messages[0]` + the source text in `messages[1]`); the `generate.content` output
 * feeds the write node's `content` input. orgId/title/kind/ownerSubject are workflow
 * VARIABLES seeded from the run inputs and threaded into the write node via
 * `{type:'variable'}` declarations (the summarize-workflow precedent).
 *
 * Replay-safe: the LLM call is a `side-effectful` node cached in the host's Layer-2
 * invocation log; the write node is a recorded action write idempotency-keyed off
 * the run. A fork replays the cached content rather than re-calling the provider. The
 * chatCompletion node fails closed at execute without BYOK (exactly like the
 * summarize workflow), so the definition loads + validates without credentials.
 *
 * @see docs/adr/0084-research-notebooks.md (Transformations T2)
 * @see src/features/notebooks/summarizeWorkflow.ts — the T1 built-in-workflow precedent
 */

import type { WorkflowDefinition } from '../../executor/types.js';

export const NOTEBOOKS_TRANSFORM_ID = 'notebooks.transform';

const READ_SOURCE = 'feature.notebooks.nodes.read-source';
const CHAT_COMPLETION = 'core.ai.chatCompletion';
const WRITE_TRANSFORMATION = 'feature.notebooks.nodes.write-transformation';

/** Managed default mirrors summarizeWorkflow (anthropic / sonnet) — what the
 *  provider-policy resolver allows for a built-in chat-completion node. The
 *  per-transformation systemPrompt is carried as a small `systemPrompt` VARIABLE
 *  (the route supplies it from the catalog); the read-source node fetches the FULL
 *  source text IN-RUN and prepends the system message, so the route never inlines
 *  the source text into run.inputs (consistent with the summarize workflow — keeps
 *  the run record small for large sources). NOT pinned in config here. */
export const transformWorkflowDefinition: WorkflowDefinition = {
  workflowId: NOTEBOOKS_TRANSFORM_ID,
  nodes: [
    {
      nodeId: 'read',
      typeId: READ_SOURCE,
      // Fetches the source's full text IN-RUN and prepends the template systemPrompt
      // → outputs `messages` = [{system}, {user}] for the chatCompletion node.
      inputs: {
        notebookId: { type: 'variable', variableName: 'notebookId' },
        sourceId: { type: 'variable', variableName: 'sourceId' },
        systemPrompt: { type: 'variable', variableName: 'systemPrompt' },
      },
    },
    {
      nodeId: 'generate',
      typeId: CHAT_COMPLETION,
      config: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      // The chatCompletion node reads ctx.inputs.messages; fed by the read.messages edge.
      outputRole: 'secondary',
    },
    {
      nodeId: 'write',
      typeId: WRITE_TRANSFORMATION,
      inputs: {
        orgId: { type: 'variable', variableName: 'orgId' },
        title: { type: 'variable', variableName: 'title' },
        kind: { type: 'variable', variableName: 'kind' },
        ownerSubject: { type: 'variable', variableName: 'ownerSubject' },
        sourceId: { type: 'variable', variableName: 'sourceId' },
      },
      outputRole: 'primary',
    },
  ],
  edges: [
    // read.messages → generate.messages (the [{system},{user}] assembled in-run)
    { edgeId: 'e_read_generate', sourceNodeId: 'read', sourceOutput: 'messages', targetNodeId: 'generate', targetInput: 'messages', triggerRule: 'all_success' },
    // generate.content → write.content (the LLM text becomes the Document body)
    { edgeId: 'e_generate_write', sourceNodeId: 'generate', sourceOutput: 'content', targetNodeId: 'write', targetInput: 'content', triggerRule: 'all_success' },
  ],
  variables: [
    { name: 'notebookId', type: 'string', description: 'The notebook whose source is transformed (read-source fetches its text in-run).', required: true },
    { name: 'sourceId', type: 'string', description: 'The source the transformation is applied to (read + idempotency key).', required: true },
    { name: 'systemPrompt', type: 'string', description: 'The transformation template’s system prompt (read-source prepends it).', required: true },
    { name: 'orgId', type: 'string', description: 'The org the output Document is created in.', required: true },
    { name: 'title', type: 'string', description: 'The output Document title.', required: true },
    { name: 'kind', type: 'string', description: 'The output Document kind (the transformation’s docKind).', required: true },
    { name: 'ownerSubject', type: 'object', description: 'The owning subject (project:<notebookId>) of the output Document.', required: true },
  ],
  metadata: { kind: 'meta-workflow', feature: 'notebooks' },
};
