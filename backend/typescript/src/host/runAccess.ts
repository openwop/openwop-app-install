/**
 * Authorization gate for every run-READ path — the single helper behind
 * `GET /v1/runs/{runId}`, its SSE `…/events` stream, `…/events/poll`, and
 * `…/debug-bundle`. Before this existed, those four paths each open-coded
 * "load the run, 404 if absent" and the SSE stream (`routes/streams.ts`)
 * additionally skipped the RFC 0049 scope seam entirely — so a caller denied
 * the JSON poll under enforcement could still read byte-identical data live,
 * and (enforcement off) any caller who knew a runId could stream another
 * tenant's full event log. The run-MUTATION paths already gate on
 * `run.tenantId !== tenantId` (`routes/runs.ts` delete/annotations); the reads
 * were the outlier. Centralizing the check keeps the boundary from drifting
 * again (architecture review #1).
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
import { requireProtocolScope } from './protocolAuthorization.js';
import { verifyRunStreamToken } from './runStreamToken.js';

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
 * @throws OpenwopError('forbidden', 403) from `requireProtocolScope` when
 *   authorization enforcement is ON and the caller lacks `runs:read`.
 */
export async function loadReadableRun(
  req: Request,
  storage: Storage,
  runId: string,
): Promise<RunRecord> {
  // (a) Run-scoped capability token — a grant mintable ONLY by a caller who
  // already passed the same-origin tenant gate (GET …/events/token). Checked
  // before the scope/tenant path so a token-bearing cross-origin SSE request
  // authorizes even when it carries no matching session.
  const streamToken = typeof req.query?.streamToken === 'string' ? req.query.streamToken : undefined;
  if (streamToken && verifyRunStreamToken(runId, streamToken)) {
    const run = await storage.getRun(runId);
    if (!run) throw new OpenwopError('run_not_found', `run ${runId} not found`, 404);
    return run;
  }

  await requireProtocolScope(req, 'runs:read'); // RFC 0049 — no-op unless enforced
  const run = await storage.getRun(runId);
  if (!run) throw new OpenwopError('run_not_found', `run ${runId} not found`, 404);
  // Wildcard operator principal reads across tenants (matches the runs-list /
  // :diff routes + the requireProtocolScope escape hatch).
  if (req.principal?.tenants?.includes('*')) return run;
  // Otherwise the run MUST belong to the caller's active tenant. `?? 'default'`
  // matches the run-mutation paths' tenant derivation verbatim.
  const tenantId = req.tenantId ?? 'default';
  if (run.tenantId !== tenantId) {
    throw new OpenwopError('run_not_found', `run ${runId} not found`, 404);
  }
  return run;
}
