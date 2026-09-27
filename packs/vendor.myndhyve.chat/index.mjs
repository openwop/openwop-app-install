/**
 * vendor.myndhyve.chat — MyndHyve chat-bridge pack.
 *
 * Four nodes route through the host's chat adapter (ctx.chat.*):
 *   sendMessage, progressCard, updateCard, phaseInputGate.
 *
 * typeId-preserve strategy: typeIds keep their core.chat.* prefixes
 * even though the pack is vendor-namespaced (per migration plan §4).
 *
 * Host contract (informative — host.chat is host-extension pending
 * Tracks 10/13 normative coverage):
 *
 *   ctx.chat.sendMessage({ role, content, citations?, sessionId?,
 *     idempotencyKey }) → Promise<{ messageId, sentAt }>
 *
 *   ctx.chat.emitCard({ cardId, cardType, payload, idempotencyKey })
 *     → Promise<{ cardId, emittedAt }>
 *
 *   ctx.chat.updateCard({ cardId, patch, patchType, idempotencyKey })
 *     → Promise<{ cardId, updatedAt, found }>
 *
 *   ctx.suspend({ reason, resumeKey, ... }) — RFC 0007 §F suspend
 *     primitive. phaseInputGate uses this with reason 'conversation-
 *     input' (per RFC 0010 H3 ratification).
 *
 * @see docs/plans/MYNDHYVE-TO-OPENWOP-PACK-MIGRATION.md
 */

import { createHash } from 'node:crypto';

