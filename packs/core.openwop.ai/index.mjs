/**
 * core.openwop.ai — spec-canonical AI-call pack runtime.
 *
 * Three nodes route through the host's `ctx.callAI(...)` primitive.
 * The pack itself makes NO HTTP calls — the host's BYOK aiProviders
 * abstraction handles provider routing, secret resolution, retry
 * policy, rate-limit handling, and provider-specific quirks (system
 * prompt placement, stop-sequence limits, etc.).
 *
 * Pack peerDependencies: `aiProviders.supported`. Hosts that don't
 * advertise this MUST refuse to register the pack at workflow-
 * register time per spec/v1/node-packs.md §"peerDependencies."
 *
 * Replay model:
 *   All three nodes declare `side-effectful` capability — LLM calls
 *   cost money + are non-deterministic. Per spec/v1/replay.md
 *   §"Replay determinism," the host's Layer-2 invocation log caches
 *   the terminal node.completed payload keyed on (runId, nodeId,
 *   request-hash). Replays return the cached payload without
 *   re-calling the provider.
 *
 * Host contract (informative — these are the ctx properties this
 * pack reads; the openwop spec doesn't yet normatively declare
 * ctx.callAI, but hosts advertising `aiProviders.supported` MUST
 * expose an equivalent primitive):
 *
 *   ctx.callAI({
 *     provider: string,
 *     model: string,
 *     messages: Array<{ role, content }>,
 *     temperature?, maxTokens?, stopSequences?, systemPrompt?,
 *     // For structured-output:
 *     responseSchema?: object,  // JSON Schema
 *     // For embeddings:
 *     embeddingMode?: true,
 *     dimensions?: number,
 *   }) → Promise<{
 *     content?: string,
 *     data?: object,            // for structured-output
 *     embedding?: number[],     // for embeddings
 *     usage: { inputTokens, outputTokens, totalTokens? },
 *     finishReason?: string,
 *     model?: string,
 *   }>
 *
 * @see spec/v1/capabilities.md §aiProviders
 * @see spec/v1/replay.md §"Replay determinism"
 * @see docs/PACKS-MVP-PLAN.md
 */

function ensureCallAI(ctx) {
  if (typeof ctx.callAI !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.callAI — workflow-register should have refused this pack at peerDependency resolution time'),
      { code: 'host_capability_missing' }
    );
  }
}

/**
 * RFC 0020 §D + SECURITY/threat-model-prompt-injection.md §"Mitigations":
 * when a run is flagged `ctx.trustBoundary === 'untrusted'` (today: every
 * inbound MCP `tools/call` invocation via the host's MCP server mount),
 * user-role message content MUST be wrapped in `<UNTRUSTED>...</UNTRUSTED>`
 * markers before reaching the LLM. System-role content is workflow-author-
 * controlled and stays unmarked; assistant-role content is downstream of
 * the original user wrap and stays unmarked.
 *
 * Idempotent: messages whose `content` already contains an `<UNTRUSTED>`
 * substring (e.g., multi-turn re-feed) are NOT rewrapped.
 *
 * Returns the input array verbatim when ctx.trustBoundary is absent or
 * `'trusted'` — zero behavioral change for non-MCP-mount runs.
 */
/**
 * Coerce a node's inputs into a non-empty messages[] for callAI. A chatCompletion /
 * structured-output node fed STRUCTURED upstream data (e.g. `{triage:{...}}` from a
 * preceding node) — not a chat `messages` array — would otherwise pass
 * `messages: undefined` to the provider and crash with "messages is not iterable".
 * Precedence: an explicit `messages[]` → a recognized single-string port → the
 * structured inputs serialized as ONE user turn (so the model still acts on them per
 * the `systemPrompt`). Returns [] only when there is genuinely no input at all.
 */
function toMessages(inputs) {
  const src = inputs && typeof inputs === 'object' ? inputs : {};
  if (Array.isArray(src.messages) && src.messages.length > 0) return src.messages;
  for (const k of ['prompt', 'text', 'message', 'content', 'input']) {
    if (typeof src[k] === 'string' && src[k].length > 0) return [{ role: 'user', content: src[k] }];
  }
  for (const [k, v] of Object.entries(src)) {
    if (k !== 'messages' && typeof v === 'string' && v.length > 0) return [{ role: 'user', content: v }];
  }
  const structured = {};
  for (const [k, v] of Object.entries(src)) if (k !== 'messages' && v !== undefined) structured[k] = v;
  if (Object.keys(structured).length > 0) return [{ role: 'user', content: JSON.stringify(structured) }];
  return [];
}

