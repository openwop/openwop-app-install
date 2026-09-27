# ADR 0654 — v1 is deprecated on this host: deprecation signalling on every `/v1` response, and the host-extension reads at protocol-shaped paths move to the vendor namespace

Status: Accepted (implemented in this PR)

## Context

Operator directive, 2026-09-11: "deprecate OpenWOP v1 on this app immediately
and move fully to v2." The corpus draws one line this host cannot cross
alone: `versioning.md` §5 makes retirement atomic — `1.x` leaves
`protocolVersions[]`, `preferredVersion` becomes `2.0` and the `/v1` path
space goes, together — and the overlap ends only at v1 end-of-support
(`overview.md`; leg (a) `notBefore` 2026-12-04, anchor 2026-09-05). There is
no early-drop clause and no host-local one. So on this host **deprecation is
today and retirement is the clock** (readiness deep dive, third pass,
crosstalk `31b0`; the question of an earlier per-host retirement is with the
steward).

Measured blast radius (Cloud Run logs, 7 days, 17,148 requests): **no
third-party v1 protocol client exists.** Every non-browser `/v1` protocol hit
is this host's own certify cuts and deploy probes; browsers hit `/v1` protocol
paths 8 times in 7 days (the SPA has been on major 2 since ADR 0647). The
only v1 consumers are the SPA's `/v1/host/openwop-app/` twin and the v1
certify lane.

Separately, the steward corrected the record (`cc6c`): `GET /runs` (list),
`DELETE /runs/{id}` and `/runs/{id}/events/token` were **never v1 protocol
operations** — the v1 OpenAPI has fifteen `/v1/runs*` operations and none of
these. They are host extensions at protocol-shaped paths, so their
disposition is RFC 0181's: they move to `/host/openwop-app/…`. And `GET /runs`
serving JSON on a manifest-named path (`/runs` is `POST createRun`) is a live
§1.4 violation under 2.0.12 until it does.

## Decision

1. **Deprecation signalling (steward ruling `4ad9`).** The negotiator stamps
   every `/v1/…` response — protocol operations and the vendor twin alike —
   and the v1 representation of the discovery document with RFC 9745
   `Deprecation: @<epoch of 2026-09-11>` and a `Link rel="deprecation"` to the
   end-of-support clause. RFC 8594 `Sunset` is emitted **only when the host
   holds a date** (`OPENWOP_V1_SUNSET=<YYYY-MM-DD>`): the clock's `notBefore`
   (2026-12-04) is a floor the corpus computes from the matrix, not a date this
   host holds, and a `Sunset` naming a floor would be a claim. Unversioned
   major-2 responses carry none. Both are IETF standard headers, not protocol
   headers (`headers.md`, RFC 0171 §C.1), so nothing in §1.4 constrains them
   and the corpus need not define them first. `OPENWOP_V1_DEPRECATION=off`
   silences the signal, so an objection or a moved clock is one env update.
2. **Vendor twins for the three reads.** `vendorTwin(path)` in
   `protocolVersion.ts` builds `/v1/host/openwop-app/<path>` from the
   constants (so the v1-reliance ratchet, which counts literals, sees a
   migration destination, not a new reliance). `GET /runs`, `DELETE
   /runs/:runId` and `GET /runs/:runId/events/token` are registered on both
   their old `/v1` path and the twin — the same handler, an Express path array.
   The old paths stay through the overlap (with the sunset signal) and retire
   with `/v1`; the canonical `/host/openwop-app/…` reaches the twin through
   ADR 0652's mount.
3. **The SPA moves first.** `VENDOR_BASE` in `client/v2Wire.ts`; `listMyRuns`,
   `deleteRun` and the stream-token mint call `/host/openwop-app/runs…`. The
   front door already rewrites `/api/**` and the backend strips `/api/`, so
   nothing changes in hosting. `spaProtocolCallSites` falls 13 → 10 and is
   re-baselined with that attribution. `debug-bundle` and `getCapabilities`
   stay v1 (they ARE v1 protocol surfaces; the capabilities read becomes the
   v2 root in a later unit).

## Alternatives

- **Drop `1.x` now.** Non-conformant for a matrix host before the clock
  (§5), and the December switch does not exist (`ff83` §0: the constants only
  change the advertisement). Rejected; the question is with the steward.
- **Move the three reads to new protocol operations.** A run list is a real
  interop gap the steward will RFC for 2.1; a protocol delete contradicts the
  append-only log. Until then they are vendor operations. Rejected for now.
- **Signal deprecation only in discovery.** Nothing in the v2 document is
  read by a v1 client; the header reaches the client that is actually calling
  `/v1`. Rejected.

## Implementation record

| what | where |
|---|---|
| `v1DeprecationHeaders()`, stamped when `versioned` or on the v1 discovery document; `vendorTwin()`; `VENDOR_ORG`/`VENDOR_ROOT` single owner | `backend/typescript/src/middleware/protocolVersion.ts` |
| list + delete on the twin | `backend/typescript/src/routes/runs.ts` |
| events token on the twin | `backend/typescript/src/routes/streams.ts` |
| route test: Deprecation on `/v1` ×3 paths and the v1 discovery document, none on major 2 or the v2 document, `Sunset` only with a held date, `off` silences; twins equal the originals; canonical address reaches the handler | `backend/typescript/test/adr0653-v1-sunset-and-vendor-twins.test.ts` |
| `VENDOR_BASE`; three call sites; token leg asserts the vendor path | `frontend/react/src/client/{v2Wire,runsClient,streamsClient}.ts`, `__tests__/v2Clients.test.ts` |

## Consequences

- Any v1 caller now sees the deprecation in every response; the only such callers
  measured are this host's own tools.
- The remaining deprecation list (`31b0` §2): SPA host-extension migration
  (1,100 sites), backend SDK 1.7.0 → 2.0.0, deploy gate → major-2 certify with
  a public receiver, the 26 ambient event readers under explicit contract,
  the single December flag, packs `<3.0.0`.