function ensureChat(ctx) {
  if (!ctx.chat || typeof ctx.chat.sendMessage !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.chat — workflow-register should have refused this pack at peerDependency resolution time'),
      { code: 'host_capability_missing' }
    );
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

/* ─── core.chat.sendMessage ──────────────────────────────── */

export async function sendMessage(ctx) {
  ensureChat(ctx);
  const role = ctx.config?.role ?? 'agent';
  const sessionId = ctx.config?.sessionId;
  const { content, citations } = ctx.inputs;
  const idempotencyKey = deriveIdempotencyKey([
    String(ctx.runId), String(ctx.nodeId), role, content,
    citations ?? [],
  ]);
  const result = await ctx.chat.sendMessage({
    role,
    content,
    ...(citations !== undefined ? { citations } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    idempotencyKey,
  });
  return {
    status: 'success',
    outputs: {
      messageId: result?.messageId ?? '',
      sentAt: result?.sentAt ?? new Date().toISOString(),
      idempotencyKey,
    },
  };
}

/* ─── core.chat.progressCard ─────────────────────────────── */

export async function progressCard(ctx) {
  ensureChat(ctx);
  if (typeof ctx.chat.emitCard !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.chat.emitCard'), { code: 'host_capability_missing' });
  }
  const { cardId, stages, title } = ctx.config;
  const { currentStageId, details } = ctx.inputs;
  const idempotencyKey = deriveIdempotencyKey([
    String(ctx.runId), String(ctx.nodeId), cardId, currentStageId,
  ]);
  const result = await ctx.chat.emitCard({
    cardId,
    cardType: 'progress',
    payload: {
      stages,
      currentStageId,
      ...(title !== undefined ? { title } : {}),
      ...(details !== undefined ? { details } : {}),
    },
    idempotencyKey,
  });
  return {
    status: 'success',
    outputs: {
      cardId: result?.cardId ?? cardId,
      emittedAt: result?.emittedAt ?? new Date().toISOString(),
    },
  };
}

/* ─── core.chat.updateCard ───────────────────────────────── */

export async function updateCard(ctx) {
  ensureChat(ctx);
  if (typeof ctx.chat.updateCard !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.chat.updateCard'), { code: 'host_capability_missing' });
  }
  const { cardId, patchType = 'merge' } = ctx.config;
  const { patch } = ctx.inputs;
  const idempotencyKey = deriveIdempotencyKey([
    String(ctx.runId), String(ctx.nodeId), cardId, patchType, patch,
  ]);
  const result = await ctx.chat.updateCard({
    cardId,
    patch,
    patchType,
    idempotencyKey,
  });
  return {
    status: 'success',
    outputs: {
      cardId: result?.cardId ?? cardId,
      updatedAt: result?.updatedAt ?? new Date().toISOString(),
      found: result?.found !== false,
    },
  };
}

/* ─── core.chat.phaseInputGate ───────────────────────────── */

/**
 * HITL gate. Emits a phase-input dialog into the chat session,
 * suspends the run, and on resume returns the user's validated
 * answers as outputs.
 *
 * Suspend semantics:
 *   Uses RFC 0007 §F primitive (ctx.suspend with reason). When the
 *   host advertises core.openwop.conversationPrimitive (RFC 0010),
 *   reason is 'conversation-input'; otherwise 'clarification'. The
 *   host's suspend resolver validates the user's response against
 *   config.answerSchema before resuming.
 */
export async function phaseInputGate(ctx) {
  ensureChat(ctx);
  if (typeof ctx.suspend !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.suspend'), { code: 'host_capability_missing' });
  }
  const { phaseId, prompt, answerSchema, timeoutMs } = ctx.config;
  const context = ctx.inputs?.context;

  // Emit the dialog card so the user sees it.
  if (typeof ctx.chat.emitCard === 'function') {
    await ctx.chat.emitCard({
      cardId: `phase-input-${phaseId}`,
      cardType: 'phase-input',
      payload: {
        phaseId,
        prompt,
        answerSchema,
        ...(context !== undefined ? { context } : {}),
      },
      idempotencyKey: deriveIdempotencyKey([String(ctx.runId), String(ctx.nodeId), phaseId, 'card']),
    });
  }

  // Suspend until the user responds. Host validates against
  // answerSchema before resuming; on resume, ctx.suspend returns
  // the validated answers.
  const resumePayload = await ctx.suspend({
    reason: 'conversation-input',
    resumeKey: phaseId,
    answerSchema,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

  // Resume payload shape: { answers, respondent?, timedOut? }
  if (resumePayload?.timedOut === true) {
    return {
      status: 'success',
      outputs: {
        phaseId,
        respondedAt: new Date().toISOString(),
        timedOut: true,
      },
    };
  }

  return {
    status: 'success',
    outputs: {
      phaseId,
      answers: resumePayload?.answers ?? {},
      ...(resumePayload?.respondent ? { respondent: resumePayload.respondent } : {}),
      respondedAt: resumePayload?.respondedAt ?? new Date().toISOString(),
    },
  };
}

/* ─── core.chat.approvalGate ─────────────────────────────── */

/**
 * Every spelling a resume payload can carry, mapped onto the gate's action
 * union. `approve` / `reject` / `request-changes` are the SHIPPED UI verbs
 * (`APPROVAL_ACTIONS` in frontend/react/src/interrupts/ApprovalCard.tsx);
 * `approved` / `rejected` / `accept` / `edit-accept` / `ask` are the legacy
 * `{decision}` spellings kept for direct `ctx.suspend` resolvers.
 *
 * `defer` and `escalate` are deliberately ABSENT: the union has no member that
 * means either, and inventing one would be a fabricated decision. They fall
 * through to the non-approving `refine` default.
 *
 * WF-EM-5 (review MEDIUM-2) — that fall-through is only SAFE while nothing
 * downstream treats "not approved" as "declined". On a chain whose `falsy
 * approved` edge leads to a terminal "no email sent" node, an approver who
 * clicked *Escalate* — an explicitly UNMADE decision — had it recorded as a
 * decline and the run reported `completed`. The cure is not another union
 * member: it is `config.actions`, forwarded below into the suspend payload so
 * `validateResumeValue` (routes/interrupts.ts) REFUSES a verb the chain cannot
 * honour with a 400 and the run stays interrupted, and so the approval card
 * (`data.actions`) stops OFFERING it. A chain that declares no `actions` keeps
 * the full legacy verb set unchanged.
 */
const APPROVAL_VERBS = {
  // → accept
  approve: 'accept',
  approved: 'accept',
  accept: 'accept',
  // → edit-accept
  'edit-accept': 'edit-accept',
  // → reject
  reject: 'reject',
  rejected: 'reject',
  // → refine
  'request-changes': 'refine',
  request_changes: 'refine',
  refine: 'refine',
  // → ask
  ask: 'ask',
};

/**
 * HITL approval gate. Suspends via ctx.suspend({reason:'approval'}) and
 * routes the decision (accept | edit-accept | refine | ask | reject |
 * timeout) back into outputs. Tracks loopback counter +
 * accumulated refine feedback on workflow variables so a downstream
 * loopback edge can re-generate with context.
 *
 * Preserved from in-tree byte-for-byte: variable keys
 *   _loopbackCount:<nodeId>
 *   _feedbackHistory:<nodeId>
 *   _previousArtifact:<nodeId>
 *
 * Multi-vote quorum + artifact-sync side-effects are HOST-side per
 * spec/v1/interrupt.md §"Host-side enforcement boundary". This
 * executor only mediates the suspend round-trip.
 */

/** ADR 0677 D1 part 3 — the approver-ACL keys `assertEligibleApprover` reads off
 *  `interrupt.data`, forwarded only when a NON-EMPTY string list is actually declared.
 *  Dropping blanks is load-bearing: a chain param that freezes to "" must remain an open
 *  gate, which is the documented default of `approvals.two-stage-sign-off`. */
function approverRefsPayload(config) {
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim() !== '') : []);
  const out = {};
  for (const key of ['approverRefs', 'approverGroupRefs', 'approverRoleRefs', 'overrideScopes']) {
    const vals = list(config[key]);
    if (vals.length > 0) out[key] = vals;
  }
  return out;
}

export async function approvalGate(ctx) {
  if (typeof ctx.suspend !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.suspend'), {
      code: 'host_capability_missing',
    });
  }
  const config = ctx.config ?? {};
  const inputs = ctx.inputs ?? {};
  const {
    title,
    artifactType,
    maxRequestChangesIterations = 0,
    timeoutMs,
  } = config;
  // WF-EM-5 — the chain's verb allowlist. Only a non-empty array of strings is
  // honoured; anything else is treated as "not declared" so a malformed config
  // widens nothing and narrows nothing.
  const actions = Array.isArray(config.actions)
    && config.actions.length > 0
    && config.actions.every((a) => typeof a === 'string' && a)
    ? [...config.actions]
    : undefined;

  const loopbackKey = `_loopbackCount:${ctx.nodeId}`;
  const feedbackKey = `_feedbackHistory:${ctx.nodeId}`;
  const previousKey = `_previousArtifact:${ctx.nodeId}`;

  // Emit the approval card so the user sees the artifact + actions.
  if (ctx.chat && typeof ctx.chat.emitCard === 'function') {
    await ctx.chat.emitCard({
      cardId: `approval-${ctx.nodeId}`,
      cardType: 'approval',
      payload: {
        title: title ?? 'Approval Required',
        artifactType,
        ...(actions ? { actions } : {}),
        artifact: inputs.artifact,
        loopbackCount: ctx.variables?.get?.(loopbackKey) ?? 0,
        feedbackHistory: ctx.variables?.get?.(feedbackKey) ?? [],
      },
      idempotencyKey: deriveIdempotencyKey([
        String(ctx.runId), String(ctx.nodeId), 'approval-card',
      ]),
    });
  }

  const resumePayload = await ctx.suspend({
    reason: 'approval',
    resumeKey: ctx.nodeId,
    // WF-EM-5 — `makeSuspendFn` persists the whole payload as `interrupt.data`,
    // which is exactly what `validateResumeValue` reads to enforce the verb
    // allowlist and what the approval cards render their buttons from. So this
    // one line is what makes `config.actions` real on BOTH sides rather than a
    // decorative hint on the chat card.
    ...(actions ? { actions } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    // ADR 0677 D1 part 3 — forward the approver ACL for the SAME reason, and it was the
    // missing half that made the route-side fix a no-op on this node type. Only two writers
    // ever put `approverRefs` on `interrupt.data` (`bootstrap/nodes.ts:943` and
    // `core.interrupt`'s verbatim forward at `:1011`); this node was neither, so an author
    // could set `approverRefs` in chain config, see it rendered in the gate evidence panel,
    // and have it enforced NOWHERE. `core.chat.approvalGate` is 49 of the corpus's 63 gate
    // instances, so without this line the RFC 0173 §B enforcement reaches almost none of
    // them. Empty/malformed values are dropped rather than forwarded, so a blank param
    // (`approvals.two-stage-sign-off` defaults both to "" — "blank = any team member") still
    // freezes to an intentional OPEN gate.
    ...approverRefsPayload(config),
  });

  // Resume payload shape: { action | decision, approved?, feedback?,
  //                          editedArtifact?, decidedBy?, decidedAt?, timedOut? }
  if (resumePayload?.timedOut === true) {
    return {
      status: 'success',
      outputs: {
        decision: 'timeout',
        approved: false,
        decidedAt: new Date().toISOString(),
        timedOut: true,
      },
    };
  }

  // ── Normalise the decision verb (ADR 0582 §9) ────────────────────────
  //
  // MEASURED 2026-08-18: EVERY shipped producer sends `action`, never
  // `decision`. This gate previously read `resumePayload.decision` ONLY, so
  // `approved` was ALWAYS false on every real click and the verb fell through
  // to `refine` — inverting every `{path:'approved', op:'truthy'}` edge in the
  // corpus (an Approve took the reject branch). The producers:
  //   frontend/react/src/interrupts/ApprovalCard.tsx        → { action, comment }
  //   frontend/react/src/chat/registry/defaultCards.tsx     → { action, comment }
  //   backend/typescript/src/routes/reviews.ts              → { action, ... }
  // and `validateResumeValue` (routes/interrupts.ts) enforces
  // `action ∈ interrupt.data.actions` whenever the card declares an `actions`
  // array — i.e. `action` is the VALIDATED field, so it is the one to read.
  // `decision` / `approved:true` are retained for direct `ctx.suspend`
  // resolvers (and the legacy tests that pin that shape).
  const rawVerb =
    typeof resumePayload?.decision === 'string' ? resumePayload.decision
    : typeof resumePayload?.action === 'string' ? resumePayload.action
    : undefined;
  // `Object.hasOwn` guard, not a bare index: `rawVerb` is caller-controlled, so
  // a bare lookup would resolve `constructor` / `toString` off the prototype
  // chain to a truthy non-verb and take the `mapped !== undefined` branch.
  const mapped =
    rawVerb !== undefined && Object.hasOwn(APPROVAL_VERBS, rawVerb)
      ? APPROVAL_VERBS[rawVerb]
      : undefined;

  // Classify into the 5-action union (accept | edit-accept | refine | ask |
  // reject). An EXPLICIT verb always wins over the legacy `approved` boolean:
  // a payload carrying both a verb and a contradicting flag must honour the
  // verb the reviewer actually clicked.
  let action;
  if (mapped === 'accept' && resumePayload?.editedArtifact) action = 'edit-accept';
  else if (mapped !== undefined) action = mapped;
  else if (resumePayload?.approved === true) action = 'accept';
  else if (resumePayload?.editedArtifact) action = 'edit-accept';
  // Any other/unknown verb (incl. the card's `defer` / `escalate`, which the
  // union has no member for) stays a non-approving `refine` — unchanged.
  else action = 'refine';

  const approved = action === 'accept' || action === 'edit-accept';

  // Loopback bookkeeping for refine.
  if (action === 'refine' && ctx.variables) {
    const prevCount = ctx.variables.get(loopbackKey) ?? 0;
    const nextCount = prevCount + 1;
    if (maxRequestChangesIterations > 0 && nextCount > maxRequestChangesIterations) {
      return {
        status: 'success',
        outputs: {
          decision: 'reject',
          approved: false,
          feedback: 'maxRequestChangesIterations exceeded',
          decidedAt: new Date().toISOString(),
        },
      };
    }
    ctx.variables.set(loopbackKey, nextCount);

    const prevFeedback = ctx.variables.get(feedbackKey) ?? [];
    if (resumePayload?.feedback) {
      ctx.variables.set(feedbackKey, [
        ...prevFeedback,
        {
          iteration: nextCount,
          feedback: resumePayload.feedback,
          submittedAt: resumePayload.decidedAt ?? new Date().toISOString(),
        },
      ]);
    }
    if (inputs.artifact !== undefined) {
      ctx.variables.set(previousKey, inputs.artifact);
    }
  }

  // The approved artifact, passed through so a side-effecting successor can
  // take its content FROM THE GATE on a `truthy approved` conditioned edge.
  // Without this a chain has to feed the effect node straight from the author
  // node, and that unconditional sibling edge alone satisfies `all_success`
  // (MEASURED — scheduler.ts `anyCompleted`), so the effect fires on a
  // REJECTION and the conditioned edge is decorative.
  const approvedArtifact = resumePayload?.editedArtifact ?? inputs.artifact;

  return {
    status: 'success',
    outputs: {
      decision: action,
      approved,
      ...(resumePayload?.feedback ? { feedback: resumePayload.feedback } : {}),
      ...(approvedArtifact !== undefined ? { artifact: approvedArtifact } : {}),
      ...(resumePayload?.editedArtifact ? { editedArtifact: resumePayload.editedArtifact } : {}),
      ...(resumePayload?.decidedBy ? { decidedBy: resumePayload.decidedBy } : {}),
      decidedAt: resumePayload?.decidedAt ?? new Date().toISOString(),
    },
  };
}

/* ─── core.chat.clarificationGate ────────────────────────── */

/**
 * HITL clarification gate. Asks a list of questions (from ask.clarify
 * envelope or upstream output), suspends until the user answers each,
 * returns answers paired with their questions.
 *
 * Per spec/v1/interrupt.md, uses suspend reason 'clarification' (or
 * 'conversation-input' when the host advertises RFC 0010
 * conversationPrimitive).
 */
export async function clarificationGate(ctx) {
  if (typeof ctx.suspend !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.suspend'), {
      code: 'host_capability_missing',
    });
  }
  const { title = 'Clarification Needed', timeoutMs = 0, writeToVariables = false } = ctx.config ?? {};
  const inputs = ctx.inputs ?? {};

  // Normalize questions — accept both string[] and Array<{question}>.
  const rawQuestions = Array.isArray(inputs.questions) ? inputs.questions : [];
  const questions = rawQuestions.map((q) =>
    typeof q === 'string' ? q : (q && typeof q.question === 'string' ? q.question : String(q)),
  );

  if (questions.length === 0) {
    return {
      status: 'success',
      outputs: { answers: [], submittedAt: new Date().toISOString() },
    };
  }

  if (ctx.chat && typeof ctx.chat.emitCard === 'function') {
    await ctx.chat.emitCard({
      cardId: `clarification-${ctx.nodeId}`,
      cardType: 'clarification',
      payload: { title, questions },
      idempotencyKey: deriveIdempotencyKey([
        String(ctx.runId), String(ctx.nodeId), 'clarification-card',
      ]),
    });
  }

  const resumePayload = await ctx.suspend({
    reason: 'clarification',
    resumeKey: ctx.nodeId,
    questions,
    ...(timeoutMs > 0 ? { timeoutMs } : {}),
  });

  if (resumePayload?.timedOut === true) {
    return {
      status: 'success',
      outputs: {
        answers: [],
        submittedAt: new Date().toISOString(),
        timedOut: true,
      },
    };
  }

  // Pair answers back to their questions.
  const rawAnswers = Array.isArray(resumePayload?.answers) ? resumePayload.answers : [];
  const answers = questions.map((question, i) => {
    const a = rawAnswers[i];
    const answer = typeof a === 'string' ? a : (a && typeof a.answer === 'string' ? a.answer : '');
    return { question, answer };
  });

  if (writeToVariables && ctx.variables) {
    for (let i = 0; i < answers.length; i++) {
      ctx.variables.set(`clarification_${i}_answer`, answers[i].answer);
    }
  }

  return {
    status: 'success',
    outputs: {
      answers,
      submittedAt: resumePayload?.submittedAt ?? new Date().toISOString(),
    },
  };
}

/* ─── Pack registry ──────────────────────────────────────── */

export const nodes = {
  'core.chat.sendMessage': sendMessage,
  'core.chat.progressCard': progressCard,
  'core.chat.updateCard': updateCard,
  'core.chat.phaseInputGate': phaseInputGate,
  'core.chat.approvalGate': approvalGate,
  'core.chat.clarificationGate': clarificationGate,
};

export default nodes;
