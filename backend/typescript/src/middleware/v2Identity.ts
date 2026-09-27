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
 * MAJOR 1 IS UNTOUCHED. Every branch below is gated on `negotiatedMajor(req)
 * === 2`; under major 1 this middleware is a single comparison and a `next()`.
 * The v1 wire never carried a tenant-bound run id and never validated an
 * `Idempotency-Key` on format, and narrowing either would be a new refusal on a
 * shipped contract.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { OpenwopError } from '../types.js';
import { tenantOf } from '../host/requestSubject.js';
import { V2_IDEMPOTENCY_KEY, fromWireRunId } from '../host/v2Ids.js';
import { looksProjected, unprojectBoundId } from '../host/boundIdProjection.js';
import { negotiatedMajor } from './protocolVersion.js';

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
const RUN_PATH = /^(\/v1\/(?:runs|webhooks|trigger-subscriptions)\/)([^/?#]+)([\s\S]*)$/;

export function v2IdentityMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (negotiatedMajor(req) !== 2) {
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
    if (m !== null) {
      const [, prefix, rawSegment, tail] = m as unknown as [string, string, string, string];
      let decoded: string;
      if (looksProjected(rawSegment)) {
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
      }
    }
    next();
  };
}