function applyUntrustedMarkers(messages, trustBoundary) {
  if (trustBoundary !== 'untrusted' || !Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || m.role !== 'user' || typeof m.content !== 'string') return m;
    if (m.content.includes('<UNTRUSTED>')) return m; // already wrapped
    return { ...m, content: `<UNTRUSTED>${m.content}</UNTRUSTED>` };
  });
}

/**
 * Canonical finishReason mapping. Providers return varied strings
 * (Anthropic: "end_turn"/"max_tokens"; OpenAI: "stop"/"length"/
 * "tool_calls"; Gemini: "STOP"/"MAX_TOKENS"/"SAFETY"). The host's
 * callAI SHOULD normalize, but defensively map common variants here
 * so the schema's enum stays honest.
 */
function normalizeFinishReason(raw) {
  if (!raw) return 'other';
  const s = String(raw).toLowerCase();
  if (s === 'stop' || s === 'end_turn' || s === 'end-turn') return 'stop';
  if (s === 'length' || s === 'max_tokens' || s === 'max-tokens') return 'length';
  if (s === 'content-filter' || s === 'safety' || s === 'content_filter') return 'content-filter';
  if (s === 'tool-call' || s === 'tool_calls' || s === 'tool_call' || s === 'function_call') return 'tool-call';
  return 'other';
}

/* ─── core.openwop.ai.chat-completion ──────────────────────── */

export async function chatCompletion(ctx) {
  ensureCallAI(ctx);
  const { provider, model, systemPrompt, temperature, maxTokens, stopSequences } = ctx.config;
  const messages = toMessages(ctx.inputs);

  const result = await ctx.callAI({
    provider,
    model,
    messages: applyUntrustedMarkers(messages, ctx.trustBoundary),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(stopSequences !== undefined ? { stopSequences } : {}),
  });

  return {
    status: 'success',
    outputs: {
      content: result.content ?? '',
      usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
      finishReason: normalizeFinishReason(result.finishReason),
      ...(result.model ? { model: result.model } : {}),
    },
  };
}

/* ─── core.openwop.ai.structured-output ─────────────────────── */

/**
 * Validate `data` against the JSON schema using a minimal recursive
 * shape-checker. We can't pull in Ajv (zero-deps pack) so we rely on
 * the host's callAI to do strict schema-conformance — providers with
 * native structured-output APIs (Anthropic tool-use, OpenAI JSON
 * mode, Gemini response_schema) handle this server-side. The retry
 * loop here covers the case where the provider returns valid JSON
 * that nonetheless doesn't match the requested schema (less common
 * with native APIs; common with prompt-engineered JSON via raw chat
 * completion).
 *
 * We compare ONLY at the structural level: required keys present,
 * types align. Deep semantic validation is the host's job.
 */
function shallowSchemaCheck(data, schema) {
  return schemaCheckErrors(data, schema).length === 0;
}

/** XCH-CORE-1 (LLM-EXCHANGE-AUDIT Wave 2): dependency-free recursive walker
 *  over the JSON-Schema subset workflow authors actually write —
 *  type / required / properties / items / enum / const — with a depth cap.
 *  PERMISSIVE by design: unknown keywords are ignored (never stricter than
 *  the provider's native structured output). Returns path-prefixed error
 *  strings so the retry prompt can teach the model what to fix. */
