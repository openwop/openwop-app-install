/**
 * vendor.myndhyve.brand — brand-workflow pack runtime.
 *
 * 7 nodes covering brand theme + persona workflows, routed through
 * ctx.brand.* (state mutation + validation + review).
 *
 * Architectural patterns:
 *   - State-mutation nodes (theme.implement, theme.publish,
 *     persona.publish): route through ctx.brand.* adapter; idempotency-
 *     keyed for replay safety.
 *   - HITL review nodes (theme.review, persona.review): suspend via
 *     ctx.suspend({ reason: 'conversation-input', resumeKey, ... });
 *     decision enum: approve / reject / request-changes.
 *   - Validate nodes (theme.validate, persona.validate): rule-engine
 *     via ctx.brand.validate; returns passed + violations.
 *
 * @see docs/plans/MYNDHYVE-TO-OPENWOP-PACK-MIGRATION.md
 */

import { createHash } from 'node:crypto';

function ensureBrand(ctx) {
  if (!ctx.brand) {
    throw Object.assign(new Error('host does not expose ctx.brand'), { code: 'host_capability_missing' });
  }
}

function deriveIdempotencyKey(parts) {
  const h = createHash('sha256');
  for (const p of parts) {
    if (p === undefined || p === null) h.update('\0');
    else if (typeof p === 'string') h.update(p, 'utf8');
    else h.update(JSON.stringify(p), 'utf8');
    h.update('\x1e');
  }
  return 'openwop-' + h.digest('hex').slice(0, 16);
}

/* ─── State-mutation nodes (implement / publish) ────────── */

async function applyOrPublish(ctx, op, envelopeType) {
  ensureBrand(ctx);
  if (typeof ctx.brand[op] !== 'function') {
    throw Object.assign(new Error(`host does not expose ctx.brand.${op}`), { code: 'host_capability_missing' });
  }
  const { force = false } = ctx.config;
  const { brandId, payload, targetCanvasId } = ctx.inputs;
  const idempotencyKey = deriveIdempotencyKey([
    String(ctx.runId), String(ctx.nodeId), op, brandId, payload, targetCanvasId ?? '', force,
  ]);
  const result = await ctx.brand[op]({
    brandId, payload, force,
    ...(targetCanvasId !== undefined ? { targetCanvasId } : {}),
    idempotencyKey,
  });
  return {
    status: 'success',
    outputs: {
      brandId,
      artifactId: result?.artifactId ?? '',
      appliedAt: result?.appliedAt ?? new Date().toISOString(),
      idempotencyKey,
    },
  };
}

export const themeImplement = (ctx) => applyOrPublish(ctx, 'implementTheme', 'theme.implement');
export const themePublish = (ctx) => applyOrPublish(ctx, 'publishTheme', 'theme.publish');
export const personaPublish = (ctx) => applyOrPublish(ctx, 'publishPersona', 'persona.publish');

/* ─── HITL review nodes ────────────────────────────────── */

function makeReview(reviewType) {
  return async function review(ctx) {
    ensureBrand(ctx);
    if (typeof ctx.suspend !== 'function') {
      throw Object.assign(new Error('host does not expose ctx.suspend'), { code: 'host_capability_missing' });
    }
    const { reviewerRole, timeoutMs } = ctx.config;
    const { artifactId, summary } = ctx.inputs;

    // Surface the review card if host exposes chat/card adapter.
    if (typeof ctx.chat?.emitCard === 'function') {
      await ctx.chat.emitCard({
        cardId: `${reviewType}-${artifactId}`,
        cardType: `brand-${reviewType}-review`,
        payload: { artifactId, summary, reviewerRole },
        idempotencyKey: deriveIdempotencyKey([String(ctx.runId), String(ctx.nodeId), reviewType, artifactId, 'card']),
      });
    }

    const resumePayload = await ctx.suspend({
      reason: 'conversation-input',
      resumeKey: `${reviewType}-review-${artifactId}`,
      reviewerRole,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

    if (resumePayload?.timedOut === true) {
      return {
        status: 'success',
        outputs: { artifactId, decision: 'reject', notes: 'timed out', respondedAt: new Date().toISOString(), timedOut: true },
      };
    }

    return {
      status: 'success',
      outputs: {
        artifactId,
        decision: resumePayload?.decision ?? 'request-changes',
        ...(resumePayload?.notes ? { notes: resumePayload.notes } : {}),
        ...(resumePayload?.respondent ? { respondent: resumePayload.respondent } : {}),
        respondedAt: resumePayload?.respondedAt ?? new Date().toISOString(),
      },
    };
  };
}

export const themeReview = makeReview('theme');
export const personaReview = makeReview('persona');

/* ─── Validate nodes ───────────────────────────────────── */

function makeValidate(validateOp) {
  return async function validate(ctx) {
    ensureBrand(ctx);
    if (typeof ctx.brand[validateOp] !== 'function') {
      throw Object.assign(new Error(`host does not expose ctx.brand.${validateOp}`), { code: 'host_capability_missing' });
    }
    const { ruleSet, failOnWarning = false } = ctx.config;
    const { artifactId } = ctx.inputs;
    const result = await ctx.brand[validateOp]({
      artifactId,
      ...(ruleSet !== undefined ? { ruleSet } : {}),
      failOnWarning,
    });
    const violations = Array.isArray(result?.violations) ? result.violations : [];
    const hasErrors = violations.some((v) => v.severity === 'error');
    const hasWarnings = violations.some((v) => v.severity === 'warning');
    const passed = !hasErrors && (!failOnWarning || !hasWarnings);
    return {
      status: 'success',
      outputs: {
        artifactId,
        passed,
        rulesRun: typeof result?.rulesRun === 'number' ? result.rulesRun : 0,
        ...(violations.length ? { violations } : {}),
      },
    };
  };
}

export const themeValidate = makeValidate('validateTheme');
export const personaValidate = makeValidate('validatePersona');

/* ─── Pack registry ───────────────────────────────────── */

export const nodes = {
  'brand.theme.implement': themeImplement,
  'brand.theme.publish': themePublish,
  'brand.theme.review': themeReview,
  'brand.theme.validate': themeValidate,
  'brand.persona.publish': personaPublish,
  'brand.persona.review': personaReview,
  'brand.persona.validate': personaValidate,
};

export default nodes;
