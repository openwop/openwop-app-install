# ADR 0301 — CDP-F: Per-tenant tamper-evident audit hash-chain

**Status:** Accepted (implemented)
**Date:** 2026-07-06
**Depends on:** ADR 0268 (CDP-F — purpose/consent/masking/decision log; opened this as an
explicit optional follow-up), ADR 0020/0227 (consent), ADR 0028 (governance), ADR 0066/0070
(approvals), ADR 0284 (host-ext tenant teardown), the host-ext durable store
(`host/hostExtPersistence.ts` — `DurableCollection` + `kvCompareAndSwap`)
**Part of:** CDP program (ADR 0262). CDP-F.
**Wire impact:** NONE — host-extension only, no RFC (see below).

## Context

ADR 0268 (CDP-F) shipped the unified **`governance.decision.*` decision log** over
`Storage.appendAudit` and closed with an explicit open question:

> "Optionally add a per-tenant audit hash-chain (`prevHash`) for tamper-evidence."

That log — like `emit`/telemetry and the run-event log — is a **plain, mutable** audit
stream: a row written there can be silently altered or deleted after the fact with no
detectable trace. For CDP-F's most sensitive events — **consent changes** and
**governance/approval decisions** — an operator (or a compromised process) able to rewrite
history undetectably is a real compliance gap. There was **no tamper-evident log** in the
app.

This ADR closes that open question with a narrowly-scoped, per-tenant, append-only
**hash-chain**: each entry commits to the previous entry's hash, so any after-the-fact
mutation of a persisted entry breaks the chain and is detectable by a verification walk.

## Decision

Add **one** new owner of the tamper-evident log: **`host/auditChainService.ts`** — the
single appender and verifier of a per-tenant hash-chain. Scope it **narrowly to CDP-F**:
consent changes (`consent.change`) and governance/approval decisions
(`governance.decision`). It does **not** replace the decision log or the run-event log; it
is a second, integrity-bearing record for the two event classes that most need it.

### Shape

- **Entry:** `{ tenantId, seq, prevHash, entryHash, kind, at, payload }`, keyed
  `${tenantId}:${seq}` in a `DurableCollection`, plus a per-tenant **head pointer** keyed
  `${tenantId}`.
- **Hash:** `entryHash = sha256(prevHash + canonicalize({tenantId, seq, kind, at, payload}))`
  where **`canonicalize`** is deterministic JSON with **recursively, stably-sorted keys**
  (arrays keep order), so the hash is reproducible and independently verifiable from the
  stored row.
- **Genesis:** a real **seq-0** entry with `prevHash = '0'×64`; real appends are `seq 1..N`.
- **Durability:** a **durable side-log**, NOT run-state — it does **not** participate in
  `:fork` and is never rewound by replay. Registered like every other `DurableCollection`,
  so ADR 0284 tenant teardown purges it automatically.

### THE CRITICAL GUARD — per-tenant serialized append (belt + braces)

`appendAudit(tenantId, kind, payload)` must be serialized per tenant so two concurrent
appends can never fork the chain or reuse a seq. Serialized **two** ways, both load-bearing:

1. **Store-level compare-and-swap (the cross-instance correctness guarantee).** The new
   entry claims its seq via an **insert-if-absent CAS** on `${tenantId}:${seq}`
   (`DurableCollection.compareAndSwap(null, entry)` → storage `kvCompareAndSwap`). Exactly
   one writer wins a given seq; a loser re-reads the (now-advanced) head and retries the
   **next** seq. Because the seq claim is exclusive and the head only advances by the
   seq-winner, the head can never fork and appends are forced to serialize **across
   processes**. This is the same proven idiom as `eventSchemaService.registerEventSchema`.
   Retries are bounded; genuine exhaustion (pathological same-instant contention) throws.
2. **In-process per-tenant async mutex (removes CAS spin within one instance).**
   `withTenantLock` chains a tenant's appends through a promise queue so, in a single
   instance, they run strictly one-at-a-time and never contend on the CAS at all. This is
   the **belt** to the CAS's **braces** — an optimization for the common single-instance
   case; the CAS remains the hard guarantee where an in-process mutex cannot reach (multiple
   Cloud Run instances).

