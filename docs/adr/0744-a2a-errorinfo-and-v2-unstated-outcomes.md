# ADR 0744 — A2A 1.0 errors carry `ErrorInfo`; unadvertised push refuses typed; three unstated v2 outcomes get their registered answer

Status: implemented

Date: 2026-09-23. Tracks the openwop MCP/A2A remediation program (`TODO.md` Phase 3,
items H1–H4, H6; openwop RFC 0211 / 0212 / 0213 / 0214 drafts). Host-side only: no wire shape
this ADR emits is new to the corpus. Each change either restates the pinned upstream
(A2A 1.0.1) or adopts the answer the v2 corpus already registers.

## Context

An overlap review of OpenWOP against A2A 1.0.1 and MCP 2026-07-28 found four places
where this host answers differently from the corpus or the pinned upstream:

1. **A2A 1.0 `error.data` shape (H1).** A2A 1.0.1 §9.5 says JSON-RPC `error.data` is
   "an array of objects, each containing a `@type` key, using ProtoJSON `Any`", and
   SHOULD carry `google.rpc.ErrorInfo`. a2a-js 1.2.0 and a2a-python 1.1.5 both emit
   `data: [ErrorInfo]`. This host (`a2aServer10.ts err10`) emitted a bare
   `{ reason }` object, so a strict client read no reason. The host's own client
   projection (`a2aCodec10.ts projectPeerError10`) read `data.reason` off a real
   peer's ARRAY, found nothing, and fell back to the numeric code. That silently
   dropped `supportedVersions`.
   Also on the A2A interface URL: a request refused **before** dispatch (auth 401,
   malformed body, 413, 429) answered with this host's `{ error, message, details? }`
   envelope. That body is neither A2A nor JSON-RPC.
2. **Version refusal code (H2).** An unsupported `A2A-Version` answered `-32600`.
   `a2a-integration.md` §B and A2A 1.0.1 §3.3.2 name `VersionNotSupportedError`
   (`-32009`), and the suite's `v2-a2a-operation-map` leg asserts `-32009`.
3. **Three v2 outcomes (H3), each of which previously leaked a vendor-prefixed code
   or dropped timing.**
   - A run-scoped interrupt resolve on a cancelled run answered
     `410 interrupt_gone`. That code has no v2 registry row, so the negotiator sent
     `openwop-app.interrupt_gone`. v2 `errors.md` §One code per state and
     `interrupt.md` say `409 interrupt_already_resolved` (RFC 0171 C4.6).
   - The in-flight idempotency 409 carried its timing only in `details.retryAfter`.
     The v2 negotiator strips that field, so a major-2 loser had no retry timing.
   - A malformed `Last-Event-ID` answered `invalid_request`, which has no v2 row, so
     the wire code was `openwop-app.invalid_request`.
4. **Witness digest (H4).** Both bundle-v3 verifier copies sorted rows with
   `localeCompare(…, 'en')` and ignored `host.relaxations[]`. A collation is a
   property of the machine: under `cs` (`ch` sorts after `h`), `sk`, `lt` and `haw`,
   the suite's default-locale sort already reorders the committed bundles. Since
   suite 2.35.0 the digest preimage includes non-empty relaxations. A relaxed bundle
   therefore failed here with `witness-digest`, for the wrong reason.

5. **Push-config refusals (H6).** With `capabilities.pushNotifications` false,
   `Get`/`List`/`DeleteTaskPushNotificationConfig` fell through to `-32601 method not
   found`. A2A 1.0.1 §3.3.4 makes every push-config operation
   `PushNotificationNotSupportedError` (-32003) when push is not advertised (openwop
   suite leg `a2a-push-unadvertised-refused`, RFC 0214).

## Decision

