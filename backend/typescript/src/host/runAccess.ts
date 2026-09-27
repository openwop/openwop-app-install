/**
 * Authorization gate for every run-READ path — the single helper behind
 * `GET /v1/runs/{runId}`, its SSE `…/events` stream, `…/events/poll`, and
 * `…/debug-bundle`. Before this existed, those four paths each open-coded
 * "load the run, 404 if absent" and the SSE stream (`routes/streams.ts`)
 * additionally skipped the RFC 0049 scope seam entirely — so a caller denied
 * the JSON poll under enforcement could still read byte-identical data live,
 * and (enforcement off) any caller who knew a runId could stream another
 * tenant's full event log. Centralizing the check keeps the boundary from
 * drifting again (architecture review #1).
 *
 * SECURITY CORRECTION (2026-07 vuln-scan remediation): an earlier version of
 * this comment asserted "the run-MUTATION paths already gate on run.tenantId".
 * That was FALSE — `routes/runs.ts` cancel / :bulk-cancel / :fork / ancestry and
 * both `routes/interrupts.ts` handlers fetched by bare `storage.getRun` with no
 * tenant check, a cross-tenant IDOR cluster (the interrupts-list leaked RFC 0093
 * capability tokens cross-tenant → full HITL hijack). Those paths now route
 * through {@link loadOwnedRun} (mutation / token-yielding gate) or
 * {@link loadReadableRun} (pure read). Only DELETE was ever correct.
 *
 * Contract, mirroring the surrounding run handlers:
 *   - threads `requireProtocolScope(req, 'runs:read')` so an enforcement-ON
 *     deploy gates the live stream identically to every other read path;
 *   - wildcard principals (`tenants: ['*']` — API key / conformance / admin)
 *     read across tenants, the same trusted operator escape hatch the
 *     runs-list + `:diff` routes use;
 *   - a run owned by another tenant is reported as `run_not_found` (404), NOT
 *     403 — the same no-existence-leak posture as notifications
 *     `assertTenantOwnership`.
 */

import type { Request } from 'express';
import type { Storage } from '../storage/storage.js';
import { OpenwopError, type RunRecord } from '../types.js';
import { requireProtocolScope, type EnforcedProtocolScope } from './protocolAuthorization.js';
import { verifyRunStreamToken } from './runStreamToken.js';
import { disposePinnedRun } from './pinnedRunDisposition.js';

/**
 * Load a run the caller is authorized to READ, or throw. Returns the
 * `RunRecord` on success so the caller skips a second `getRun`.
 *
 * Authorizes by EITHER (a) a valid `?streamToken` capability for this run — the
 * cross-origin-safe path for the SSE stream (a BYOK-anon owner whose cookie
 * can't follow to `*.run.app`; see `host/runStreamToken`), checked first so it
 * also works under RFC 0049 enforcement — OR (b) the scope seam + tenant
 * ownership (the same-origin path).
 *
 * @throws OpenwopError('run_not_found', 404) when the run is absent OR owned by
 *   another tenant (existence is never leaked to a non-owner).
 * @throws OpenwopError('forbidden', 403) + the insufficient_scope challenge from `requireProtocolScope` when the caller
 *   lacks `runs:read` — an `owk_` key's declared scopes always (ADR 0745 D2),
 *   membership only when authorization enforcement is ON.
 *
 * `opts` (ADR 0746) serves a read of something the run OWNS rather than the run
 * itself — `getArtifact` authorizes on `artifacts:read` (RFC 0205 §A.3), and the
 * SSE `?streamToken` grant is a stream capability that must not open that door,
 * so it is refused there (`streamToken: false`).
 */
