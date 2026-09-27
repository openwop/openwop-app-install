/**
 * feature.workflow-author.nodes — the AI workflow-author meta-workflow building
 * blocks (ADR 0072), over the `ctx.features['workflow-author']` surface.
 *
 * CORRECTED (ADR 0673 D1) — this header used to say every node is role:"action"
 * "so the engine records the output and replay/fork read the recorded result rather
 * than re-issuing". BOTH halves were false: the executor reads `role` ZERO times
 * (`grep "role === 'action'" src/executor/`), and the derived floor binds
 * role:"side-effect" only — so all four sat in MANIFEST_DECLARED_TYPE_IDS alone,
 * `isSideEffectingNode` returned false for every one, and a diverged replay fork
 * re-executed `persist` and durably authored a SECOND workflow.
 *
 * All four are now role:"side-effect". They do NOT land in the same place, and the
 * asymmetry is deliberate: `validate`/`get`/`persist` are fast-path SERVED, while
 * `draft` is held back as an `ai-invocation-log` because it calls `ctx.callAI` —
 * fast-pathing a model call would retire RFC 0041 §B divergence injection. So a
 * replay fork re-drafts (normally served from the source run's invocation record)
 * and never re-persists. Pure-JS, Node-20 stdlib only.
 *
 * Pipeline: draft (LLM authors a graph) → validate (closed-world re-check, fails
 * the run when invalid) → persist (register through the shared validator).
 */

/** DEBT-3 — pack-local mirror of the providers.json SSoT default (the
 *  anthropic `recommended: true` model; src/providers/catalog.ts
 *  getDefaultModel). ctx.callAI REQUIRES an explicit model and standalone
 *  .mjs packs cannot import the catalog, so the default lives in this ONE
 *  greppable constant — the /refresh-model-catalog sweep updates it. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Resolve the workflow-author feature surface, or fail with the canonical
 *  capability error (the surface is gated by the `workflow-author` toggle). */
function ensureWorkflowAuthor(ctx) {
  const wa = ctx.features && ctx.features['workflow-author'];
  if (!wa || typeof wa.getCatalog !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['workflow-author'] — the AI Workflow Author feature must be composed and enabled (ADR 0072)"),
      { code: 'host_capability_missing', capability: 'host.sample.workflow-author' },
    );
  }
  return wa;
}

function ensureAi(ctx) {
  if (typeof ctx.callAI !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.callAI — workflow authoring requires aiProviders'),
      { code: 'host_capability_missing', capability: 'host.aiProviders' },
    );
  }
}

const str = (v) => (typeof v === 'string' ? v : '');

