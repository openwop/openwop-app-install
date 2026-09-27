# ADR 0249 — Soft-bounce escalation

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Status** | implemented (2026-07-04) — the ADR 0241 §"Open items" soft-bounce follow-on |
| **Deciders** | openwop-app maintainers |
| **Relates** | ADR 0241 (bounce/complaint webhook ingestion — the entry point), ADR 0217 (suppression reasons + owner), ADR 0218 (email engagement) |

## Context

ADR 0241 ingests provider event webhooks and suppresses **hard** bounces +
complaints immediately — "soft/deferred/transient are ignored (suppressing a
transient failure would wrongly kill deliverability)." It recorded the gap as an
open item:

> "Soft-bounce escalation (suppress after N consecutive soft bounces) — requires
> per-address soft-bounce counting; deferred (hard bounces + complaints are the
> high-value, unambiguous signals)."

A single soft bounce is noise; **N consecutive soft bounces with no intervening
success** is a real undeliverability signal. This ADR adds that escalation without
weakening the "transient failures are noise" stance.

## Decision

Extend `ingestBounceWebhook` (no new endpoint) to classify each provider event as
`suppress` (hard — immediate, unchanged), `soft` (transient), or `success`
(`delivered`/`open`/`click`), and track a **per-(tenant, address) consecutive
soft-bounce streak**:

- **A soft bounce** CAS-increments the streak; at the threshold it escalates —
  `addSuppression(reason:'bounced', actor:'webhook:<provider>:soft-escalation')`
  (the ADR 0217 suppression owner, never a second store) — then clears the streak.
- **A success signal** (`delivered`/`open`/`click`) clears the streak. This is what
  makes it "N *consecutive*": any positive signal resets. Without success signals
  the metric degrades to cumulative soft bounces — still a valid escalation.
- **A hard suppression** clears the streak (it supersedes it).
- **Threshold** = env `OPENWOP_EMAIL_SOFT_BOUNCE_THRESHOLD`, default **5**, clamped
  ≥1 (0/negative/NaN would suppress on the first soft bounce, defeating the point).

Signals are processed in provider-batch order, so a `[delivered, soft]` batch
resets-then-counts (streak ends at 1) while `[soft, delivered]` with a streak
already at threshold-1 escalates on the leading soft. Provider batches are
time-ordered, so this matches real chronology.

### Idempotency: CAS, and replay-dedup deferred by design

Hard suppression is an idempotent upsert (ADR 0241) — a replayed signed batch
re-suppresses harmlessly. **Soft counting is NOT idempotent**: a replayed batch
re-increments the streak. The decision:

- **CAS-guard** the increment so concurrent deliveries never lose a count
  (`compareAndSwap` with retry).
- **DEFER provider-event-id replay-dedup.** A replayed batch only *over*-counts,
  which suppresses a repeatedly-soft-bouncing address *earlier* — a conservative
  failure for a heuristic, never a false positive on a healthy address (a success
  always resets). A seen-event-id store (unbounded growth, a new sweep) is not
  worth it for an early-suppress-by-a-few conservative skew. Recorded as an open
  item if provider replay proves noisy in practice.

## Alternatives weighed

- **A rolling time-window count** (soft bounces in the last D days) instead of a
  consecutive streak reset-by-success. More faithful to ESP practice, but needs
  per-event timestamps + windowed pruning. The success-reset streak is simpler and
  captures the same "is this address currently failing" signal; a staleness window
  is a deferred refinement.
- **Suppress on the first soft bounce.** Rejected — exactly the deliverability-
  killing over-suppression ADR 0241 warned against.
- **Count in a second suppression-like store.** Rejected — suppression stays owned
  by `suppressionService`; the streak counter is separate, purpose-built state, and
  escalation routes THROUGH `addSuppression`.

## Boundaries / wire

- **No wire change, no RFC.** Host-ext ingestion behavior; suppression is internal
  host state. The `ok` outcome gains an additive `escalated` count (observability);
  the route response adds `escalated` beside `suppressed`.
- **Feature-package boundary (ADR 0001).** All changes inside `email/bounceWebhooks`
  + its route; the new `email:soft-bounce-count` `DurableCollection` is owned by the
  email feature, tenant-indexed, keyed `${tenantId}:${email}` — no cross-tenant read.
- **Replay/fork.** Not a run concern; webhook ingestion is outside run replay.

## Implementation

| Change | File |
| --- | --- |
| `classify{Sendgrid,Postmark}Events` → `BounceSignal[]` (suppress/soft/success); `parse*` derive the hard subset; soft-count store + `softBounceThreshold()` + CAS `bumpSoftBounce`/`resetSoftBounce`; escalation in `ingestBounceWebhook`; `escalated` on the ok outcome | `backend/typescript/src/features/email/bounceWebhooks.ts` |
| `escalated` in the route response | `backend/typescript/src/features/email/routes.ts` |
| Tests — N-1 no-suppress / Nth escalates; success resets the streak; hard suppresses immediately; in-batch `[delivered, soft]` reset-first | `backend/typescript/test/email-bounce-webhooks.test.ts` |
| FEATURES.md email row — soft-bounce escalation note | `FEATURES.md` |

## Open items (deferred)

- **Provider-event-id replay dedup** — only if real provider retries prove to skew
  escalation materially (currently a conservative early-suppress, see above).
- **Staleness window** — expire a stale streak (e.g. no soft bounce in D days) so a
  slow drip across months doesn't accumulate; the success-reset already covers the
  common case.
- **Bounce/complaint analytics** — the ADR 0241 read-projection open item (a
  suppression-cause view) is the next open-items PR (OI-2), separate from this.
