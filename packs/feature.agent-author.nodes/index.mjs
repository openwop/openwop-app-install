/**
 * feature.agent-author.nodes — the Agent Author building blocks (ADR 0514),
 * over the `ctx.features['agent-author']` surface. Every node is role:"action"
 * (reads the roster/registry, calls the LLM, or writes the roster), so the
 * engine records the output and replay/fork read the recorded result rather
 * than re-issuing. Pure-JS, Node-20 stdlib only.
 *
 * Pipeline: get (closed world) → draft (LLM authors a roster-entry draft,
 * bounded error-fed repair) → validate → persist (SHARED wizard path; the
 * created agent lands DISABLED for human review).
 */

/** Pack-local mirror of the providers.json SSoT default (see the workflow-
 *  author pack's DEBT-3 note — the /refresh-model-catalog sweep updates it). */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

function ensureAgentAuthor(ctx) {
  const aa = ctx.features && ctx.features['agent-author'];
  if (!aa || typeof aa.getCatalog !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['agent-author'] — the Agent Author feature must be composed and enabled (ADR 0514)"),
      { code: 'host_capability_missing', capability: 'host.sample.agent-author' },
    );
  }
  return aa;
}

function ensureAi(ctx) {
  if (typeof ctx.callAI !== 'function') {
    throw Object.assign(new Error('draft requires ctx.callAI (aiProviders)'), {
      code: 'host_capability_missing', capability: 'aiProviders',
    });
  }
}

/** The draft object's schema — also the pack's schemas/draft.io.schema.json. */
const DRAFT_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['persona', 'agentId'],
  additionalProperties: false,
  properties: {
    persona: { type: 'string', description: 'display name; MUST NOT collide with an existing roster persona' },
    agentId: { type: 'string', description: 'MUST be one of the catalog `agents` agentIds (closed-world)' },
    label: { type: 'string' },
    description: { type: 'string' },
    roleKey: { type: 'string' },
    autonomyLevel: { type: 'string', enum: ['auto', 'guided', 'review'] },
    workflows: { type: 'array', items: { type: 'string' } },
  },
};

function tryParseJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; } }
    return null;
  }
}

function buildSystemPrompt(catalog) {
  return [
    'You are the OpenWOP Agent Author. You author a roster-agent draft (a JSON object) for the user\'s intent.',
    '',
    'HARD RULES — a violation makes your output rejected:',
    '1. CLOSED-WORLD: `agentId` MUST be one of the catalog agentIds below. NEVER invent one.',
    '2. Every id in `workflows` MUST come from the catalog workflows list.',
    '3. `persona` MUST be distinct from every existing roster persona below.',
    '4. `autonomyLevel`, when set, is one of auto | guided | review. Prefer "review" unless the intent asks for autonomy.',
    '',
    'Return ONLY the JSON object. No prose, no code fences.',
    '',
    `AGENTS (the only legal agentId values): ${JSON.stringify(catalog.agents ?? [])}`,
    `WORKFLOWS (the only legal portfolio ids): ${JSON.stringify(catalog.workflows ?? [])}`,
    `EXISTING ROSTER PERSONAS (must not collide): ${JSON.stringify((catalog.roster ?? []).map((r) => r.persona))}`,
  ].join('\n');
}

/** get — the closed world + read-before-write roster. Read-only. */
export async function get(ctx) {
  const aa = ensureAgentAuthor(ctx);
  const catalog = await aa.getCatalog();
  return { status: 'success', outputs: catalog };
}

/** draft — LLM authors a candidate roster draft; bounded error-fed repair. */
export async function draft(ctx) {
  const aa = ensureAgentAuthor(ctx);
  ensureAi(ctx);
  const i = ctx.inputs ?? {};
  const intent = str(i.intent);
  if (!intent) {
    return { status: 'failed', error: { code: 'intent_required', message: 'A non-empty `intent` input is required.' } };
  }
  const provider = str(i.provider) || 'anthropic';
  const model = str(i.model) || DEFAULT_MODEL;
  const maxAttempts = typeof i.maxAttempts === 'number' && i.maxAttempts > 0 ? Math.min(Math.floor(i.maxAttempts), 5) : 2;

  const catalog = await aa.getCatalog();
  const systemPrompt = buildSystemPrompt(catalog);

  let lastDraft = null;
  let lastValidation = { ok: false, errors: ['no attempt made'] };
  let attempts = 0;
  let userMessage = `Agent intent:\n${intent}\n\nReturn ONLY the JSON draft object.`;

  while (attempts < maxAttempts) {
    attempts++;
    const ai = await ctx.callAI({
      provider,
      model,
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      responseSchema: DRAFT_RESPONSE_SCHEMA,
    });
    const candidate = (ai && ai.data && typeof ai.data === 'object') ? ai.data : tryParseJson(ai && ai.content);
    lastDraft = candidate ?? {};
    const v = await aa.validateDraft({ draft: lastDraft });
    lastValidation = v;
    if (v.ok) break;
    userMessage =
      `Your previous draft was INVALID:\n${(v.errors || []).map((e) => `- ${e}`).join('\n')}\n\n` +
      `Fix ALL of the above and return ONLY the corrected JSON draft for the intent:\n${intent}`;
  }

  if (!lastValidation.ok) {
    // Typed failure, never success-with-empty (the doctrine): the run fails
    // with the validator's actionable messages after the bounded repair.
    return {
      status: 'failed',
      error: { code: 'validation_error', message: `Agent draft failed validation after ${attempts} attempt(s): ${(lastValidation.errors || []).join(' ')}` },
    };
  }
  return { status: 'success', outputs: { draft: lastDraft, attempts, model } };
}

/** validate — closed-world re-check of a candidate draft. Read-only. */
export async function validate(ctx) {
  const aa = ensureAgentAuthor(ctx);
  const v = await aa.validateDraft({ draft: (ctx.inputs ?? {}).draft });
  if (!v.ok) {
    return { status: 'failed', error: { code: 'validation_error', message: (v.errors || []).join(' ') } };
  }
  return { status: 'success', outputs: { ok: true } };
}

/** persist — create through the SHARED wizard path; lands DISABLED.
 *  mode:"draft" (OQ1) stashes the VALIDATED draft for the wizard prefill
 *  instead — nothing is created. */
export async function persist(ctx) {
  const aa = ensureAgentAuthor(ctx);
  const i = ctx.inputs ?? {};
  if (i.mode === 'draft') {
    if (typeof aa.stashDraft !== 'function') {
      return { status: 'failed', error: { code: 'host_capability_missing', message: "This host's agent-author surface predates draft mode (needs stashDraft) — persist with mode:'create' or upgrade the host." } };
    }
    try {
      const out = await aa.stashDraft({ draft: i.draft });
      return { status: 'success', outputs: { ...out, wizardPath: '/agents/new' } };
    } catch (e) {
      return { status: 'failed', error: { code: 'validation_error', message: e instanceof Error ? e.message : String(e) } };
    }
  }
  const out = await aa.persistDraft({ draft: i.draft });
  return { status: 'success', outputs: { ...out, enabled: false } };
}

export const nodes = {
  'feature.agent-author.nodes.get': get,
  'feature.agent-author.nodes.draft': draft,
  'feature.agent-author.nodes.validate': validate,
  'feature.agent-author.nodes.persist': persist,
};

export default nodes;
