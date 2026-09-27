/**
 * RFC 0168 §C.1 — the v2 address of the conformance seam surface.
 *
 * `api/seams-v2.yaml` addresses every seam under `/conformance/seams/…`, and the
 * suite's `lib/seams.ts` maps the v1 seam paths onto it with exactly three
 * prefix rules. This module is the INVERSE of those rules: it rewrites an
 * inbound v2 seam address onto the v1 path the host already serves, so the seam
 * space is ONE implementation reachable at two addresses — never a second copy
 * that can drift from the first.
 *
 * WHY A REWRITE AND NOT A SECOND ROUTER. The seams exist to witness real host
 * behaviour. A parallel handler under `/conformance/seams/…` would witness
 * itself; a rewrite witnesses the same code path a v1 caller reaches, including
 * `testSeam.ts`'s `app.use('/v1/host/sample', guardSeam)` — which is why this
 * middleware must run BEFORE that guard (it rewrites into the guarded space, so
 * the guard applies to seam callers too).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: advertise `conformance.seamsProfile`.
 * The advert is a claim that the seam space is served, and `SEAM_OPERATIONS`
 * below records which of the `api/seams-v2.yaml` operations (every one, pinned by
 * a parity test against the vendored yaml) this host
 * actually implements. Four do not exist here — and they are exactly the four
 * the seams-v2 FLOOR drives — so the profile claim stays false and the advert
 * stays off. `seamsFloorServed()` is the one place that decides, and
 * `test/v2-conformance-seams-mount.test.ts` calls every operation the manifest
 * marks `served: true`, so the manifest cannot lie in the direction that matters.
 */
import type { Express, RequestHandler } from 'express';
import { sendError } from '../middleware/errorEnvelope.js';

export const SEAMS_PREFIX = '/conformance/seams';

