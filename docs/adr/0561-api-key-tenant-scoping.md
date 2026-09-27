# ADR 0561 — API-key tenant scoping

Status: Accepted — implemented 2026-08-13

Date: 2026-08-13

Composes: `middleware/auth.ts`, `host/runAccess.ts`, ADR 0270 (self-service
scoped keys), ADR 0553 P0 (the MCP anonymous-wildcard removal). No RFC gate —
this is host-local authorization, not wire shape.

## Context

Every key configured in `OPENWOP_API_KEYS` / `OPENWOP_API_KEY` received
`tenants: ['*']`:

```ts
// API-key path — wildcard tenant (conformance harness / admin
// tooling). Real deployments narrow via a key→tenant table.
req.principal = { principalId: `bearer:…`, tenants: ['*'], token: bearerToken };
```

That comment described a key→tenant table **that did not exist**. There was no
way to narrow, so the wildcard was not a default — it was the only reachable
behaviour, and the comment made it read as a configuration choice someone had
already thought about.

The wildcard is not cosmetic. `host/runAccess.ts` returns any run to a wildcard
principal **before** the ownership check, in both `loadReadableRun` and
`loadOwnedRun`:

```ts
if (req.principal?.tenants?.includes('*')) return run;
const tenantId = req.tenantId ?? 'default';
if (run.tenantId !== tenantId) throw new OpenwopError('run_not_found', …, 404);
```

Twelve-plus modules treat `tenants.includes('*')` as operator authority,
including `superadmin.ts`, both storage backends, `sseChannel.ts` and
`featureRoute.ts`. So configuring one API key handed its holder every tenant's
runs, events, SSE streams and feature state.

**It was inert in production, and saying so matters.** The live Cloud Run service
declares `OPENWOP_API_KEYS` with **no value** and does not set `OPENWOP_API_KEY`;
`readKeyTenants`' CSV split then yields an empty set, so no bearer matched.
`DEPLOY.md:413` documents `OPENWOP_API_KEYS: ""` as *correct* for the
cookie-per-visitor posture. This ADR fixes a latent grant, not an active breach —
and that is precisely why the default could be changed cheaply, since nothing in
production depended on it.

### Why the ADR 0553 P0 precedent is weaker than it looks

ADR 0553 P0 removed a wildcard too, and it is tempting to file this as the same
defect on a second lane. It is not. That was an **anonymous** principal
synthesized when authentication was **absent** — authority from nothing. This is
an **authenticated** principal derived from a deliberately configured secret. The
first was unambiguously a bug; this one is an over-broad default for a real
capability that some operators legitimately want.

That difference is why this ADR preserves cross-tenant access rather than
deleting it.

## Decision

`OPENWOP_API_KEYS` entries become `<key>` or `<key>:<tenant>`:

| config | principal |
|---|---|
| `k1` | `tenants: ['default']` |
| `k1:acme` | `tenants: ['acme']` |
| `k1:*` | `tenants: ['*']` — cross-tenant operator |

A bare key is **scoped**. Cross-tenant authority still exists, but an operator
has to write `*`, which makes the grant visible in the config that produces it.

The scoped path also pins `req.tenantId` to the key's tenant, matching what the
ADR 0270 `owk_` path already did. This is load-bearing: routes read
`req.tenantId ?? 'default'`, so setting `tenants` alone would leave a key scoped
to `acme` acting as `default` and 404ing on its own data. The wildcard had hidden
that — `loadReadableRun` short-circuits before the ownership check — so it only
surfaced once scoping became reachable. **The test caught it, not review.**

A `*` key deliberately leaves `req.tenantId` unset, preserving today's operator
posture: cross-tenant on reads, `default` for anything needing a concrete tenant.

Edge cases resolve toward **less** authority: `"k1:"` (a half-written scope) is a
typo, not a wildcard request, and parses as `default`. Keys containing colons
split on the **last** one.

