/**
 * The major-2 identity gate: the inbound half of the tenant-bound id grammar
 * (`spec/v2/core/identity.md` §5, RFC 0170 §D.1) and the `Idempotency-Key`
 * grammar (`spec/v2/core/idempotency.md` §"Layer 1", RFC 0170 §D.3).
 *
 * Mounted ONCE, immediately after `authMiddleware()`, because both rules need
 * the AUTHENTICATED tenant and neither may be decided from the body:
 *
 *   - `identity.md` §5: "A host MUST reject a tenant-bound id whose tenant
 *     segment is not the caller's with `403 id_tenant_mismatch`." The caller's
 *     tenant comes from the credential; `runs.md` §Identity adds that the
 *     refusal MUST NOT disclose whether the run exists, which is why the check
 *     runs HERE — before the route reaches the store at all.
 *   - `idempotency.md` §"Layer 1": the record key is
 *     `(authenticatedTenantId, canonicalEndpointId, callerIdempotencyKey)` and
 *     "the tenant MUST come from the credential, never the body".
 *
 * One middleware rather than a helper each route calls: `routes/runs.ts` alone
 * mounts nine `/v1/runs/:runId` operations and `POST /v1/runs` is not the only
 * mutating endpoint that reads `Idempotency-Key`. A per-call-site check is the
 * "wrapper some call sites bypass" failure `persistence.md` §"The seat" names
 * for the era adapter, and it has the same shape here.
 *
 * VENDOR PATHS ARE UNTOUCHED. Every branch below is gated on
 * `isProtocolRequest(req)` (ADR 0812 P3c replaced the `negotiatedMajor(req) ===
 * 2` test, and P4 deleted `negotiatedMajor`); for the host dialect this
 * middleware is a single comparison and a `next()`.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { OpenwopError } from '../types.js';
import { tenantOf } from '../host/requestSubject.js';
import { V2_IDEMPOTENCY_KEY, fromWireRunId } from '../host/v2Ids.js';
import { looksProjected, unprojectBoundId } from '../host/boundIdProjection.js';
import { verifyRunStreamToken } from '../host/runStreamToken.js';
import { setBearerChallenge } from './authChallenge.js';
import { isProtocolClient, isProtocolRequest } from './protocolVersion.js';

/** `GET`/`HEAD` MUST NOT honor `Idempotency-Key` (`idempotency.md` §Layer 1). */
const NON_MUTATING = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The `/v1/runs/<segment>` prefix, after `protocolVersionMiddleware` has
 * rewritten an unversioned v2 key onto its `/v1` twin. The segment is the RAW,
 * still-encoded path component, and since RFC 0184 there are TWO spellings a
 * tenant-bound id may arrive in: `<tenant>~2F<opaque>` (the projection, which
 * a host MUST accept and MUST emit) and `<tenant>%2F<opaque>` (released
 * behaviour, which a host MUST still accept). `<opaque>` may carry a `:fork` /
 * `:pause` / `:resume` operation suffix in EITHER spelling — literal `:` or
 * `~3A` — because the op is split off AFTER decoding, so both land on the same
 * code path.
 *
 * The class is `[^/?#]+`, which already admits `~`; no grammar change was
 * needed to accept the projection, only a decoder that understands it.
 */