function schemaCheckErrors(data, schema, path = '$', depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 8) return [];
  const errors = [];
  if (schema.type) {
    const actualType = Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data === 'number' && Number.isInteger(data) ? 'integer' : typeof data;
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = expected.some((t) => t === actualType || (t === 'number' && actualType === 'integer'));
    if (!matches) { errors.push(`${path}: expected type ${expected.join('|')}, got ${actualType}`); return errors; }
  }
  if (schema.const !== undefined && JSON.stringify(data) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: must equal the const value ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(data))) {
    errors.push(`${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) if (!(k in data)) errors.push(`${path}: missing required key '${k}'`);
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in data) errors.push(...schemaCheckErrors(data[k], sub, `${path}.${k}`, depth + 1));
      }
    }
  }
  if (Array.isArray(data) && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    data.forEach((item, i) => errors.push(...schemaCheckErrors(item, schema.items, `${path}[${i}]`, depth + 1)));
  }
  return errors;
}

export async function structuredOutput(ctx) {
  ensureCallAI(ctx);
  const {
    provider, model, systemPrompt, temperature, maxTokens,
    outputSchema, retryOnInvalidJson = 2,
  } = ctx.config;
  const messages = toMessages(ctx.inputs);

  let retries = 0;
  let lastErr = null;

  while (retries <= retryOnInvalidJson) {
    // XCH-CORE-1: a retry FEEDS THE VALIDATION ERRORS BACK — re-rolling the
    // same messages just re-samples the same mistake.
    const attemptMessages = lastErr
      ? [...messages, { role: 'user', content: `Your previous structured output was INVALID:\n${lastErr}\nReturn a corrected JSON value that satisfies the schema. Fix ALL of the above.` }]
      : messages;
    const result = await ctx.callAI({
      provider,
      model,
      messages: applyUntrustedMarkers(attemptMessages, ctx.trustBoundary),
      responseSchema: outputSchema,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });

    const data = result.data;
    const schemaErrors = data === undefined ? [] : schemaCheckErrors(data, outputSchema);
    if (data === undefined) {
      lastErr = 'host returned no `data` field — provider may not support structured output';
    } else if (schemaErrors.length) {
      lastErr = schemaErrors.slice(0, 10).join('\n');
    } else {
      return {
        status: 'success',
        outputs: {
          data,
          usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
          ...(result.model ? { model: result.model } : {}),
          retries,
        },
      };
    }
    retries++;
  }

  // Retries exhausted. Fail with a typed error so the executor can
  // surface it through the engine's error-envelope.
  throw Object.assign(
    new Error(`structured output invalid after ${retries} retries: ${lastErr}`),
    { code: 'structured_output_invalid' }
  );
}

/* ─── core.openwop.ai.embeddings ────────────────────────────── */

export async function embeddings(ctx) {
  ensureCallAI(ctx);
  const { provider, model, dimensions } = ctx.config;
  const { text } = ctx.inputs;

  const result = await ctx.callAI({
    provider,
    model,
    embeddingMode: true,
    messages: applyUntrustedMarkers([{ role: 'user', content: text }], ctx.trustBoundary),
    ...(dimensions !== undefined ? { dimensions } : {}),
  });

  const vector = result.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw Object.assign(
      new Error('host returned no `embedding` array — provider may not support embeddings'),
      { code: 'embeddings_unsupported' }
    );
  }

  return {
    status: 'success',
    outputs: {
      vector,
      dimensions: vector.length,
      model: result.model ?? model,
      ...(result.usage ? { usage: result.usage } : {}),
    },
  };
}

/* ─── Pack registry ─────────────────────────────────────────── */

/* ─── core.ai.toolCalling ────────────────────────────────────── */

/**
 * core.ai.toolCalling — invokes the LLM with a declared tool/function
 * set + lets the model emit tool calls. Routes through
 * ctx.callAIWithTools (a host extension above the base ctx.callAI;
 * required for hosts that want to advertise this typeId).
 *
 * Hosts without ctx.callAIWithTools refuse to register the pack at
 * peerDependency resolution time per spec/v1/node-packs.md. The
 * runtime throws `host_capability_missing` defensively in case the
 * resolver gate misfires.
 */
export async function toolCalling(ctx) {
  if (typeof ctx.callAIWithTools !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.callAIWithTools'),
      { code: 'host_capability_missing', capability: 'aiProviders.toolCalling' },
    );
  }
  const { provider, model, systemPrompt, temperature, maxTokens, tools, toolChoice } = ctx.config;
  const messages = toMessages(ctx.inputs);

  const result = await ctx.callAIWithTools({
    provider,
    model,
    messages: applyUntrustedMarkers(messages, ctx.trustBoundary),
    tools,
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });

  return {
    status: 'success',
    outputs: {
      content: result.content ?? '',
      toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
      usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
      finishReason: normalizeFinishReason(result.finishReason),
      ...(result.model ? { model: result.model } : {}),
    },
  };
}

/* ─── v1.1 multi-modal + LLM helpers ───────────────────────── */

function delegateProvider(method) {
  return async function (ctx) {
    const fn = ctx[method] ?? ctx.aiProviders?.[method];
    if (typeof fn !== 'function') {
      throw Object.assign(new Error(`host does not implement ${method}`), { code: 'HOST_CAPABILITY_MISSING' });
    }
    const result = await fn.call(ctx, { ...ctx.config, ...ctx.inputs });
    return { status: 'success', outputs: result };
  };
}

export const imageGenerate = delegateProvider('callImageGenerator');
export const imageEdit = async (ctx) => {
  const fn = ctx.callImageEditor ?? ctx.aiProviders?.callImageEditor;
  if (typeof fn !== 'function') throw Object.assign(new Error('host does not implement callImageEditor'), { code: 'HOST_CAPABILITY_MISSING' });
  const r = await fn.call(ctx, { ...ctx.config, ...ctx.inputs });
  return { status: 'success', outputs: r };
};
export const imageUpscale = delegateProvider('callImageUpscaler');
export const audioTranscribe = delegateProvider('callSpeechToText');
export const audioSynthesize = delegateProvider('callTextToSpeech');
export const videoGenerate = delegateProvider('callVideoGenerator');
export const rerank = delegateProvider('callReranker');

export async function classify(ctx) {
  if (typeof ctx.callAI !== 'function') throw Object.assign(new Error('host does not implement ctx.callAI'), { code: 'HOST_CAPABILITY_MISSING' });
  const labels = ctx.config.labels;
  const r = await ctx.callAI({
    systemPrompt: 'You are a single-label classifier. Reply with exactly one label from the provided list and nothing else.',
    messages: applyUntrustedMarkers([{ role: 'user', content: `Labels: ${labels.join(', ')}\n\nText:\n${ctx.inputs.text}` }], ctx.trustBoundary),
    model: ctx.config.model,
  });
  // XCH-CORE-2 (LLM-EXCHANGE-AUDIT Wave 2): no fabricated confidence, no
  // silent coercion to labels[0]. Normalize-match first (models add case/
  // punctuation noise); a genuinely off-list reply is a typed failure the
  // caller can see, not a fake first-label classification. `confidence` /
  // `allScores` are omitted — this node has no real scores to report.
  const raw = (r.text ?? r.content ?? '').trim();
  const norm = (s) => s.toLowerCase().replace(/["'`.,;:!]/g, '').trim();
  const label = labels.find((l) => l === raw) ?? labels.find((l) => norm(l) === norm(raw));
  if (label === undefined) {
    throw Object.assign(
      new Error(`model reply is not one of the ${labels.length} configured labels`),
      { code: 'classification_unmatched', details: { reply: raw.slice(0, 200), labels } },
    );
  }
  return { status: 'success', outputs: { label } };
}

