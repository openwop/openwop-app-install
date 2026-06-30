/**
 * feature.brand.nodes — Brand & Guardrails nodes over the `ctx.features.brand`
 * surface (ADR 0155 / ADR 0014). All role:"action" so the engine records outputs
 * and replay/fork read the recorded result rather than re-querying / re-scoring.
 * Pure-JS, Node-20 stdlib only.
 *
 * The compliance-check node blends two legs: the surface's PURE deterministic
 * score (banned-phrase / formality / per-channel length — 60 %) and an LLM tone
 * judgement via the run-scoped ctx.callAI (40 %). A banned-phrase hit caps the
 * overall score at 30 regardless of the LLM. When ctx.callAI is absent the node
 * degrades to the deterministic score alone (never fails the run).
 */

function ensureBrand(ctx) {
  const brand = ctx.features && ctx.features.brand;
  if (!brand || typeof brand.checkComplianceDeterministic !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.brand — the Brand feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.brand' },
    );
  }
  return brand;
}

function str(v) { return typeof v === 'string' ? v : ''; }
function clampScore(n) { return Math.max(0, Math.min(100, Math.round(Number(n)))); }

export async function listBrands(ctx) {
  const brand = ensureBrand(ctx);
  const i = ctx.inputs ?? {};
  const out = await brand.listBrands(i.orgId ? { orgId: str(i.orgId) } : {});
  return { status: 'success', outputs: { brands: out.brands ?? [] } };
}

export async function getAppIdentity(ctx) {
  const brand = ctx.features && ctx.features.brand;
  if (!brand || typeof brand.getAppIdentity !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.brand.getAppIdentity — the Brand feature must be composed (ADR 0014/0170)'),
      { code: 'host_capability_missing', capability: 'host.sample.brand' },
    );
  }
  const out = await brand.getAppIdentity({});
  return { status: 'success', outputs: { identity: out.identity ?? {} } };
}

export async function resolveVoice(ctx) {
  const brand = ensureBrand(ctx);
  const i = ctx.inputs ?? {};
  const out = await brand.resolveVoice({
    brandId: str(i.brandId),
    ...(i.channel ? { channel: str(i.channel) } : {}),
    ...(i.register ? { register: str(i.register) } : {}),
  });
  if (out.voice == null) {
    return { status: 'failed', error: { code: 'brand_not_found', message: `Brand not found: ${str(i.brandId)}` } };
  }
  return { status: 'success', outputs: { voice: out.voice } };
}

export async function complianceCheck(ctx) {
  const brand = ensureBrand(ctx);
  const i = ctx.inputs ?? {};
  const content = str(i.content);
  const channel = i.channel ? str(i.channel) : undefined;

  // 1) Deterministic leg (pure, in the surface).
  const det = await brand.checkComplianceDeterministic({
    brandId: str(i.brandId),
    content,
    ...(channel ? { channel } : {}),
  });
  const report = det.report;
  if (report == null) {
    return { status: 'failed', error: { code: 'brand_not_found', message: `Brand not found: ${str(i.brandId)}` } };
  }

  // 2) Optional LLM tone leg via the run-scoped provider. Degrade gracefully:
  //    any failure (no provider, empty/garbled output) keeps the deterministic score.
  let llmScore;
  const llmIssues = [];
  if (typeof ctx.callAI === 'function' && content.length > 0) {
    try {
      const voiceOut = await brand.resolveVoice({ brandId: str(i.brandId), ...(channel ? { channel } : {}) });
      const voiceBlock = str(voiceOut.voice);
      const ai = await ctx.callAI({
        provider: str(i.provider) || 'anthropic',
        model: str(i.model) || 'claude-sonnet-4-6',
        systemPrompt:
          'You are a brand-compliance auditor. Score how well the CONTENT matches the BRAND VOICE on a 0-100 scale (tone, formality, voice consistency). Reply with strict JSON only.',
        messages: [{ role: 'user', content: `BRAND VOICE:\n${voiceBlock}\n\nCONTENT:\n${content}` }],
        responseSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['score'],
          properties: {
            score: { type: 'integer', minimum: 0, maximum: 100 },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['description'],
                properties: { description: { type: 'string' }, suggestion: { type: 'string' } },
              },
            },
          },
        },
      });
      const data = ai && typeof ai === 'object' ? ai.data : undefined;
      if (data && typeof data === 'object' && typeof data.score === 'number') {
        llmScore = clampScore(data.score);
        for (const it of Array.isArray(data.issues) ? data.issues : []) {
          if (it && typeof it.description === 'string') {
            llmIssues.push({ category: 'voice', severity: 'warning', description: it.description, suggestion: typeof it.suggestion === 'string' ? it.suggestion : undefined });
          }
        }
      }
    } catch {
      // fall through — deterministic score stands.
    }
  }

  // 3) Blend 60 % deterministic / 40 % LLM; a banned phrase caps the overall ≤30.
  let overallScore = report.deterministicScore;
  if (typeof llmScore === 'number') overallScore = clampScore(report.deterministicScore * 0.6 + llmScore * 0.4);
  if (report.hasBannedPhrase) overallScore = Math.min(overallScore, 30);

  return {
    status: 'success',
    outputs: {
      report: {
        overallScore,
        deterministicScore: report.deterministicScore,
        ...(typeof llmScore === 'number' ? { llmScore } : {}),
        issues: [...report.issues, ...llmIssues],
        hasBannedPhrase: report.hasBannedPhrase,
        passesThreshold: overallScore >= 70 && !report.hasBannedPhrase,
        checkedAt: report.checkedAt,
      },
    },
  };
}

export const nodes = {
  'feature.brand.nodes.list-brands': listBrands,
  'feature.brand.nodes.get-app-identity': getAppIdentity,
  'feature.brand.nodes.resolve-voice': resolveVoice,
  'feature.brand.nodes.compliance-check': complianceCheck,
};

export default nodes;