export async function loadReadableRun(
  req: Request,
  storage: Storage,
  runId: string,
  opts: { scope?: EnforcedProtocolScope; streamToken?: boolean } = {},
): Promise<RunRecord> {
  // (a) Run-scoped capability token — a grant mintable ONLY by a caller who
  // already passed the same-origin tenant gate (GET …/events/token). Checked
  // before the scope/tenant path so a token-bearing cross-origin SSE request
  // authorizes even when it carries no matching session.
  const streamToken = opts.streamToken !== false && typeof req.query?.streamToken === 'string' ? req.query.streamToken : undefined;
  if (streamToken && verifyRunStreamToken(runId, streamToken)) {
    const run = await storage.getRun(runId);
    if (!run) throw new OpenwopError('run_not_found', `run ${runId} not found`, 404);
    return disposePinnedRun(storage, run);
  }

  await requireProtocolScope(req, opts.scope ?? 'runs:read'); // RFC 0049 — owk_ key scopes always (ADR 0745 D2); membership only when enforced
  const run = await storage.getRun(runId);
  if (!run) throw new OpenwopError('run_not_found', `run ${runId} not found`, 404);
  // Wildcard operator principal reads across tenants (matches the runs-list /
  // :diff routes + the requireProtocolScope escape hatch).
  if (req.principal?.tenants?.includes('*')) return disposePinnedRun(storage, run);
  // Otherwise the run MUST belong to the caller's active tenant. `?? 'default'`
  // matches the run-mutation paths' tenant derivation verbatim.
  const tenantId = req.tenantId ?? 'default';
  if (run.tenantId !== tenantId) {
    throw new OpenwopError('run_not_found', `run ${runId} not found`, 404);
  }
  // `persistence.md` §"Runs pinned to v1" — EVERY authorized return disposes.
  // This tenant branch used to `return run` and only the wildcard branch above
  // disposed, so the rule held for `dev-token` (the wildcard every host test
  // authenticates as) and for no real tenant: a configured key read a run
  // pinned to an unimplemented change id back as `running` forever. Measured
  // on the RFC 0199 side revision, where it was the one non-429 red.
  return disposePinnedRun(storage, run);
}

/**
 * Load a run the caller OWNS, for a run-MUTATION or capability-token-yielding
 * path (cancel / :fork / interrupt resume / interrupt-token listing). Returns
 * the `RunRecord` on success so the caller skips a second `getRun`.
 *
 * Unlike {@link loadReadableRun} this deliberately does NOT honor the
 * `?streamToken` capability: that token is a READ grant minted for the SSE
 * stream, and letting it authorize a mutation (or hand out RFC 0093 resume
 * tokens) would be a read→write privilege upgrade. Authority is EITHER the
 * wildcard operator principal OR the caller's active-tenant ownership; a
 * non-owned/absent run is `run_not_found` (404, no existence leak) — the same
 * posture the DELETE handler uses. The scope is caller-supplied so each site
 * keeps its RFC 0049 authority floor (`runs:cancel` for cancel/fork-of-cancel,
 * `runs:create` for :fork, `runs:read` for interrupt resolve — the node-resume
 * floor RFC 0049 defines).
 *
 * @throws OpenwopError('run_not_found', 404) when absent OR owned by another tenant.
 * @throws OpenwopError('forbidden', 403) + the insufficient_scope challenge from `requireProtocolScope` — key scopes always, membership under enforcement.
 */
export async function loadOwnedRun(
  req: Request,
  storage: Storage,
  runId: string,
  scope: EnforcedProtocolScope,
): Promise<RunRecord> {
  await requireProtocolScope(req, scope); // RFC 0049 — owk_ key scopes always (ADR 0745 D2); membership only when enforced
  const run = await storage.getRun(runId);
  if (!run) throw new OpenwopError('run_not_found', `run ${runId} not found`, 404);
  // Wildcard operator principal acts across tenants (matches DELETE / loadReadableRun).
  if (req.principal?.tenants?.includes('*')) return disposePinnedRun(storage, run);
  const tenantId = req.tenantId ?? 'default';
  if (run.tenantId !== tenantId) {
    throw new OpenwopError('run_not_found', `run ${runId} not found`, 404);
  }
  // `persistence.md` §"Runs pinned to v1" — dispose an inherited run before any
  // reader sees it. Placed on the SHARED reader so poll, snapshot and every other
  // by-id read get the same disposition; a per-route call would be a rule some
  // call sites bypass.
  return disposePinnedRun(storage, run);
}