export async function extract(ctx) {
  if (typeof ctx.callAI !== 'function') throw Object.assign(new Error('host does not implement ctx.callAI'), { code: 'HOST_CAPABILITY_MISSING' });
  const r = await ctx.callAI({
    systemPrompt: 'Extract structured data per the provided JSON Schema. Reply with JSON only.',
    messages: applyUntrustedMarkers([{ role: 'user', content: `Schema:\n${JSON.stringify(ctx.config.schema)}\n\nText:\n${ctx.inputs.text}` }], ctx.trustBoundary),
    responseSchema: ctx.config.schema,
    model: ctx.config.model,
  });
  // Prefer provider-parsed shapes when present; fall back to text parse
  // only when neither r.data nor r.parsed is provided. A non-JSON text
  // body — model ignored responseSchema — surfaces as raw text with
  // confidence 0 instead of throwing an uncaught SyntaxError. Mirrors
  // the catch-and-fallback pattern used by `transform()` below.
  if (r.data != null) {
    return { status: 'success', outputs: { value: r.data, confidence: 1 } };
  }
  if (r.parsed != null) {
    return { status: 'success', outputs: { value: r.parsed, confidence: 1 } };
  }
  const raw = r.text ?? r.content ?? null;
  if (raw != null) {
    try {
      return { status: 'success', outputs: { value: JSON.parse(raw), confidence: 1 } };
    } catch { /* fall through to the bounded repair */ }
  }
  // XCH-CORE-6 (LLM-EXCHANGE-AUDIT round 2): ONE bounded repair before the
  // honest low-confidence fallback — feed the failure back instead of
  // shipping raw prose at confidence 0 on the first miss.
  try {
    const retry = await ctx.callAI({
      systemPrompt: 'Extract structured data per the provided JSON Schema. Reply with JSON only.',
      messages: applyUntrustedMarkers([
        { role: 'user', content: `Schema:\n${JSON.stringify(ctx.config.schema)}\n\nText:\n${ctx.inputs.text}` },
        { role: 'assistant', content: String(raw ?? '') },
        { role: 'user', content: 'Your previous reply was not parseable JSON matching the schema. Return ONLY the JSON value — no prose, no code fences.' },
      ], ctx.trustBoundary),
      responseSchema: ctx.config.schema,
      model: ctx.config.model,
    });
    if (retry.data != null) return { status: 'success', outputs: { value: retry.data, confidence: 1 } };
    const retryRaw = retry.text ?? retry.content ?? null;
    if (retryRaw != null) {
      try { return { status: 'success', outputs: { value: JSON.parse(retryRaw), confidence: 1 } }; } catch { /* honest fallback below */ }
    }
  } catch { /* honest fallback below */ }
  return { status: 'success', outputs: { value: raw, confidence: 0 } };
}