## Alternatives weighed

- **Narrow hard, no wildcard from env keys.** Strongest isolation, but deletes
  the operator capability that `superadmin.ts` and the runs-list routes assume,
  and breaks the conformance harness. Rejected as a behaviour deletion wearing a
  security fix's clothes.
- **Leave it; add a boot warning and a tripwire.** Lowest risk, closes nothing.
  A warning is not an authorization boundary — the same reasoning ADR 0553 P0
  applied to `mcp-anonymous`.
- **A separate `OPENWOP_API_KEY_WILDCARD=true` flag.** Rejected: it scopes the
  grant to the deployment rather than the key, so an operator wanting one
  admin key plus three tenant keys cannot express it.

## Implementation record

`readValidKeys()` → `readKeyTenants()`, returning `Map<key, tenants[]>`. Renamed
because four comments across three files referenced the old name and would have
become quietly false.

### The blast radius I measured was right, and the conclusion I drew from it was wrong

I narrowed the grant locally, ran the **conformance** suite, got 2 failures out
of 2565, and treated that as the blast radius. Then `npm run ci` failed with
**181 tests across 59 files** in the vitest lane — thirty times larger.

The measurement was accurate; the generalisation was not. One lane is not the
system, and "I measured it" is not the same claim as "I measured the thing that
would break." The conformance harness configures its own key explicitly, so it
exercised exactly the path I had reasoned about, and told me nothing about the
166 test files that authenticate with the built-in `dev-token` default.

The fix is a line worth drawing on its own merits rather than a retrofit: the
**unconfigured `dev-token` fallback keeps the wildcard**. It is not a key an
operator configured — it is the local-development default, and
`authIsEnforced()` already withdraws it in production (SEC-2), so it cannot be
what hands a real deployment cross-tenant access. Scoping it would change no
production posture while breaking every local admin affordance. Configuring
`OPENWOP_API_KEYS=dev-token` explicitly still scopes it, like any other
configured key — pinned by its own test, so "dev-token is special" cannot drift
into "the string dev-token is always an operator".

**Blast radius, measured before the change rather than argued about.** Narrowing
locally and running the full conformance suite: **2 failures out of 2565** —
`artifact-type-registration-source` and `artifact-type-store-emission`, both
reading a run's event log over the standard poll endpoint, both 404 without the
wildcard. Exactly the `runAccess.ts` short-circuit. `conformance/run.ts` now opts
in with `OPENWOP_API_KEYS = ${API_KEY}:*`, set via `OPENWOP_API_KEYS` rather than
by suffixing `OPENWOP_API_KEY` — that variable is handed to the suite process as
the **client's** bearer token, and a `:*`-suffixed token authenticates against
nothing. Full suite green afterwards: 2565 passed.

Tests: `test/api-key-tenant-scoping.test.ts` (8), asserted at the wire through
`GET /v1/runs/:runId` — the real bypass path, not the parser's own arithmetic.
The suite uses a **file-backed** sqlite DSN on purpose: `memory://` opens a fresh
in-memory database per `openStorage` call, so a run seeded through a second
handle would be invisible to the app and every assertion would 404 for the wrong
reason — passing while measuring nothing. `beforeAll` asserts the seed is
readable by the `*` key before any negative leg runs.

**Sabotage-proven:** restoring the bare-key wildcard
(`out.set(trimmed, ['*'])`) turns the regression leg red with
`expected 200 to be 404` — a bare key reading another tenant's run, which is the
defect itself.

The isolation leg is paired with a same-tenant positive and a different-tenant
negative, so a 404 cannot pass by the endpoint simply being dead.

## Operator note

Existing deployments that set `OPENWOP_API_KEYS` and relied on implicit
cross-tenant access must append `:*` to those keys. The demo deployment is
unaffected (empty value). This is a deliberate breaking change to an
operator-facing contract, taken while the blast radius is zero.