// ADR 0723 — three prefixes, not one. `/webhooks/:subscriptionId` and
// `/trigger-subscriptions/:subscriptionId` read the segment RAW via `req.params`
// (`routes/webhooks.ts:192`, `routes/triggerBridge.ts:80`), so once the host
// EMITS bound subscription ids a client echoing one back got a 404 — RFC 0184
// leg 1 on a different kind. `/interrupts/:token` is deliberately absent: a
// resume token (`identity.md` §4), not a bound id.
// ADR 0812 P3a — the `/v1` prefix is OPTIONAL and captured into `prefix`, so the
// guard holds whichever spelling routing hands it (the rewritten `/v1…` today,
// the bare path after P3b) and the rewrite below puts back exactly what it took.
// A missed spelling is a tenant-isolation gap: a bound id would never be checked
// against the credential's tenant, and a bare id would not be refused 400.
const RUN_PATH = /^((?:\/v1)?\/(?:runs|webhooks|trigger-subscriptions)\/)([^/?#]+)([\s\S]*)$/;

/** Is this `GET /runs/{id}/events?streamToken=…`, with a token that verifies for `runId`? */
/** Is this `GET /runs/{id}/events` carrying a `?streamToken=`? */
function presentsStreamToken(req: Request, prefix: string, tail: string): boolean {
  return req.method === 'GET'
    && prefix.endsWith('/runs/')
    // Compared as strings, not with an anchored path regex: that spelling is how
    // `unversioned-mount-guard-complete` recognises a host-owned root.
    && (tail === '/events' || tail.startsWith('/events?'))
    && typeof req.query?.streamToken === 'string';
}

/** …and does that token verify for `runId`? */
function streamTokenAdmits(req: Request, prefix: string, tail: string, runId: string): boolean {
  return presentsStreamToken(req, prefix, tail) && verifyRunStreamToken(runId, req.query.streamToken as string);
}

export function v2IdentityMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!isProtocolRequest(req)) {
      next();
      return;
    }
    const tenant = tenantOf(req);

    // §Layer 1 — the grammar, before anything is cached. `idempotency.md`
    // requires `400 idempotency_key_invalid` NOT be cached, and refusing here
    // means the claim is never taken in the first place.
    if (!NON_MUTATING.has(req.method)) {
      const key = req.header('idempotency-key');
      if (key !== undefined && !V2_IDEMPOTENCY_KEY.test(key)) {
        next(
          new OpenwopError(
            'idempotency_key_invalid',
            'Idempotency-Key MUST match ^[A-Za-z0-9._~-]{22,128}$ and carry at least 128 bits of entropy.',
            400,
          ),
        );
        return;
      }
    }

    // §5 — the tenant-bound run id. The tenant segment is checked against the
    // credential's tenant and then STRIPPED, so the shared `/v1` handler below
    // sees exactly the id it has always seen.
    const m = RUN_PATH.exec(req.url);
    // ADR 0812 P3a hotfix — the bare spelling (`/runs/<id>`) is ALSO the SPA's
    // page address. A browser navigation there (prefers text/html, no
    // OpenWOP-Version) is the page's, not the protocol's (ADR 0646,
    // `isProtocolClient`), so it must fall through to the SPA shell instead of
    // being refused 400. Measured on prod 00875 (ac47fe16d): every run deep link
    // and refresh answered `validation_error` JSON. The `/v1…` spelling is only
    // ever a protocol request, so it keeps the guard unconditionally.
    if (m !== null && m[1] !== undefined && !m[1].startsWith('/v1/') && !isProtocolClient(req)) {
      next();
      return;
    }
    if (m !== null) {
      const [, prefix, rawSegment, tail] = m as unknown as [string, string, string, string];
      let decoded: string;
      // A `%` means the separator (or anything else) is PERCENT-encoded, so
      // percent-decode FIRST, even when a `~` escape is also present. That is
      // the spelling an SDK sends for the id this host returned
      // (`encodeURIComponent('user~3Ax/<opaque>')` → `user~3Ax%2F<opaque>`),
      // and what the negotiator rebuilds after a `%2F`-decoding proxy. The
      // projection branch below never touches `%2F`, so it looked up
      // `user:x%2F<opaque>` as a bare id and answered 404 for every personal
      // and org tenant (they all carry a `:`). The tenant half keeps its `~`
      // escape after percent-decoding, and `fromWireRunId` → `fromWireTenant`
      // decodes it. The full projection (`user~3Ax~2F<opaque>`) has no `%`.
      if (rawSegment.includes('%')) {
        try {
          decoded = decodeURIComponent(rawSegment);
        } catch {
          decoded = rawSegment;
        }
      } else if (looksProjected(rawSegment)) {
        // RFC 0184 §A.1 — the `~`-escape projection. Tried FIRST and only when
        // the marker is present, so a legacy `%2F` segment takes the identical
        // path it always took: the percent form is released behaviour and
        // `identity.md` §5 still requires it, so this ADDS a spelling rather
        // than switching one.
        try {
          decoded = unprojectBoundId(rawSegment);
        } catch {
          // A malformed escape named no run — it is not a 404 ("no such run"),
          // which would answer a question the request never asked.
          next(
            new OpenwopError(
              'validation_error',
              "A tenant-bound id's '~' escape MUST be followed by two hex digits.",
              400,
            ),
          );
          return;
        }
      } else {
        try {
          decoded = decodeURIComponent(rawSegment);
        } catch {
          decoded = rawSegment;
        }
      }
      // A colon-suffixed operation (`:diff`, `:fork`, `:pause`, `:resume`) rides
      // INSIDE this segment — `RUN_PATH`'s class admits `:` — so `<opaque>:diff`
      // reached the 16–128 grammar and was refused as a tenant mismatch (measured
      // 2026-09-05, corpus steward `4f74`: every colon op on a bound id was a
      // false 403). Split the op off, resolve the id, put the op back.
      // ADR 0726 — the op suffix is a TRAILING `:<op>` (`:fork`, `:pause`),
      // never the first colon: a personal tenant is `user:<hash>`, and the
      // first-colon split sliced `user:x/<id>` at `user` and 404'd every raw
      // bound id under a personal workspace.
      const opMatch = /:([A-Za-z][A-Za-z-]*)$/.exec(decoded);
      const colon = opMatch !== null ? opMatch.index : -1;
      const idPart = colon >= 0 ? decoded.slice(0, colon) : decoded;
      const opSuffix = colon >= 0 ? decoded.slice(colon) : '';
      if (idPart.includes('/')) {
        const resolved = fromWireRunId(idPart, tenant);
        // A run-scoped `?streamToken=` on the run-events stream stands in for the
        // tenant check, exactly as it does in `runAccess.loadReadableRun`. The SPA
        // streams from the cross-origin SSE base, where the session cookie cannot
        // follow, so the auth layer gives the request a FRESH anon session and the
        // caller's tenant can never be the run's. Without this the bound id was
        // refused 403 here, before the route ever saw the token: every cookie-mode
        // viewer's live v2 run stream (MEASURED on prod 2026-10-01: 18/18 stream-token
        // requests 403). The token is an HMAC over exactly one run id, so it admits
        // that run's stream and nothing else; the route re-verifies it.
        const opaque = idPart.slice(idPart.lastIndexOf('/') + 1);
        if (!resolved.ok && streamTokenAdmits(req, prefix, tail, opaque)) {
          req.url = `${prefix}${encodeURIComponent(opaque)}${opSuffix}${tail}`;
          next();
          return;
        }
        // A presented token that did NOT verify, and was the whole of the caller's
        // authority (`anonymousPrincipal`: a fresh mint or a returning anon
        // cookie): a REJECTED credential, `401 invalid_token`, exactly as
        // `runAccess.loadReadableRun` answers it, so an expired-token viewer is
        // told to mint a new token instead of being told the id is not theirs.
        // A caller with another credential falls through to the tenant check.
        if (!resolved.ok && presentsStreamToken(req, prefix, tail) && req.anonymousPrincipal === true) {
          if (req.res) setBearerChallenge(req, req.res, { presented: true });
          next(new OpenwopError('unauthenticated', 'The stream token is invalid or expired. Mint a new one.', 401));
          return;
        }
        if (!resolved.ok) {
          // `runs.md` §Identity — the refusal MUST NOT disclose whether the run
          // exists, so the message names the rule and nothing about the id.
          next(
            new OpenwopError(
              'id_tenant_mismatch',
              "A tenant-bound id's tenant segment MUST be the caller's.",
              403,
            ),
          );
          return;
        }
        req.url = `${prefix}${encodeURIComponent(resolved.runId)}${opSuffix}${tail}`;
      } else {
        // `identity.md` §5 — a bare (unbound) id is the v1 spelling, admitted
        // under the caller's tenant only THROUGH THE OVERLAP. v1 is retired
        // (ADR 0812), so it MUST be refused 400. This also
        // covers a DOUBLE-projected segment, which decodes to the bare-looking
        // form and must not resolve. Found by the 2026-10-03 cut rehearsal
        // (`v2-id-grammar`, `v2-bound-id-path-projection` both answered 200/404).
        next(
          new OpenwopError(
            'validation_error',
            'A tenant-bound id in a major-2 path (a run, webhook or trigger-subscription id) MUST be <tenantId>/<id>; the bare form is not admitted on a host that has retired 1.x.',
            400,
          ),
        );
        return;
      }
    }
    next();
  };
}
