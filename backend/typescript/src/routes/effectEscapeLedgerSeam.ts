/**
 * ADR 0591 P3 — the per-effect-identity escape read, for RFC 0158 §C.7
 * (`duplicate-delivery`) and, later, RFC 0150 §D box #4 leg (ii).
 *
 *   GET /v1/host/sample/replay/effect-escapes?runId=<runId>
 *     → 200 { runId: string, escapes: Array<{ invocationId, nodeId, count }> }
 *
 * WHY THIS IS A SECOND SEAM AND NOT A FIELD ON `replay/effect-count`. They
 * measure different things and only coincidentally agree.
 *
 * §20's `effectCount` is a per-RUN SCALAR held in a process-local Map
 * (`runEffectContext.ts`). It answers "did anything escape during this run",
 * which is the right question for replay suppression. It cannot answer §C.7's
 * question — `:162` asks for the count "per effect identity, not by end state" —
 * for two independent reasons: a scalar equals the per-identity count only when
 * the graph happens to hold exactly ONE identity (a property of the fixture, not
 * of the host), and a process-local Map does not survive the SIGKILL the
 * duplicate-delivery scenario is built around. Folding this into that route
 * would make one endpoint's answer depend on which of two incompatible
 * questions the caller meant.
 *
 * This route is a pure reader over the durable ledger, exactly as its sibling is
 * a pure reader over the counter: it holds no counting logic and therefore
 * cannot drift from what it reports on.
 *
 * READING THE NUMBER HONESTLY — this is not a tally of deliveries:
 *
 *   - It is a CEILING, not a floor — FOR A COVERED SEAM. The row is written
 *     before the effect fires, because a row written after is lost precisely
 *     when the process dies in between — the window §C.7 manufactures on
 *     purpose — and a lost row makes a real double-fire read as 1. So within a
 *     covered seam under-reporting is structurally impossible and
 *     over-reporting is possible in the crash-between-append-and-fire window.
 *     `count >= 2` is therefore NOT automatically a real double-fire;
 *     `count == 1` genuinely cannot hide a second fire.
 *
 *     The qualifier is load-bearing and is not a hedge: an UNCOVERED seam
 *     reports nothing at all, so "under-reporting is impossible" is a statement
 *     about counted identities, never about whether an effect was counted. Read
 *     the two bullets together or the first one overstates.
 *   - Coverage is PER-SEAM, not universal. Only effect seams that call
 *     `recordDurableEffectEscape` appear here. That is a deliberate consequence
 *     of the guard being synchronous by contract (see `host/effectEscapeLedger.ts`),
 *     and it is stated rather than implied — a ledger honest about which seams it
 *     observes beats one whose placement implies it observes all of them.
 *
 * Gated on `OPENWOP_TEST_SEAM_ENABLED=true` (OFF by default) — the SAME flag as
 * every other `/v1/host/sample/*` seam, deliberately. RFC 0158 item 12 names the
 * shared-flag hazard, and the answer to it is not a second flag: a per-seam flag
 * multiplies the number of ways a deployment is half-enabled, and a seam that is
 * enabled-but-unwired is indistinguishable to the suite from one that is absent.
 * One posture, one switch, production keeps it 404.
 *
 * @see spec/v1/host-sample-test-seams.md §"Production safety"
 * @see docs/adr/0591-durable-effect-escape-ledger.md
 */

import type { Express, Request, Response } from 'express';
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { sendError } from '../middleware/errorEnvelope.js';

const log = createLogger('routes.effect-escape-ledger-seam');

/** Product (host-namespaced) + spec-canonical (suite-driven) paths — the dual
 *  mount its §20 sibling uses. */
const SEAM_PATHS = [
  '/v1/host/openwop-app/replay/effect-escapes',
  '/v1/host/sample/replay/effect-escapes',
] as const;

function handler(storage: Storage) {
  return async (req: Request, res: Response): Promise<void> => {
    const runId = req.query['runId'];
    if (typeof runId !== 'string' || runId.length === 0) {
      sendError(res, 400, 'validation_error', 'runId (non-empty string query param) required');
      return;
    }
    try {
      // An unknown runId answers an EMPTY LIST, not 404 — "no effect escaped
      // during that run" is the true answer for a run that never existed, and a
      // 404 would be indistinguishable to the suite from "seam not wired",
      // which soft-skips. Same reasoning as the §20 sibling's `0`.
      res.status(200).json({ runId, escapes: await storage.listEffectEscapes(runId) });
    } catch (err) {
      // A FAILED READ MUST NOT ANSWER `[]`. An empty list is a load-bearing
      // claim here — the scenario reads it as "nothing escaped" and passes. A
      // storage error that presented as success would turn an outage into a
      // green conformance run, which is the failed-read-as-empty family this
      // whole ADR is about. Fail loudly instead.
      log.error('effect-escape ledger read failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 500, 'internal_error', 'effect escape ledger read failed');
    }
  };
}

export function registerEffectEscapeLedgerSeamRoutes(app: Express, deps: { storage: Storage }): void {
  if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
    log.info('effect-escape ledger seam disabled (set OPENWOP_TEST_SEAM_ENABLED=true to enable)');
    return;
  }
  for (const path of SEAM_PATHS) {
    app.get(path, handler(deps.storage));
  }
}
