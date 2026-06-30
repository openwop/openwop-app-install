/**
 * Research Notebooks — the `notebooks.summarize` built-in workflow (ADR 0084
 * Transformations T1). A 3-node graph that produces a source's LLM summary as the
 * LIVE output of a real run (the insights-suite metaWorkflows precedent — no fake
 * summary, no synchronous route-side LLM call):
 *
 *   read (feature.notebooks.nodes.read-source)   reads the source's full text →
 *        │  messages                              a chatCompletion `messages` payload
 *        ▼
 *   generate (core.ai.chatCompletion)            BYOK LLM summarizes the source
 *        │  content                               (provider/model/systemPrompt in config)
 *        ▼
 *   store (feature.notebooks.nodes.store-summary) persists the summary via the one
 *                                                 justified surface write (un-gates the
 *                                                 `summary` context level)
 *
 * Wiring uses the executor's port model: the `read.messages` output feeds the
 * chatCompletion `messages` input; the `generate.content` output feeds the
 * store-summary `summary` input. notebookId/sourceId are workflow VARIABLES seeded
 * from the run inputs and threaded into the two notebook nodes via `{type:'variable'}`
 * input declarations (the anniversary-draft `workdayResource` precedent).
 *
 * Replay-safe: the LLM call is a `side-effectful` node cached in the host's Layer-2
 * invocation log; the two notebook nodes are recorded action reads/writes. A fork
 * replays the cached summary rather than re-calling the provider. The chatCompletion
 * node fails closed at execute without BYOK (exactly like the insights workflows),
 * so the definition loads + validates without credentials.
 *
 * @see docs/adr/0084-research-notebooks.md (Transformations T1)
 * @see src/features/insights-suite/metaWorkflows.ts — the built-in-workflow precedent
 */

import type { WorkflowDefinition } from '../../executor/types.js';
import { transformWorkflowDefinition } from './transformWorkflow.js';
import { ingestAudioWorkflowDefinition, ingestYoutubeWorkflowDefinition } from './transcribeWorkflow.js';

export const NOTEBOOKS_SUMMARIZE_ID = 'notebooks.summarize';

const READ_SOURCE = 'feature.notebooks.nodes.read-source';
const CHAT_COMPLETION = 'core.ai.chatCompletion';
const STORE_SUMMARY = 'feature.notebooks.nodes.store-summary';

/** Managed default mirrors the insights-suite metaWorkflows (anthropic / sonnet) —
 *  what the provider-policy resolver allows for a built-in chat-completion node. */
const SUMMARIZE_SYSTEM_PROMPT =
  'Summarize the following source for a research notebook in 3-5 sentences; plain text; no preamble.';

export const summarizeWorkflowDefinition: WorkflowDefinition = {
  workflowId: NOTEBOOKS_SUMMARIZE_ID,
  nodes: [
    {
      nodeId: 'read',
      typeId: READ_SOURCE,
      inputs: {
        notebookId: { type: 'variable', variableName: 'notebookId' },
        sourceId: { type: 'variable', variableName: 'sourceId' },
      },
    },
    {
      nodeId: 'generate',
      typeId: CHAT_COMPLETION,
      config: { provider: 'anthropic', model: 'claude-sonnet-4-6', systemPrompt: SUMMARIZE_SYSTEM_PROMPT },
      outputRole: 'secondary',
    },
    {
      nodeId: 'store',
      typeId: STORE_SUMMARY,
      inputs: {
        notebookId: { type: 'variable', variableName: 'notebookId' },
        sourceId: { type: 'variable', variableName: 'sourceId' },
      },
      outputRole: 'primary',
    },
  ],
  edges: [
    // read.messages → generate.messages (the chatCompletion node reads ctx.inputs.messages)
    { edgeId: 'e_read_generate', sourceNodeId: 'read', sourceOutput: 'messages', targetNodeId: 'generate', targetInput: 'messages', triggerRule: 'all_success' },
    // generate.content → store.summary (the LLM text becomes the stored summary)
    { edgeId: 'e_generate_store', sourceNodeId: 'generate', sourceOutput: 'content', targetNodeId: 'store', targetInput: 'summary', triggerRule: 'all_success' },
  ],
  variables: [
    { name: 'notebookId', type: 'string', description: 'The notebook whose source is summarized.', required: true },
    { name: 'sourceId', type: 'string', description: 'The source document to summarize.', required: true },
  ],
  metadata: { kind: 'meta-workflow', feature: 'notebooks' },
};

// ADR 0084 Transformations T1 (summarize) + T2 (apply-transformation) + ADR 0085
// source-ingest (ingest-audio / ingest-youtube). All are `read/derive → write`
// built-in workflows resolved in catalog source A.
export const notebooksBuiltinWorkflows: readonly WorkflowDefinition[] = [
  summarizeWorkflowDefinition,
  transformWorkflowDefinition,
  ingestAudioWorkflowDefinition,
  ingestYoutubeWorkflowDefinition,
];