/** The inverse of the suite's `lib/seams.ts` prefix table. */
const SEAM_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  // RFC 0209 (ADR 0749) — `emitA2uiSurface` is NOT the v1 emit seam at a new
  // address: its body is `{runId, envelope}` where v1's is `{runId, surface}`,
  // and it admits through the major-2 catalog. So this ONE path is routed to its
  // own handler, ahead of the generic `sample/` rule that would otherwise land it
  // on the v1 seam. Still under `/v1/host/sample/`, so `guardSeam` applies.
  [/^\/conformance\/seams\/sample\/a2ui\/emit-surface(?=$|\?)/, '/v1/host/sample/a2ui/v2/emit-surface'],
  [/^\/conformance\/seams\/sample\//, '/v1/host/sample/'],
  [/^\/conformance\/seams\/workspace\/files/, '/v1/host/workspace/files'],
  [/^\/conformance\/seams\/packs-test\//, '/v1/packs-test/'],
];

/** `api/seams-v2.yaml`, one entry per operation, with the v1 address it reaches.
 *  `floor` marks the four the `openwop-conformance-seams-v2` profile drives. */
export interface SeamOperation {
  readonly operationId: string;
  readonly method: 'get' | 'put' | 'post' | 'delete';
  readonly v2Path: string;
  readonly served: boolean;
  readonly floor: boolean;
}

export const SEAM_OPERATIONS: readonly SeamOperation[] = [
  // RFC 0209 / ADR 0749 — admits through `host/a2uiSurfaceAdmission.ts`.
  { operationId: 'emitA2uiSurface', method: 'post', v2Path: '/conformance/seams/sample/a2ui/emit-surface', served: true, floor: false },
  { operationId: 'getA2ATaskState', method: 'get', v2Path: '/conformance/seams/sample/a2a/tasks/{taskId}', served: true, floor: false },
  { operationId: 'listWorkspaceFiles', method: 'get', v2Path: '/conformance/seams/workspace/files', served: true, floor: false },
  { operationId: 'getWorkspaceFile', method: 'get', v2Path: '/conformance/seams/workspace/files/{path}', served: true, floor: false },
  { operationId: 'putWorkspaceFile', method: 'put', v2Path: '/conformance/seams/workspace/files/{path}', served: true, floor: false },
  { operationId: 'deleteWorkspaceFile', method: 'delete', v2Path: '/conformance/seams/workspace/files/{path}', served: true, floor: false },
  { operationId: 'putTestPackTarball', method: 'put', v2Path: '/conformance/seams/packs-test/{name}/-/{version}.tgz', served: true, floor: false },
  { operationId: 'getTestPackTarball', method: 'get', v2Path: '/conformance/seams/packs-test/{name}/-/{version}.tgz', served: true, floor: false },
  { operationId: 'deleteTestPackVersion', method: 'delete', v2Path: '/conformance/seams/packs-test/{name}/-/{version}', served: true, floor: false },
  { operationId: 'getTestPackSignature', method: 'get', v2Path: '/conformance/seams/packs-test/{name}/-/{version}.sig', served: true, floor: false },
  // ── The four that were the last to land. All are served now. ──
  //
  // CORRECTED 2026-09-12: this block was headed "NOT served here", and said
  // `forceEffectTransportRetry` was "the last unserved floor operation" —
  // directly above four entries every one of which reads `served: true`. The
  // prose outlived the work: the seam mount (#3655 / ADR 0634) opened the space
  // and **ADR 0639 completed the floor** — it names `forceEffectTransportRetry`
  // (RFC 0173 §D.2 G4) as the last unserved one — and nobody came back to the
  // paragraph that had been counting them. `test/v2-conformance-seams-mount.test.ts`
  // calls every `served: true` entry one by one and is green on 19 assertions,
  // so the table is the true half and the header was the false one.
  //
  // Why it mattered rather than being untidy: a reader deciding whether this
  // host can be certified against `openwop-conformance-seams-v2` would have
  // concluded four floor operations still needed building. Nothing needs
  // building. `seamsFloorServed()` returns true whenever
  // `OPENWOP_TEST_SEAM_ENABLED=true`, and it is `false` on the production
  // service by deliberate choice — these seams plant runs, so they must not be
  // reachable there. What remains is a certify-run DEPLOY decision, not code.
  { operationId: 'seedEra2EventLog', method: 'post', v2Path: '/conformance/seams/sample/event-log/seed', served: true, floor: true },
  { operationId: 'fireEffectSeam', method: 'post', v2Path: '/conformance/seams/sample/effect-seams/fire', served: true, floor: true },
  { operationId: 'forceEffectTransportRetry', method: 'post', v2Path: '/conformance/seams/sample/test/idempotency/effect-retry', served: true, floor: true },
  { operationId: 'receiveWebhookDelivery', method: 'post', v2Path: '/conformance/seams/sample/webhooks/receive', served: true, floor: true },
  // ── Declared by the pinned `api/seams-v2.yaml`, NOT served here (WS0, 2026-09-24). ──
  //
  // `served: false` is not only bookkeeping: `registerConformanceSeamAlias`
  // answers 404 for these instead of rewriting them, because the generic
  // `sample/` prefix rule would otherwise land them on whatever v1 route shares
  // the tail. `emitA2uiSurface` is the case that forced it — its v2 address
  // rewrote onto the RFC 0114 `/v1/host/openwop-app/a2ui/emit-surface` handler,
  // which takes `{runId, surface}` and answered 400 to the RFC 0209
  // `{runId, envelope}` body. The corpus reads any non-404/405 as "seam wired",
  // so the v2 scenario would have recorded FAILS against a seam this host never
  // built, instead of `inapplicable`. The v1 route is untouched (its scenario is
  // major-1-only). The RFC 0209 seam lands with WS5 and flips this to `true`.
  // → DONE (ADR 0749): `emitA2uiSurface` is now served by its own handler and
  //   listed at the top of this table; its alias is the first `SEAM_ALIASES` rule.
  // → DONE (ADR 0753 D12): both RFC 0199 OAuth seams are served by
  //   `features/connections/oauthConformanceSeams.ts`, which configures a provider
  //   the production way and calls the production `beginAuthorization` (R9).
  { operationId: 'startOAuthAuthorization', method: 'post', v2Path: '/conformance/seams/sample/oauth/authorize-start', served: true, floor: false },
  { operationId: 'expireOAuthAccessToken', method: 'post', v2Path: '/conformance/seams/sample/oauth/expire-refresh', served: true, floor: false },
  // RFC 0170 §B.3 — `routes/credentialLaneSeams.ts` (api-key lane;
  // session lane while cookies are enabled). Listed from the 2.40.3 pin, which
  // carries them in `api/seams-v2.yaml` (openwop#1569/#1602).
  { operationId: 'mintLaneCredential', method: 'post', v2Path: '/conformance/seams/sample/auth/credential/mint', served: true, floor: false },
  { operationId: 'revokeLaneCredential', method: 'post', v2Path: '/conformance/seams/sample/auth/credential/revoke', served: true, floor: false },
  // RFC 0213 §B `armIdempotencyHold` — served (ADR 0753 follow-up): the seam arms a
  // single-use hold; the hold itself lives in the production POST /runs claim path.
  { operationId: 'armIdempotencyHold', method: 'post', v2Path: '/conformance/seams/sample/test/idempotency/hold', served: true, floor: false },
  // NEW at 2.41.0 — RFC 0111 `getTranscriptWindow` (context budget). This host
  // OPTS OUT of `openwop-context-budget`, so there is no accounting to expose;
  // declared unserved (404) so its scenarios record inapplicable, not a guess.
  { operationId: 'getTranscriptWindow', method: 'get', v2Path: '/conformance/seams/sample/agent/transcript-window', served: false, floor: false },
];

/** `served: false` operations with their path compiled once — the alias runs on
 *  EVERY request, so nothing here may build a RegExp per call. `{param}`
 *  segments match exactly one path segment. */
const UNSERVED: ReadonlyArray<{ op: SeamOperation; re: RegExp }> = SEAM_OPERATIONS
  .filter((op) => !op.served)
  .map((op) => {
    const pattern = op.v2Path
      .split('/')
      .map((seg) => (/^\{[^}]+\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^$()|[\]\\]/g, '\\$&')))
      .join('/');
    return { op, re: new RegExp(`^${pattern}/?$`) };
  });

