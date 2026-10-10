# ADR 0760 — bind anonymous-tenant run ids on the v2 wire (revisits ADR 0704)

Status: implemented

Issue: #4169. Revisits [ADR 0704](0704-anon-tenant-bound-ids.md).

## Context

Every anonymous visitor is an `anon:<sid>` tenant (`middleware/cookieSession.ts`
`mintAnonSession`). ADR 0704 kept those tenants' run ids **bare** on the major-2
wire: `toWireTenant` returned early for `anon:` and `V2_TENANT_ID` excluded the
prefix, so `toWireRunId` declined to bind. At the time the vendored `runId`
grammar did not admit `anon:`, so binding would have minted schema-invalid ids.

That premise expired at suite 2.2.0: RFC 0184 widened every bound-id kind's
tenant segment to `(anon:)?[A-Za-z0-9._~-]{1,128}`. ADR 0704 § "The tripwire
fired" then kept the ids bare anyway, as a product decision — binding changes
the id every anonymous visitor's links carry.

`@openwop/cli`'s v2 client audit (openwop-cli#46, 2026-09-27) measured the
result live: `POST /runs` and `GET /runs` under `OpenWOP-Version: 2` with an
anonymous session return bare ids. `spec/v2/core/identity.md` §5 and
`versioning.md` §5 forbid that: *"A host MUST NOT return a bare v1 id in a
major-2 response."* The steward asked for it fixed.

## Decision

Bind anonymous runs exactly like every other tenant's:

- `V2_TENANT_ID` / `V2_TENANT_BOUND_ID` are the corpus grammar **including**
  `(anon:)?`; the `anon:` early return in `toWireTenant` is deleted.
- On the wire an anonymous run id is `anon:<sid>/<opaque>` in bodies and
  `anon~3A<sid>~2F<opaque>` as a path segment (RFC 0184 projection — no new
  encoding; the `:` is escaped by the same codec that handles `user:`).
- `tenantId`-typed fields keep emitting `anon:<sid>` raw — inside
  `ids.schema.json#tenantId`, unchanged.

### Why this is safe for existing links

The storage id is unchanged (ADR 0629: binding is a wire projection, nothing is
re-minted or backfilled), so every `/v1/…` URL and every link built from a
stored id is untouched. On the v2 accept path `fromWireRunId` still takes a
**bare** id verbatim, so a v2 link minted before this change keeps resolving.
The SPA's `unbindRunIds` pattern (`client/v2Wire.ts`) already admits any tenant
spelling without `/`, so anonymous pages see the same bare ids they did before.
Isolation is unchanged: `host/runAccess.ts` enforces the tenant check
independently of spelling; the bound form adds the `id_tenant_mismatch` refusal
for a foreign anonymous tenant on top.

## Rollout note — the idempotency window (found by `/grade-data`, 2026-09-27)

The Layer-1 idempotency cache stores a response **before** the major-2
projection and re-projects it on replay (`routes/runs.ts`, the RFC 0213 fix).
So an anonymous client that created a run with an `Idempotency-Key` under
major 2 **before** this change and replays the same key **after** it receives
`anon:<sid>/<opaque>` where the original said `<opaque>`. The opaque half is
identical, the reference SPA strips the tenant segment (`unbindRunIds`), and
the replay now carries the form the spec requires — so this is accepted, not
patched. It is bounded by the cache TTL (`OPENWOP_IDEMPOTENCY_TTL_DAYS`,
default 7) after deploy. Persisted webhook deliveries keep the spelling they
were first sent with (deliberately — a retry repeats the receiver's dedup key),
so a pre-deploy delivery retried afterwards still says `<opaque>`.

## Not changed (and why)

An unauthenticated v2 request (no cookie, no bearer, no key) still gets `401` +
`WWW-Authenticate: Bearer` rather than a minted anonymous session. That was
reported alongside this issue as a second bug; it is not one — RFC 0200 §B.1 /
ADR 0750, `identity.md` §2.5, and every v2 operation declares security. The v1
twin and `/host/openwop-app/*` still mint anonymous sessions, and the SPA
bootstraps its session on a major-1 route before using v2.

## Alternatives weighed

| option | why not |
| --- | --- |
| keep bare (ADR 0704) | the MUST is violated on every anonymous v2 response; the premise (schema rejects `anon:`) no longer holds |
| project the tenant segment (`anon~3A<sid>/…`) in bodies, like `user:` | unnecessary — `anon:` is inside the corpus grammar raw; projecting would emit a spelling that is not the tenant's `tenantId` value |
| re-mint anonymous run ids | rewrites storage and every v1 URL for a wire-only requirement (rejected by ADR 0629) |

## Implementation record

| change | witness |
| --- | --- |
| `host/v2Ids.ts` — grammar includes `(anon:)?`; early return deleted | `anon-tenant-bound-id-tripwire` restored to EQUALITY with the vendored segment |
| HTTP boundary | `test/adr0760-anon-tenant-bound-http.test.ts`: create + list bound; projected / raw / bare all resolve for the owner; foreign anon → 403 `id_tenant_mismatch` |
| pinned old behaviour updated | `v2-identity.test.ts`, `adr0726-tenant-segment-codec.test.ts` |

Sabotage: re-introducing the unbound path for `anon:` reds 3 of the 6 witness
tests; restored, 6/6.
