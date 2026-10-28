/**
 * Interrupt-resolution routes:
 *   POST /v1/runs/{runId}/interrupts/{nodeId}    — node-scoped resolve
 *   POST /v1/interrupts/{token}                   — token-scoped resolve (unauth-friendly)
 *   GET  /v1/interrupts/{token}                   — inspect (returns kind + resumeSchema)
 *
 * After resolution, the run resumes via executor.executeRun() with
 * the suspended node's index + the resolved value as input.
 */

import { assertNotSubWorkflowMirror } from '../host/subWorkflowMirrorGuard.js';
import { notifyInterruptResolved } from '../host/interruptResolutionObservers.js';
import { assertApprovalSurfaceTrusted } from '../host/a2uiSurfaceAdmission.js';
import { timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { urlencoded } from 'express';
import type { ResolveInterruptRequest } from '@openwop/openwop';
import type { Storage } from '../storage/storage.js';
import { credentialStatusFor } from '../features/connections/connectionsService.js';
import { OpenwopError, type InterruptRecord } from '../types.js';
import { assertResumeMatchesSchema } from '../host/resumeSchemaValidation.js';
import { requestSubjectV2, type RunSubjectV2 } from '../host/runOwner.js';
import { tenantOf } from '../host/requestSubject.js';
import { getEventLog, RunLogClosedError } from '../executor/eventLog.js';
import { emitTerminalFailure, executeRun, RUN_DISPATCH_LEASE_MS } from '../executor/executor.js';
import { timeoutApprovalGateIfDue } from '../executor/approvalGateTimeout.js';
import { normalizeApprovalAction, resumeActionSpelling } from '../executor/interruptActions.js';
import { createLogger } from '../observability/logger.js';
import { resolveRunDefinition } from '../host/resolveRunDefinition.js';
import { createHostAdapterSuite, type HostAdapterSuite } from '../host/index.js';
import { isDispatchWaitInterrupt } from '../host/dispatchWaitAll.js';
import { handleConversationResolve } from '../host/conversationExchange.js';
import { startWorkflowRun } from '../host/runStarter.js';
import { AGENT_MENTION_WORKFLOW_ID, agentMentionConfigurable } from '../host/agentMentionWorkflows.js';
import { appendDecision, tallyDecisions, clearDecisions, evaluateQuorumTally, readRejectionPolicy, type DecisionOutcome } from '../host/reviewDecisionLedger.js';
import { listTenantMembers, resolveEffectiveAccess } from '../host/accessControlService.js';
import { isEligibleApprover, consumeVoteIdentity, gateAclOf, gateApproverRefs } from '../host/approverResolution.js';
import { isAutonomyGateData, isAutonomyRequester } from '../host/autonomyPolicy/selfApproval.js';
import { verifyVoterBinding } from '../host/interruptVoterBinding.js';
import { loadOwnedRun } from '../host/runAccess.js';
import { holdsRunApprovalGrant } from '../host/runApprovalGrant.js';
import { holdsProtocolScope, grantMayStandIn, withdrawScopeChallenge } from '../host/protocolAuthorization.js';
import { resolveCallerUser } from '../features/users/usersGuards.js';
import { callerHoldsTenantScope } from '../features/featureRoute.js';
import { emitReviewUpdatedSignal } from '../notifications/notify.js';
import { recordInterruptResolved } from '../observability/metricSeams.js';
import { VENDOR_ROOT } from '../middleware/protocolVersion.js';
import { verifyInterruptToken } from '../host/interruptToken.js';

const log = createLogger('routes.interrupts');

interface Deps {
  storage: Storage;
  hostSuite?: HostAdapterSuite;
}

/** Constant-time token re-comparison (RFC 0093 §B.3). The lookup itself is a
 *  DB unique-index probe; this re-check makes the in-process comparison that
 *  gates the response explicitly timing-safe. */
function tokenMatches(presented: string, stored: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** RFC 0093 §B.1 — a token past its `expiresAt` is refused with the canonical
 *  410 `interrupt_expired` envelope. Pre-migration rows (no expiresAt) never
 *  expire. */
function interruptTokenExpired(interrupt: InterruptRecord, now: number = Date.now()): boolean {
  if (!interrupt.expiresAt) return false;
  const expires = Date.parse(interrupt.expiresAt);
  return Number.isFinite(expires) && now > expires;
}

/** Run statuses that invalidate an unresolved interrupt's token
 *  (RFC 0093 §B.2 — resolved, or the owning run cancelled or completed). */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Shared signed-token gate for GET + POST /v1/interrupts/{token}
 * (RFC 0093 §B.1-B.3). Looks the token up, lazily times out an overdue
 * approval gate, then enforces the lifecycle refusals in spec order:
 *   404 invalid_interrupt_token  — unknown token
 *   409 interrupt_already_resolved — resolved (incl. a gate this call just
 *       timed out), or the owning run is terminal while unresolved
 *   410 interrupt_expired — past expiresAt while unresolved
 * Returns the interrupt for the happy path. When `allowResolved` is true
 * (inspect), a resolved interrupt is returned instead of refused so the
 * inspect view can report `resolved: true`.
 */
async function loadInterruptByTokenChecked(
  storage: Storage,
  token: string,
  opts: { allowResolved: boolean; verifyScheme?: boolean },
): Promise<InterruptRecord> {
  // `spec/v2/core/identity.md` §4 / `interrupt.md` §Tokens (RFC 0170 §E.1) —
  // under major 2 the SCHEME is checked before the store is touched: an `alg`
  // this host does not advertise, a `kid` it does not hold, a MAC that does not
  // verify, or a string outside the `ow2.<alg>.<kid>.<payload>.<mac>` grammar
  // is `401 interrupt_token_invalid`. One code for all four states — never
  // `not_found` for a token this host cannot verify.
  //
  // A token WITHOUT the `ow2.` prefix is this host's own v1 credential and is
  // drained under `kid: legacy` (`persistence.md` §"Everything else a v1 host
  // persisted"): it falls through to the store lookup below, which answers
  // `404` when it names no interrupt. That is the honest split for the token
  // this host actually issued — an opaque random row key with no MAC to verify,
  // so "unverifiable" and "unknown" are the same observation.
  //
  // `verifyScheme` is set by the PROTOCOL routes only. The vendor
  // `interrupt-action` links (email/chat one-click, host dialect) take the store
  // lookup they always took, prefixed token or not (ADR 0812 P3c).
  if (opts.verifyScheme === true) {
    const verdict = verifyInterruptToken(token);
    if (verdict.form === 'invalid') {
      throw new OpenwopError('interrupt_token_invalid', verdict.reason, 401);
    }
  }
  const interrupt = await storage.getInterruptByToken(token);
  if (!interrupt || !tokenMatches(token, interrupt.token)) {
    throw new OpenwopError('invalid_interrupt_token', 'unknown interrupt token', 404);
  }
  // Lazy half of the RFC 0093 §D timeout enforcement — an overdue approval
  // gate auto-rejects before this access can act on it.
  if (await timeoutApprovalGateIfDue(storage, interrupt)) {
    throw new OpenwopError('interrupt_already_resolved', 'approval gate timed out (auto-rejected; reason: timeout)', 409);
  }
  if (interrupt.resolvedAt) {
    // ADR 0778 C12 — a gate closed BY a run cancel (the cascade marker) was
    // never decided: it answers the terminal-run 409 it answered while the
    // cancel still left it open, not `200 {resolved:true}`.
    // The marker alone is caller-writable (a token holder can resolve a
    // clarification with `{cancelled:true}`), so the run must agree.
    if (isCancelCascade(interrupt) && (await storage.getRun(interrupt.runId))?.status === 'cancelled') {
      throw new OpenwopError('interrupt_already_resolved', 'interrupt token invalidated — owning run is cancelled', 409, { runStatus: 'cancelled' });
    }
    if (opts.allowResolved) return interrupt;
    throw new OpenwopError('interrupt_already_resolved', 'interrupt already resolved', 409);
  }
  if (interruptTokenExpired(interrupt)) {
    throw new OpenwopError('interrupt_expired', 'interrupt token past its expiry', 410, {
      expiresAt: interrupt.expiresAt,
    });
  }
  // Unresolved token on a terminal run: invalidated per RFC 0093 §B.2.
  const run = await storage.getRun(interrupt.runId);
  if (run && TERMINAL_RUN_STATUSES.has(run.status)) {
    throw new OpenwopError(
      'interrupt_already_resolved',
      `interrupt token invalidated — owning run is ${run.status}`,
      409,
      { runStatus: run.status },
    );
  }
  return interrupt;
}

export function registerInterruptRoutes(app: Express, deps: Deps): void {
  const { storage } = deps;
  // Lazily build a host suite for workflow lookups on resume; routes layer
  // below also reuses this. The shared suite is constructed in index.ts;
  // this fallback keeps the file self-contained for tests.
  const hostSuite = deps.hostSuite ?? createHostAdapterSuite({ storage });

  /** ADR 0189 — lazy expiry for connect-to-continue prompts: an EXPIRED,
   *  unresolved `openwop-connection` interrupt resumes as `{action:'skip'}`
   *  so the suspended node returns its graceful no-op (approval gates, by
   *  contrast, fail closed via timeoutApprovalGateIfDue). Best-effort: a
   *  race with a live resolve loses quietly. Returns true when THIS call
   *  resolved it (callers drop it from "open" listings). */
  const timeoutConnectionPromptIfDue = async (it: InterruptRecord): Promise<boolean> => {
    if (it.resolvedAt) return false;
    const data = (it.data ?? {}) as { profile?: unknown };
    if (data.profile !== 'openwop-connection') return false;
    if (!it.expiresAt || Date.parse(it.expiresAt) > Date.now()) return false;
    // Atomic claim BEFORE driving the resume (the approvalGateTimeout ENG-6
    // pattern): this runs on an idempotent GET the chat + run-detail both poll
    // concurrently, so without the compare-and-set NULL→resolved two readers
    // would each re-dispatch executeRun for the same node. resolveInterrupt
    // returns won only to the flip-winner; the loser drops it from the listing
    // without resuming. resolveAndResume's own (discarded-won) resolve is then
    // a no-op second write, and it dispatches the re-invoke exactly once.
    const skippedAt = new Date().toISOString();
    const won = await storage.resolveInterrupt(it.interruptId, { action: 'skip' }, skippedAt);
    if (!won) return true;
    // ADR 0556 P1 — CAS winner only. This runs on a GET both the chat and the
    // run detail poll, so counting every caller would multiply one expiry by
    // however many surfaces happened to be open.
    recordInterruptResolved(it, 'skipped', skippedAt);
    try {
      await resolveAndResume(storage, hostSuite, it.interruptId, { action: 'skip' }, { preclaimed: true });
    } catch {
      /* the claim already dropped it from open; a dispatch failure surfaces on the run */
    }
    return true;
  };

  app.post('/runs/:runId/interrupts/:nodeId', async (req, res, next) => {
    try {
      // RFC 0049 (ADR 0006 Phase 3) — resolving a run's interrupt gates on
      // `approvals:respond` (`rest-endpoints.md` names it for exactly this route,
      // `interrupt.md` §"resume" likewise) AND on run.tenantId ownership.
      // CORRECTED (ADR 0745 follow-up): this read `runs:read`, "the node-resume
      // floor", so a key minted read-only could answer an approval gate — a
      // MUTATION on a read grant. `approvals:respond` is what the spec names. Tenant-ownership gate (2026-07 vuln-scan):
      // loadOwnedRun refuses a cross-tenant runId (a bare getInterruptByNode let a
      // caller who knew another tenant's runId+nodeId inject a resumeValue into that
      // tenant's suspended run). No streamToken bypass — resume is a mutation. Quorum
      // eligibility + capability-token checks still apply below.
      const { runId, nodeId } = req.params;
      await loadOwnedRunForDecision(req, storage, runId);
      const interrupt = await storage.getInterruptByNode(runId, nodeId);
      if (!interrupt) {
        // RFC 0213 §C — `getInterruptByNode` returns OPEN interrupts only
        // (`resolved_at IS NULL`), so the realistic second resolve — accept, the run
        // completes, resolve again — lands HERE, not at the terminal check below,
        // which only an unresolved interrupt on a terminal run reaches (a state
        // this host never produces). A terminal owning run answers
        // `409 interrupt_already_resolved` ("already resolved, or the run is
        // cancelled or completed"). That covers a run cancel, which CLOSES its
        // own gates (ADR 0778 D3).
        const terminalRun = await storage.getRun(runId);
        if (terminalRun && TERMINAL_RUN_STATUSES.has(terminalRun.status)) {
          throw new OpenwopError(
            'interrupt_already_resolved',
            `no open interrupt — owning run is ${terminalRun.status}`,
            409,
            { runStatus: terminalRun.status },
          );
        }
        throw new OpenwopError('interrupt_not_found', 'no open interrupt for this node', 404);
      }
      // Cascaded-cancel detection per `interrupt-profiles.md
      // §openwop-interrupt-parent-child`: when the run is cancelled,
      // the interrupt is invalidated. Prefer 410 Gone over 409 so the
      // contract distinguishes "resource removed by external state"
      // from "resource already resolved by you" — the conformance suite
      // accepts both, but Gone is the more honest answer.
      const currentRun = await storage.getRun(runId);
      // ADR 0744 — under major 2 the answer is `409 interrupt_already_resolved`
      // for EVERY terminal owning run (v2 `errors.md` §One code per state,
      // `interrupt.md` resolve table; RFC 0171 C4.6 "one code per state"). The
      // `interrupt_gone` 410 below is a host code with no v2 registry row — the
      // negotiator vendor-prefixed it, so a v2 client saw
      // `openwop-app.interrupt_gone`, a code no v2 reader can act on.
      if (
        currentRun &&
        TERMINAL_RUN_STATUSES.has(currentRun.status) &&
        !interrupt.resolvedAt
      ) {
        throw new OpenwopError(
          'interrupt_already_resolved',
          `interrupt invalidated — owning run is ${currentRun.status}`,
          409,
          { runStatus: currentRun.status },
        );
      }
      if (currentRun && currentRun.status === 'cancelled') {
        throw new OpenwopError('interrupt_gone', 'interrupt invalidated — run was cancelled', 410);
      }
      // RFC 0093 §D — lazy gate-timeout check: an overdue approval gate
      // auto-rejects (fail closed) before this vote/resolve can land.
      if (await timeoutApprovalGateIfDue(storage, interrupt)) {
        throw new OpenwopError('interrupt_already_resolved', 'approval gate timed out (auto-rejected; reason: timeout)', 409);
      }
      if (interrupt.resolvedAt) throw new OpenwopError('interrupt_already_resolved', 'interrupt already resolved', 409);
      // Conversation primitive (RFC 0005 §D/§E): an `exchange` processes the
      // turn + agent reply and STAYS suspended; only `close` resumes. Routed to
      // the conversation handler, which validates the turn itself.
      if (interrupt.kind === 'conversation') {
        // CS-BE-1 — resolve the AUTHENTICATED caller for the handler's
        // per-conversation visibility gate (fail-soft: an anonymous/unresolvable
        // caller passes undefined, and only unowned conversations then resolve).
        // ADR 0839 D1 — a SUBJECT-owned conversation (a project room) is decided by
        // the subject seam, which is handed `callerPrincipal` below when there is no
        // canonical user, so an anonymous demo owner or an `owk_` key still resolves.
        const caller = await resolveCallerUser(req).catch(() => null);
        const callerPrincipal = req.userId ?? req.principal?.principalId;
        const result = await handleConversationResolve(
          storage, interrupt, (req.body as { resumeValue?: unknown })?.resumeValue,
          (id, val) => resolveAndResume(storage, hostSuite, id, val),
          // ADR 0089 — inject the provider policy resolver so a tool-bearing
          // @mentioned agent can run its tool loop (the loop's adapter needs it).
          {
            policyResolver: hostSuite.providerPolicyResolver,
            ...(caller ? { callerUserId: caller.userId } : {}),
            // ADR 0834 D3 — the run-stamp derivation, for the bypass authority check.
            ...(callerPrincipal ? { callerPrincipal } : {}),
            // ADR 0089 Phase 4 (Option B) — dispatch a deep-investigation
            // @mentioned agent's tool loop as a SEPARATE persisted run via the
            // standard run path (the synthetic `openwop-app.agent-mention`
            // workflow). The conversation embeds it as a `workflow_run` bubble.
            startAgentMentionRun: ({ tenantId, agentId, task, provider, model, credentialRef, metadata, orgScopeSubject }) => {
              // BYOK fix (review): a non-managed credentialRef must be REGISTERED in
              // `configurable.credentialRefs` so `prepareRunSecrets` resolves it into the
              // nested run's secret scope (the adapter's resolveCredential reads it).
              // Passing it only via `inputs` left BYOK deep-investigation runs throwing
              // `byok_required_but_unresolved`.
              const configurable = agentMentionConfigurable(credentialRef);
              return startWorkflowRun(
                { storage, hostSuite },
                {
                  tenantId,
                  workflowId: AGENT_MENTION_WORKFLOW_ID,
                  inputs: {
                    agentId,
                    task,
                    ...(provider ? { provider } : {}),
                    ...(model ? { model } : {}),
                    ...(credentialRef ? { credentialRef } : {}),
                  },
                  ...(Object.keys(configurable).length > 0 ? { configurable } : {}),
                  ...(metadata ? { metadata } : {}),
                  ...(orgScopeSubject ? { orgScopeSubject } : {}),
                },
              );
            },
          },
        );
        const cRun = await storage.getRun(runId);
        // ADR 0178 — thread the BYOK spend soft-warning onto the ack. The FE's
        // conversationClient narrows `body.notice`; this route silently DROPPED
        // the handler's `result.notice`, so the warning never reached a client
        // (found during the ADR 0327 P1 characterization pass). Sync path only —
        // the async path acks before the dispatch that would compute it.
        res.json({
          runId, nodeId, status: cRun?.status ?? 'waiting-input',
          conversation: { operation: result.operation, turns: result.turns.length },
          ...(result.notice ? { notice: result.notice } : {}),
        });
        return;
      }
      const body = req.body as ResolveInterruptRequest;
      validateResumeValue(interrupt, body?.resumeValue);
      await requireInterruptDecider(req, storage, interrupt); // ADR 0778 D2
      // ADR 0070 — the vote identity is the authenticated USER session
      // (`req.userId`): we pin it (eligibility-enforced) and IGNORE the client
      // `voter` field (anti-spoofing). A bare API-key / bearer principal with NO
      // user session is the RFC 0093 capability-token transport — the token
      // authorizes ACCESS, and the body `voter` declares WHICH approver (distinct
      // voters on one token), so we DON'T pin the single principal id (that would
      // dedup every token vote into one). An anon cookie session (no `userId`,
      // `session:`/`anon:` principal) is NEITHER — it fails closed on a quorum
      // gate (see `assertTokenQuorumVote`); the API-key path sets a `bearer:`
      // principal id (middleware/auth.ts).
      // ADR 0778 D6 — one derivation for both session lanes (`reviewerOf`).
      await resolveAndResume(storage, hostSuite, interrupt.interruptId, body?.resumeValue, await reviewerOf(req));
      const run = await storage.getRun(runId);
      res.json({ runId, nodeId, status: run?.status ?? 'running' });
    } catch (err) {
      next(err);
    }
  });

  app.post('/interrupts/:token', async (req, res, next) => {
    try {
      const { token } = req.params;
      // RFC 0093 §B lifecycle gate: 404 unknown / 409 resolved-or-run-terminal
      // / 410 expired — see loadInterruptByTokenChecked.
      const interrupt = await loadInterruptByTokenChecked(storage, token, { allowResolved: false, verifyScheme: true });
      const body = req.body as { resumeValue?: unknown };
      // External-event interrupts validate correlation per
      // `interrupt-profiles.md §openwop-interrupt-external-event`:
      // the resume payload MUST match every field in
      // `interrupt.data.correlation`. Mismatched correlation
      // returns 422 without resuming.
      if (interrupt.kind === 'external-event') {
        const violation = checkExternalEventCorrelation(interrupt.data, body?.resumeValue);
        if (violation) {
          throw new OpenwopError(
            'validation_error',
            `External event correlation mismatch: ${violation}`,
            422,
            { mismatch: violation },
          );
        }
      }
      // The URL token was cryptographically matched to THIS interrupt — the RFC
      // 0093 capability-token path (the token is the authorization; body `voter`
      // declares the approver — on an ACL'd gate it must be eligible AND carry its
      // emailed signature, `assertTokenQuorumVote`, ADR 0899 D1). A public path:
      // no session reaches this route, so a cookie never stands in for the proof.
      await resolveAndResume(storage, hostSuite, interrupt.interruptId, body?.resumeValue, { capabilityToken: true });
      const run = await storage.getRun(interrupt.runId);
      res.json({ runId: interrupt.runId, nodeId: interrupt.nodeId, status: run?.status });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0478 §2 — the email decide-by-token confirm page. The GET renders a
  // form and NEVER mutates (mail scanners prefetch links — a mutating GET
  // would let a corporate link-scanner approve production actions); the POST
  // performs EXACTLY the public token resolution above (same checked load,
  // same resolveAndResume, same 404/409/410 taxonomy). Token possession is
  // the authorization (RFC 0093) — guest approvers need no session.
  const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const confirmShell = (title: string, bodyHtml: string): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem">
${bodyHtml}
</body></html>`;
  // ux-review B1 — a guest clicking a stale email link must get HUMAN copy,
  // never the JSON error envelope (this page's most common path is the late
  // click). Only unexpected errors fall through to next().
  const confirmFailurePage = (res: Response, err: unknown): boolean => {
    if (!(err instanceof OpenwopError)) return false;
    const copy = err.httpStatus === 410
      ? { title: 'This link has expired', body: 'This approval link has expired. Ask for a fresh approval, or review it in the app.' }
      : err.httpStatus === 409
        ? { title: 'Already decided', body: 'This request was already decided (or the run has finished). Nothing more to do.' }
        : err.httpStatus === 404
          ? { title: 'Link not valid', body: 'This link isn\u2019t valid. If you copied it from an email, make sure the whole link was copied.' }
          : null;
    if (!copy) return false;
    res.status(err.httpStatus).type('html').send(confirmShell(copy.title,
      `<h1 style="font-size:1.1rem">${esc(copy.title)}</h1><p>${esc(copy.body)}</p><p><a href="/inbox">Review in the app</a></p>`));
    return true;
  };
  app.get('/host/openwop-app/interrupt-action', async (req, res, next) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const action = req.query.action === 'reject' ? 'reject' : 'approve';
      const voter = typeof req.query.voter === 'string' ? req.query.voter : '';
      const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
      // Grade-code H1 — a voter claim is honored only from a SIGNED emailed
      // link (the binding covers (token, voter)); a hand-edited voter renders
      // the invalid-link story, never a forged-identity form.
      if (voter && !verifyVoterBinding(token, voter, sig)) {
        throw new OpenwopError('not_found', 'Interrupt not found.', 404, {});
      }
      // Validates + surfaces the honest lifecycle answer BEFORE rendering the
      // form (an expired link gets the 410 story in plain language, not a form).
      const interrupt = await loadInterruptByTokenChecked(storage, token, { allowResolved: false });
      const data = (interrupt.data ?? {}) as { prompt?: unknown };
      const prompt = typeof data.prompt === 'string' ? data.prompt.slice(0, 300) : 'Please confirm your decision.';
      const heading = action === 'approve' ? 'Confirm approval' : 'Confirm rejection';
      res.status(200).type('html').send(confirmShell(heading,
        `<h1 style="font-size:1.1rem">${esc(heading)}</h1>
<p>${esc(prompt)}</p>
<form method="post" action="${VENDOR_ROOT}/interrupt-action">
<input type="hidden" name="token" value="${esc(token)}">
<input type="hidden" name="action" value="${esc(action)}">
<input type="hidden" name="voter" value="${esc(voter)}">
<input type="hidden" name="sig" value="${esc(sig)}">
<label>Optional comment<br><input type="text" name="comment" maxlength="500" style="width:100%"></label>
<p><button type="submit">${esc(action === 'approve' ? 'Approve' : 'Reject')}</button></p>
</form>
<p style="color:#666;font-size:0.85rem">Nothing happens until you press the button. This link expires with the request.</p>`));
    } catch (err) {
      if (!confirmFailurePage(res, err)) next(err);
    }
  });
  app.post('/host/openwop-app/interrupt-action', urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const token = typeof b.token === 'string' ? b.token : '';
      const action = b.action === 'reject' ? 'reject' : 'approve';
      const voter = typeof b.voter === 'string' && b.voter.length > 0 ? b.voter : undefined;
      const sig = typeof b.sig === 'string' ? b.sig : '';
      const comment = typeof b.comment === 'string' && b.comment.trim().length > 0 ? b.comment.trim().slice(0, 500) : undefined;
      // Grade-code H1 — reject a voter claim without its emailed (token, voter)
      // binding BEFORE any resolution work (assertTokenQuorumVote re-verifies
      // on every ACL'd gate, ADR 0899 D1; this check also covers OPEN gates so a
      // forged voter never reaches the decision ledger).
      if (voter && !verifyVoterBinding(token, voter, sig)) {
        throw new OpenwopError('not_found', 'Interrupt not found.', 404, {});
      }
      const interrupt = await loadInterruptByTokenChecked(storage, token, { allowResolved: false });
      await resolveAndResume(storage, hostSuite, interrupt.interruptId, {
        action,
        ...(voter ? { voter, voterSig: sig } : {}),
        ...(comment ? { comment } : {}),
      }, { capabilityToken: true });
      res.status(200).type('html').send(confirmShell('Decision recorded',
        `<h1 style="font-size:1.1rem">Decision recorded</h1><p>Your ${esc(action === 'approve' ? 'approval' : 'rejection')} was recorded. You can close this page.</p>`));
    } catch (err) {
      if (!confirmFailurePage(res, err)) next(err);
    }
  });

  // Authenticated list of open interrupts for a run. Returns tokens —
  // public event log no longer carries them (see executor.ts §node.suspended).
  //
  // Vendor-prefixed under /v1/host/openwop-app/* per host-extensions.md
  // §"Canonical prefixes". This endpoint is a strong RFC candidate —
  // every host that strips tokens from the public event log needs a
  // way for authed callers to list open interrupts with tokens. For
  // now it stays sample-scoped to avoid contract drift.
  app.get('/host/openwop-app/runs/:runId/interrupts', async (req, res, next) => {
    try {
      // Tenant-ownership gate (2026-07 vuln-scan — CRITICAL). This endpoint hands
      // out each open interrupt's RFC 0093 capability `token`, which authorizes the
      // PUBLIC POST /v1/interrupts/:token resolve path. A bare getRun let any authed
      // caller who knew another tenant's runId list — and thus HIJACK — that tenant's
      // HITL/approval gates. loadOwnedRun enforces run.tenantId ownership and does
      // NOT honor the read-only ?streamToken (a read grant must never yield resume
      // tokens); a non-owned run 404s with no existence leak.
      const run = await loadOwnedRun(req, storage, req.params.runId, 'runs:read');
      // ADR 0755 D3 — listing is a `runs:read`; the `token` in each row is the
      // authority to ANSWER the gate (the token route checks nothing else), so it
      // is projected only to a holder of `approvals:respond` — the scope the
      // run-scoped resolve route requires. Before this a `runs:read` key read the
      // token here and resolved through `POST /v1/interrupts/{token}`.
      const mayHoldToken = decideTokenProjector(req, run.tenantId, await holdsProtocolScope(req, 'approvals:respond'));
      const open = await storage.listOpenInterrupts(run.runId);
      // RFC 0093 §D lazy enforcement on the read path: an overdue approval
      // gate auto-rejects here and drops out of the "open" listing.
      // ADR 0189 — an EXPIRED connect-to-continue prompt instead RESUMES as
      // skip (the run degrades to the graceful no-op rather than parking;
      // this read is the chat's poll, so the only runs that can suspend —
      // interactive ones — get healed the next time anyone looks).
      const stillOpen: typeof open[number][] = [];
      for (const it of open) {
        if (await timeoutApprovalGateIfDue(storage, it)) continue;
        if (await timeoutConnectionPromptIfDue(it)) continue;
        stillOpen.push(it);
      }
      const withToken = await Promise.all(stillOpen.map((it) => mayHoldToken(it)));
      res.json({
        runId: run.runId,
        interrupts: stillOpen.map((it, i) => ({
          interruptId: it.interruptId,
          nodeId: it.nodeId,
          kind: it.kind,
          ...(withToken[i] ? { token: it.token } : {}),
          data: it.data,
          resumeSchema: it.resumeSchema,
          createdAt: it.createdAt,
          ...(it.expiresAt ? { expiresAt: it.expiresAt } : {}),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/interrupts/:token', async (req, res, next) => {
    try {
      // RFC 0093 §B.4 — a resolve-intent token authorizes inspect too, so the
      // same lifecycle gate applies (410 expired / 409 run-terminal). A
      // RESOLVED interrupt stays inspectable (`resolved: true`) — the
      // already-resolved 409 belongs to the resolve surface.
      const interrupt = await loadInterruptByTokenChecked(storage, req.params.token, { allowResolved: true, verifyScheme: true });
      res.json({
        kind: interrupt.kind,
        key: interrupt.interruptId,
        resumeSchema: interrupt.resumeSchema,
        data: interrupt.data,
        // RFC 0093 §B.4 — inspect reports the token's expiry.
        ...(interrupt.expiresAt ? { expiresAt: interrupt.expiresAt } : {}),
        resolved: interrupt.resolvedAt != null,
      });
    } catch (err) {
      next(err);
    }
  });
}

/**
 * Validate `resumeValue` against the interrupt's declared shape.
 * Per `interrupt.md §"resumeSchema"`: a resolve payload that
 * violates the schema MUST be rejected with 400 (validation_error)
 * or 422. Today we cover the common-case approval-gate enum check
 * (data.actions must contain resumeValue.action) without pulling
 * Ajv into the route layer; richer JSON-Schema validation can stack
 * later as resume contracts grow.
 */
// Exported (ADR 0068) so the unified /reviews action surface validates an
// interrupt resume through the SAME contract the interrupt routes use.
export function validateResumeValue(
  interrupt: { kind: string; data: unknown; resumeSchema?: unknown },
  resumeValue: unknown,
): void {
  if (interrupt.kind === 'credential') {
    assertCredentialResumeShape(resumeValue);
    return;
  }
  if (interrupt.kind !== 'approval') return;
  const data = (interrupt.data ?? {}) as { actions?: unknown };
  if (!Array.isArray(data.actions)) return;
  const allowed = data.actions.filter((a): a is string => typeof a === 'string');
  if (allowed.length === 0) return;
  const action = (resumeValue && typeof resumeValue === 'object'
    ? (resumeValue as { action?: unknown }).action
    : undefined);
  // loop row 3, P2 — interrupt.md §Events — `interrupt.requested` advertises the NORMALISED actions (a
  // gate listing `approve` offers `accept` on the wire), so a client that posts
  // the advertised spelling must be admitted. Only `approve` ≡ `accept`:
  // `override` is a bypass, never admitted by equivalence (resumeActionSpelling).
  if (typeof action !== 'string' || !allowed.map(resumeActionSpelling).includes(resumeActionSpelling(action))) {
    throw new OpenwopError(
      'validation_error',
      `resumeValue.action MUST be one of [${allowed.join(', ')}]; received ${JSON.stringify(action)}.`,
      400,
      { allowed, received: action },
    );
  }
  assertActionPayloadComplete(resumeValue as Record<string, unknown> | null | undefined, action);
}

/**
 * RFC 0199 §C.4 / §E.3 — a `credential` resume is exactly `{outcome}` with
 * `authorized | declined`. Closed so a credential cannot be submitted through it
 * (§C.6): any other property, or any other outcome, is refused.
 */
function assertCredentialResumeShape(resumeValue: unknown): void {
  const rv = resumeValue && typeof resumeValue === 'object' && !Array.isArray(resumeValue) ? (resumeValue as Record<string, unknown>) : null;
  const keys = rv ? Object.keys(rv) : [];
  if (!rv || keys.length !== 1 || keys[0] !== 'outcome' || (rv.outcome !== 'authorized' && rv.outcome !== 'declined')) {
    throw new OpenwopError(
      'validation_error',
      "resumeValue for a credential interrupt MUST be exactly { outcome: 'authorized' | 'declined' } (RFC 0199 §C.4) — it never carries a credential.",
      400,
      { field: 'resumeValue' },
    );
  }
}

/**
 * RFC 0199 §C.4 — `authorized` is RE-CHECKED, never trusted: refused unless a
 * credential for the run's Subject, the provider and the scopes resolves NOW.
 * Runs in `resolveAndResume`, the choke point every path shares (the REST
 * resolve, the token resolve, MCP, and the host's own resolve when a grant
 * completes), through the same resolver the node's token fetch uses.
 */
async function assertCredentialAuthorizedResolves(storage: Storage, interrupt: { runId: string; data: unknown }, resumeValue: unknown): Promise<void> {
  if ((resumeValue as { outcome?: unknown } | null)?.outcome !== 'authorized') return;
  const run = await storage.getRun(interrupt.runId);
  const data = (interrupt.data ?? {}) as { provider?: unknown; scopes?: unknown };
  const actingUserId = typeof (run?.metadata as Record<string, unknown> | undefined)?.actingUserId === 'string'
    ? ((run!.metadata as Record<string, unknown>).actingUserId as string)
    : undefined;
  const status = run && typeof data.provider === 'string'
    ? await credentialStatusFor({
      tenantId: run.tenantId,
      provider: data.provider,
      scopes: Array.isArray(data.scopes) ? data.scopes.filter((x): x is string => typeof x === 'string') : [],
      ...(actingUserId !== undefined ? { actingUserId } : {}),
    })
    : { status: 'missing' as const };
  if (status.status !== 'ok') {
    throw new OpenwopError(
      'validation_error',
      'outcome "authorized" is refused: no credential for this provider and scopes resolves yet (RFC 0199 §C.4). Complete the authorization at connectUrl first.',
      400,
      { field: 'resumeValue' },
    );
  }
}

/**
 * RFC 0183 §A.2 (ADR 0705) — the two actions whose MEANING IS INCOMPLETE
 * without their payload: *"A host recording `action: 'refine'` MUST carry
 * `refineFeedback`; a host recording `action: 'edit-accept'` MUST carry
 * `editedArtifactData`."*
 *
 * Refused at resolve time rather than dropped at emit time, because the host
 * cannot record what it was never given — accepting the resolution and then
 * emitting an incomplete `interrupt.resolved` would put the violation in the
 * durable event log, where a replay reproduces it forever.
 *
 * BOTH arms are enforced, though suite 2.2.0's scenario exercises only
 * `refine`. The MUST is one sentence covering two actions; shipping the tested
 * half would leave a rule that greps as implemented and is not.
 */
function assertActionPayloadComplete(
  resumeValue: Record<string, unknown> | null | undefined,
  action: string,
): void {
  const rv = (resumeValue ?? {}) as Record<string, unknown>;
  if (action === 'refine') {
    const fb = rv.refineFeedback;
    if (!fb || typeof fb !== 'object' || Array.isArray(fb)) {
      throw new OpenwopError(
        'validation_error',
        "resumeValue.refineFeedback is REQUIRED when action is 'refine' (RFC 0183 §A.2) — the feedback is what the action means.",
        400,
      );
    }
    // `interrupt.md` §RefineFeedback is a CLOSED object with `required:
    // [scope]`. Only `scope` is asserted here: the full closure is the
    // schema's job (`check-v2-schemas`), and a host inventing extra refusals
    // would narrow a shape the corpus deliberately left admissible.
    const scope = (fb as { scope?: unknown }).scope;
    if (scope !== 'whole' && scope !== 'section' && scope !== 'items') {
      throw new OpenwopError(
        'validation_error',
        `resumeValue.refineFeedback.scope MUST be one of [whole, section, items]; received ${JSON.stringify(scope)}.`,
        400,
      );
    }
    return;
  }
  if (action === 'edit-accept' && rv.editedArtifactData === undefined) {
    throw new OpenwopError(
      'validation_error',
      "resumeValue.editedArtifactData is REQUIRED when action is 'edit-accept' (RFC 0183 §A.2).",
      400,
    );
  }
}

/**
 * RFC 0183 §A.1/§A.2 (ADR 0705) — the `interrupt.resolved` fields that carry
 * WHICH action was applied, for an approval-kind resolution.
 *
 * `interruptResolved` is `additionalProperties: false`, so every key here must
 * be one the def declares — which is why `outcome` is absent from the accept
 * path (ADR 0688 § The field that is not there) and why this returns a spread
 * rather than stamping defaults.
 */
/** Exported for test: the emitted-payload half has no other observable seam
 *  short of a full suspend/resume round trip, and a leg that cannot reach
 *  the code it names is a gate that cannot fail (measured — see ADR 0705). */
export function resolvedActionFields(kind: string, resumeValue: unknown): Record<string, unknown> {
  // RFC 0199 §C.4 — a credential resolution records its closed `{outcome}`; it is
  // validated closed before it gets here, so it can carry no credential.
  if (kind === 'credential') {
    const outcome = (resumeValue as { outcome?: unknown } | null)?.outcome;
    return outcome === 'authorized' || outcome === 'declined' ? { resumeValue: { outcome } } : {};
  }
  if (kind !== 'approval') return {};
  const rv = (resumeValue && typeof resumeValue === 'object' ? resumeValue : {}) as Record<string, unknown>;
  const raw = rv.action;
  if (typeof raw !== 'string') return {};
  // ADR 0725 — the RECORD carries the corpus enum (`interruptResolved.action`:
  // accept | reject | refine | edit-accept | timeout). This host's quorum path
  // also accepts the spellings `approve` (a vote) and `override` (the bypass
  // path, whose governance outcome is `decision: 'overridden'`); both APPLY
  // `accept`, so that is what the record says. Measured: 4 enum violations.
  const action = normalizeApprovalAction(raw);
  return {
    action,
    // Conditional, not unconditional: `validateResumeValue` has already
    // REFUSED a refine with no feedback, so an absent value here means the
    // action is one that does not take it — not that a required field was
    // dropped on the way to the log.
    ...(action === 'refine' && rv.refineFeedback !== undefined ? { refineFeedback: rv.refineFeedback } : {}),
    ...(action === 'edit-accept' && rv.editedArtifactData !== undefined ? { editedArtifactData: rv.editedArtifactData } : {}),
  };
}

/** Per `interrupt-profiles.md §openwop-interrupt-external-event`:
 *  the resume payload's fields MUST match every field in the
 *  interrupt's `data.correlation` object. Returns null on match, or
 *  a description of the first mismatch on miss.
 *
 *  Match semantics are deep-equal on each correlation key. Extra
 *  fields in the resume payload (e.g., the test's
 *  `externalReference`) are ignored — only the correlation keys
 *  declared by the suspended node need to match. */
function checkExternalEventCorrelation(
  interruptData: unknown,
  resumeValue: unknown,
): string | null {
  const data = (interruptData ?? {}) as { correlation?: unknown };
  const correlation = data.correlation;
  if (!correlation || typeof correlation !== 'object') return null;
  if (!resumeValue || typeof resumeValue !== 'object') {
    return 'resumeValue MUST be an object when interrupt declares correlation';
  }
  const rv = resumeValue as Record<string, unknown>;
  for (const [key, expected] of Object.entries(correlation as Record<string, unknown>)) {
    if (JSON.stringify(rv[key]) !== JSON.stringify(expected)) {
      return `correlation.${key} expected ${JSON.stringify(expected)}, got ${JSON.stringify(rv[key])}`;
    }
  }
  return null;
}

// Quorum votes live in the DURABLE `review:decision` ledger (ADR 0070 —
// host/reviewDecisionLedger.ts), keyed `(interruptId, reviewerRef)`, so they
// survive restart, are correct across instances, and dedup per reviewer. The
// final gate transition stays the `storage.resolveInterrupt` CAS (one winner).

/** Per-run resume serialization queue. See `resolveAndResume` below
 *  for the race this guards against. Keyed by runId; each entry is
 *  the tail of a promise chain whose `.then(…)` reads the freshest
 *  persisted `schedulerSnapshot`, dispatches `executeRun`, and waits
 *  for that executor to settle before unblocking the next resume.
 *  In-memory by design — same lifetime as the per-run interrupt
 *  state and the in-flight HTTP requests; a process restart drains
 *  the queue, which is fine since each resume reads its snapshot
 *  fresh anyway. */
const runResumeChains = new Map<string, Promise<void>>();

/** Result of feeding one vote into a quorum gate. `override` is set when the
 *  vote took the gate's override path (RFC 0093 §D.2) — the caller MUST then
 *  emit `approval.overridden { principal, reason }` + an audit entry per
 *  `interrupt-profiles.md` §"Approval gate". */
interface QuorumVoteResult {
  outcome: 'accept-quorum-met' | 'reject-quorum' | 'pending' | 'accept-override';
  override?: { principal: string; reason: string };
}

/** Accumulate a quorum vote. Returns:
 *   - outcome 'accept-quorum-met' → run can resume with accepted outcome
 *   - outcome 'accept-override' → an override principal bypassed quorum
 *     (only when the gate config sets `overrideBypassesQuorum: true` —
 *     RFC 0093 §D.2; default false ⇒ the override counts as ONE vote)
 *   - outcome 'reject-quorum' → gate fails with rejection (per the gate's
 *     rejectionPolicy: 'any' default ⇒ one reject vetoes; 'majority' ⇒ > half)
 *   - outcome 'pending' → record vote, return 200 to client, DON'T resume
 *   - null → not a quorum gate; caller proceeds with normal resume */
async function recordQuorumVote(
  interruptId: string,
  interruptData: unknown,
  resumeValue: unknown,
  reviewerRef: string | undefined,
  voteIdentity?: { countAs: string; actedBy?: string },
  tenantId?: string, // ADR 0464 — stamped on each ledger row for subject erasure.
): Promise<QuorumVoteResult | null> {
  const data = (interruptData ?? {}) as {
    requiredApprovals?: number;
    rejectionPolicy?: string;
    override?: unknown;
    overrideBypassesQuorum?: unknown;
  };
  const requiredApprovals = typeof data.requiredApprovals === 'number' && data.requiredApprovals > 1
    ? data.requiredApprovals
    : 0;
  if (requiredApprovals === 0) return null; // not a quorum gate
  const rv = (resumeValue ?? {}) as { action?: string; voter?: string; override?: unknown; reason?: unknown };

  // The vote IDENTITY (ADR 0070/0198): the CONSUMED identity from eligibility
  // (the reviewer, or the principal a delegate acts for) when present;
  // otherwise the legacy client `voter` (the signed-token path, where the token
  // is the capability) or an anon counter. NEVER trust `voter` over an
  // authenticated reviewer — eligibility was already enforced upstream.
  // ADR 0778 D4(a) — never an invented identity. This used to fall back to
  // `anon-${n}`, so one caller repeating a voterless vote met any quorum.
  const namedVoter = typeof rv.voter === 'string' && rv.voter.trim() !== '' ? rv.voter : undefined;
  const voter = voteIdentity?.countAs ?? reviewerRef ?? namedVoter;
  if (!voter) {
    throw new OpenwopError('validation_error', 'A quorum vote must identify its voter.', 400, { field: 'resumeValue.voter' });
  }
  const actedBy = voteIdentity?.actedBy;

  // Override path (RFC 0093 §D.2 + interrupt-profiles.md §"Approval gate").
  // A vote takes the override path when it says so (`action: 'override'` or
  // `override: true` alongside an accept) AND the gate's config actually
  // declares an `override` block — a gate without one has no override path
  // to take (fail closed: the flag alone grants nothing).
  const isOverrideAttempt = rv.action === 'override' || (rv.action === 'accept' && rv.override === true);
  const gateHasOverridePath = !!data.override && typeof data.override === 'object';
  if (isOverrideAttempt && gateHasOverridePath) {
    // `reason` is REQUIRED on the override path (spec: approval.overridden
    // carries { principal, reason } with reason REQUIRED).
    if (typeof rv.reason !== 'string' || rv.reason.length === 0) {
      throw new OpenwopError(
        'validation_error',
        'The approval-gate override path requires a non-empty `reason` (interrupt-profiles.md §"Approval gate").',
        400,
        { field: 'reason' },
      );
    }
    const override = { principal: voter, reason: rv.reason };
    if (data.overrideBypassesQuorum === true) {
      // Opt-in bypass: a single override accept resolves the gate. Record the
      // decision (audited as an override) before resolving.
      await appendDecision({ gateId: interruptId, reviewerRef: voter, ...(tenantId ? { tenantId } : {}), outcome: 'override_approved', reason: rv.reason, decidedAt: new Date().toISOString() });
      return { outcome: 'accept-override', override };
    }
    // Default (false/absent): the override grant counts as ONE quorum vote —
    // recorded as `override_approved` so it is auditable as an override.
    const outcome = await tallyVote(interruptId, requiredApprovals, data.rejectionPolicy, 'override_approved', voter, rv.reason, actedBy, tenantId);
    return { outcome, override };
  }

  // ADR 0478 (review HIGH-1) — on a QUORUM gate an unknown action must NEVER
  // fall through to the single-resume path (a silent one-click quorum
  // defeat, proven end-to-end): map the common 'approve' synonym to the
  // tally's 'accept' verb, and fail CLOSED on anything else.
  const voteAction = rv.action === 'approve' ? 'accept' : rv.action;
  if (voteAction !== 'accept' && voteAction !== 'reject') {
    throw new OpenwopError(
      'validation_error',
      `A quorum gate vote must be 'accept'/'approve' or 'reject' (got '${String(rv.action)}').`,
      400,
      { field: 'action' },
    );
  }
  const outcome: DecisionOutcome = voteAction === 'accept' ? 'approved' : 'rejected';
  return { outcome: await tallyVote(interruptId, requiredApprovals, data.rejectionPolicy, outcome, voter, undefined, actedBy, tenantId) };
}

/** Append the reviewer's decision to the DURABLE ledger (overwrite-by-reviewer =
 *  dedup), then evaluate the gate over the full ledger. The final transition
 *  itself stays the `storage.resolveInterrupt` CAS in `resolveAndResume`. */
async function tallyVote(
  interruptId: string,
  requiredApprovals: number,
  rejectionPolicy: string | undefined,
  outcome: DecisionOutcome,
  voter: string,
  reason?: string,
  actedBy?: string,
  tenantId?: string,
): Promise<'accept-quorum-met' | 'reject-quorum' | 'pending'> {
  await appendDecision({ gateId: interruptId, reviewerRef: voter, outcome, ...(reason ? { reason } : {}), ...(actedBy ? { actedBy } : {}), ...(tenantId ? { tenantId } : {}), decidedAt: new Date().toISOString() });
  const tally = await tallyDecisions(interruptId);
  // Single source of truth for the threshold + rejection math (ADR 0070).
  const verdict = evaluateQuorumTally(tally, {
    requiredApprovals,
    // ADR 0600 §6 — the shared READER. Coerces (never refuses) because this
    // reads an already-persisted interrupt; see `normalizeRejectionPolicy`.
    rejectionPolicy: readRejectionPolicy(rejectionPolicy),
  });
  if (verdict === 'accept') return 'accept-quorum-met';
  if (verdict === 'reject') return 'reject-quorum';
  return 'pending';
}

async function clearQuorumVotes(interruptId: string): Promise<void> {
  await clearDecisions(interruptId);
}

/**
 * Eligibility gate (ADR 0070) — enforced ONLY when the host knows the
 * authenticated reviewer (the token path stays capability-based). A vote is
 * accepted iff the reviewer is on the gate's explicit `approverRefs`; a gate
 * with NO explicit approver list is an OPEN quorum gate (any authenticated
 * reviewer may vote — the gate counts distinct identities, deduped by subject).
 * An OVERRIDE additionally requires one of the gate's `overrideScopes`.
 * Visible-but-ineligible → 403 (the route already 404s a non-visible interrupt).
 *
 * **Why empty-list = open (not scope-gated).** The `openwop-interrupt-quorum`
 * profile (`interrupt-profiles.md`) is pure vote-COUNTING to a threshold +
 * `rejectionPolicy`; per-subject AUTHORIZATION is the SEPARATE
 * `openwop-interrupt-auth-required` profile. The conformance fixture
 * `conformance-interrupt-quorum` (empty `approversList`, three voters, an
 * API-key caller) asserts an open gate accepts votes; requiring an
 * `approvals:respond` scope here previously 403'd that scenario and blocked the
 * (honest) discovery claim. An empty-list gate is still far stronger than the
 * pre-0070 in-memory `voter`-from-body counter (real identity, no spoofing,
 * durable dedup); authors who want an ACL set `approverRefs`.
 *
 * **CORRECTED (ADR 0677 D1).** That last clause was FALSE as written for years: setting
 * `approverRefs` did nothing unless the author ALSO set `requiredApprovals > 1`, because the
 * early return below fired first. The coupling was undocumented and is the reason the only
 * two ACL-declaring gates in the corpus are authored without a threshold. A non-empty ACL
 * now binds on its own, in BOTH lanes — which is what RFC 0173 §B requires.
 *
 * NOTE — the pre-execution **approval** quorum path (`host/approvalDecision.ts`
 * `evaluateQuorum`) DELIBERATELY differs: there an empty list still requires the
 * `approvals:respond` scope (higher-stakes, no conformance obligation). The two
 * are intentionally asymmetric; keep them that way.
 */
async function assertEligibleApprover(
  storage: Storage,
  interrupt: InterruptRecord,
  reviewerRef: string,
  resumeValue: unknown,
): Promise<{ countAs: string; actedBy?: string } | undefined> {
  const data = (interrupt.data ?? {}) as { requiredApprovals?: number; approverRefs?: unknown; approversList?: unknown; approverGroupRefs?: unknown; approverRoleRefs?: unknown; overrideScopes?: unknown };
  const requiredApprovals = typeof data.requiredApprovals === 'number' && data.requiredApprovals > 1 ? data.requiredApprovals : 0;
  // ADR 0677 D1 — a DECLARED ACL binds regardless of `requiredApprovals`.
  //
  // This used to be `if (requiredApprovals === 0) return undefined;`, which returned BEFORE
  // `approverRefs` was ever read — so a gate declaring an explicit approver list but no
  // quorum threshold was an OPEN gate, and the docblock's own advice ("authors who want an
  // ACL set `approverRefs`") was false as written. RFC 0173 §B makes this a MUST, not a
  // preference: `v2-approver-enforced.test.ts` pins "a host advertising `interrupt` MUST
  // refuse a resolver not in approversList with 403 (enforcement, not advice)" over a
  // fixture that carries NO `requiredApprovals`.
  //
  // The empty-list rule is UNCHANGED and load-bearing: `openwop-interrupt-quorum` is pure
  // vote-counting and `conformance-interrupt-quorum.json` pins `approversList: []` as an
  // open gate. Only a NON-EMPTY declaration now binds.
  const declaresAcl =
    (Array.isArray(data.approverRefs) && data.approverRefs.some((r) => typeof r === 'string' && r.trim() !== '')) ||
    (Array.isArray(data.approversList) && data.approversList.some((r) => typeof r === 'string' && r.trim() !== '')) ||
    (Array.isArray(data.approverGroupRefs) && data.approverGroupRefs.some((r) => typeof r === 'string' && r.trim() !== '')) ||
    (Array.isArray(data.approverRoleRefs) && data.approverRoleRefs.some((r) => typeof r === 'string' && r.trim() !== ''));
  if (requiredApprovals === 0 && !declaresAcl) return undefined; // open, non-quorum → no eligibility gate
  const run = await storage.getRun(interrupt.runId);
  const tenantId = run?.tenantId ?? 'default';
  const access = await resolveEffectiveAccess(tenantId, { subject: reviewerRef });

  const rv = (resumeValue ?? {}) as { action?: string; override?: unknown; actedFor?: unknown };
  const isOverride = rv.action === 'override' || (rv.action === 'accept' && rv.override === true);
  const overrideScopes = Array.isArray(data.overrideScopes) ? data.overrideScopes.filter((s): s is string => typeof s === 'string') : [];
  // ADR 0677 D1 part 4 — the override branch stays QUORUM-ONLY on purpose. Making the ACL
  // bind (above) newly reaches this code on single-approver gates, where it would return
  // `{countAs}` WITHOUT consulting the ACL — and because `recordQuorumVote` returns null for
  // a non-quorum gate (`:603`), the RFC 0093 §D.2 `approval.overridden` event and its
  // audit-sink row are never written. That is an ACL bypass with NO audit trail: a new
  // defect shipped inside the fix for the old one. Gating on `requiredApprovals > 1` keeps
  // override semantics exactly as they were and leaves the non-quorum path to the ACL check.
  if (requiredApprovals > 1 && isOverride && overrideScopes.length > 0) {
    if (!overrideScopes.some((s) => (access.scopes as readonly string[]).includes(s))) {
      throw new OpenwopError('forbidden', 'Override requires one of the gate\'s override scopes.', 403, { interruptId: interrupt.interruptId });
    }
    // An override is the principal's OWN authority — it never rides a delegation.
    return { countAs: reviewerRef };
  }
  // Eligibility (ADR 0075 §D1) — explicit subjects (`approverRefs`, or the legacy
  // `approversList`) ∪ group members ∪ role holders, resolved through the single
  // approver authority against the run's fail-closed org (`run.metadata.approverOrgId`,
  // §D3) and CANONICALIZED to userIds so a group member's `oidc:` subject matches
  // the bound-user reviewer's userId (§D6). An empty set ⇒ open quorum gate (any
  // authenticated reviewer may vote — the `openwop-interrupt-quorum` contract).
  const subjects = (Array.isArray(data.approverRefs) ? data.approverRefs : Array.isArray(data.approversList) ? data.approversList : [])
    .filter((r): r is string => typeof r === 'string');
  const groupRefs = Array.isArray(data.approverGroupRefs) ? data.approverGroupRefs.filter((r): r is string => typeof r === 'string') : [];
  const roleRefs = Array.isArray(data.approverRoleRefs) ? data.approverRoleRefs.filter((r): r is string => typeof r === 'string') : [];
  const approverOrgId = (run?.metadata as Record<string, unknown> | undefined)?.approverOrgId;
  // ADR 0942 D7 — the one builder, so `allowDelegation:false` reaches eligibility on this lane too.
  const gateRefs = { ...gateApproverRefs(interrupt.data), approverRefs: subjects, approverGroupRefs: groupRefs, approverRoleRefs: roleRefs };
  const gateCtx = { tenantId, ...(typeof approverOrgId === 'string' ? { orgId: approverOrgId } : {}) };
  const { eligible, openGate } = await isEligibleApprover(reviewerRef, gateRefs, gateCtx);
  if (!openGate && !eligible) {
    throw new OpenwopError('forbidden', 'You are not an eligible approver for this gate.', 403, { interruptId: interrupt.interruptId });
  }
  // ADR 0198 §identity — open gates vote as self; non-open gates consume
  // exactly one identity (self when directly eligible, else the covered
  // principal — explicit `actedFor` when the delegate covers several).
  if (openGate) return { countAs: reviewerRef };
  // ADR 0677 D1 — a NON-quorum ACL gate needs the 403-or-pass decision only. `consumeVoteIdentity`
  // is quorum vote-identity machinery: it can throw a 400 ("You cover several approvers — pass
  // `actedFor`") and its `countAs`/`actedBy` are discarded on this path, since `recordQuorumVote`
  // returns null for a non-quorum gate. Calling it here would surface a confusing 400 on a gate
  // that counts no votes.
  if (requiredApprovals === 0) return { countAs: reviewerRef };
  return consumeVoteIdentity(reviewerRef, gateRefs, gateCtx, typeof rv.actedFor === 'string' ? rv.actedFor : undefined);
}

/**
 * Quorum eligibility for a caller with NO bound user identity (ADR 0070). Two
 * cases for a quorum gate (`requiredApprovals > 1`):
 *   - `isCapabilityToken` (a signed RFC 0093 interrupt token, or a bearer /
 *     API-key principal): the token IS the authorization, and its body `voter`
 *     declares the approver. When the gate lists explicit approvers, that `voter`
 *     MUST be one of them — otherwise a single token could satisfy a restricted
 *     N-approver gate with fabricated voter ids. An OPEN gate (empty list) admits
 *     any `voter`, matching the `openwop-interrupt-quorum` conformance contract.
 *     ADR 0899 D1 — on ANY gate that declares an ACL (quorum or single-approver),
 *     the `voter` must also carry its emailed `(token, voter)` binding: a listed
 *     name alone is a claim, not a proof.
 *   - otherwise (anon cookie session / no principal): a quorum vote fails closed
 *     — the node route has no per-run owner check, so eligibility is the only
 *     authorization on this path, and an anonymous caller is not an approver.
 * No-op for an interrupt that is neither a quorum gate nor ACL'd (the
 * clarification / open single-approver / token resume paths are unchanged).
 */
async function assertTokenQuorumVote(
  interrupt: InterruptRecord,
  resumeValue: unknown,
  isCapabilityToken: boolean,
  storage?: Pick<Storage, 'getRun'>,
): Promise<{ countAs: string; actedBy?: string } | undefined> {
  const data = (interrupt.data ?? {}) as { requiredApprovals?: number };
  const requiredApprovals = typeof data.requiredApprovals === 'number' && data.requiredApprovals > 1 ? data.requiredApprovals : 0;
  const acl = gateAclOf(interrupt.data);
  // ADR 0677 D1 part 1 — THIS lane carried the identical early return, and it is the lane
  // every token caller drives: the API-key/bearer path, the RFC 0093 signed-token route, the
  // email decide-by-token POST, MCP (`host/mcpSemantics.ts`) and inbound webhooks.
  // `resolveAndResume` picks this one whenever there is no bound user, so fixing only
  // `assertEligibleApprover` would leave the ACL unconsulted for every one of them — and the
  // RFC 0173 §B conformance fixture is resolved by a BEARER, so the MUST is only closed with
  // both lanes. An empty list still admits any voter (the quorum contract).
  if (requiredApprovals === 0 && !acl.declared) return undefined; // open, non-quorum
  if (!isCapabilityToken) {
    throw new OpenwopError('forbidden', 'Voting on a quorum gate requires an authenticated approver or a valid interrupt token.', 403, { interruptId: interrupt.interruptId });
  }
  const rv = (resumeValue ?? {}) as { voter?: unknown; voterSig?: unknown; actedFor?: unknown };
  const voter = typeof rv.voter === 'string' && rv.voter.trim() !== '' ? rv.voter : undefined;
  if (!acl.declared) {
    // ADR 0778 D4(a) — an OPEN quorum gate counts distinct `voter`s (the
    // `openwop-interrupt-quorum` contract). A vote naming none used to be
    // recorded as `anon-${n}`, so repeating one POST met any quorum: the host
    // invented the identities it then counted. It is refused instead.
    if (!voter) {
      throw new OpenwopError('validation_error', 'A quorum vote on this lane must name its `voter`.', 400, { field: 'resumeValue.voter' });
    }
    return undefined;
  }
  // ADR 0778 D4(b) — the FULL ACL, through the single resolver the session lane
  // uses. This lane used to read only `approverRefs`/`approversList`, so a gate
  // whose approvers were a GROUP or ROLE was open here: any `voter` string was
  // admitted and no signature checked. Refused as 403 (not 400) when `voter` is
  // absent, so `v2-approver-enforced` keeps its 403 (C8).
  if (!voter) {
    throw new OpenwopError('forbidden', 'The `voter` is not an eligible approver for this gate.', 403, { interruptId: interrupt.interruptId });
  }
  const run = storage ? await storage.getRun(interrupt.runId) : null;
  // Fail closed without the run: its tenant and org are what the group/role
  // refs resolve against, and a `'default'` guess would resolve them elsewhere.
  if (storage && !run) {
    throw new OpenwopError('forbidden', 'The `voter` is not an eligible approver for this gate.', 403, { interruptId: interrupt.interruptId });
  }
  const gateRefs = gateApproverRefs(interrupt.data);
  const approverOrgId = (run?.metadata as Record<string, unknown> | undefined)?.approverOrgId;
  const gateCtx = { tenantId: run?.tenantId ?? 'default', ...(typeof approverOrgId === 'string' ? { orgId: approverOrgId } : {}) };
  const { eligible } = await isEligibleApprover(voter, gateRefs, gateCtx);
  if (!eligible) {
    throw new OpenwopError('forbidden', 'The `voter` is not an eligible approver for this gate.', 403, { interruptId: interrupt.interruptId });
  }
  // Grade-code H1 (ADR 0478 correction), widened by ADR 0778 D4(c) from explicit
  // lists to EVERY declared ACL, and by ADR 0899 D1 to every gate SIZE: the token
  // is handed to every `approvals:respond` holder (the listing) and shared across
  // every emailed approver, so an unproven `voter` let any of them resolve the
  // gate AS a named approver. ADR 0677 scoped this to quorum gates on the premise
  // that single-approver emailed links carry no binding; they do — every emailed
  // link is signed for its recipient (`emailApprovalDelivery.ts`), so a real
  // recipient is unaffected. (`ISWF-23`, closed.)
  const voterSig = typeof rv.voterSig === 'string' ? rv.voterSig : '';
  if (!verifyVoterBinding(interrupt.token, voter, voterSig)) {
    throw new OpenwopError('forbidden', 'This vote requires the signed per-approver link from your notification email.', 403, { interruptId: interrupt.interruptId });
  }
  // ADR 0677 D1 — a NON-quorum ACL gate needs the 403-or-pass decision only (see
  // `assertEligibleApprover`); the vote-identity machinery below is quorum-only.
  if (requiredApprovals === 0) return undefined;
  // ADR 0778 C6 — the ADR 0198 consumed identity, as on the session lane: a
  // delegate voting by email counts as the principal they cover, so the pair can
  // never count twice.
  return consumeVoteIdentity(voter, gateRefs, gateCtx, typeof rv.actedFor === 'string' ? rv.actedFor : undefined);
}

/**
 * ADR 0778 D1 (grade-code `APCD-2`) — what a LOST claim tells its caller. A
 * branch that lost may only return quietly when the decision that WON is the
 * same verdict it was trying to record; otherwise its caller would be told a
 * result that did not happen (a tipping voter told "OK" while the timeout had
 * already rejected the gate; a rejecter told "OK" while an accept released the
 * downstream). The verdict is read back from what the winner stored.
 */
async function answerLostClaim(storage: Storage, interruptId: string, attempted: 'accepted' | 'rejected'): Promise<void> {
  const stored = await storage.getInterrupt(interruptId);
  const v = (stored?.resolvedValue ?? null) as { action?: unknown; reason?: unknown; cancelled?: unknown; cascadedFromParent?: unknown } | null;
  const closedByCancel = !!v && (v.cancelled === true || typeof v.cascadedFromParent === 'string');
  const storedRejected = !!v && (v.action === 'reject' || v.action === 'timeout' || v.reason === 'timeout' || v.reason === 'quorum-reject');
  const sameVerdict = !closedByCancel && (attempted === 'rejected' ? storedRejected : !storedRejected);
  if (sameVerdict) return;
  throw new OpenwopError('interrupt_already_resolved', 'interrupt already resolved — a different decision won', 409);
}

/** ADR 0778 (grade-code `APCD-6`) — the terminal-run check before the claim is
 *  a read; a cancel can close the run log between it and the append below. The
 *  claim is already won then, so answer the truth (409, run terminal) rather
 *  than the 500 the closed log throws. */
async function appendResolution(event: Parameters<ReturnType<typeof getEventLog>['append']>[0]): Promise<void> {
  try {
    await getEventLog().append(event);
  } catch (err) {
    if (err instanceof RunLogClosedError) {
      throw new OpenwopError('interrupt_already_resolved', 'interrupt invalidated — owning run ended while it was being decided', 409, { closedBy: err.closedBy });
    }
    throw err;
  }
}

/**
 * ADR 0778 C1 — the timer sweep's resume continuation. The sweep CLAIMS the row
 * first (`executor/timerResume.ts`), so this resume is PRECLAIMED: without the
 * flag, the accept path's own claim (D1) loses to the sweep's and every ADR 0267
 * timed wait throws 409 with its interrupt consumed and its run never resumed.
 * Lives here, not inline at boot, so the wiring itself is witnessable.
 */
export function timerResumeContinuation(storage: Storage, hostSuite: HostAdapterSuite): (interrupt: InterruptRecord) => Promise<void> {
  return (interrupt) => resolveAndResume(storage, hostSuite, interrupt.interruptId, { elapsed: true, reason: 'timer' }, { preclaimed: true });
}

/** ADR 0778 D3 — was this interrupt closed by a run cancel rather than decided?
 *  `host/runCancel.ts` stamps `{ cancelled: true }` on the run's own gates and
 *  `{ cascadedFromParent }` on its children's. */
export function isCancelCascade(interrupt: InterruptRecord): boolean {
  const v = interrupt.resolvedValue as { cancelled?: unknown; cascadedFromParent?: unknown } | null | undefined;
  return !!v && typeof v === 'object' && (v.cancelled === true || typeof v.cascadedFromParent === 'string');
}

/**
 * ADR 0778 D6 — who a SESSION decide lane votes as, derived ONE way for both the
 * node route and `/reviews` (they used to disagree: `req.userId` here,
 * `req.userId ?? principalId` there, so one human was two ledger keys).
 *  - a signed-in person (`auth.kind === 'subject'`): the CANONICAL user
 *    (`resolveCallerUser`), so an unbound OIDC bearer and the cookie session are
 *    one voter;
 *  - a bound session without that: `req.userId`, as before;
 *  - a `bearer:` env key: the RFC 0093 capability lane (body `voter`) — never a
 *    subject, or `conformance-interrupt-quorum`'s three voters on one bearer
 *    would dedup into one (C4);
 *  - anything else (an anon cookie, an `apikey:`): no identity, so a quorum or
 *    ACL gate fails closed — never the raw `session:<sid>` (C5).
 */
const reviewerMemo = new WeakMap<Request, Promise<{ subjectRef: string; resolvedBy?: RunSubjectV2 } | { capabilityToken: boolean }>>();
export function reviewerOf(req: Request): Promise<{ subjectRef: string; resolvedBy?: RunSubjectV2 } | { capabilityToken: boolean }> {
  // Once per request (grade-code `APCD-9`): `resolveCallerUser` can write (the
  // canonical-user fold), and the inbox read calls this for `canDecide`.
  let hit = reviewerMemo.get(req);
  if (!hit) {
    hit = deriveReviewer(req);
    reviewerMemo.set(req, hit);
  }
  return hit;
}

async function deriveReviewer(req: Request): Promise<{ subjectRef: string; resolvedBy?: RunSubjectV2 } | { capabilityToken: boolean }> {
  // ADR 0932 — the Subject that resolved, from the SAME mapping the run owner
  // stamp uses, so `resolvedBy` and `run.started.owner.subject` agree.
  const resolvedBy = requestSubjectV2(req, tenantOf(req));
  if (req.principal?.auth?.kind === 'subject') {
    try {
      return { subjectRef: (await resolveCallerUser(req)).userId, ...(resolvedBy ? { resolvedBy } : {}) };
    } catch {
      /* unresolvable subject — fall through to the bound session, if any */
    }
  }
  if (req.userId) return { subjectRef: req.userId, ...(resolvedBy ? { resolvedBy } : {}) };
  return { capabilityToken: req.principal?.principalId?.startsWith('bearer:') ?? false };
}

/**
 * ADR 0778 D2 — the decide floor itself: `approvals:respond` held in `tenantId`,
 * read the way kanban and the agent area read authority (`callerHoldsTenantScope`).
 *
 * RECONCILED WITH ADR 0755 D3 (caught by the row-6 gate). A credential — an
 * `owk_` key — that EXPLICITLY declares `approvals:respond` is a responder by
 * that declaration in a tenant with NO member rows, where membership is not the
 * authority at all (the posture `adr0755-key-lane-scopes` pins, and the one
 * `emailApprovalDelivery` already honours for memberless tenants). Once a tenant
 * has members, the key is judged by its issuer's membership like everything
 * else, so a Viewer's key cannot decide what the Viewer cannot. An undeclared
 * (`*`) key never takes this arm.
 */
async function holdsDecideFloor(req: Request, tenantId: string): Promise<boolean> {
  if (await callerHoldsTenantScope(req, tenantId, 'approvals:respond')) return true;
  const auth = req.principal?.auth;
  if (auth?.kind !== 'api-key' || !Array.isArray(auth.scopes) || !auth.scopes.includes('approvals:respond')) return false;
  return (await listTenantMembers(tenantId)).length === 0;
}

/**
 * ADR 0778 D2 (grade-code `APCD-1`) — may this caller be HANDED an approval
 * gate's resume token? The token route checks nothing but the token, so handing
 * it out is granting the decision: a Viewer who could not decide on either
 * session lane read the token off the interrupt listing and approved through
 * `POST /v1/interrupts/{token}`. `base` is the existing key/enforcement check
 * (`holdsProtocolScope`); an APPROVAL row additionally needs the always-on floor.
 * Non-approval kinds (chat, clarification) keep `base` — a Viewer answers those.
 */
export function decideTokenProjector(req: Request, tenantId: string, base: boolean): (interrupt: InterruptRecord) => Promise<boolean> {
  let floor: Promise<boolean> | undefined;
  return async (interrupt) => {
    if (!base) return false;
    if (interrupt.kind !== 'approval') {
      // ADR 0932 (Book AI P6) — an interrupt that DECLARES an approver ACL hands
      // its resume token only to a caller on that ACL, whatever the kind. Before,
      // any caller with the base scope got a clarification's token, and the token
      // lane then trusted a body-supplied voter name (ISWF-23), so a workspace
      // Viewer could answer an author's questions by naming the author.
      const acl = gateAclOf(interrupt.data);
      if (!acl.declared) return true;
      const reviewer = await reviewerOf(req);
      if (!('subjectRef' in reviewer)) return false;
      const { eligible } = await isEligibleApprover(
        reviewer.subjectRef,
        { approverRefs: acl.subjects, approverGroupRefs: acl.groupRefs, approverRoleRefs: acl.roleRefs },
        { tenantId },
      );
      return eligible;
    }
    floor ??= holdsDecideFloor(req, tenantId);
    return floor;
  };
}

/**
 * ADR 0778 D2 — the always-on authority floor for deciding an OPEN approval
 * gate on a session lane: `approvals:respond` (Editor and above), read the way
 * kanban and the agent area read it (`callerHoldsTenantScope`: wildcard operator,
 * own personal workspace, key declaration, then membership under either identity
 * spelling). `requireProtocolScope` only consulted membership when
 * `OPENWOP_AUTHORIZATION_ENFORCEMENT=true`, so a Viewer decided every open gate.
 *  - scoped to `kind === 'approval'` (C3): the node route also carries chat,
 *    clarification, walkthrough and credential interrupts a Viewer must answer;
 *  - a gate that DECLARES an ACL is governed by its ACL (eligibility runs in
 *    `resolveAndResume`), as on the approvals lane (`approvalDecision.ts`).
 * Only ever refuses; the token lane is not a session lane and is untouched.
 */
export async function requireInterruptDecider(req: Request, storage: Storage, interrupt: InterruptRecord): Promise<void> {
  if (interrupt.kind !== 'approval') return;
  if (gateAclOf(interrupt.data).declared) return;
  const run = await storage.getRun(interrupt.runId);
  if (!run) return; // resolveAndResume answers the missing/terminal run
  if (await holdsDecideFloor(req, run.tenantId)) return;
  // ADR 0975 D1 — a feature's run-scoped grant (e.g. a KickTodo operator on the
  // Factory runs they started) decides without the tenant-wide scope.
  if (await holdsRunApprovalGrant(req, run)) return;
  throw new OpenwopError('forbidden_scope', 'Missing required scope: approvals:respond', 403, { requiredScope: 'approvals:respond' });
}

/**
 * The node route's entry gate: `approvals:respond` plus run-tenant ownership, as
 * before. ADR 0975 D1 — when ONLY the scope is missing, a run-scoped grant may
 * stand in for it; the tenant gate is still `loadOwnedRun`'s, read at `runs:read`.
 */
export async function loadOwnedRunForDecision(req: Request, storage: Storage, runId: string): Promise<void> {
  try {
    await loadOwnedRun(req, storage, runId, 'approvals:respond');
  } catch (err) {
    // ADR 0975 D8 — the scope refusal `requireProtocolScope` actually throws is
    // `forbidden` + `requiredScope`; testing for `forbidden_scope` alone meant
    // this grant was never asked once enforcement was on.
    if (!grantMayStandIn(req, err, 'approvals:respond')) throw err;
    const run = await loadOwnedRun(req, storage, runId, 'runs:read').catch(() => null);
    if (!run || !(await holdsRunApprovalGrant(req, run))) throw err;
    withdrawScopeChallenge(req);
  }
}

/** ADR 0942 D10.2 — a resume that rejects (a requester may always refuse their own request). */
function isRejectingResume(resumeValue: unknown): boolean {
  const v = resumeValue as { action?: unknown } | null | undefined;
  // The quorum ledger consumes action. A reject alias beside action:approve
  // must never authorize a requester's counting approval vote.
  return v?.action === 'reject';
}

/** ADR 0778 D5 — does this gate need a NAMED approver (a quorum, or a declared
 *  ACL)? A lane with no approver identity (MCP `requestState`) must refuse such a
 *  gate rather than consume it. */
export function needsNamedApprover(interruptData: unknown): boolean {
  const required = (interruptData as { requiredApprovals?: unknown } | null | undefined)?.requiredApprovals;
  return (typeof required === 'number' && required > 1) || gateAclOf(interruptData).declared;
}


/** ADR 0677 D1 — test alias for the TOKEN eligibility lane. Exported because this is the
 *  lane the RFC 0173 §B conformance fixture drives (its resolver is the suite's bearer), and
 *  it is dependency-free, so the MUST can be witnessed directly rather than through a full
 *  route harness. */
export const __assertTokenQuorumVoteForTests = assertTokenQuorumVote;

/** Test-only alias, kept for the regression tests that name it. */
export const __awaitRunResumeChainForTests = awaitRunResumeChain;

/**
 * Await the per-run resume chain: returns once every resume queued for `runId`
 * has settled, immediately when none are pending.
 *
 * Was `__awaitRunResumeChainForTests` and test-only. ADR 0553 P2 gave it a
 * production caller: an MRTR retry (`host/mcpSemantics.resumeInterrupt`) answers
 * the peer's in-flight `tools/call` with the run's NEW state, so it must not
 * read that state while the resume it just triggered is still queued. The
 * alternative — polling the run row — would be a second, weaker way to observe
 * the same fact.
 */
export async function awaitRunResumeChain(runId: string): Promise<void> {
  // Re-poll: the chain entry mutates as each chained resume settles
  // and clears itself, so awaiting one entry is not enough — the
  // .finally() may swap in a fresh tail.
  for (;;) {
    const tail = runResumeChains.get(runId);
    if (!tail) return;
    await tail;
    // Loop: a sibling resume scheduled mid-await would have replaced
    // `tail` in the map. Re-check until the map is empty.
  }
}

/** Test-only seam: exports `resolveAndResume` for regression coverage
 *  of the per-run serialization fix. Production callers go through
 *  the registered HTTP routes above. Resolves as the RFC 0093 capability-token
 *  path (the signed-token route's posture), which these tests simulate. */
export const __resolveAndResumeForTests = (
  storage: Storage,
  hostSuite: HostAdapterSuite,
  interruptId: string,
  resumeValue: unknown,
): Promise<void> => resolveAndResume(storage, hostSuite, interruptId, resumeValue, { capabilityToken: true });

/** Is `nodeId` still `suspended` in a persisted scheduler snapshot? An
 *  unparseable snapshot answers true so the executor's own fallback decides. */
function gateStillSuspended(serialized: string, nodeId: string): boolean {
  try {
    const snap = JSON.parse(serialized) as { nodeState?: Array<[string, string]> };
    const state = snap.nodeState?.find(([id]) => id === nodeId)?.[1];
    return state === undefined || state === 'suspended';
  } catch {
    return true;
  }
}

/**
 * Dispatch the executor for a resolved gate — the ONE resume seam behind every
 * resolution: accept, the single-approver and quorum rejects, and (through the
 * router `index.ts` registers with `approvalGateTimeout`) the timeout sweep.
 *
 * With `rejection`, RFC 0223 (interrupt.md §Rejection): the gate node FAILS in
 * the executor exactly as any node fails, and the scheduler routes it. The
 * caller has already won the resolve CAS and appended `interrupt.resolved`.
 */
export async function dispatchGateResume(
  storage: Storage,
  hostSuite: HostAdapterSuite,
  interrupt: InterruptRecord,
  resumeValue: unknown,
  rejection?: { code: string; message: string; operatorAct?: boolean },
): Promise<void> {
  // Synchronous validation (preserves the pre-existing 404 / 500
  // behaviour on the HTTP response path). These reads aren't racy —
  // they only check existence, not the snapshot. The *snapshot*
  // read moves into the chained block below.
  const run = await storage.getRun(interrupt.runId);
  // ADR 0474 — resume against the run's PINNED revision when stamped (the
  // head may have moved; a resumed run must continue on the def it started).
  const resolvedDef = run ? await resolveRunDefinition(run, hostSuite.workflowCatalog) : null;
  const nodeIndex = resolvedDef ? resolvedDef.definition.nodes.findIndex((n) => n.nodeId === interrupt.nodeId) : -1;
  if (rejection && (!run || !resolvedDef || nodeIndex < 0)) {
    // The interrupt is already consumed, so throwing here would strand the run
    // waiting on a gate nothing can resolve. Nothing can be routed without the
    // definition, so fail closed through the executor's own terminal helper,
    // naming the gate.
    if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
      await emitTerminalFailure({
        storage, runId: run.runId, nodeId: interrupt.nodeId, failedNodeId: interrupt.nodeId,
        error: { code: rejection.code, message: rejection.message }, skipOnlineEvals: rejection.operatorAct === true,
      });
    }
    return;
  }
  if (!run) throw new OpenwopError('run_not_found', `run ${interrupt.runId} missing during resume`, 404);
  if (!resolvedDef) throw new OpenwopError('workflow_not_found', `workflow ${run.workflowId} not found`, 404);
  const wf = { workflowId: run.workflowId, definition: resolvedDef.definition };
  if (nodeIndex < 0) throw new OpenwopError('internal_error', `suspended node ${interrupt.nodeId} not in workflow`, 500);

  // Per-run resume serialization. Concurrent resolves of *parallel*
  // suspended interrupts (e.g. a fan-out workflow where 4 approval
  // nodes all suspend on the same run, then the user approves all
  // four in quick succession) used to race on the persisted
  // `schedulerSnapshot`:
  //
  //   1. Each call read `run.schedulerSnapshot` at API time,
  //      capturing the same stale snapshot in which *all four*
  //      approvals are still suspended.
  //   2. Each call scheduled its own `executeRun` via setImmediate.
  //      The four executors ran concurrently — each one hydrated
  //      from the captured stale snapshot, marked *only its own*
  //      resumed node `completed`, drained, and persisted.
  //   3. Each persist overwrote the previous one. Net effect: only
  //      the *last* executor's view (one resume) survived in the
  //      stored snapshot. The other three resumes emitted
  //      `interrupt.resolved` but never reached `run.resumed`
  //      / `node.completed` — silently dropped.
  //
  // Symptom in the event log: 4 × `interrupt.resolved`, but
  // only 1-2 × `run.resumed` + `node.completed`. The user-facing
  // chat shows the workflow stuck at "Running" forever.
  //
  // Fix: chain the snapshot read + executor dispatch behind any
  // pending resume on the *same* runId so each resume hydrates from
  // the freshest persisted snapshot. The HTTP response still
  // returns immediately (we don't await `next` here) — only the
  // background executor work serializes.
  const prevChain = runResumeChains.get(interrupt.runId) ?? Promise.resolve();
  const next: Promise<void> = prevChain.then(async () => {
    // Re-read the run AFTER the previous resume's executor has
    // fully settled and persisted its snapshot. This is what fixes
    // the race — pre-chain, every concurrent resume read the same
    // pre-any-resume snapshot.
    let freshRun = await storage.getRun(interrupt.runId);
    if (!freshRun) {
      log.warn('resume skipped — run record vanished between resolve + execute', {
        runId: interrupt.runId,
      });
      return;
    }
    // A resume that queued behind one which already settled this gate — a
    // losing concurrent accept behind a routed rejection, or two accepts — has
    // nothing left to do. The accept path cannot CAS its own resolve (callers
    // such as the MCP retry pre-claim the interrupt, so the resolve here is a
    // deliberate no-op second write); this is where exactly-once is enforced
    // for the EXECUTION instead. Without it a losing accept would hydrate the
    // snapshot the rejection just persisted and mark the failed gate completed.
    if (TERMINAL_RUN_STATUSES.has(freshRun.status)) return;
    if (isDispatchWaitInterrupt(interrupt)) {
      const { claimDispatchWaitResume } = await import('../host/dispatchWaitAll.js');
      freshRun = await claimDispatchWaitResume(storage, interrupt, resumeValue, RUN_DISPATCH_LEASE_MS);
      if (!freshRun) return;
    }
    if (typeof freshRun.schedulerSnapshot === 'string' && !gateStillSuspended(freshRun.schedulerSnapshot, interrupt.nodeId)) {
      log.info('resume skipped — gate already settled by an earlier resume', { runId: interrupt.runId, nodeId: interrupt.nodeId });
      return;
    }
    // Resume the DAG scheduler. If a serialized snapshot exists
    // (post-DAG), hydrate it and mark the suspended node as
    // completed with the resolved value. If not (legacy linear
    // path), fall back to `resumeFromNodeIndex` which the executor
    // handles via its implicit-linear chain logic.
    const serializedSnapshot = freshRun.schedulerSnapshot;
    // ctx.suspend/ctx.interrupt nodes tag the interrupt for re-invoke resume
    // (the node re-runs to shape the resolution into its outputs); native
    // return-and-resume nodes use the default mark-completed path.
    const idata = (interrupt.data ?? {}) as { __resumeStyle?: unknown; __resumeKey?: unknown };
    const reinvokeOpts = idata.__resumeStyle === 'reinvoke'
      ? { resumeStyle: 'reinvoke' as const, ...(typeof idata.__resumeKey === 'string' ? { resumeKey: idata.__resumeKey } : {}) }
      : {};
    // RFC 0223 — a rejection FAILS the gate node inside the executor, so the
    // scheduler's triggerRule logic routes it (resumeRejection overrides the
    // resume style: a rejected gate is never re-invoked). On the legacy
    // no-snapshot path the gate's own index is the resume target.
    const rejectionOpts = rejection ? { resumeRejection: rejection, resumeNodeId: interrupt.nodeId } : {};
    const legacyIndex = rejection ? nodeIndex : nodeIndex + 1;
    const resumeOptions =
      typeof serializedSnapshot === 'string'
        ? (() => {
            try {
              return {
                resumeSnapshot: JSON.parse(serializedSnapshot) as never,
                resumeNodeId: interrupt.nodeId,
                resumeValue,
                ...reinvokeOpts,
                ...rejectionOpts,
                policyResolver: hostSuite.providerPolicyResolver,
              };
            } catch {
              return {
                resumeFromNodeIndex: legacyIndex,
                resumeValue,
                ...rejectionOpts,
                policyResolver: hostSuite.providerPolicyResolver,
              };
            }
          })()
        : {
            resumeFromNodeIndex: legacyIndex,
            resumeValue,
            ...rejectionOpts,
            policyResolver: hostSuite.providerPolicyResolver,
          };
    // AWAIT here — the chain's whole purpose is that the next
    // resume's snapshot read sees this executor's persist.
    await executeRun(storage, freshRun, wf.definition, resumeOptions);
  }).catch((err) => {
    log.error('resume dispatch failed', {
      runId: interrupt.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }).finally(() => {
    // Only clear if we're still the tail — a subsequent resolve may
    // have chained another resume onto us. Clearing then would
    // strand the chain entry, and the next concurrent resolve
    // would start a fresh unserialized chain that races with us.
    if (runResumeChains.get(interrupt.runId) === next) {
      runResumeChains.delete(interrupt.runId);
    }
  });
  runResumeChains.set(interrupt.runId, next);
}

// Exported (ADR 0068) so the unified /reviews action surface resolves an
// interrupt through the SAME quorum/resume/replay path as the interrupt routes —
// the projection never re-implements resume.
export async function resolveAndResume(
  storage: Storage,
  hostSuite: HostAdapterSuite,
  interruptId: string,
  resumeValue: unknown,
  reviewer?: {
    subjectRef?: string;
    capabilityToken?: boolean;
    /** ADR 0932 (Book AI P6) — the resolving Subject, recorded as
     *  `interrupt.resolved.resolvedBy` (the v1 interrupt.md MUST carried into
     *  v2). Present on the session lanes; a bare capability token has no
     *  identity to record, so it stays absent rather than invented. */
    resolvedBy?: RunSubjectV2;
    /** The caller already WON `storage.resolveInterrupt` for this interrupt (the
     *  ENG-6 claim pattern — the MCP retry, the connection-prompt expiry). The
     *  reject paths' own CAS would then lose and return, stranding the run with
     *  its interrupt consumed and nothing resumed; this tells them the claim is
     *  already theirs. */
    preclaimed?: boolean;
    /** ADR 0935 — the host's own join of a parallel dispatch wave
     *  (`host/dispatchWaitAll.ts`). The only lane that may resolve that wait. */
    hostDispatchJoin?: boolean;
  },
): Promise<void> {
  const interrupt = await storage.getInterrupt(interruptId);
  if (!interrupt) throw new OpenwopError('interrupt_not_found', 'interrupt missing on resume', 404);
  // ADR 0935 — a dispatch wave's wait resolves when its children finish, and its
  // resume value IS the join. Refused on every other lane, before any claim, so a
  // caller cannot forge which children completed (or strand the wave by trying).
  if (isDispatchWaitInterrupt(interrupt) !== (reviewer?.hostDispatchJoin === true)) {
    throw new OpenwopError(
      'forbidden',
      reviewer?.hostDispatchJoin === true
        ? 'hostDispatchJoin resolves only a dispatch wait.'
        : 'This wait resolves itself when every dispatched child run has finished; decide the children instead.',
      403,
      { interruptId },
    );
  }
  // ADR 0942 P4b — a veto window is ended ONLY by the timer sweep. The sweep CAS-
  // claims the interrupt itself (`storage.resolveInterrupt`) and then resumes
  // through here with `preclaimed` and the timer's own resume value — the one
  // shape no session or MCP caller can produce. Anyone else resolving it early
  // would skip the window the notified people were promised.
  const sweepTimerResume = reviewer?.preclaimed === true
    && (resumeValue as { elapsed?: unknown; reason?: unknown } | null | undefined)?.elapsed === true
    && (resumeValue as { reason?: unknown }).reason === 'timer';
  if (!sweepTimerResume && interrupt.kind === 'timer' && ((interrupt.data as { autonomy?: { vetoWindow?: unknown } } | undefined)?.autonomy?.vetoWindow === true)) {
    throw new OpenwopError('forbidden', 'This step is waiting out a review window. It runs when the window ends unless someone vetoes it; it cannot be resumed early.', 403, { reason: 'autonomy_veto_window' });
  }
  // ADR 0853 D5 — a PERSON's resolution, announced after the winning claim and
  // its `interrupt.resolved` row (fail-soft; the resume never depends on it).
  const announceResolved = (outcome: 'accepted' | 'rejected', value: unknown): Promise<void> => notifyInterruptResolved({
    runId: interrupt.runId, interruptId, kind: interrupt.kind, outcome, data: interrupt.data, resumeValue: value,
    ...(reviewer?.subjectRef ? { decidedBy: reviewer.subjectRef } : {}),
  });
  // ADR 0778 D3/D7 — refusals that must precede ANY claim, in the one choke point
  // every lane shares (the node route checked some of these itself; `/reviews`,
  // MCP and the rest did not). A preclaimed caller already consumed the row, so
  // for it these would only strand the run: it skips them.
  // ADR 0932 (Book AI P6) — a declared resumeSchema binds every EXTERNAL lane
  // (a session reviewer, a capability token, MCP, the email action, inbound
  // webhooks), before anything is claimed. Host-internal resumes (a timer, a
  // skip, a preclaimed expiry) pass no reviewer or are preclaimed, and keep
  // their host-built values.
  if (reviewer && reviewer.preclaimed !== true && (reviewer.subjectRef !== undefined || reviewer.capabilityToken !== undefined)) {
    assertResumeMatchesSchema(interrupt.resumeSchema, resumeValue);
  }
  if (reviewer?.preclaimed !== true) {
    if (interrupt.resolvedAt) throw new OpenwopError('interrupt_already_resolved', 'interrupt already resolved', 409);
    const ownerRun = await storage.getRun(interrupt.runId);
    if (ownerRun && TERMINAL_RUN_STATUSES.has(ownerRun.status)) {
      throw new OpenwopError('interrupt_already_resolved', `interrupt invalidated — owning run is ${ownerRun.status}`, 409, { runStatus: ownerRun.status });
    }
    // RFC 0093 §D lazy enforcement: an overdue gate auto-rejects (fail closed)
    // before this decision can land. `approvalGateTimeout.ts` promised every
    // path checked; only the node route did.
    if (await timeoutApprovalGateIfDue(storage, interrupt)) {
      throw new OpenwopError('interrupt_already_resolved', 'approval gate timed out (auto-rejected; reason: timeout)', 409);
    }
  }

  // RFC 0209 §C.12 (ADR 0749) — trust is sticky across a surface's fold. An
  // `approval` bound to an A2UI surface that ANY untrusted envelope touched MUST
  // NOT advance, however many trusted updates followed. Checked HERE, the one
  // resume choke point every human path shares (both resolve routes, the email
  // action, /reviews, MCP), so no path can route around it — the MCP
  // `requestState` claim ALSO checks before it consumes (`mcpSemantics.ts`), since
  // a refusal after its claim would strand the interrupt. Every resolution is
  // refused, not just `accept`: an approval's actions are gate-defined strings,
  // and "which one is safe" is not a judgement an untrusted surface should get to
  // exercise. The fail-safe exits stay open — cancel the run, or let the gate's
  // own timeout auto-reject (that path writes the store directly, not via here).
  await assertApprovalSurfaceTrusted(interrupt);
  // A sub-workflow child's gate mirrored onto its parent is not decidable here:
  // resolving it would fabricate the child's completion (subWorkflowMirrorGuard.ts).
  // Same choke point as the trust check above, so every human lane (and MCP, which
  // resolves through here) shares it. Refused before any claim: nothing is consumed.
  await assertNotSubWorkflowMirror(storage, interrupt);
  // RFC 0223 (interrupt.md §Rejection) — `timeout` is a RECORD-ONLY action the
  // host's own timer branch mints (approvalGateTimeout.ts writes the store
  // directly, never through here). A client that could post it would disguise
  // a decision as expiry, so it is refused on every human path — including a
  // gate whose `actions` list happens to name it, and a gate with no list at
  // all, which `validateResumeValue` otherwise leaves open.
  if (interrupt.kind === 'approval' && (resumeValue as { action?: unknown } | null | undefined)?.action === 'timeout') {
    throw new OpenwopError(
      'validation_error',
      "resumeValue.action 'timeout' is record-only: the host mints it when a gate expires and MUST NOT accept it on a resume (RFC 0223).",
      400,
      { field: 'resumeValue.action', received: 'timeout' },
    );
  }
  if (interrupt.kind === 'credential') {
    assertCredentialResumeShape(resumeValue);
    await assertCredentialAuthorizedResolves(storage, interrupt, resumeValue);
  }

  // ADR 0074 — broadcast a `review.updated` cache hint at each terminal outcome
  // so every live review surface reconciles. The interrupt record carries no
  // tenant, so resolve it from the run (a keyed point lookup). Best-effort: the
  // helper swallows emission failures (a cache hint must not break a resume).
  const signalReview = async (
    status: string,
    policy?: { requiredApprovals: number; approvals: number; rejections: number },
  ): Promise<void> => {
    const ownerRun = await storage.getRun(interrupt.runId);
    // Fail closed: without a run we can't determine the tenant, so don't
    // broadcast (the cache hint is best-effort, and an orphaned interrupt has
    // no live surface to update anyway).
    if (!ownerRun) return;
    emitReviewUpdatedSignal({
      tenantId: ownerRun.tenantId,
      reviewId: `interrupt:${interruptId}`,
      status,
      runId: interrupt.runId,
      nodeId: interrupt.nodeId,
      interruptId,
      ...(policy ? { policy } : {}),
    });
  };

  // ADR 0070 — gate a quorum vote on WHO is voting, in three tiers:
  //   (a) a bound authenticated USER (`subjectRef`): pin the identity and enforce
  //       `assertEligibleApprover` (approverRefs membership / approvals:respond);
  //   (b) an RFC 0093 CAPABILITY TOKEN (a signed interrupt token, or a bearer /
  //       API-key principal with no bound user): the token authorizes access and
  //       the body `voter` declares the approver — but it MUST name a listed
  //       approver when the gate declares an ACL, proven by its signed emailed
  //       binding (`assertTokenQuorumVote`, ADR 0899 D1);
  //   (c) anon / no identity: a quorum or ACL'd vote fails closed.
  // (Interrupts that are neither quorum gates nor ACL'd — clarification, open
  // single-approver, conversation — are untouched: both helpers no-op.)
  const reviewerRef = reviewer?.subjectRef;
  // Denial-only requester aliases apply before eligibility too: an API key
  // owned by the requester must not acquire a different refusal path simply
  // because it is not itself a listed approver. Delegated identities are
  // checked again after the existing eligibility resolver below.
  const autonomyApproval = interrupt.kind === 'approval' && isAutonomyGateData(interrupt.data) && !isRejectingResume(resumeValue);
  const autonomyRun = autonomyApproval ? await storage.getRun(interrupt.runId) : null;
  const refuseSelfApproval = (): never => {
    throw new OpenwopError('forbidden_scope', 'You requested this step, so someone else has to approve it.', 403,
      { reason: 'autonomy_self_approval_refused' });
  };
  if (autonomyRun && reviewerRef && await isAutonomyRequester(autonomyRun, [reviewerRef])) refuseSelfApproval();
  // ADR 0198 — eligibility returns the CONSUMED vote identity: the reviewer
  // themselves normally; the covered principal when they vote as a delegate
  // (with `actedBy` preserving who really clicked). The ledger dedups on the
  // consumed identity, so a principal + delegate pair can never count twice.
  let voteIdentity: { countAs: string; actedBy?: string } | undefined;
  if (reviewerRef) voteIdentity = await assertEligibleApprover(storage, interrupt, reviewerRef, resumeValue);
  else voteIdentity = await assertTokenQuorumVote(interrupt, resumeValue, reviewer?.capabilityToken === true, storage);

  // ADR 0942 D10.2 — no self-approval on an autonomy gate, on EVERY vote lane
  // (bound user, capability token, delegate). The run's requesters (its acting
  // user and its owner) may not decide it, and there is no sole-approver escape.
  // Only the approving action is refused: a requester may still reject their own
  // request.
  if (autonomyRun) {
    const voters = [reviewerRef, voteIdentity?.countAs, voteIdentity?.actedBy];
    if (voters.some(Boolean) && await isAutonomyRequester(autonomyRun, voters)) refuseSelfApproval();
  }

  // Quorum-gate handling: accumulate votes (durable ledger) until threshold met.
  // Returns null when not a quorum gate (fall-through to normal resume).
  // ADR 0464 — the interrupt record carries no tenant; resolve it from the run
  // (a keyed point lookup) so each ledger row is tenant-stamped for erasure.
  // Best-effort: an orphaned interrupt leaves the row untenanted (the eraser's
  // legacy full-scan fallback still reaches it by reviewer ref).
  const tenantId = (await storage.getRun(interrupt.runId))?.tenantId;
  const quorumResult = await recordQuorumVote(interruptId, interrupt.data, resumeValue, reviewerRef, voteIdentity, tenantId);
  const quorumOutcome = quorumResult?.outcome ?? null;
  // RFC 0093 §D.2 — the override path (whether it bypassed quorum or counted
  // as one vote) MUST emit `approval.overridden { principal, reason }` AND
  // write an audit-log entry (v1 `interrupt-profiles.md:95`).
  //
  // Stored in the CLOSED v1 shape, `{gateId, principal, reason}`, so it is valid
  // on the v1 wire; the major-2 read rebuilds it into the v2 alias shape
  // (`storage/approvalOverriddenProjection.ts`). It used to carry `interruptId`
  // and `bypassedQuorum`, which the closed v1 def forbids: `gateId` IS the
  // interrupt id, and `bypassedQuorum` lives in the audit entry below, where it
  // always was — the audit ledger, not the wire, is the home for detail the
  // protocol shape cannot express.
  // ADR 0778 (grade-code `APCD-11`) — the override's event + SUCCESS audit row
  // are written only once the override actually TOOK: when its vote is recorded
  // and the gate stays open ('pending'), or when the accept path WINS the claim.
  // They used to be written here, before the claim, so an override that lost to a
  // reject or the timeout was still audited as a successful override. Payload
  // unchanged (#4229: v1-valid `{gateId, principal, reason}`).
  const recordOverride = async (): Promise<void> => {
    if (!quorumResult?.override) return;
    await getEventLog().append({
      runId: interrupt.runId,
      nodeId: interrupt.nodeId,
      type: 'approval.overridden',
      payload: {
        gateId: interruptId,
        principal: quorumResult.override.principal,
        reason: quorumResult.override.reason,
      },
    });
    hostSuite.auditSink.record({
      principalId: quorumResult.override.principal,
      action: 'approval.override',
      resource: `interrupt:${interruptId}`,
      outcome: 'success',
      payload: {
        runId: interrupt.runId,
        nodeId: interrupt.nodeId,
        interruptId,
        reason: quorumResult.override.reason,
        bypassedQuorum: quorumOutcome === 'accept-override',
      },
    });
  };
  if (quorumOutcome === 'pending') {
    await recordOverride(); // the override counted as one vote and was recorded
    // Vote recorded but quorum not met. Emit a partial-vote event so
    // callers polling the event log can see the progress. The
    // interrupt stays open; the run stays in waiting-approval.
    const ledger = await tallyDecisions(interruptId);
    await getEventLog().append({
      runId: interrupt.runId,
      nodeId: interrupt.nodeId,
      type: 'interrupt.vote.recorded',
      payload: { interruptId, kind: interrupt.kind, ledger },
    });
    // ADR 0074 — still pending; broadcast the updated quorum progress so other
    // surfaces re-render the counts without a full refetch.
    const required = (interrupt.data as { requiredApprovals?: number } | null)?.requiredApprovals;
    await signalReview('pending', typeof required === 'number'
      ? { requiredApprovals: required, approvals: ledger.accepts.length, rejections: ledger.rejects.length }
      : undefined);
    return;
  }
  if (quorumOutcome === 'reject-quorum') {
    const rejectedAt = new Date().toISOString();
    // Atomic CAS, mirroring the single-approver reject below: a concurrent
    // resolve (the timeout sweep, a racing accept) that won owns the events and
    // the run's terminal state.
    const won = reviewer?.preclaimed === true
      || await storage.resolveInterrupt(interruptId, { action: 'reject', reason: 'quorum-reject' }, rejectedAt);
    if (!won) return answerLostClaim(storage, interruptId, 'rejected');
    // ADR 0778 D1 — cleared only by the WINNER: a claim lost to the timeout
    // used to destroy the vote record it never used.
    await clearQuorumVotes(interruptId);
    // ADR 0556 P1 — a quorum rejection is a resolution: the gate waited, then
    // said no. Omitting it would make the age histogram describe only the
    // approvals, which is the flattering half.
    recordInterruptResolved(interrupt, 'rejected', rejectedAt);
    // openwop#1692 — `action` is the v2 MUST (interrupt.md §ApprovalResume);
    // `reason` is the RFC 0186 §A.2 cause.
    await appendResolution({
      runId: interrupt.runId,
      nodeId: interrupt.nodeId,
      type: 'interrupt.resolved',
      payload: { interruptId, kind: interrupt.kind, decision: 'rejected', action: 'reject', reason: 'quorum-reject', ...(reviewer?.resolvedBy ? { resolvedBy: reviewer.resolvedBy } : {}) },
    });
    await announceResolved('rejected', { action: 'reject', reason: 'quorum-reject' });
    await signalReview('rejected'); // ADR 0074 — gate failed; surfaces clear the card
    // RFC 0223 — the gate node fails IN THE EXECUTOR (node.failed,
    // approval_rejected, retryable:false) and the scheduler routes it: an
    // all_complete / any_failed edge continues the run, anything else skips,
    // and only then does the run fail with `failedNodeId`. This path used to
    // fail the run directly, so no edge out of a rejected gate could ever fire.
    await dispatchGateResume(storage, hostSuite, interrupt, { action: 'reject', reason: 'quorum-reject' }, {
      code: 'approval_rejected',
      message: 'Quorum gate failed: rejected.',
      operatorAct: true,
    });
    return;
  }
  // 'accept-quorum-met' / 'accept-override' fall through to the accept path
  // below, which claims and then clears the votes (ADR 0778 D1).

  // WF-DOC-2 / GEN-DOC-2 — the SINGLE-APPROVER reject path. Quorum gates fail
  // the run above ('reject-quorum') and the timeout sweep fails it too
  // (approvalGateTimeout.ts, RFC 0093 §D.1) — but an INTERACTIVE reject on a
  // single-approver `core.approvalGate` used to fall through to the verb-blind
  // resume below: the node completed with the reject payload as its output and
  // every downstream edge fired, so `rejectionPolicy` was inert config and the
  // gate did not gate (live instance: anniversary-draft.approve → notify still
  // notified the tenant on reject). Scoped to `core.approvalGate`, the native
  // return-and-resume gate: reinvoke-style gates (`core.chat.approvalGate`,
  // ctx.suspend nodes) shape their own reject output and route via conditioned
  // edges — that lane keeps its semantics (the kicktodo reject barrier).
  // Verified before shipping: no chain or workflow in the corpus conditions an
  // edge on a core.approvalGate reject, so no consumer relied on
  // reject-continues. Distinct mechanism from the ADR 0582
  // `core.chat.approvalGate` ledger — recorded there as such.
  const rejectAction = ((resumeValue ?? {}) as { action?: unknown }).action;
  if (quorumOutcome === null && interrupt.kind === 'approval') {
    const gateRun = await storage.getRun(interrupt.runId);
    const gateDef = gateRun ? await resolveRunDefinition(gateRun, hostSuite.workflowCatalog) : null;
    const gateNode = gateDef?.definition.nodes.find((n) => n.nodeId === interrupt.nodeId);
    // Review F1 — FAIL CLOSED on an UNIDENTIFIABLE gate node. The first cut of
    // this guard fired only when the node RESOLVED as `core.approvalGate`;
    // when the run/definition/node could not be resolved at all (the run row
    // gone, the head moved past a dropped/renamed node — reachable: the
    // anon-lane seams resolve from head, and the builder permits deleting or
    // renaming a referenced node) it fell through to the verb-blind accept —
    // the original WF-DOC-2 bug, one layer down. An unprovable reject must
    // never be CONVERTED into an accept, so refuse the resolve (409) and leave
    // the interrupt OPEN. DECISION (stated): the refusal covers BOTH verbs of
    // an approval-kind interrupt — an approve on an unidentifiable node used
    // to consume the suspend and then 404/500 on the resume lookups below,
    // stranding the run with the interrupt already spent; refusing first is
    // strictly safer and keeps the interrupt recoverable. Nodes that DO
    // resolve to a non-`core.approvalGate` type keep the fall-through: the
    // reinvoke lane (`core.chat.approvalGate`, ctx.suspend nodes) shapes its
    // own reject output and routes via conditioned edges.
    if (!gateNode) {
      throw new OpenwopError(
        'conflict',
        `approval interrupt ${interruptId} cannot be resolved: node ${interrupt.nodeId} is not present in the run's resolvable definition — refusing to ${rejectAction === 'reject' ? 'reject' : 'accept'} a gate whose semantics cannot be proven`,
        409,
        { reason: 'approval_node_unresolvable', interruptId, runId: interrupt.runId, nodeId: interrupt.nodeId },
      );
    }
    if (gateNode.typeId === 'core.approvalGate' && rejectAction === 'reject') {
      const rejectedAt = new Date().toISOString();
      // Atomic CAS — a concurrent resolve that wins leaves nothing to do here.
      const won = reviewer?.preclaimed === true || await storage.resolveInterrupt(interruptId, resumeValue, rejectedAt);
      if (!won) return answerLostClaim(storage, interruptId, 'rejected');
      recordInterruptResolved(interrupt, 'rejected', rejectedAt);
      await appendResolution({
        runId: interrupt.runId,
        nodeId: interrupt.nodeId,
        type: 'interrupt.resolved',
        // ADR 0722 — no `outcome` (undeclared on the closed def; `decision`
        // carries it). openwop#1692 — `action` is a v2 MUST.
        payload: { interruptId, kind: interrupt.kind, decision: 'rejected', action: 'reject', ...(reviewer?.resolvedBy ? { resolvedBy: reviewer.resolvedBy } : {}) },
      });
      await announceResolved('rejected', resumeValue);
      await signalReview('rejected');
      // RFC 0223 — routed through the scheduler; see the quorum path.
      await dispatchGateResume(storage, hostSuite, interrupt, resumeValue, {
        code: 'approval_rejected',
        message: 'Approval gate rejected.',
        operatorAct: true,
      });
      return;
    }
  }

  const acceptedAt = new Date().toISOString();
  // ADR 0778 D1 (`APWF-1`) — the accept path CLAIMS, like both reject paths
  // above. It used to call `getSuspendManager().resolve`, which discards the
  // CAS result, then append `interrupt.resolved{accepted}` and dispatch the
  // resume regardless. So an accept that lost to a reject or the timeout sweep
  // still resumed the run, and when its resume was queued first the gate
  // completed and its downstream fired under a stored REJECTION — fail-open.
  const won = reviewer?.preclaimed === true || await storage.resolveInterrupt(interruptId, resumeValue, acceptedAt);
  if (!won) {
    // ADR 0778 C2 — a voter whose vote TIPPED the quorum, racing a peer's
    // identical tip, is not told "already decided": the vote counted and the
    // gate passed. But only when the winner really ACCEPTED (grade-code
    // `APCD-2`): a tip that lost to the timeout's rejection is a 409.
    if (quorumOutcome === 'accept-quorum-met' || quorumOutcome === 'accept-override') return answerLostClaim(storage, interruptId, 'accepted');
    throw new OpenwopError('interrupt_already_resolved', 'interrupt already resolved', 409);
  }
  if (quorumOutcome !== null) await clearQuorumVotes(interruptId);
  await recordOverride(); // APCD-11 — only after the claim is WON
  // ADR 0556 P1 — the accept path (quorum met, or an operator override).
  recordInterruptResolved(interrupt, 'accepted', acceptedAt);
  // ADR 0688 — the ACCEPT path emits the codemap type, same as the reject path
  // thirty lines above. It used to emit `interrupt.resolved`
  // (ADR 0682's rename of `node.interrupt.resolved`), so this one function
  // spelled one fact two ways BY OUTCOME: a rejection was protocol-named and
  // legible to any v2 reader, an acceptance was vendor-named and opaque. Nobody
  // chose that — the accept branch never got the review the reject branch got.
  //
  // Payload deliberately does NOT carry `outcome`, despite both sibling
  // emitters doing so: `interruptResolved` is `additionalProperties: false` and
  // declares `decision`, not `outcome` (see ADR 0688 § The field that is not
  // there). Copying the sibling would have propagated an invalid payload to a
  // third site by citation.
  const resolutionEvent: Parameters<ReturnType<typeof getEventLog>['append']>[0] = {
    runId: interrupt.runId,
    nodeId: interrupt.nodeId,
    type: 'interrupt.resolved',
    // RFC 0183 §A.1/§A.2 (ADR 0705) — the action the host APPLIED, and the
    // payload without which that action has no meaning. Added by suite 2.2.0;
    // before it, a `refine` and an `accept` were wire-indistinguishable here,
    // so a reader could see that a gate resolved and never what was decided.
    //
    // Approval-kind only, and only when an action was actually supplied: the
    // def serves all eight `kind` values and §A.1 is OPTIONAL precisely
    // because a non-approval resolution has no action to record. Stamping a
    // default would be inventing one.
    payload: { interruptId, kind: interrupt.kind, ...resolvedActionFields(interrupt.kind, resumeValue), ...(reviewer?.resolvedBy ? { resolvedBy: reviewer.resolvedBy } : {}) },
  };
  if (reviewer?.hostDispatchJoin === true) {
    const { appendDispatchWaitResolution } = await import('../host/dispatchWaitAll.js');
    await appendDispatchWaitResolution(storage, { ...interrupt, resolvedAt: acceptedAt, resolvedValue: resumeValue });
  } else await appendResolution(resolutionEvent);
  await announceResolved('accepted', resumeValue);
  await signalReview('resolved'); // ADR 0074 — review resolved; surfaces mark it done

  await dispatchGateResume(storage, hostSuite, interrupt, resumeValue);
}
