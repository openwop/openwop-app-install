/**
 * RFC 0140 conformance test seam — `host-sample-test-seams.md` §20.
 *
 *   GET /v1/host/sample/replay/effect-count?runId=<runId>
 *     → 200 { runId: string, effectCount: integer }
 *
 * WHY THIS SEAM HAS TO EXIST. `replay.md` §"Side-effect suppression in replay"
 * turns on a fact the run event log CANNOT express. A replayed side-effecting
 * node that fires and records its outcome identically to the source produces an
 * event log byte-indistinguishable from one that was correctly suppressed —
 * which is precisely the failure RFC 0140 exists to prevent. Every existing
 * replay scenario asserts on the event log, so all of them pass green against a
 * host that re-sends the email on every replay. The only way to tell the two
 * apart is to count effects OUTSIDE the log.
 *
 * The number comes from `host/runEffectContext.ts`, i.e. from the ALLOW branch
 * of `assertEffectAllowed` — the same call every guarded effect seam makes
 * before acting. §20 requires exactly that co-location ("the counter MUST sit at
 * the same effect seam as the rule-5(b) default-deny guard"), so this route is
 * a pure reader: it holds no counting logic of its own and therefore cannot
 * drift away from what the guard protects.
 *
 * HONESTY LIMIT, recorded here as well as in the suite's `coverage.md`: the host
 * counts its own effects, and it counts the paths it routes through the guarded
 * seam. A leak through an UNGUARDED path is invisible to the counter and to the
 * suite alike. That is the reason rule 5 mandates a default-deny guard rather
 * than an enumeration — coverage is a property of the seam set
 * (`EffectKind` in `runEffectContext.ts`), not of this endpoint.
 *
 * Gated on `OPENWOP_TEST_SEAM_ENABLED=true` (OFF by default), the standard
 * `/v1/host/sample/*` posture per `host-sample-test-seams.md` §"Production
 * safety" — production deployments keep it 404.
 *
 * @see spec/v1/host-sample-test-seams.md §20 (openwop monorepo)
 * @see spec/v1/replay.md §"Side-effect suppression in replay" (RFC 0140)
 * @see docs/adr/0533-replay-effect-counter-and-advert.md
 */

import type { Express, Request, Response } from 'express';
import { effectCountForRun } from '../host/runEffectContext.js';
import { createLogger } from '../observability/logger.js';
import { sendError } from '../middleware/errorEnvelope.js';

const log = createLogger('routes.replay-effect-count-seam');

/** The product (host-namespaced) + spec-canonical (suite-driven) paths, the
 *  same dual-mount posture as the RFC 0095/0118/0122 seams. */
const SEAM_PATHS = [
  '/v1/host/openwop-app/replay/effect-count',
  '/v1/host/sample/replay/effect-count',
] as const;

function handleEffectCount(req: Request, res: Response): void {
  const runId = req.query['runId'];
  if (typeof runId !== 'string' || runId.length === 0) {
    sendError(res, 400, 'validation_error', 'runId (non-empty string query param) required');
    return;
  }
  // An unknown runId answers 0 rather than 404: "no effect escaped during that
  // run" is the true answer for a run that never existed, and a 404 here would
  // be indistinguishable to the suite from "seam not wired" (which soft-skips).
  res.status(200).json({ runId, effectCount: effectCountForRun(runId) });
}

export function registerReplayEffectCountSeamRoutes(app: Express): void {
  if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
    log.info('replay effect-count seam disabled (set OPENWOP_TEST_SEAM_ENABLED=true to enable)');
    return;
  }
  for (const path of SEAM_PATHS) {
    app.get(path, handleEffectCount);
  }
}
