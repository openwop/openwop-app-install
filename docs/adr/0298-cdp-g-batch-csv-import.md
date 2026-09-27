# ADR 0298 — CDP-G: batch/CSV import (rides `collectEventBatch`)

**Status:** Accepted (implemented 2026-07-06)
**Date:** 2026-07-06
**Depends on / composes:** ADR 0269 (CDP-G — event schema registry + collection + ingest-time PII
tagging; this is the batch-import follow-on it names), ADR 0262 (CDP program + ruling: reuse the
ingest spine, never a second mechanism), ADR 0077 (PII classification — reused verbatim via the
collect path).
**Part of:** CDP program (ADR 0262). CDP-G.

> **Numbering note.** Drafted as "ADR 0293" per the task brief, but 0293–0297 were claimed by a
> parallel session (the Funnel Program slate, #1401) before this landed; renumbered to the next free
> slot, **0298**. No content change.

**RFC gate:** **no new RFC.** A host-issued operator convenience: parse a CSV → feed the EXISTING
`cdp/collect` batch path. Nothing on the wire — no run-event field, no capability flag, no endpoint
contract change. Host-extension route under `/v1/host/openwop-app/cdp/*`, non-normative. The ingest
contract stays exactly as CDP-G (ADR 0269) already defined it.

## Why this exists

CDP-G (ADR 0269) shipped a schema-enforced, PII-tagging `cdp/collect` endpoint and a best-effort
`cdp/collect/batch` sibling that fans a bounded (≤100) array of `{ eventType, payload }` events
through the SAME per-event `collectEvent` path. Operators onboarding historical data have it in
**CSV**, not a JSON event array. Without a CSV path they either (a) hand-roll a client-side
CSV→JSON→batch loop (drifts, re-derives chunking + the cap) or (b) we grow a second importer with
its own validation/PII handling. Both fragment the one ingest owner.

## Decision

Add ONE host-ext route, `POST /v1/host/openwop-app/cdp/collect/import`, owned by a new
`features/cdp/csvImportService.ts`, that **rides `collectService.collectEventBatch` verbatim**.
The import module owns only two things it must: a pure CSV parser and the row→event mapping +
chunking. Schema validation, ingest-time PII tagging, and per-row outcome are NOT reimplemented —
they are whatever `collectEventBatch` (→ `collectEvent` → `validateEvent`) already does.

### 1. Single owner — `collectService` (rides the batch)

`importCsv(tenantId, csv, opts)` parses the CSV, maps each row to `{ eventType, payload }`, chunks
the mappable rows into ≤`MAX_COLLECT_BATCH` (100) groups, and calls `collectEventBatch` per chunk.
The per-row `ok`/`error` from the batch result is mapped back to the source CSV line. There is no
second `collectEvent` call, no second store write, no second schema check.

### 2. Pure, dependency-free CSV parser

`parseCsv(text)` — Node stdlib only, no new dependency. A minimal RFC-4180-ish state machine:
header row → column names; quoted fields; commas and newlines inside quotes; `""` as an escaped
quote; `\n`/`\r\n`/`\r` line endings; blank lines skipped. It returns each data record with its
1-based source line so per-row outcomes point at the operator's CSV. An unterminated quoted field
throws → the route maps it to a 400 (fail-closed structural error).

### 3. Event-type mapping

Exactly one of two params selects the event type (both/neither → 400):
- `eventType` — a fixed type applied to every row; the whole row becomes the payload.
- `eventTypeColumn` — a header whose per-row value is the type; that column is **stripped from the
  payload** (it is the type, not a payload field). A blank value → per-row failure.

CSV values are strings (CSV is untyped); payloads are `Record<string, string>`. Operators whose
schemas require non-string types register string-typed event schemas or coerce upstream — recorded
as a deliberate simplification, not a gap.

### 4. Dedup — in-import, scoped

`collectService` has **no** event-level dedup (confirmed by reading it). Rather than invent a
durable dedup store (that would be a second mechanism, out of scope), `dedupKeyField` (a header
name; not-in-header → 400) does **in-import** dedup: the first row for a key value is sent, later
rows with the same value this import are `skipped`. This is honest about its scope (one import, not
cross-import idempotency) and adds no persistence.

### 5. Fail-closed caps

- Whole-import hard cap `MAX_IMPORT_ROWS = 10_000` (data rows) on top of the per-batch 100 cap —
  oversize is rejected outright (400) before any write, never truncated.
- A scoped 8mb JSON body parser is mounted for the import route only (the global limit is 1mb): a
  10k-row CSV can exceed 1mb, which would 413 before the row cap is reached, making the cap dead
  code. The 8mb parser keeps the **row-count** cap the binding guard.
- Parse errors (unterminated quote, no header) → 400. Param errors (both/neither type selector,
  unknown `eventTypeColumn`/`dedupKeyField`) → 400. Per-row problems (column-count mismatch, blank
  event type, schema rejection) are surfaced per row and do NOT sink the import (parity with the
  batch's best-effort semantics).

### 6. Toggle + tenant + RBAC

Mirrors the batch route: `requireEnabled` (the `cdp` toggle; off → 404, no surface) and
`tenantOf(req)` scoping. Writes go only through `collectEventBatch`, which is tenant-scoped, so
there is no cross-tenant write path.

## Result shape

`200` with `{ imported, failed, skipped, rows: [{ line, status: 'imported'|'failed'|'skipped',
error? }] }`. Status codes: `200` (any per-row mix), `400` (parse/param/oversize/empty),
`404` (toggle off).

## Alternatives weighed

- **A second CSV importer with its own validation/PII** — rejected: fragments the one ingest owner
  (the exact anti-pattern ADR 0262/0269 guard against).
- **A new CSV dependency (`csv-parse`)** — rejected: the RFC-4180 subset we need is ~90 lines of
  stdlib; a dependency is not worth the supply-chain + build surface.
- **A durable cross-import dedup store** — deferred: that is idempotency-key territory (ADR 0269 §1
  notes the collect endpoint is idempotency-keyed at the SDK layer); in-import dedup covers the
  common "my CSV has dupes" case without new persistence.
- **A wire event / RFC** — not applicable: nothing here is advertised or normative; it is a host
  convenience over an already-host-ext endpoint.

## Implementation

| Piece | Where |
| --- | --- |
| CSV parser + import service | `backend/typescript/src/features/cdp/csvImportService.ts` |
| Route (`POST …/cdp/collect/import`) | `backend/typescript/src/features/cdp/routes.ts` |
| Scoped 8mb body parser | `backend/typescript/src/index.ts` |
| Tests | `backend/typescript/test/cdp-csv-import.test.ts` |

## Open decisions checklist

- [x] Single owner = `collectService.collectEventBatch` (no second importer).
- [x] Pure stdlib CSV parser (no new dependency).
- [x] Whole-import 10k hard cap + ≤100 chunking; oversize fail-closed.
- [x] Parse/param errors → 400 fail-closed; per-row failures surfaced, non-sinking.
- [x] In-import dedup via `dedupKeyField` (collectService has no durable dedup).
- [x] Toggle-gated + tenant-scoped; no cross-tenant write path.
- [x] No new RFC (host-ext, non-normative).
