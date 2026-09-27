# ADR 0636 — The durability guard asserts only what an operator can satisfy

Status: Accepted — P0 implemented (2026-09-05); P1 open

Corrects ADR 0195 (LEAK-2 — a correction note is filed there). Found on a real
`OPENWOP_DEPLOY_POSTURE=auth` deploy of the KickTodo distribution (crosstalk
`fa83`, 2026-09-05); same family as ADR 0630 / #3627: a guard whose intent is
right and whose practice forces every adopter to route around it.

## Context

`host/surfaceBackends.ts` runs two boot guards over the thirteen `ctx.*` host
surfaces (`DURABILITY_REQUIRED_SURFACES` in `inMemorySurfaces.ts`):

- `assertDurableSurfacesInEnterprise` (ADR 0195, LEAK-2) — in the `auth`
  posture, refuse to boot if ANY surface resolves to `memory`. Its message said:
  *set `OPENWOP_SURFACE_BACKEND` (or per-surface `OPENWOP_SURFACE_*`) to a
  registered durable backend, or set `OPENWOP_ALLOW_INMEMORY_SURFACES=true`.*
- `assertSelectedBackendsAvailable` — refuse to boot if a surface SELECTS a
  backend id with no registered adapter. Never fall back silently; a deployment
  that asked for a real backend and did not get one is a durability lie.

Doing what the first message says makes the second fire. **Measured** by
enumerating every `registerSurfaceAdapter()` call the boot performs
(`initDurableSurfaces`, `registerS3BlobAdapter`, `registerOpenSearchAdapter`,
`registerPgVectorAdapter`, `registerPgSqlAdapter`):

| backend id | surfaces |
|---|---|
| `durable` | `kv cache table queue queueBus vector search nosql fs sql memory` (11) |
| `s3` | `blob` |
| `opensearch` / `pgvector` / `postgres` | `search` / `vector` / `sql` |
| *(none)* | `observability` |

So `OPENWOP_SURFACE_BACKEND=durable` selects a backend `blob` and
`observability` do not have → the wiring guard refuses. Opting them back out
(`=memory`) → the durability guard refuses. The durability guard was therefore
**unsatisfiable by configuration**, and its escape hatch became mandatory
boilerplate for every auth deploy. A guard that is always bypassed has stopped
guarding: `OPENWOP_ALLOW_INMEMORY_SURFACES=true` cannot distinguish "two
surfaces have no implementation" from "all thirteen are ephemeral and tenant
data resets on every restart" — the case it exists to catch. The one-line form
boots just as happily as the four-line safe form, and the error message steers
operators to the one-liner.

The only configuration that booted, verified on the live service
(`kicktodo-backend-00006-rs4`, read back from the running instance: 11
`durable`, 1 `structured-logger`, 1 `in-memory`), was derivable from neither
message:

```
OPENWOP_SURFACE_BACKEND=durable
OPENWOP_SURFACE_BLOB=memory
OPENWOP_SURFACE_OBSERVABILITY=memory
OPENWOP_ALLOW_INMEMORY_SURFACES=true
```

Six Cloud Run revisions failed before the backend served. And the durability
guard had **no test anywhere in the tree** — it had never been made to go red,
so nothing could have noticed that it could no longer go green.

## Decision

The guard asserts only what an operator can actually satisfy, and the
acknowledgement names what it acknowledges.

1. **Structurally unbackable surfaces are not violations.** A surface with no
   registered non-`memory` adapter (`isUnbackable(key)`) is excluded from the
   durability assertion. Nothing an operator sets can make it durable, so
   demanding it is not a guard, it is a toll. Today that is `observability`
   only; the set is computed from the registry at boot, not hard-coded, so a
   future adapter re-includes the surface automatically and a removed adapter
   excludes it. `blob` stays IN the assertion: it is backable by `s3`, and blob
   content is tenant data.
2. **`OPENWOP_ALLOW_INMEMORY_SURFACES` acknowledges surfaces BY NAME.** A
   comma-separated list of surface keys excuses exactly those. `true` keeps its
   old meaning — everything ephemeral — and is now visibly the dangerous form.
   An unknown key is a refused boot, not an ignored typo. "I accept ephemeral
   blob" and "I accept ephemeral everything" are different configurations
   again, which is the signal the hatch had lost.