- **H1.** Every A2A **1.0** JSON-RPC error's `data` is the §9.5 `Any[]` with one
  `google.rpc.ErrorInfo`: `reason` in UPPER_SNAKE, `domain: "a2a-protocol.org"`
  (`errorData10`).
  - `TASK_NOT_FOUND` carries no metadata. An unknown task and a foreign-tenant task
    therefore answer identically apart from the id the caller sent.
  - The client accepts both the `Any[]` shape and the legacy `{ reason,
    supportedVersions[] }` object. It reads only `reason` and
    `metadata.supportedVersions`.
  - The 0.3 codec is unchanged, byte for byte.
  - New middleware `a2aInterfaceErrors.ts` re-renders an OpenWOP-envelope refusal on
    the A2A interface URL as a JSON-RPC error on the **same** HTTP status, keeping
    every header the refusing layer set:
    - a malformed body gives `-32700`;
    - any other refusal gives `-32000` with an `openwop.dev`-domain `ErrorInfo`;
    - a 5xx gives `-32603`.
  - The middleware's scope is `POST` to the listed interface, the A2A server enabled,
    and an `A2A-Version` header present. A disabled interface is listed on no card.
    A header-less request is 0.3 by the upstream receiver rule.
- **`supportedVersions` placement (openwop decision D1).** `ErrorInfo.metadata` is
  `map<string,string>`, so the list travels comma-joined
  (`metadata.supportedVersions: "1.0,0.3"`). A client falls back to the card's
  `supportedInterfaces[].protocolVersion` when the field is absent.
- **H2.** An unsupported `A2A-Version` gives `-32009 VersionNotSupportedError` with
  the `ErrorInfo` above. The HTTP status stays 200, the endpoint's contract for
  every JSON-RPC error.
- **H3.** The first two items apply under major 2 only. Major 1 keeps what its
  clients read.
  - A run-scoped resolve on a terminal run (cancelled, completed or failed) with an
    unresolved interrupt gives `409 interrupt_already_resolved` with
    `details.runStatus`.
  - A malformed `Last-Event-ID` gives `400 validation_error` with
    `details.field: "Last-Event-ID"`.
  - The in-flight 409 sets `Retry-After` on every major. The header is standard HTTP,
    and the v2 negotiator strips the `details` copy.
- **H4.** Rows are ordered by UTF-16 code unit (plain `<`, the RFC 8785 §3.2.3
  comparator). `host.relaxations[]` joins the preimage as `{ rows, relaxations }`
  only when non-empty, exactly as the suite's `certification-bundle-v3.ts` does.
  Both copies change together: `certificationEvidence.ts` and
  `scripts/lib/bundle-v3-verify.mjs`.

- **H6.** Unadvertised push: all four push-config methods give `-32003` with the
  `PUSH_NOTIFICATION_NOT_SUPPORTED` `ErrorInfo`. Advertised push (the durable flag):
  this host still has no addressable per-task config, so Get/List/Delete give a typed
  `UNSUPPORTED_OPERATION`, never `-32601`. The push-sink defects (credentials dropped,
  redirects followed, 0.3 body) are tracked separately, and `pushNotifications` stays
  unadvertised in production until they are fixed.

## Alternatives weighed

- **Keep `{ reason }` and ask upstream to bless it.** Rejected. The upstream text
  and both reference SDKs already agree on `Any[]`. The divergence is ours.
- **Put `supportedVersions` as an array inside `ErrorInfo.metadata`.** Rejected, as
  it is not representable: metadata is `map<string,string>`.
- **Answer pre-dispatch refusals on the A2A URL with HTTP 200 JSON-RPC.** Rejected.
  It would hide a real 401 or 429 from HTTP-level retry and auth logic and drop the
  `WWW-Authenticate` challenge. Keeping the status and changing only the body is the
  smaller change.
- **Keep `'en'` collation (the previous pin).** Rejected. It matches one producer
  locale, not the bundle. Code-unit order is locale-free and agrees with every
  committed bundle: a census of the 5 committed v3 bundles found all digests
  unchanged.

## Consequences

- A strict A2A 1.0 client now reads this host's `reason`. This host now reads a real
  peer's `reason` and `supportedVersions`.
- The `v2-a2a-operation-map` `-32009` leg can now pass against this host.
- A v2 client never sees `openwop-app.interrupt_gone` or
  `openwop-app.invalid_request` from these paths.
- A relaxed bundle verifies instead of failing `witness-digest`.
- No persisted data changes, and nothing to migrate: error bodies are not stored.

## Implementation

