# 0619 — Egress send-idempotency ledger (SMS + push dedup on retry / re-dispatch)

Status: **implemented** (verified 2026-09-17, #3616)

## Context

`NP-INT-1` (docs/steward/NODE-PACK-AUDIT.md, deep node-internals pass + the
`/architect` disposition #3607): 4 of 7 `role:"side-effect"` send nodes in
`packs/core.openwop.integration` pass **no idempotency key** to their host adapter,
while the email/slack/chat siblings do. The exposure:

- A node with `config.retry.maxAttempts ≥ 2` (ADR 0326 CS-WF-3, `executor.ts:425-433`)
  **re-invokes the node body** on a transient failure. The Layer-2 invocation-log cache
  is **keyed per attempt** (`executor.ts:445-450`, ADR 0326 P3a), so attempt-2 does NOT
  short-circuit — it re-runs the body and re-calls the provider. If attempt-1 already
  POSTed to the provider and then failed downstream (e.g. `smsAdapter.ts:69-74`'s
  bad-response branch AFTER Twilio accepted), attempt-2 **double-sends**.
- Email survives this because `emailAdapter.ts` dedups on the **attempt-invariant**,
  fork-stable `idempotencyKey` via `emailSentLedger` (ADR 0193): `priorSend` →
  `reserveSend` (CAS) → send → `recordSend`/`releaseSend`. The `smsAdapter` and
  `notificationAdapter` POST straight to the provider with no ledger; neither Twilio's
  `Messages` API nor Expo's push API dedups natively.

**Scope correction (from the `/architect` pass):** of the 4 nodes, **only 2 reach a live
adapter** — `sms-send` (`ctx.messaging` = `makeSmsAdapter`, `executor.ts:843`) and
`notification-push` (`ctx.notification` = `makeNotificationAdapter`, `executor.ts:850`).
**`ctx.voice` does not exist** (no type in `executor/types.ts`, no runtime assignment),
so `voice-call-place` / `voice-call-tts-greet` throw `HOST_CAPABILITY_MISSING` today —
latent, like the chat nodes. Live blast radius = a duplicate SMS (billable) + a duplicate
push (spam), **2 surfaces, not 4**.

Replay/`:fork` is already safe for all 7 via ADR 0341 (the executor replay-serves recorded
side-effect outcomes; a fork never fires a new effect — so the ledger is NOT and need not
be the fork guard). This ADR closes strictly the live, SAME-runId re-execution axes ADR
0341 leaves open: the **within-run `config.retry` re-run + the same-runId dispatch-recovery
restart** — the same class `emailSentLedger` guards for email.

## Decision

Add a **shared host-side egress send-ledger** and wire it into the SMS + push adapters,
mirroring the established `emailSentLedger` (ADR 0193) / `ads:dispatch` (`adsAdapter.ts`)
put-on-accept dedup.

1. **`host/egressSentLedger.ts`** — a `DurableCollection<EgressSentRecord>('egress:sent', r => r.key)`
   with the same surface as `emailSentLedger`: `priorSend(key)`, `reserveSend(rec)` (the
   `compareAndSwap(null, rec)` CAS → `'reserved' | 'duplicate'`), `recordSend(rec)`
   (put-on-accept), `releaseSend(key)` (delete on FAILED send so a retry re-sends), and
   `sweepExpiredEgressSent(now)` (TTL sweep, `OPENWOP_EGRESS_LEDGER_TTL_DAYS` default 30,
   `SWEEP_DELETE_CAP` bounded, keeps unparseable rows). Record shape:
   `{ key, tenantId, channel, provider, providerRef, createdAt }` — `providerRef` is the
   Twilio `sid` / Expo `id`; **no name/address/body** (the recipient is hashed into the
   caller's `idempotencyKey`, never stored plaintext — same as `email:sent`).
   Key: `${tenantId}:${channel}:${idempotencyKey}` — one collection for all brokered
   non-email channels (sms, push, and voice when `ctx.voice` lands).
2. **Adapters** — `smsAdapter.sendSms` and `notificationAdapter.push` gain the dedup
   sequence: `priorSend` (hit ⇒ return the recorded accept, `{ sent:true, sid/id:providerRef, provider }`,
   **no fresh POST**) → `reserveSend` (`'duplicate'` ⇒ same recorded-accept return) →
   `brokeredPost` → on accept `recordSend`, on failure `releaseSend` (so a retry re-sends).
   No `idempotencyKey` ⇒ the pre-ADR behaviour (unguarded), so nothing regresses for
   callers that pass none.
3. **Surface types** — widen `executor/types.ts` `messaging.sendSms` and
   `notification.push` args with an optional `idempotencyKey?: string` (email already has it).
4. **Pack nodes** — `packs/core.openwop.integration/index.mjs`: derive a fork-stable
   `deriveIdempotencyKey([runId, nodeId, recipient, content])` (the existing helper) in
   `smsSend` / `notificationPush` and pass it; surface it in the node outputs (as
   `emailSend`/`slackMessage` do). Do the same in `voiceCallPlace`/`voiceCallTtsGreet` so
   the keys are correct **when `ctx.voice` lands** — but that path stays latent until then.
   Bump the pack version + run the pack cascade.
5. **Retention wiring** — `sweepExpiredEgressSent` rides the same worker tick as
   `sweepExpiredEmailSent`.

### ADR 0464 subject-erasure classification — EXEMPT by parity, NOT a new eraser

The `/architect` pass flagged the new `DurableCollection` as an ADR 0464 obligation. On
verification, the correct classification is **EXEMPT**, identical to how `email:sent` is
carried at `test/subject-erasure-coverage.test.ts:174`: the ledger is TTL-swept
(bounded lifetime), stores no name/address/body, and — decisively — **early deletion would
un-dedup a live send generation and risk double-delivery to the very subject requesting
erasure**, so retaining until the TTL is the *more* protective reclaim. The fix therefore
adds an `egress:sent` entry to the coverage test's exempt map with this reason; it does
**not** register a `SubjectEraser`.

## Alternatives considered

- **Per-channel ledgers** (`sms:sent`, `notification:sent`) following the `email:sent` /
  `ads:dispatch` per-channel precedent — rejected: sms/push/voice are structurally
  identical brokered egress (`brokeredPost` → `{ sent, sid/id }`); three near-duplicate
  files triple the retention sweep + the ADR 0464 surface for no benefit. Email stays its
  own ledger (established retention/tests; no churn).
- **Pack-level `idempotencyKey` only** (no adapter ledger) — rejected: **decorative**.
  Nothing reads it (the adapters POST straight to the provider; Twilio/Expo have no native
  idempotency key), so it would *look* guarded without deduping — worse than nothing.
- **Provider-native idempotency** — rejected: Twilio `Messages` and Expo push expose no
  idempotency-key header.

## Replay / fork safety

Keyed on the attempt-invariant key (which INCLUDES runId) with put-on-accept, the ledger
composes with ADR 0341 but is NOT the fork guard: the send nodes are in the served-set,
so a replay / `:fork` serves the source run's recorded side-effect outcome and never
re-invokes the adapter — the runId in the key is irrelevant on a fork because the adapter
is not reached. The ledger therefore bites **only** the live, SAME-runId re-execution axes
ADR 0341 leaves open: a within-run `config.retry` re-run, and a dispatch-recovery restart
(an orphaned run re-driven through `executeRun` with the same runId). A genuinely separate
run (new runId) derives a DIFFERENT key and is correctly not suppressed. No within-run
TOCTOU: the drain loop runs nodes sequentially and a retry follows attempt-1's
completion; the `reserveSend` CAS covers the cross-instance route-retry window (mirrors
`emailSentLedger`'s DEF-3 reservation, including the deliberate at-most-once-on-crash
trade-off — a suppressed duplicate beats a double send).

## Wire / governance

**No wire change.** `idempotencyKey` is an internal host-adapter arg + ledger key; no
run-event/capability/schema shape changes; surfacing it in node outputs is a non-normative
host-extension output. **No `openwop` RFC required** — host work. This ADR is the record.

## Phased implementation plan

- **P1** — `egressSentLedger.ts` (mirror `emailSentLedger`) + widen the two surface types.
- **P2** — wire the dedup sequence into `smsAdapter` + `notificationAdapter`; ledger-hit
  returns the recorded accept.
- **P3** — derive + pass the fork-stable key in the 4 pack nodes (2 live); bump the pack
  version + run the cascade.
- **P4** — `egress:sent` EXEMPT entry in `subject-erasure-coverage.test.ts`; wire
  `sweepExpiredEgressSent` into the worker tick.
- **P5** — born-red witness + full `npm run ci` + merge; flip this ADR to `implemented`.

### Born-red witness

Invoke `smsSend` twice inside one run with the same `(runId, nodeId, idempotencyKey)`
(simulating the attempt-2 `config.retry` re-run) against a `brokeredPost` mock; assert the
provider is POSTed **once** and attempt-2 returns the recorded `{ sent:true, sid }`.
**Sabotage:** remove the `priorSend`/`reserveSend` guard ⇒ two POSTs (the test must go red),
proving the assertion is load-bearing.

## Open questions / decisions

- [ ] Voice-node keys are authored now but latent until `ctx.voice` exists (a separate
  surface — its own follow-up; not in this ADR's live scope).
- [ ] `OPENWOP_EGRESS_LEDGER_TTL_DAYS` default 30 (parity with the email ledger); revisit
  only if a real replay/`:fork` window ever approaches it.

## Implementation record

| phase | where | proof |
|---|---|---|
| P1 ledger | `host/egressSentLedger.ts:58-109` (`DurableCollection<EgressSentRecord>('egress:sent')`, `egressLedgerKey`, the four ops, `sweepExpiredEgressSent` with `SWEEP_DELETE_CAP=500`) | `test/sms-notification-adapter.test.ts` |
| P2 adapters | `host/smsAdapter.ts:92-104`, `host/notificationAdapter.ts:75-87` — `recordSend` on accept, `releaseSend` on failure, `key=null` preserves pre-ADR behaviour | same, all four legs |
| P3 surface + keys | `executor/types.ts:777,783`; `packs/core.openwop.integration/index.mjs:190,221` (+ `:200,210` latent voice), pack 1.2.1 | — |
| P4 erasure + sweep | `test/subject-erasure-coverage.test.ts:194` EXEMPT row; sweep wired `host/webhookDeliveryWorker.ts:34,212` | that file |

_(This table replaced a `(Pending — …)` placeholder on 2026-09-17. The placeholder was
left behind when #3616 merged, so the record said the work had not started while the code
was live — the same class of stale claim as the `Status:` line above it, in the section
whose job is to prevent it.)_

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3616**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** P1 `host/egressSentLedger.ts:58-109`; P2 `host/smsAdapter.ts:92-104` + `host/notificationAdapter.ts:75-87`; P3 `executor/types.ts:777,783` + `packs/core.openwop.integration/index.mjs:190,221`; P4 erasure EXEMPT row `test/subject-erasure-coverage.test.ts:194`, sweep wired `host/webhookDeliveryWorker.ts:34,212`.