export async function guardrails(ctx) {
  if (typeof ctx.guardrails?.evaluate === 'function') {
    const r = await ctx.guardrails.evaluate({ text: ctx.inputs.text, checks: ctx.config.checks });
    return { status: 'success', outputs: { enforced: true, ...r } };
  }
  // XCH-CORE-3: never report a fabricated pass as an enforced one. Without the
  // host capability the node cannot evaluate anything — say so honestly, and
  // let strict callers refuse to proceed at all.
  if (ctx.config?.requireEnforcement === true) {
    throw Object.assign(new Error('host does not implement ctx.guardrails and requireEnforcement is set'), { code: 'HOST_CAPABILITY_MISSING' });
  }
  return { status: 'success', outputs: { passed: true, violations: [], enforced: false, reason: 'host_capability_missing' } };
}

export async function transform(ctx) {
  if (typeof ctx.callAI !== 'function') throw Object.assign(new Error('host does not implement ctx.callAI'), { code: 'HOST_CAPABILITY_MISSING' });
  const exShown = (ctx.config.examples ?? []).map((e) => `Input: ${JSON.stringify(e.input)}\nOutput: ${JSON.stringify(e.output)}`).join('\n\n');
  // XCH-CORE-5 (LLM-EXCHANGE-AUDIT Wave 5): an optional caller-declared
  // outputSchema engages provider-native structured output; result.data is
  // then preferred over text parsing.
  const outputSchema = ctx.config.outputSchema && typeof ctx.config.outputSchema === 'object' ? ctx.config.outputSchema : undefined;
  const r = await ctx.callAI({
    systemPrompt: 'Transform the input per the instruction. Reply with the transformed JSON value only.',
    messages: applyUntrustedMarkers([{ role: 'user', content: `Instruction: ${ctx.inputs.instruction}\n\n${exShown}\n\nInput: ${JSON.stringify(ctx.inputs.value)}\nOutput:` }], ctx.trustBoundary),
    model: ctx.config.model,
    ...(outputSchema ? { responseSchema: outputSchema } : {}),
  });
  if (outputSchema && r.data !== undefined) {
    return { status: 'success', outputs: { result: r.data } };
  }
  let result;
  try { result = JSON.parse(r.text ?? r.content ?? 'null'); } catch { result = r.text ?? r.content; }
  return { status: 'success', outputs: { result } };
}

/* ─── Pack registry ─────────────────────────────────────────── */

export const nodes = {
  'core.ai.chatCompletion': chatCompletion,
  'core.ai.structuredOutput': structuredOutput,
  'core.ai.toolCalling': toolCalling,
  'core.openwop.ai.embeddings': embeddings,
  // v1.1
  'core.openwop.ai.image-generate': imageGenerate,
  'core.openwop.ai.image-edit': imageEdit,
  'core.openwop.ai.image-upscale': imageUpscale,
  'core.openwop.ai.audio-transcribe': audioTranscribe,
  'core.openwop.ai.audio-synthesize': audioSynthesize,
  'core.openwop.ai.video-generate': videoGenerate,
  'core.openwop.ai.rerank': rerank,
  'core.openwop.ai.classify': classify,
  'core.openwop.ai.extract': extract,
  'core.openwop.ai.guardrails': guardrails,
  'core.openwop.ai.transform': transform,
};

export default nodes;