| Item | Files | Tests |
|---|---|---|
| H1 | `src/host/a2aCodec10.ts`, `src/host/a2aServer10.ts`, `src/host/a2aServer.ts` (type), `src/middleware/a2aInterfaceErrors.ts`, `src/index.ts` | `a2a-codec-1-0`, `a2a-1-0-server`, `a2a-tenant-binding`, `adr-0744-a2a-errorinfo-v2-outcomes` §1 |
| H2 | `src/routes/agents.ts` | `a2a-version-refusal` |
| H3 | `src/routes/interrupts.ts`, `src/routes/runs.ts`, `src/routes/streams.ts` | `adr-0744-…` §2, `idempotent-run-admission`, `sse-resume` |
| H6 | `src/host/a2aCodec10.ts` (method names), `src/host/a2aServer10.ts` | `a2a-1-0-server` (unadvertised → -32003 ×4; advertised → typed, never -32601) |
| H4 | `src/host/certificationEvidence.ts`, `scripts/lib/bundle-v3-verify.mjs` | `adr-0744-…` §3, `whd18-scripts`, `whd18-certification-bundle-routes` |

Sabotage (run 2026-09-23): unmounting `a2aInterfaceErrorsMiddleware` and disabling
the major-2 terminal-run branch turned 5 of the 11 new tests red. Removing the H6
switch arm turned both H6 tests red. The §3 tests
include an assertion that an `'en'` collation gives a different digest for their
ids, so the order assertion can fail.

## Correction (2026-09-24, architect review before merge)

> **§2 was green on a state the host never produces.** Its tests seeded an
> UNRESOLVED interrupt on a terminal run. On the real path — accept, the run
> completes, resolve again — `getInterruptByNode` returns OPEN interrupts only
> (`resolved_at IS NULL`), so the handler answered `404 interrupt_not_found`
> before the new terminal check ran, and RFC 0213 §C's 409 was unreachable
> (`v2-interrupt-resolve-terminal` leg 2 asserts exactly this). Fixed in
> `routes/interrupts.ts`: under major 2, a missing open interrupt on a TERMINAL
> run is `409 interrupt_already_resolved`; a live run still 404s, and major 1 is
> unchanged. Pinned by HTTP legs that drive the real storage transitions
> (`resolveInterrupt` → `updateRun`); reverting the route reds both.
>
> Known residuals, recorded rather than fixed here (none is asserted by the
> published suite, all verified by reading the code):
> - `a2aInterfaceErrors.ts` re-renders only when an `A2A-Version` header is
>   present, so a header-less refusal on the card-listed URL keeps the host
>   envelope (RFC 0211 §C says "every response"; §F scopes 0.3 out). It also
>   re-renders an explicit `A2A-Version: 0.3` request into 1.0 shape; gating on
>   `codecVersionFor(...) !== '0.3'` would be tighter.
> - `jsonGzip.ts` serialises past `res.json`, so with context-economy transport
>   ON a late 503 skips the A2A wrapper (and, pre-existing, the v2 negotiator).
> - ~~RFC 0212 §B's canonicalisation refusals (duplicate names, lone surrogates,
>   integers > 2^53−1) are not implemented in either `canonicalJSON`; only §C
>   (code-unit order, relaxations) is. The relaxations wiring has no
>   boundary-level test.~~ **Closed 2026-09-24** (`fix/bundle-verify-ijson-refusal`):
>   both verifiers now canonicalize through `host/jcs.ts` / `scripts/lib/jcs.mjs`
>   (mirrors of the suite's `src/lib/jcs.ts`) and parse bundle text through the
>   I-JSON boundary, so every §B refusal is a structured `non-ijson` rejection.
>   `test/rfc0212-jcs-vectors.test.ts` runs the full normative `jcs-v1.json` set
>   against both, re-derives the three committed openwop evidence bundles, verifies
>   the bundle actually served for `ea9cd39ee` end to end (no false refusal on the
>   `publish-evidence.sh` path), and pins the relaxations preimage at the boundary.
> - With `OPENWOP_A2A_DURABLE_TASKS=true` push is advertised but Get/List/Delete
>   answer `UNSUPPORTED_OPERATION`, so RFC 0214 §A/§E are unmet in that mode
>   (pre-existing; off by default).
