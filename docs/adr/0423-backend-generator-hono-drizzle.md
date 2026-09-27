# ADR 0423 — Backend generator: TypeScript (Hono) + Drizzle + Postgres emit

Status: implemented (2026-07-18)

Decision source: **ADR 0348 §6e** ("first backend generator adapter — deferred to
its own slice/ADR when the first stack is chosen — migrations + SBOM +
conformance fixtures come with it") + the ratified **DECIDE-2 memo**
(`docs/DECISIONS-adr0342-deploy-stack-clarify.md`): TS + Drizzle + Postgres,
containerized — inert SQL migrations, one-lockfile SBOM, seed fixtures, in the
generator's existing language, deployable on the DECIDE-1 Cloud Run lane.

## Decision

A pure generator module `features/app-builder/export/backendGen.ts` emitting,
from the SAME `models[]`/`operations[]` SSoT that produces `openapi.json`
(`openapiGen.ts` — one closed field map, zero drift between the contract and
the server):

- `backend/src/db/schema.ts` — a Drizzle `pgTable` per model (the closed field
  map mirrors `FIELD_JSON`: string/number/boolean/date/reference/object/list).
- `backend/drizzle/0000_init.sql` — the initial migration emitted DIRECTLY as
  inert SQL (hashable, diffable — no drizzle-kit run inside the host; evolving
  apps run drizzle-kit themselves after export).
- `backend/src/routes.ts` + `backend/src/index.ts` — a Hono route per
  operation, kind-idiomatic method/path IDENTICAL to the OpenAPI projection
  (`KIND_METHOD`); CRUD kinds implemented over Drizzle; `action` kinds emit an
  honest 501 stub (the design declares intent, not an implementation).
- `backend/package.json` — PINNED exact dep versions (a shared const) so the
  emit is deterministic and the SBOM is derivable without resolution.
- `backend/sbom.cdx.json` — CycloneDX 1.5 listing exactly the pinned deps.
- `backend/test/fixtures/<opId>.json` — per-operation conformance fixtures
  ({request, response} samples derived deterministically from the declared
  input/output field shapes — the closed world again, no randomness).
- `backend/Dockerfile` — the Cloud Run-ready container (DECIDE-1 lane).

**Bundle integration:** `generateScrubbed` appends the backend files whenever
the design declares operations (the same "ships WITH the code when declared"
rule as `openapi.json`), so the secret-scrub + file/size caps apply unchanged.
**Determinism gate:** same canvas state ⇒ byte-identical backend files (no
timestamps, no randomness, pinned versions) — test-pinned by hashing a double
emit.

Non-goals: running/verifying the generated server in-host (that is the ADR 0345
3e live-preview + ADR 0349 deploy lanes); auth scaffolding (the DECIDE-2 memo's
recorded Supabase flip trigger); arbitrary SQL beyond the closed field map.

## Alternatives weighed
Recorded in the DECIDE-2 memo (Supabase-style managed backend; Next.js API
routes; Convex/Encore) — the memo's falsifiability condition stands.

## Implementation record
`backendGen.ts` (pure, bounded: 40 models × 40 fields, 50 operations — the
openapiGen caps) + `generateScrubbed` wiring + `test/app-builder-backend-gen.test.ts`
(determinism hash, schema/migration per field kind, route↔OpenAPI path parity,
SBOM component parity with package.json, fixture shape validity, honest-501
action stubs, no-operations ⇒ no backend emit).