/**
 * The structured-output schema the LLM must return — a WorkflowDefinition.
 *
 * ADR 0673 D3 (`WFAWF-15`) — **hand-written on purpose, and pinned behaviourally.**
 * Two generation sources were proposed and BOTH are wrong:
 *   - "the SSoT the validator reads" — `host/workflowDefinitionValidation.ts` is imperative
 *     code that reads no schema at runtime; there is nothing to generate from.
 *   - `schemas/workflow-definition.schema.json` — the vendored WIRE schema, which is a
 *     DIFFERENT shape: it requires `id` (not `workflowId`) plus `name`, `version`,
 *     `triggers`, `variables`, `metadata` and `settings`. A definition generated from it
 *     would be REJECTED by the host validator at `workflowDefinitionValidation.ts:401`.
 * So the drift guard is a behavioural round-trip instead — a definition satisfying this
 * schema must PASS `validateWorkflowDefinition` — which is stronger than schema-vs-schema
 * because it pins the thing that actually gates the write. See
 * `test/workflow-author-response-schema.test.ts`.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['workflowId', 'nodes'],
  properties: {
    workflowId: { type: 'string', description: 'kebab/dotted id, matches [a-zA-Z0-9_.-:]{1,128}' },
    nodes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['nodeId', 'typeId'],
        properties: {
          nodeId: { type: 'string', description: 'unique within workflow, [a-zA-Z0-9_-]{1,64}' },
          typeId: { type: 'string', description: 'MUST be one of the catalog typeIds (closed-world)' },
          config: { type: 'object', description: 'config conforming to the node configSchema' },
          outputRole: { type: 'string', enum: ['primary', 'secondary'] },
        },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        // ADR 0673 D3 — `id` is the CANONICAL edge field (`workflowDefinitionValidation.ts:526`
        // — "`id` WINS when both are present"); `edgeId` is only a legacy host alias kept so
        // existing callers keep working. Teaching the model the alias taught it the wrong
        // field name for every workflow it has ever authored.
        required: ['id', 'sourceNodeId', 'targetNodeId'],
        properties: {
          id: { type: 'string', description: 'unique within workflow, [a-zA-Z0-9_-]{1,64}' },
          sourceNodeId: { type: 'string' },
          targetNodeId: { type: 'string' },
          sourceOutput: { type: 'string' },
          targetInput: { type: 'string' },
          triggerRule: { type: 'string', enum: ['all_success', 'any_success', 'all_complete', 'none_failed', 'any_failed'] },
          label: { type: 'string' },
        },
      },
    },
  },
};

function buildSystemPrompt(catalog) {
  const menu = (catalog.nodes ?? []).map((n) => ({
    typeId: n.typeId,
    label: n.label,
    description: n.description,
    category: n.category,
    ...(n.configSchema ? { configSchema: n.configSchema } : {}),
    ...(n.inputSchema ? { inputSchema: n.inputSchema } : {}),
    ...(n.outputSchema ? { outputSchema: n.outputSchema } : {}),
  }));
  return [
    'You are the OpenWOP Workflow Architect. You author a WorkflowDefinition (a directed acyclic graph of nodes + edges) that accomplishes the user\'s automation intent.',
    '',
    'HARD RULES — a violation makes your output rejected:',
    '1. CLOSED-WORLD: every node.typeId MUST be one of the catalog typeIds below. NEVER invent a typeId.',
    '2. Each node.config MUST conform to that node\'s configSchema (when one is given).',
    '3. nodeId values are unique within the workflow and match [a-zA-Z0-9_-]{1,64}.',
    '4. workflowId matches [a-zA-Z0-9_.-:]{1,128}.',
    // ADR 0596 (`WFAWF-9`) — this line used to assert BOTH rules as MUSTs while
    // the host enforced NEITHER. Acyclicity is now checked at validate + persist
    // (the executor's own `topologicalOrder`, so the gate agrees with the
    // runtime by construction). Connectivity is NOT enforced and is not a
    // correctness rule — two disconnected components both run fine — so it is
    // stated as the preference it actually is. Telling a model a rule is a MUST
    // when nothing checks it is the same lie as checking a rule you never stated.
    '5. Every edge.sourceNodeId / targetNodeId MUST reference a declared nodeId. The graph MUST be ACYCLIC — a cycle is REJECTED (the only exception is an RFC 0022 dispatch-supervisor back-edge). Prefer a single connected graph; disconnected islands are allowed but rarely what the user meant.',
    '6. Use a single linear chain unless the intent genuinely needs fan-out/fan-in; on a fan-in node set an appropriate triggerRule.',
    '7. Mark the node that produces the final deliverable with outputRole:"primary".',
    '',
    'Return ONLY the JSON WorkflowDefinition. No prose, no code fences.',
    '',
    'NODE CATALOG (the only legal building blocks):',
    JSON.stringify(menu),
  ].join('\n');
}

function tryParseJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  // strip ```json ... ``` fences if present
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // last resort: slice from first { to last }
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
    }
    return null;
  }
}

function sanitizeId(id) {
  const cleaned = String(id).replace(/[^a-zA-Z0-9_.\-:]/g, '-').slice(0, 128);
  return cleaned || null;
}

/**
 * Derive the candidate definition from the LLM result. Returns `null` when the
 * model produced nothing that is even an object — the caller feeds that back as
 * a repair error and, if the attempts run out, FAILS.
 *
 * ADR 0596 (`WFAC-2` / `WFAWF-10` / `WFAU-4`) — this function used to coerce an
 * unparseable response to `{}` and then MINT `authored.<slug-of-intent>-<runId>`
 * onto it, so a model that answered "sorry, I can't" produced a plausible-looking
 * workflow object carrying a durable id. Two defects in one line:
 *   1. FABRICATION. A placeholder standing in for invalid model output is the
 *      exact shape CLAUDE.md's exchange contract forbids. The id the model did
 *      not supply is now a VALIDATION ERROR the repair loop feeds back (the
 *      structured-output schema already declares `workflowId` required), not
 *      something the host invents on the model's behalf.
 *   2. RUN-IDENTITY (`WFAWF-10b`). The minted id was derived from `ctx.runId`,
 *      so a `:fork` — a fresh runId, not a resume — re-executing `draft` would
 *      mint a DIFFERENT durable workflowId for the same authoring intent.
 * Sanitising an id the model DID supply is kept: that is normalisation of a real
 * value, not invention of an absent one.
 */