`verifyChain(tenantId)` walks `seq 0..head`, recomputing each `entryHash` from its stored
fields **and** checking the prev-hash linkage, returning `{ ok: true }` for an intact/empty
chain or `{ ok: false, brokenAt }` at the first tampered/mislinked seq.

### Seed points (thin, non-restructuring)

- **`consentService.recordConsent`** → `appendAudit(tenantId, 'consent.change', …)` after the
  record is written.
- **`approvalService.resolveApproval`** → `appendAudit(tenantId, 'governance.decision', …)`
  **only on the winning CAS claim** (`changed: true`), so a losing double-resolve appends
  nothing.

Both are **best-effort** at the call site (wrapped so an audit-chain failure never breaks
recording consent or resolving an approval) — the integrity guarantee is about *detecting*
tampering of what *was* recorded, not about blocking the primary action.

### Route

`GET /v1/host/openwop-app/cdp/audit-chain/verify` — **toggle-gated** (`cdp`) + **admin-gated**
(resolves the acting member, or the tenant-owner principal, and requires `admin`|`owner`) +
**tenant-scoped**. Returns `{ ok, length, brokenAt? }`.

## Alternatives weighed

- **Extend the existing `governance.decision.*` log with a `prevHash` column.** Rejected:
  that log is a mutable, cross-cutting stream shared by firewall/retention/masking; bolting a
  chain onto it couples integrity to an unrelated write path and muddies its single
  responsibility. A dedicated, narrow owner is cleaner and matches the "single owner" rule.
- **In-process mutex only (no CAS).** Rejected: correct on one instance, silently forks the
  chain across Cloud Run instances. The CAS is mandatory; the mutex is only an optimization.
- **CAS only (no mutex).** Correct, but spins under in-process contention. Adding the mutex
  makes the single-instance path deterministic and spin-free (belt + braces).
- **A signed Merkle tree / external transparency log.** Over-scoped for a host courtesy;
  a per-tenant linear hash-chain is sufficient for detect-tampering and adds no wire surface.

## No RFC (host-extension only)

This adds **no** wire surface: no run-event field, capability flag, event type, endpoint
contract, or normative `MUST`. It is a host-internal integrity record under
`/v1/host/openwop-app/*`. Per CLAUDE.md the wire is untouched, so **no RFC** is required. If a
future decision makes tamper-evidence a **cross-host** claim (e.g. an interop attestation),
that would need a new `openwop` RFC before advertising it.

## Implementation

| Piece | Location |
|---|---|
| Hash-chain service (single owner: append/verify/canonicalize) | `backend/typescript/src/host/auditChainService.ts` |
| Consent-change append | `src/features/consent/consentService.ts` (`recordConsent`) |
| Approval-decision append | `src/host/approvalService.ts` (`resolveApproval`, winning claim) |
| Verify route (admin-gated) | `src/features/cdp/routes.ts` |
| Tests | `test/audit-chain.test.ts`, `test/cdp-audit-chain-route.test.ts` |

**Tests:** genesis + sequential chaining; **concurrency** — 20 simultaneous appends for one
tenant yield contiguous seqs 1..N with no gaps/dupes and a chain that verifies (5 rounds);
`verifyChain` ok on a clean chain and `brokenAt` on a store-mutated payload or broken
linkage; per-tenant isolation; the seeded consent + approval appends land; the route is
toggle-gated (404), admin-gated (403), and reports ok/brokenAt.

## Open questions / decisions

- [x] Single owner = `auditChainService.ts` (the one appender + verifier).
- [x] Append is CAS-serialized per tenant (seq-claim insert-if-absent CAS) + an in-process
      per-tenant mutex as belt-and-braces.
- [x] Append-only durable side-log, NOT run-state (no `:fork` participation).
- [x] No RFC — no wire surface.
- [ ] Retention/rotation of the chain (a very long-lived tenant grows unbounded). Deferred:
      appends are rare and the head-pointer read is O(1); a future compaction would snapshot
      a checkpoint hash and truncate below it. Not needed at current scale.
