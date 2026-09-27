/**
 * feature.production.nodes — Production Intelligence nodes (ADR 0172).
 * Both role:"action" so the engine records outputs (replay/fork read the recorded
 * plan/context rather than re-generating). Pure-JS, Node-20 stdlib only.
 *
 * plan-generate composes the production context (ctx.features.production.
 * buildContext — team + vendor ranking, ADR 0005/0172) then calls the run-scoped
 * ctx.callAI for the routing plan, persists it via ctx.features.production.savePlan,
 * and emits a `production.plan` artifact (ADR 0055/0083).
 */

/** DEBT-3 — pack-local mirror of the providers.json SSoT default (the
 *  anthropic `recommended: true` model; src/providers/catalog.ts
 *  getDefaultModel). ctx.callAI REQUIRES an explicit model and standalone
 *  .mjs packs cannot import the catalog, so the default lives in this ONE
 *  greppable constant — the /refresh-model-catalog sweep updates it. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// XCH-PROD-2 — one schema literal, used by the first call AND the repair retry.
const PLAN_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['strategySummary', 'recommendations'],
  properties: {
    strategySummary: { type: 'string' },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['assetType', 'executionRoute', 'rationale'],
        properties: {
          assetType: { type: 'string' },
          assetDescription: { type: 'string' },
          executionRoute: { type: 'string', enum: ['internal', 'contractor', 'agency', 'hybrid'] },
          rationale: { type: 'string' },
          budget: { type: 'object', additionalProperties: true },
          timelineEstimate: { type: 'string' },
        },
      },
    },
    totalBudget: { type: 'object', additionalProperties: true },
    timeline: { type: 'object', additionalProperties: true },
    capabilityAssessment: { type: 'object', additionalProperties: true },
  },
};

function ensureProduction(ctx) {
  const p = ctx.features && ctx.features.production;
  if (!p || typeof p.buildContext !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.production — the Production Intelligence feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.production' },
    );
  }
  return p;
}

function str(v) { return typeof v === 'string' ? v : ''; }
function strArr(v) { return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }

export async function contextBuild(ctx) {
  const p = ensureProduction(ctx);
  const i = ctx.inputs ?? {};
  const out = await p.buildContext({ orgId: str(i.orgId), channels: strArr(i.channels) });
  // PROD2-R3 — a node's outputs are RECORDED in the run event log, and run
  // reads are TENANT-scoped (`runs:read` + matching tenantId — no org check, no
  // run-owner check). `vendorSection` now carries vendor RATES when the run
  // owner is entitled to them, so echoing it here would let any viewer in the
  // tenant — including a member of another org with zero scopes here — read
  // them back out of the run bundle. That is the cross-org reach PROD2-B1 just
  // closed at the surface, re-entered one hop later, carrying the one field
  // with a dedicated redaction subsystem, a route gate, a surface gate and an
  // explicit KB carve-out.
  //
  // Entitlement was evaluated for the run OWNER; the log has a WIDER audience,
  // so the priced block stays out of the recorded projection. `plan-generate`
  // keeps it in the prompt only, which is where it is needed.
  const { vendorSectionPriced, ...recordable } = out;
  void vendorSectionPriced;
  return { status: 'success', outputs: recordable };
}

export async function planGenerate(ctx) {
  const i = ctx.inputs ?? {};
  // ADR 0356 P1 — spine-slottable: when the production feature is OFF (surface
  // absent), SKIP honestly instead of failing the whole campaign run.
  const prod = ctx.features && ctx.features.production;
  if (!prod || typeof prod.buildContext !== 'function') {
    return { status: 'success', outputs: { skipped: true, reason: 'production feature is not enabled for this tenant' } };
  }
  const p = ensureProduction(ctx);
  let orgId = str(i.orgId);
  let channels = strArr(i.channels);
  // Spine calls pass only briefId — resolve org + enabled channels from the brief.
  const briefIdIn = str(i.briefId);
  if ((!orgId || channels.length === 0) && briefIdIn) {
    const cb = ctx.features && ctx.features['campaign-brief'];
    if (cb && typeof cb.assembleContext === 'function') {
      try {
        const asm = await cb.assembleContext({ briefId: briefIdIn });
        if (asm && asm.found) {
          if (!orgId && asm.brief && typeof asm.brief.orgId === 'string') orgId = asm.brief.orgId;
          if (channels.length === 0 && Array.isArray(asm.enabledChannels)) channels = asm.enabledChannels.map(String);
        }
      } catch { /* fall through to the explicit-input contract */ }
    }
  }
  if (!orgId) return { status: 'failed', error: { code: 'missing_input', message: '`orgId` is required (directly or resolvable from `briefId`).' } };

  // 1) Ranked production context (team + vendors + gaps).
  // PROD2-R4 — the surface is now fail-closed for runs with no acting user
  // (PROD2-B1), and this call sits outside the try/catch below. An inbound
  // webhook starts a genuine system run with no `actingUserId`, so the new gate
  // would throw here and fail the whole node — and with it the campaign spine —
  // producing exactly the failure mode the "SKIP honestly" note fifteen lines
  // above was written to prevent. A missing acting user is a legitimate,
  // non-exceptional state for a slotted node: skip with a reason rather than
  // taking the run down.
  let context;
  try {
    context = await p.buildContext({ orgId, channels });
  } catch (err) {
    if (err && err.code === 'forbidden_scope') {
      return {
        status: 'success',
        outputs: { skipped: true, reason: 'a production plan needs an acting user with access to this organization; this run has neither' },
      };
    }
    throw err;
  }

  // 2) Generate the routing plan with the run-scoped provider.
  if (typeof ctx.callAI !== 'function') {
    return { status: 'failed', error: { code: 'capability_missing', message: 'host does not expose ctx.callAI' } };
  }
  const assets = strArr(i.assets);
  const assetLine = assets.length ? `ASSETS TO PRODUCE:\n${assets.map((a) => `- ${a}`).join('\n')}` : 'ASSETS: infer the asset set from the enabled channels.';
  const systemPrompt =
    'You are a senior production strategist. Given the ranked internal team, external vendors, coverage gaps, and the assets to produce, recommend a per-asset execution route (internal / contractor / agency / hybrid) with a budget estimate, a timeline estimate, and a rationale. Prefer internal for covered capabilities; recommend contractors/agencies for gaps; use hybrid when a split is clearly better. Ground every recommendation in the provided context; do not invent team members or vendors. Reply with strict JSON only.';
  const userParts = [
    `ENABLED CHANNELS: ${channels.join(', ') || '(none specified)'}`,
    context.teamCapabilitySection || 'INTERNAL TEAM: (none)',
    context.vendorSectionPriced || context.vendorSection || 'EXTERNAL VENDORS: (none)',
    (context.gaps && context.gaps.length) ? `COVERAGE GAPS: ${context.gaps.join(', ')}` : '',
    assetLine,
  ].filter(Boolean);

  let data;
  try {
    const ai = await ctx.callAI({
      provider: str(i.provider) || 'anthropic',
      model: str(i.model) || DEFAULT_MODEL,
      systemPrompt,
      messages: [{ role: 'user', content: userParts.join('\n\n') }],
      responseSchema: PLAN_RESPONSE_SCHEMA,
    });
    data = ai && typeof ai === 'object' ? ai.data : undefined;
    // XCH-PROD-2 (LLM-EXCHANGE-AUDIT round 2): ONE bounded error-fed repair
    // before failing — tell the model exactly what was missing.
    if (!data || typeof data !== 'object' || typeof data.strategySummary !== 'string') {
      const retry = await ctx.callAI({
        provider: str(i.provider) || 'anthropic',
        model: str(i.model) || DEFAULT_MODEL,
        systemPrompt,
        messages: [
          { role: 'user', content: userParts.join('\n\n') },
          { role: 'assistant', content: JSON.stringify(data ?? null) },
          { role: 'user', content: 'Your previous reply was INVALID: it must be a JSON object with a string `strategySummary` and a `recommendations` array (assetType, executionRoute, rationale per item). Return the corrected FULL plan object only.' },
        ],
        temperature: 0,
        responseSchema: PLAN_RESPONSE_SCHEMA,
      });
      data = retry && typeof retry === 'object' ? retry.data : undefined;
    }
  } catch (e) {
    return { status: 'failed', error: { code: 'generation_failed', message: e instanceof Error ? e.message : 'plan generation failed' } };
  }
  if (!data || typeof data !== 'object' || typeof data.strategySummary !== 'string') {
    return { status: 'failed', error: { code: 'generation_empty', message: 'The provider returned no plan (after one repair attempt).' } };
  }

  // 3) Persist the plan (idempotent per the run) — recorded output ⇒ replay-safe.
  //    PIC-2: savePlan now REJECTS semantically-invalid model output with a typed
  //    OpenwopError (never coerce-and-persist garbage). Catch it and FAIL the node
  //    honestly instead of letting an uncaught throw escape — the PROD2-R4 lesson
  //    (a node that throws instead of returning a typed status can take the whole
  //    campaign spine down). The provider is already schema-constrained
  //    (PLAN_RESPONSE_SCHEMA) + one repair above, so this is the durable backstop.
  let saved;
  try {
    saved = await p.savePlan({
      orgId,
      ...(str(i.briefId) ? { briefId: str(i.briefId) } : {}),
      ...(str(ctx.runId) ? { planId: `pln:run:${str(ctx.runId)}`, workflowRunId: str(ctx.runId) } : {}),
      strategySummary: data.strategySummary,
      recommendations: data.recommendations,
      totalBudget: data.totalBudget,
      timeline: data.timeline,
      capabilityAssessment: data.capabilityAssessment,
    });
  } catch (e) {
    return { status: 'failed', error: { code: 'plan_invalid', message: e instanceof Error ? e.message : 'the generated plan failed validation' } };
  }
  const plan = saved && typeof saved === 'object' ? saved.plan : undefined;

  // 4) Typed-artifact envelope (ADR 0055/0083) — the host persists a renderable
  //    production.plan artifact from this `outputs.artifact` envelope.
  //    CORRECTION 2026-08-10: this comment used to say "+ emits artifact.created".
  //    It does not, and never did. `runArtifactStore.persistRunArtifact` persists
  //    WITHOUT emitting, by explicit design (`runArtifactStore.ts:18`); the only
  //    `ctx.emit('artifact.created', ...)` in this tree is
  //    `feature.documents.nodes:125`. Measured while wiring the RFC 0142 leg-B
  //    witness, which is exactly the claim it had to check. This is why `store`
  //    is advertised PER-TYPE for the emitting types only — a global `store: true`
  //    would be false for everything that reaches persistence through here.
  return {
    status: 'success',
    outputs: {
      plan,
      artifact: {
        artifactTypeId: 'production.plan',
        payload: {
          strategySummary: data.strategySummary,
          recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
          ...(data.totalBudget ? { totalBudget: data.totalBudget } : {}),
          ...(data.timeline ? { timeline: data.timeline } : {}),
          ...(data.capabilityAssessment ? { capabilityAssessment: data.capabilityAssessment } : {}),
        },
        title: `Production plan${channels.length ? ` — ${channels.join(', ')}` : ''}`,
      },
    },
  };
}

export const nodes = {
  'feature.production.nodes.context-build': contextBuild,
  'feature.production.nodes.plan-generate': planGenerate,
};