function parseDefinition(ai) {
  let obj = ai && ai.data && typeof ai.data === 'object' && !Array.isArray(ai.data) ? ai.data : null;
  if (!obj) obj = tryParseJson(ai && ai.content);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.workflowId === 'string') {
    const id = sanitizeId(obj.workflowId);
    if (id) obj.workflowId = id;
    else delete obj.workflowId; // unusable → let the validator say so
  }
  return obj;
}

/** The repair feedback for a response that was not JSON at all. */
const UNPARSEABLE_ERROR =
  'Your response was not parseable as a JSON object. Return ONLY the JSON WorkflowDefinition — no prose, no apology, no code fences.';

export async function draft(ctx) {
  const wa = ensureWorkflowAuthor(ctx);
  ensureAi(ctx);
  const i = ctx.inputs ?? {};
  const intent = str(i.intent);
  if (!intent) {
    return { status: 'failed', error: { code: 'intent_required', message: 'A non-empty `intent` input is required.' } };
  }
  const provider = str(i.provider) || 'anthropic';
  const model = str(i.model) || DEFAULT_MODEL;
  const maxAttempts = typeof i.maxAttempts === 'number' && i.maxAttempts > 0 ? Math.min(Math.floor(i.maxAttempts), 5) : 3;

  const catalog = await wa.getCatalog();
  const systemPrompt = buildSystemPrompt(catalog);

  let lastDef = null;
  let lastValidation = { ok: false, errors: ['no attempt made'] };
  let attempts = 0;
  let userMessage = `Automation intent:\n${intent}\n\nReturn ONLY the JSON WorkflowDefinition.`;

  while (attempts < maxAttempts) {
    attempts++;
    const ai = await ctx.callAI({
      provider,
      model,
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      responseSchema: RESPONSE_SCHEMA,
    });
    const candidate = parseDefinition(ai);
    lastDef = candidate;
    if (!candidate) {
      lastValidation = { ok: false, errors: [UNPARSEABLE_ERROR] };
    } else {
      lastValidation = await wa.validateDraft({ definition: candidate });
      if (lastValidation.ok) break;
    }
    userMessage =
      `Your previous WorkflowDefinition was INVALID:\n${(lastValidation.errors || []).map((e) => `- ${e}`).join('\n')}\n\n` +
      `Fix ALL of the above and return ONLY the corrected JSON WorkflowDefinition for the intent:\n${intent}`;
  }

  // ADR 0596 (`WFAC-2` = `WFAWF-10` = `WFAU-4`) — the ONE bounded error-fed
  // repair loop has run out. This used to return `status:'success'` carrying a
  // definition the node had just been told was invalid, and relied on the NEXT
  // node (`validate`) re-checking to fail the run. Two things were wrong with
  // that: the node's own contract lied (its `status` is what a chat tool, an
  // `:fork`, a sub-chain caller or any future edge reads), and the chain's
  // `draft → validate` edge is `all_success`, so the honesty depended on a
  // wiring decision made in a DIFFERENT file. A typed failure here is the
  // contract; the downstream re-check stays as defence in depth.
  if (!lastValidation.ok) {
    const errors = (lastValidation.errors || []).filter((e) => typeof e === 'string');
    return {
      status: 'failed',
      error: {
        code: 'workflow_author_unrepaired',
        message:
          `The model could not produce a valid WorkflowDefinition for this intent in ${attempts} attempt(s). `
          + `Last validation errors: ${errors.length > 0 ? errors.join('; ') : 'unknown'}`,
      },
    };
  }

  // Stamp authoring provenance onto the candidate so the persisted workflow
  // records that it was AI-authored, from what intent, by which model, and how
  // many attempts it took (no separate store — ADR 0072 §provenance).
  lastDef.metadata = {
    ...(lastDef.metadata && typeof lastDef.metadata === 'object' ? lastDef.metadata : {}),
    authoring: { authoredVia: 'workflow-author', intent, model, attempts },
  };

  return { status: 'success', outputs: { definition: lastDef, validation: lastValidation, attempts } };
}

