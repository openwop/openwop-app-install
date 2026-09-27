# ADR 0580 — the CRM record-MERGE lifecycle seam

Status: implemented

Relates to: ADR 0283 (the CRM record-DELETE lifecycle seam this extends),
ADR 0508 (org-scope tenant source), ADR 0267 (frequency governor),
ADR 0020 (consent / subject erasure).

## Context

`host/crmRecordLifecycle.ts` (ADR 0283) gave the app ONE dependency-safe way for a
feature to clean up its soft references to a CRM record when that record is
**deleted**, without `crm/` importing the consumer and without consumers importing
each other. `crmMutated` host events could not serve: they are webhook/host-event
**egress only**, so nothing in-process can subscribe — which is exactly how territory
assignments orphaned on deal deletion (TERR-DATA-1).

A **merge** is a different operation with the same shape of problem, and it had no
seam at all. `crmMergeService` relinked exactly the three collections it owns — deals,
tasks, activities — while its own docblock claimed it "RELINKS every referencing row
… never a dangling reference to a tombstone". Roughly twenty cross-feature stores were
left pointing at the tombstoned source. Two of them are compliance-grade:

- **`consent:record` is keyed on the contactId.** A source contact that had opted OUT
  of marketing lost that record on merge, while the survivor became reachable at the
  source's **absorbed** email identifier. A recorded revocation silently became a
  permitted send.
- **`email:sendlog` keys the per-recipient dedupe** (`cmp:<campaignId>:<contactId>`)
  and the ADR 0267 frequency cap on the contactId. So the survivor could be re-sent a
  campaign the source had already received, at that same absorbed address, and the cap
  reset to zero.

## Decision

Add a **merge seam** and its **inverse**, alongside — never folded into — the delete
seam:

```ts
export interface CrmRecordMergedEvent {
  tenantId: string;
  orgId?: string;                 // org-scoped entities only (company/deal)
  entity: 'contact' | 'company' | 'deal';
  sourceId: string;               // the now-tombstoned record
  survivorId: string;             // the record references must move TO
}

onCrmRecordMerged(key, handler)    /  fireCrmRecordMerged(event)
onCrmRecordUnmerged(key, handler)  /  fireCrmRecordUnmerged(event)
```

### 1. A separate EVENT TYPE, not a discriminator on the delete event

The delete handlers' contract is *"drop your soft reference"*. Applying that to a
merge would **destroy exactly the data that has to move** — a delete handler that
dropped the source's consent row is the defect, not the fix. A distinct type means a
consumer must **opt in with merge-aware code**, and the consumers that have not are
honestly *uncovered* rather than silently mishandled.

### 2. Fired AFTER the merge commits — the opposite of the delete seam, on purpose

The delete seam fires **after** the row is gone so a mid-way handler failure fails
CLOSED. The merge seam fires after the survivor is written, references relinked and
the source tombstoned, for a different reason: firing earlier would let a handler move
references onto a survivor whose CAS then failed to write.

### 3. The inverse leg is mandatory for any handler that MOVES rows

A contact merge is reversible. A handler that moves rows (rather than performing an
idempotent fold that destroys nothing) turns a reversible operation into a lossy one —
fixing one silent-loss defect by introducing another, one step downstream. So
`onCrmRecordUnmerged` exists and `email-sendlog-relink` registers for both. Its move
stamps `mergedFrom` on each row it touches, and the reverse returns **exactly those**
rows: a naive "move everything back" would hand the survivor's own pre-merge
deliveries to the source.

### 4. Handlers MUST be bounded — and that is now GATE-ENFORCED, not documented

Registrations are keyed (idempotent across repeated boots), handlers must be
idempotent, and the fan-out is best-effort with a **logged** failure (invisible
best-effort is what let orphans accumulate silently before ADR 0283).

The bounded-read rule needs more than prose. `test/crm-merge-bounded-reads.test.ts`
proxies storage during a real merge and records every `kvList` prefix, and the rule it
asserts is universal: **no whole-collection prefix may be scanned during a merge**,
recognised by SHAPE (`hostext:<name>:` with nothing after it) rather than by a list of
known offenders.

> **Correction note, fold-in B4.** That gate shipped as an **allowlist** of two
> literals, and it walked straight past a live offender in the very change that added
> this seam: `email-sendlog-relink` did `for (const s of await sendLogs.list())` — every
> tenant's send ledger, on the merge hot path — and the probe observed
> `hostext:email:sendlog:` and discarded it. The lesson is recorded here rather than
> quietly fixed: **a gate that only recognises the offences already fixed cannot catch
> the next one.** `email:sendlog` now carries `tenantOf` (arming the `hostextidx:`
> tenant secondary index; primary rows are not re-keyed, so no migration) and the
> handler reads `listForTenantIndexed`. The gate is inverted.

### 5. A handler is gated on its own feature toggle

A merge in a tenant that does not have the email feature must not touch the email
store at all. The gate fails **open** on a toggle-read error — narrowly and
deliberately: it is work avoidance, not an authorization boundary (the read it guards
is already scoped to the merging tenant), and skipping a relink on a transient toggle
blip would leave a send ledger pointing at a tombstone, which is the exact defect this
seam exists to close.

## Alternatives weighed

| Alternative | Why not |
|---|---|
| Reuse `fireCrmRecordDeleted` with a `reason: 'merge'` discriminator | A consumer that ignores the new field applies delete semantics to a merge and DESTROYS the data that had to move. Silence must default to "uncovered", not "mishandled". |
| Let `crmMergeService` import each consumer and relink directly | The coupling ADR 0283 exists to prevent: `crm/` would import consent, email, and ~18 others; every new consumer edits CRM. |
| Ride `crmMutated` host events | Egress-only — nothing in-process can subscribe. This is the original TERR-DATA-1 mechanism failure. |
| Move rows at READ time (resolve tombstones on lookup) | Every reader in every feature would need tombstone-following logic, forever, and a missed reader is a silent wrong answer rather than a loud one. |
| No unmerge leg — accept that a merge is lossy for moved rows | Trades a duplicate-send defect for a lost-delivery-record defect. Same family, one step downstream. |

## Consequences

- Consumers that need merge-awareness register explicitly; the rest are **honestly
  uncovered** and can be enumerated (`mergeHandlers` is a keyed map).
- The seam is a host module with no feature imports, so `crm/` still imports nothing
  downstream.
- Fan-out cost is bounded by construction, and the bound is test-enforced rather than
  asserted in a comment.

### Known gap, tracked

**Chained merges.** A → B, then B → C. The event names only the immediately merged
pair, so a handler that keyed on A and relinked to B is not re-notified when B merges
into C. Rows stamped `mergedFrom: A` on B move to C as B's own rows, which is correct
for the ledger's contact key but loses the A→B attribution. Tracked as a follow-up; it
needs either a transitive event or a `mergedFrom` chain, and picking between those is
its own decision.

## Implementation record

| Piece | Where |
|---|---|
| The seam (merge + unmerge events, keyed registration, best-effort fan-out) | `src/host/crmRecordLifecycle.ts` |
| Fire sites | `src/features/crm/crmMergeService.ts` (`mergeContacts` / `unmergeContacts`) |
| Reference consumers | `src/features/consent/consentService.ts`, `src/features/email/emailService.ts` |
| Outcome tests (consent + ledger, not "a handler ran") | `test/crm-merge-lifecycle.test.ts` |
| Bounded-read gate (inverted; universal rule) | `test/crm-merge-bounded-reads.test.ts` |
