# ADR 0579 — Media byte-retention lifecycle (the deliberate MED2-M3 remainder)

Status: implemented (2026-08-15) — DESIGN CORRECTION recorded: the proposed refindex is UNNECESSARY (refs are 1:1 by construction — dedup runs BEFORE put; cross-collection copies re-store), and deleteAsset already released bytes with MED2-R3 semantics. What shipped: the orphan sweep (byte enumeration seam + a media retention purger, grace window operator-tunable via OPENWOP_MEDIA_ORPHAN_GRACE_MS default 7d) and the TTL comment now cites this ADR as the outer backstop.

## Problem

Media asset BYTES are stored with a ~100-year TTL
(`media/mediaStorage.ts:19` — `DURABLE_TTL_SECONDS = 100y`, with the comment
"a real backend ignores this"), and the only sweep is expiry-based. The R3
media pass (#3250) shipped the eraser + PII declaration and **deliberately
excluded byte lifecycle**: "blob lifecycle spans the store and the blob
backend, and deleting bytes out from under live embeds is a storage-lifecycle
design, not an eraser pass." This is that design. Context that shapes it:
media DEDUPES on content hash (MED2-M2: re-uploading the same bytes returns
the existing row), so **bytes may be shared by multiple asset rows**, and the
replay-effect guard for blob writes is ADR 0563.

## The invariant

**Bytes live exactly as long as at least one live asset row references them,
plus a grace window.** Reference-absence — never subject identity, never age
alone — is the deletion trigger. (Subject erasure anonymizes rows and keeps
bytes: an org's content outlives the byline, per the #3250 decision. Age-based
VERSION retention was the documents/environments pattern; media has no
versions — its unit is the reference.)

## Decision — reference-lifecycle GC in three phases

### P1 — delete-asset releases bytes (the synchronous half)

`deleteAsset` computes the surviving reference count for the row's
`contentHash`/`storageRef` (a bounded indexed read — add a
`media:refindex` keyed `hash → count`, maintained CAS-style at create/delete,
NOT a full scan). Count 0 ⇒ delete the bytes via `mediaStorage.delete`
(new, thin — the store already owns refs/tokens); count > 0 ⇒ bytes stay
(dedup siblings live). A bytes-delete failure logs + enqueues the ref for the
P2 sweep — the asset row deletion is never blocked (fail toward the sweep,
never toward a stranded UI).

### P2 — the orphan sweep (the asynchronous truth)

A `media` purger joins the existing retention sweep daemon (the documents/
environments seam — `registerRetentionPurger`, classification `internal`):
enumerate storage refs whose refindex count is 0 **and** whose orphan-mark is
older than a 7-day grace window, then delete bytes. The grace window is the
undelete/incident buffer; the operator's per-tenant retention window governs
WHEN the sweep runs at all (no window ⇒ never — the operator owns the age,
the mechanism owns the rule; the standing pattern).

### P3 — honesty at the seams

- **Usage refs:** media already tracks `media:usage` (where an asset is
  embedded). Deleting the LAST asset row while usage refs exist gets the
  existing confirm-with-usage treatment (the R2 Improvement note) — this ADR
  doesn't change delete UX, it makes the bytes follow the decision.
- **Replay:** byte deletion is a live-side operation; recorded runs that
  reference a serve token replay against ADR 0563's effect guard (a replayed
  blob WRITE is suppressed; a replayed READ of deleted bytes is the
  `replay_source_missing` family — already specified, cite-only here).
- The 100-year TTL REMAINS as the outer backstop (belt for refs that escape
  both halves); the comment stops claiming a real backend ignores it and
  starts citing this ADR.

## Boundaries audit

Byte ownership stays in `media/mediaStorage.ts` (ONE owner; the refindex is
its sibling, not a second store of truth — it is derivable and
reconcilable from asset rows, and the sweep re-derives on divergence).
The retention daemon seam is reused, not duplicated.

## Alternatives weighed

- **Age-based byte purge** (the documents shape): wrong unit — an old byte
  blob under a live asset is not stale, and a day-old orphan is. Rejected.
- **Refcount on the asset row only (no index):** every delete becomes a full
  `assets.list()` scan (the Performance dimension's named smell). Rejected.
- **Hard-delete bytes synchronously with no sweep:** a single failed delete
  strands bytes forever (the current state, minus a century). Rejected.

## Test plan / sabotage

Two rows sharing a hash: deleting one keeps bytes, deleting both releases
them; a failed byte-delete leaves the row deleted and the ref queued; the
sweep ignores refs younger than grace and refs with live rows; erasure never
touches bytes. Sabotage: skip the refcount (always delete) ⇒ the shared-hash
test fires; drop the grace check ⇒ its test fires.

## RFC verdict

None — host storage internals.

## Open questions (for David)

Grace window length (assumed 7 days) and whether the sweep's deletions should
appear in the audit log (assumed yes — same as fee-config's new audit line).
