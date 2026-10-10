# ADR 0814 — a grammar-clean wire tenantId: stop minting `~` in tenant-bound ids

Status: **implemented** (2026-10-05). #4387 (`800722836`) is live and verified on prod in a personal workspace (see P3).

Corrects ADR 0726's wire form of the tenant segment. Found during ADR 0812 P2b,
and confirmed against the corpus by the steward (7b).

## Context

This host's internal tenant keys are not all inside the v2 tenantId grammar:
- a personal workspace is `user:<sha256[:32]>` (`middleware/auth.ts`);
- a shared workspace is `ws:<uuid>`;
- a test-login org fixture is `org:<slug>`.

ADR 0726 made them wire-legal by byte-escaping the colon with RFC 0184's
projection (`host/v2Ids.ts` `toWireTenant` → `user~3A<hex>`), in every
tenant-bound id and every tenantId-typed body field. **Measured:** a v2 create
response body carries `runId: "org~3Acjchain-…/<uuid>"`.

`identity.md` §5 forbids exactly that:
- **`~` is reserved.** It exists only as the on-wire PROJECTION, and "a host MUST
  NOT mint a tenant-bound id containing `~`". The tenant is a segment of every
  tenant-bound id.
- **Project exactly once, where an id leaves.** That is a path or a link. A body
  carries the plain id.

No conformance leg sees it. `v2-id-grammar` (`openwop.requirement.0170.id-grammar.*`)
checks the tenant-bound regex, which admits `~` syntactically. And the conformance
key lands in `default`, which needs no escape. Every signed-in user's runs are
affected. The steward confirmed (2026-10-04) that nothing in `spec/v2/core` says
the wire tenantId must equal a stored key: tenantId is `x-openwop-minted: host`,
and §5 constrains only its wire grammar and handling.

## Decision

**A deterministic, injective, reversible host mapping from the internal tenant key
to a grammar-clean wire tenantId.** Internal keys are untouched.

| Internal key | Wire tenantId |
|---|---|
| grammar-clean (`^[A-Za-z0-9._-]{1,128}$`), and not starting with a reserved prefix | unchanged (`default`, `conformance-prod`) |
| `anon:<sid>` | unchanged (the corpus admits the `anon:` prefix literally; ADR 0760) |
| `user:<rest>`, with `<rest>` grammar-clean | `u-<rest>` |
| `ws:<rest>`, with `<rest>` grammar-clean | `w-<rest>` |
| `org:<rest>`, with `<rest>` grammar-clean | `o-<rest>` |
| anything else | `x-` + lowercase hex of the key's UTF-8 bytes |

> **Correction (implementation, 2026-10-04).** This table first routed a
> grammar-clean key starting with `u-`/`o-`/`x-` to the hex row. That made the
> map non-idempotent: `projectV2RunIds` rewrites `tenant`/`tenantId` keys at any
> depth, so a value that was already a wire value would be re-encoded. The map is
> now **idempotent** (a clean value passes through), and injectivity instead
> rests on an invariant enforced where keys are configured: **no internal key may
> start with `u-`/`w-`/`o-`/`x-`**, nor map past 128 characters
> (`v2Ids.ts` `wireTenantViolation`). An `OPENWOP_API_KEYS` entry that breaks it
> is **refused** (fail closed, logged once), never re-mapped. The keys this host
> mints (`user:`, `ws:`, `anon:`, `org:`) satisfy it by construction. `ws:` was
> missing from the first table and gets its own `w-` row.

**Injective under the invariant above.** The outputs are disjoint: only the
mapped rows start with a reserved prefix, and an identity output never does,
because no legal internal key starts with one. Decoding is a prefix dispatch, and
a new-form value decodes only when it is the CANONICAL spelling of its decode
(so `x-<hex(user:h)>` is not an alias of `u-h`). `x-` hex longer than 128 characters (an internal key over 63 bytes)
fails closed: the id is not bound, and that is logged, never truncated.

