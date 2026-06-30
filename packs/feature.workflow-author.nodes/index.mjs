/**
 * feature.workflow-author.nodes — the AI workflow-author meta-workflow building
 * blocks (ADR 0072), over the `ctx.features['workflow-author']` surface. Every
 * node is role:"action" (it reads the catalog / calls the LLM / writes the
 * registry, all side-effects), so the engine records the output and replay/fork
 * read the recorded result rather than re-issuing. Pure-JS, Node-20 stdlib only.
 *
 * Pipeline: draft (LLM authors a graph) → validate (closed-world re-check, fails
 * the run when invalid) → persist (register through the shared validator).
 */

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

/** The structured-output schema the LLM must return — a WorkflowDefinition. */
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
        required: ['edgeId', 'sourceNodeId', 'targetNodeId'],
        properties: {
          edgeId: { type: 'string' },
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
    '5. Every edge.sourceNodeId / targetNodeId MUST reference a declared nodeId. The graph MUST be connected and ACYCLIC (no loops).',
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

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workflow';
}

function sanitizeId(id) {
  const cleaned = String(id).replace(/[^a-zA-Z0-9_.\-:]/g, '-').slice(0, 128);
  return cleaned || null;
}

/** Derive the candidate definition from the LLM result, ensuring a valid id. */
function parseDefinition(ai, intent, ctx) {
  let obj = ai && ai.data && typeof ai.data === 'object' ? ai.data : null;
  if (!obj) obj = tryParseJson(ai && ai.content);
  if (!obj || typeof obj !== 'object') obj = {};
  const id = typeof obj.workflowId === 'string' ? sanitizeId(obj.workflowId) : null;
  if (!id) {
    const suffix = str(ctx.runId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'gen';
    obj.workflowId = `authored.${slugify(intent)}-${suffix}`;
  } else {
    obj.workflowId = id;
  }
  return obj;
}

export async function draft(ctx) {
  const wa = ensureWorkflowAuthor(ctx);
  ensureAi(ctx);
  const i = ctx.inputs ?? {};
  const intent = str(i.intent);
  if (!intent) {
    return { status: 'failed', error: { code: 'intent_required', message: 'A non-empty `intent` input is required.' } };
  }
  const provider = str(i.provider) || 'anthropic';
  const model = str(i.model) || 'claude-sonnet-4-6';
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
    const candidate = parseDefinition(ai, intent, ctx);
    lastDef = candidate;
    const v = await wa.validateDraft({ definition: candidate });
    lastValidation = v;
    if (v.ok) break;
    userMessage =
      `Your previous WorkflowDefinition was INVALID:\n${(v.errors || []).map((e) => `- ${e}`).join('\n')}\n\n` +
      `Fix ALL of the above and return ONLY the corrected JSON WorkflowDefinition for the intent:\n${intent}`;
  }

  // Stamp authoring provenance onto the candidate so the persisted workflow
  // records that it was AI-authored, from what intent, by which model, and how
  // many attempts it took (no separate store — ADR 0072 §provenance).
  if (lastDef && typeof lastDef === 'object') {
    lastDef.metadata = {
      ...(lastDef.metadata && typeof lastDef.metadata === 'object' ? lastDef.metadata : {}),
      authoring: { authoredVia: 'workflow-author', intent, model, attempts },
    };
  }

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
    return { status: 'success', outputs: { workflowId: out.workflowId, nodeCount: out.nodeCount, definition: def } };
  } catch (err) {
    return { status: 'failed', error: { code: err && err.code ? err.code : 'persist_failed', message: err && err.message ? err.message : String(err) } };
  }
}

export const nodes = {
  'feature.workflow-author.nodes.draft': draft,
  'feature.workflow-author.nodes.validate': validate,
  'feature.workflow-author.nodes.persist': persist,
};

export default nodes;