export async function validate(ctx) {
  const wa = ensureWorkflowAuthor(ctx);
  const def = (ctx.inputs ?? {}).definition;
  const v = await wa.validateDraft({ definition: def });
  if (!v.ok) {
    return { status: 'failed', error: { code: 'workflow_invalid', message: (v.errors || []).join('; ') || 'invalid workflow' } };
  }
  return { status: 'success', outputs: { definition: def } };
}

export async function persist(ctx) {
  const wa = ensureWorkflowAuthor(ctx);
  const def = (ctx.inputs ?? {}).definition;
  try {
    const out = await wa.persistDraft({ definition: def });
    return {
      status: 'success',
      outputs: {
        workflowId: out.workflowId,
        nodeCount: out.nodeCount,
        definition: def,
        // ADR 0524 §5 / ADR 0595 §Correction 3 — NOT SILENT. The host restores
        // fields this pack's RESPONSE_SCHEMA cannot express (node `inputs`,
        // node `compensation`, `variables`, `configurableSchema`, `settings`)
        // when a save omits them wholesale. A merge nobody can see is a silent
        // success wearing the costume of a fix, so the disclosure has to reach
        // a surface a person reads — and this node is the seam it died at:
        // the service and the surface both returned it, this output object did
        // not, and `persist.output.schema.json` is `additionalProperties:false`,
        // so it had to be DECLARED there too, not just emitted here.
        ...(out.preservedFields && out.preservedFields.length > 0
          ? { preservedFields: out.preservedFields }
          : {}),
      },
    };
  } catch (err) {
    return { status: 'failed', error: { code: err && err.code ? err.code : 'persist_failed', message: err && err.message ? err.message : String(err) } };
  }
}

/** XCH-WFA-1 (LLM-EXCHANGE-AUDIT Wave 4) — read an EXISTING registered
 *  workflow (or list the index) so a revision grounds on the real definition
 *  instead of blind re-authoring. Read-only. */
export async function get(ctx) {
  const wa = ensureWorkflowAuthor(ctx);
  const workflowId = typeof (ctx.inputs ?? {}).workflowId === 'string' ? ctx.inputs.workflowId : '';
  if (!workflowId) {
    if (typeof wa.listWorkflows !== 'function') {
      return { status: 'failed', error: { code: 'host_capability_missing', message: 'this host does not expose workflow reads' } };
    }
    const out = await wa.listWorkflows({});
    return { status: 'success', outputs: { workflows: out.workflows } };
  }
  if (typeof wa.getWorkflow !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'this host does not expose workflow reads' } };
  }
  const out = await wa.getWorkflow({ workflowId });
  if (!out.found) {
    return { status: 'failed', error: { code: 'not_found', message: `no registered workflow '${workflowId}'` } };
  }
  return { status: 'success', outputs: { definition: out.definition } };
}

export const nodes = {
  'feature.workflow-author.nodes.draft': draft,
  'feature.workflow-author.nodes.validate': validate,
  'feature.workflow-author.nodes.persist': persist,
  'feature.workflow-author.nodes.get': get,
};

export default nodes;