**One mapping on every surface (the steward's constraint 3).**
- `toWireTenant` and `fromWireTenant` remain the single choke. They feed the
  tenant-bound ids (`toWireRunId` / `fromWireRunId`, so runs, webhooks and trigger
  subscriptions) and the tenantId-typed body fields (`projectV2RunIds`).
- The `403 id_tenant_mismatch` check compares after `fromWireTenant` inverts the
  segment.
- The test seam's `fromWireTenant` call follows automatically.

**Bodies carry the plain id; links project once.** `o-xyz/<uuid>` in a body. A
path or link carries RFC 0184's projection of that plain id (`o-xyz~2F<uuid>`),
whose only escape is the separator.

**Ids already minted keep resolving (§5).** `fromWireTenant` accepts, for the same
tenant:
- the new form (`u-<hex>`);
- ADR 0726's form (`user~3A<hex>`). On a path that is two layers: our minted
  escape plus §5's own projection. It reaches the segment decoder already
  percent- or `~2F`-decoded (#4382);
- the raw internal key (`user:<hex>`), which the SPA's host-extension `active`
  value supplies. It is accepted through the overlap as before.

A host test pins every round trip and the injectivity table.

**Stable.** It is a pure function of the internal key, which never changes.

## Alternatives

- **Migrate stored tenant keys off `:`.** Also conformant, but it rewrites every
  tenant-keyed row, cookie, API-key binding and org reference. The wire would gain
  nothing over the mapping, and the risk is far larger.
- **Keep ADR 0726's `~3A`.** That violates §5, so it is not an option.
- **`.`-substitution (`user.<hex>`).** Not injective without forbidding `.` in
  internal keys, and operator-defined tenants (API-key config) can contain it.

## Consequences

- **Clients that stored an old `user~3A…` / `org~3A…` id keep working** (input
  tolerance). New responses carry `u-…` / `o-…`. A client comparing tenant strings
  across the change sees a different spelling for the same tenant. That is
  allowed: tenantId is host-minted and opaque.
- **The SPA needs no change.** It binds bare ids with whatever tenant it is given
  (`client/v2Wire.ts`), and both the raw and the new forms resolve.
- **Risk: an existing grammar-clean internal tenant that starts with `u-`, `o-` or
  `x-`.** Its wire tenant changes from identity to `x-<hex>`, and an id previously
  minted as `u-foo/<id>` would decode to `user:foo` and get 403 (fail closed, never
  a cross-tenant read: the run lookup is by opaque id plus the route's ownership
  check). Phase 1 measures whether any such tenant exists before shipping.

## Implementation plan

1. **P1 — census.** Count internal tenants starting with a reserved prefix
   (storage plus API-key config). If any exist, that tenant set is decoded as
   identity first, and the row's history is recorded here.
2. **P2 — the mapping.** Change `toWireTenant` / `fromWireTenant`, add the
   round-trip and injectivity unit tests, and extend the ADR 0726 HTTP test so a
   personal and an org create return `u-…` / `o-…` and the old `~3A` forms still
   resolve.
3. **P3 — verify on a personal tenant live.** Create, read and fork under a
   signed-in user, asserting that no `~` appears in any body.

## Implementation record

| Phase | Result |
|---|---|
| P1 census | Prod `OPENWOP_API_KEYS` tenants: `conformance-prod`, `conformance-verify`. `OPENWOP_SUPERADMIN_TENANTS` is a `user:` key. Minted shapes: `user:`, `ws:`, `org:`, `anon:`, `default`. **No tenant starts with a reserved prefix.** The only in-repo `u-…` tenant is a storage fixture (`adr0379-fold-idempotency.test.ts`) that never reaches the wire. |
| P2 mapping | `host/v2Ids.ts` (`toWireTenant`/`fromWireTenant`/`wireTenantViolation`), `middleware/apiKeyTenants.ts` (the leaf copy, pinned to agree), `test/adr0814-wire-tenant.test.ts`; ADR 0726 tests corrected and a legacy `user~3A` read pinned over HTTP; the SPA's `v2Wire` comment + test. |
| P3 live | Deployed 2026-10-05 as rev `00850-dc6` (both halves verified). It survived the redeploys to `00853` (`daa693872`) and `00856` (`1f6d635fe`). The probe creates, reads and forks a run, and fails on `~` in any body-borne bound id or tenant field. It PASSES for `conformance-prod` and for an anonymous session (`anon:<sid>`) on all three revisions. Neither tenant discriminates (both were already clean). **Closed 2026-10-05 (rev `00858`, `ce2abbde3`):** in the owner's personal workspace, with the owner's go-ahead, using a 10-minute session signed for that tenant; nothing was minted or stored. Create 201, read 200 and fork 201 all carry `u-c51185914124375f328788edbc4a29f8/…` with no `~` in any body. The ADR 0726 spelling `user~3Ac511…/<id>` resolves live to the same run, answered in the `u-` form. The non-clean case IS proven, in-process: the HTTP test (personal tenant → `u-<hash>/…`, the legacy `user~3A` read still resolves) and the suite leg below. |
| Suite leg | openwop #1902 (`openwop.requirement.0184.mint-no-tilde`, suite 2.45.19), run both ways on `800722836`. (a) Key tenant `acme@corp.example` with this map → PASS, runId `x-61636d6540636f72702e6578616d706c65/…`. (b) The same posture with `toWireTenant` reverted to `projectBoundId` → FAIL, naming `acme~40corp.example/…`. (c) `default` → PASS on both builds, the leg's documented limit. |

## Open questions

- [x] Does any v2 client (the CLI, MyndHyve) parse the tenant out of a run id?
      **No (researched 2026-10-04).**
      - **`@openwop/cli`** (`src/ids.ts` at `5fdd36d`) only *projects* ids. A
        `u-…/<id>` carries a `/`, so it is projected in full (`u-…~2F<id>`), which
        the host decodes. An old `user~3A…/<id>` is double-projected to
        `user~7E3A…~2F<id>`, which is the two-layer input this ADR keeps accepting
        (pinned in `adr0726-personal-tenant-http.test.ts`). No CLI change is needed.
        The comment there that cites the `user~3A` spelling becomes historical.
      - **MyndHyve** (`services/workflow-runtime/src/host/wireTenant.ts`) is a
        separate host whose wire tenant is its own workspace id. It never consumes
        this host's ids.
      - **The SPA** remembers the tenant it reads from a bound id
        (`client/v2Wire.ts` `fromWireRunId`) and re-binds with it, alternating
        harmlessly with the raw `active` key. Both decode to the same tenant, and
        nothing compares tenant strings (`workflowRunSubscription.ts` compares
        *unbound* ids).
- [x] **Steward review (openwop, 2026-10-04): no §5 objection.**
      - Accepting the old spellings is REQUIRED ("ids already minted MUST still resolve").
      - An idempotent map plus a fail-closed refusal at the only operator-supplied
        source (`OPENWOP_API_KEYS`) plus a canonical-checked decode that 403s rather
        than crossing tenants satisfies §5. Refusing an over-long key is preferred to
        hashing it, because `fromWireTenant` must invert.
      - The steward's question about `anon:` in a tenantId body field is answered by
        the SSoT: `ids.schema.json` `tenantId` = `^(anon:)?…`. The §5 prose table,
        which merges `tenantId` with `workspaceId`, is stale; the steward files the
        erratum.
- [ ] **Follow-up at the suite pin bump to ≥ 2.45.19:** `conformance/run.ts`
      gives the primary key `:*`, which lands in `default`, so the leg above is
      green-by-construction in our certified cut. Add a SECOND key scoped to a
      non-clean tenant (the `conformance-secondary` precedent), not a change to the
      primary key, whose wildcard many scenarios need.
- [x] ~~**Conformance cannot see this class today**~~ (closed by openwop #1902; history kept), because the suite key lands in
      `default`. The steward queued a suite leg for the 2.45.18 cycle (no RFC; the
      §5 MUST exists). It checks only FRESHLY minted ids, so legacy ids that still
      resolve stay legal, and it is inapplicable on a clean tenant. This host
      sabotage-proves it with `OPENWOP_API_KEYS=<key>:acme@corp.example` against a
      `toWireTenant` reverted to `projectBoundId`.