/** The declared-but-unserved operation an inbound request addresses, if any.
 *  Matched on method AND path, so a served operation sharing a path is never
 *  shadowed. */
export function unservedSeamOperation(method: string, url: string): SeamOperation | null {
  if (!url.startsWith(`${SEAMS_PREFIX}/`)) return null;
  const path = url.split('?')[0] ?? '';
  const m = method.toLowerCase();
  for (const { op, re } of UNSERVED) {
    if (op.method === m && re.test(path)) return op;
  }
  return null;
}

/** The v1 address an inbound v2 seam path reaches, or `null` for a non-seam path. */
export function seamAliasTarget(url: string): string | null {
  for (const [re, to] of SEAM_ALIASES) {
    if (re.test(url)) return url.replace(re, to);
  }
  return null;
}

/**
 * May this host advertise `conformance.seamsProfile`? Only when EVERY floor
 * operation is served — a partial mount answers 404 for the seams the profile
 * exists to drive, and the advert would be a false claim about the path space.
 */
export function seamsFloorServed(): boolean {
  // The env gate is PART of the claim, not a deployment detail beside it. Every
  // floor seam is test-only — `seedEra2EventLog` plants runs — so each 404s when
  // `OPENWOP_TEST_SEAM_ENABLED` is off. Deriving the advert from the manifest
  // alone would advertise `conformance.seamsProfile` on a production deployment
  // whose seam space answers 404 to every request: a claim contradicted by the
  // very next call, and exactly the shape ADR 0634 built this derivation to stop.
  if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') return false;
  return SEAM_OPERATIONS.every((op) => !op.floor || op.served);
}

/** Register the alias. MUST run before `testSeam.ts` installs `guardSeam`. */
export function registerConformanceSeamAlias(app: Express): void {
  const alias: RequestHandler = (req, res, next) => {
    const unserved = unservedSeamOperation(req.method, req.url);
    if (unserved) {
      // The seams-v2 contract for an unwired seam: 404, so the suite records
      // `inapplicable` rather than failing a seam the host never claimed.
      sendError(res, 404, 'not_found', `conformance seam ${unserved.operationId} is not served by this host`);
      return;
    }
    const target = seamAliasTarget(req.url);
    if (target !== null) req.url = target;
    next();
  };
  app.use(alias);
}