3. **Both messages hand over the fix.** The durability message names the
   violating surfaces, the adapters each one DOES have
   (`OPENWOP_SURFACE_BLOB=<s3>`), the surfaces it did NOT count and why, and the
   exact acknowledgement for the violating set. The wiring message says whether
   a miss came from the surface's own variable or from the global default, lists
   the adapters that surface has, and for global-default misses prints the
   exact opt-out lines and (in the auth posture) the exact acknowledgement.

What did not change: the wiring guard still never falls back silently. With the
global default set to `durable`, `blob` and `observability` still have to be
opted out explicitly — the message now tells you the two lines.

After this ADR the auth-posture configurations are:

```
# durable everywhere it can be, blob acknowledged ephemeral by name
OPENWOP_SURFACE_BACKEND=durable
OPENWOP_SURFACE_BLOB=memory
OPENWOP_SURFACE_OBSERVABILITY=memory
OPENWOP_ALLOW_INMEMORY_SURFACES=blob

# fully durable — no acknowledgement at all
OPENWOP_SURFACE_BACKEND=durable
OPENWOP_SURFACE_BLOB=s3            # + OPENWOP_BLOB_S3_*
OPENWOP_SURFACE_OBSERVABILITY=memory
```

> **ORDERING CONSTRAINT (added 2026-09-07, found by the first adopter to apply
> this).** The list form is only understood by a backend at or after
> `093014619` (#3656). Every older backend evaluates the hatch as a strict
> `=== 'true'`, so `OPENWOP_ALLOW_INMEMORY_SURFACES=blob` on an older revision
> is not "acknowledge blob" — it is "no acknowledgement", and the guard refuses
> to boot. Apply the list form in the SAME deploy that carries the new code,
> never as a config-only update (`gcloud run services update --update-env-vars`)
> to a revision that predates it. The natural reading of this ADR's
> recommendation was "set this now"; on an un-synced white-label host that is a
> failed boot.

## Alternatives weighed

- **Register durable adapters for `blob` and `observability` so the guard is
  satisfiable as written.** The most complete fix and the most work; a
  Storage-backed blob store is a real feature (size limits, streaming,
  presign semantics) and a durable observability sink is a different product
  decision (what is stored, for how long, who reads it). Recorded as P1, not
  blocking: with (1) in place, landing either adapter later re-includes that
  surface in the assertion automatically. Not otherwise tracked in
  `docs/steward/` — this ADR is the tracker.
- **Keep both guards, improve the messages only.** The smallest change and the
  weakest: the hatch stays mandatory and `true` stays the only form, so the
  guard still cannot distinguish the two cases it exists to separate.
- **Document the four-line recipe and change nothing.** Rejected: the recipe
  ends in `=true`, which is the dangerous form; a document cannot make a
  boolean carry two meanings.
- **Make the global default skip surfaces that lack an adapter under that id.**
  Rejected: that is the silent fallback the seam header forbids. The operator
  said "everything durable"; quietly serving `blob` from memory would be the
  durability lie, just one level up.

## Consequences

- Every auth deploy loses one mandatory line of boilerplate (`=true`) and gains
  one meaningful one (`=blob`, or none).
- The hatch's value is again evidence: `grep ALLOW_INMEMORY` on a deploy's env
  now says which tenant-data surfaces the operator chose to run ephemeral.
- `true` is still accepted for compatibility. Adopters on the old recipe keep
  booting; the message they see if they ever trip the guard steers to the list.
- `readInMemoryAllowance`, `registeredBackendIds`, `isUnbackable` are exported
  for the readiness/diagnostics surfaces to reuse; nothing consumes them yet.

## Phases

| Phase | Scope | Status |
|---|---|---|
| P0 | `surfaceBackends.ts`: unbackable exclusion, named acknowledgement, both messages; `surface-backends.test.ts` pins the PREMISE against the real registrars (observability none, blob only s3, durable ×11), SABOTAGES each guard independently, pins that the live KickTodo config boots with `=blob`, that `=true` still boots, that the list excuses only what it names, that an unknown key refuses boot; `.env.example` + `DEPLOY.md` + deploy pack READMEs + ADR 0195 correction | implemented 2026-09-05 (this ADR's PR) |
| P1 | durable adapters for `blob` (Storage-backed, Postgres large-object or bytea) and `observability` (durable sink) — each re-enters the assertion automatically | open, not scheduled |

## RFC gate (wire vs host-extension)

**Host posture only — no RFC.** No wire shape, capability flag, run-event field
or endpoint changes. The `/.well-known/openwop` `implementation` tags are
unchanged; `structured-logger` for observability and `in-memory` for a
memory-backed blob were already honest.
