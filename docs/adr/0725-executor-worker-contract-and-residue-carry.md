# ADR 0725 — The executor is a worker; residue payload keys are fixed at the writer, not carried by the reader

Status: Accepted — Phase 1 implemented, Phase 2 in progress (Phase E of the v2 gap-closure plan)
Date: 2026-09-17
Relates to: ADR 0650 (worker contract for daemons), ADR 0702 (envelope-id projection), ADR 0722 (composed major-2 payload projection + audit), ADR 0723 (bound-id kinds), RFC 0185 §C (carry-or-fail), RFC 0041 §C (fork byte-equivalence), corpus 2.3.3.

## Context

Two facts met during the Phase E architect pass:

1. **The executor inherits the launching request's protocol contract.** The event
   seat's contract is an `AsyncLocalStorage` value (`storage/eventEraAdapter.ts`
   `currentContract()`): a negotiated request parks its major there
   (`protocolVersion.ts` `runUnderContract(major, next)`), and ADR 0650 made the
   five `setInterval` daemons enter `runUnderWorkerContract` (contract 1)
   explicitly. Nothing did that for the executor — and **twenty-one sites** launch
   `executeRun` from *inside* a request (`routes/runs.ts:1443` `void executeRun`,
   the fork route, kanban, CRM, the trigger bridge, …). Under a major-2 `:fork`
   the executor's own parent-log reads — the verbatim `memory.written` copy into
   the child log (`executor.ts` RFC 0041 §C) and the refusal-divergence scan —
   came back **projected** (envelope ids, aliases, owner echo). It was byte-safe
   only by composition: no copied type has a required envelope id or an alias
   row today. The `worker-contract-explicit` ratchet enumerates `setInterval`
   workers, so the executor was invisible to it.

2. **58 of the corpus's typed events map to an UNHATCHED def, and this host emits
   ~35 of them in-tree** (`provider.usage`, every `envelope.*`, `voice.*`,
   `compensation.*`, `runOrchestrator.decided`, `node.dispatched`, …). RFC 0185
   §C says a projection MUST NOT silently drop a property — carry it (the
   `^(openwop-|x-|vendor\.)` hatch) or fail (`payload_unprojectable`, 500,
   non-retriable, registered in 2.3.2). Read literally as a runtime rule, that
   turns a static fact about in-tree emitters into a per-request outage on
   `GET /runs/{id}/events`, an SSE stream that ends in an error frame, and a
   dead-lettered webhook — for every run that emits `provider.usage` with one
   extra key.

## Decision

**D1 — `executeRun` enters the worker contract at its one owner.** The exported
`executeRun` is now a thin wrapper: `runUnderWorkerContract(() =>
executeRunInner(...))`. Every launch site is right by construction; the
alternative (wrapping 21 call sites) is the shared-helper-drift shape.
Witness: `test/adr0725-executor-worker-contract.test.ts` — a node observing
`currentContract()` reports `1` when the run is launched from inside
`runUnderContract(2, …)`; a negative control proves the observer sees the
ambient contract when no executor sits between them; sabotage (wrapper
removed) turns the leg red.

**D2 — residue keys on in-tree emitters are DEFECTS fixed at the write seam,
gated by the audit ratchet in CI; the reader carries nothing for them.**
The point of §C's carry-or-fail is a host that cannot change the writer. This
host can, with a witness per type (`adr0722-workforce-fixture-validates` is
the template: project every emitted event through
`projectV2Payload → projectV2RunIds` and validate against its def). After the
sweep the type-level baseline is a list of *named* emitters still to fix, not
a tolerance.

> **CORRECTION (same day, during implementation) — D2's population was drawn too
> wide, and D3's too narrow.** D2 said residue on in-tree emitters is fixed at
> the writer. The pre-sweep then found that the **SPA is itself a major-2
> consumer** (SSE and poll both pinned to `OpenWOP-Version: 2.0`, ADR 0647) and
> reads several of those keys at the top level: `conversation.opened.initialTurn`
> / `conversation.closed.finalTurn` (`chat/conversationClient.ts:153-155`,
> `runs/RunConversationPanel.tsx:272-283`), `run.failed.error.userMessage` /
> `.action` (`chat/ErrorCard.tsx:51`). A writer change for those would move BOTH
> wires (v1's `versioning.md` §1.2 forbids that mid-overlap) and break the SPA.
> So the rule as implemented is: **a key some reader consumes is CARRIED in the
> box on the major-2 read and the SPA opens the box at its one seam
> (`client/v2Wire.ts` `unbindRunIds`, `VENDOR_CARRY_KEY`)**; **a key NO reader
> consumes — a pure misnaming — is fixed at the writer** (`agent.reasoned`
> `summary → reasoning`, `agent.toolReturned` `transport` dropped,
> `replay.diverged` `null`s → absent). The box is not "pack keys only"; it is
> "keys that must keep their v1 spelling". `storage/vendorKeyCarry.ts` is
> schema-driven (walks the vendored def, recurses into closed+hatched
> sub-objects such as `_errorObject`, leaves unhatched defs untouched so the
> ratchet still sees them, idempotent). D2's gate is unchanged: unhatched-def
> residue is a CI failure fixed at the writer.

**D3 — the read-time carry is reserved for writers this host cannot change**
(node packs — the same population `payloadKeyAliases.json` scopes its rows
to). Shape, when a pack key needs it: ONE boxed `vendor.openwop-app` object
property holding the undeclared keys by their own names, built only from keys
the def does not declare, applied AFTER the alias step (so it cannot collide
with a seat rename) and idempotent by construction (`vendor.openwop-app` is
hatch-matching and therefore declared-equivalent on a second pass). A future
seat is one key move. **No runtime `payload_unprojectable` path ships in this
phase**: with no corpus scenario exercising it, a 500 nobody witnesses is a
green-by-absence outage; it is filed as a follow-up gated on that scenario.

**D4 — the audit measures the FULL wire.** `eventEraAdapter`'s recorder now
applies `projectV2RunIds` after `projectV2Payload`, the order every egress
channel applies. Phase A's audit recorded the copy before id binding, so 188
of its 797 wire errors were `must match pattern` on bare ids — an artefact.

## Alternatives weighed

- Per-key hand rows `key → vendor.openwop-app.key` in the alias table —
  rejected: the table's own header scopes rows to pack emitters, and the
  tripwire that keeps a row from outliving its seat ("target is a declared
  property") would have to be weakened.
- Generic box + runtime fail for every unhatched def (a sibling host's shape) —
  rejected for in-tree emitters (Context §2); kept as D3 for pack emitters.
- Wrapping the 21 `executeRun` call sites — rejected (drift).

## Consequences

- Fork copies and divergence scans read the storage vocabulary regardless of
  the caller's major; a carry step can no longer leak into a child log.
- The ratchet baselines shrink toward zero as emitters are fixed; `--write-shapes`
  runs once after the sweep, never after a corpus bump.
- Readers of the v1 wire are unchanged.

## Implementation record

| Phase | Change | Witness |
|---|---|---|
| 1 | `executor.ts` `executeRun` → `runUnderWorkerContract(executeRunInner)` | `adr0725-executor-worker-contract.test.ts` (3 legs, sabotage-proved) |
| 1 | recorder binds ids (D4) | audit shape ledger: `must match pattern` class → 0 on re-measure |
| 2 | emitter sweep per D2 (measured list, see ADR 0722 addendum) | one "projects clean" witness per fixed type |
| 3 (follow-up) | D3 box for pack emitters + `payload_unprojectable` when a corpus scenario exercises it | — |
