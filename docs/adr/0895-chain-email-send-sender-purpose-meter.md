# ADR 0895 — The chain email send: bound sender, admin-only transactional, metered

Status: implemented (2026-10-15, branch `fix/email-send-controls`, closes #4517)

Closes residue `EM2-WF-1` of ADR 0848 (architect review B1). Builds on ADR 0193
(brokered send), ADR 0655 (the recipient egress guard) and ADR 0848 D5 (the
test-send meter, whose shape D3 copies).

## Context

`core.openwop.integration.email-send` is the widest email exit in the app, and it
was bound by none of the email feature's own controls:

- `from` came verbatim from node config. 13 shipped chains use a free
  `{{params.senderEmail}}`.
- `purpose: "transactional"` was the workflow author's to declare, and it skips
  the marketing-consent leg of the egress guard.
- Nothing counted the sends.

What already held it, so this was never an open relay: tombstone + suppression
on every purpose (an unsubscribe writes a suppression row), marketing consent
unless declared transactional, provider-side verified senders on SendGrid and
Postmark, the acting user's OWN provider connection (the broker never lends the
org's), and an approval gate upstream of all 13 shipped sends.

ADR 0848 left it open for two stated reasons: binding `from` to "the org sender"
would fail all 13 chains, and a run has no single org. Both have answers below.

## Decision

The rules live in `host/chainEmailPolicy.ts` and apply ONLY to the chain lane:
the executor builds `ctx.email` with `lane: 'chain'`, and `makeEmailAdapter`
consults the policy after the ledger short-circuit (a recorded send is returned
as-is) and around the egress guard. Campaigns, invites, receipts and approval
notices construct the adapter without a lane and are unchanged — they carry
their own sender and purpose.

**D1 — sender binding.** The verified senders are every `senderAddress` the
email feature's settings hold for the tenant, across ALL its orgs (that answers
"a run has no single org"). The email feature registers the lookup at boot,
toggle-independent, on a host seam (the `recipientEgressGuard` import shape).
- One or more configured: `from` must be one of them, case-insensitively, else
  `email_sender_not_verified`. A blank `from` takes the workspace-root org's
  sender (or the only one).
- None configured: `from` passes as before. This is what keeps the 13 chains
  working in a tenant that never set up Email Marketing (the feature is off by
  default, so most have not). Stated residue: there the floor stays the
  provider's sender verification on the acting user's own account.
- An unreadable settings store refuses (`email_sender_unreadable`).

**D2 — purpose authority.** `transactional` is honoured only when the run has an
acting user who holds `host:members:manage` on the workspace root — the same
scope that sets the sender (ADR 0848 D4). Anyone else, and an actorless run, is
DEMOTED to `marketing`, never refused: demotion only adds the consent leg. No
shipped chain declares `transactional`, so nothing shipped changes.

**D3 — recipient meter.** A per-tenant budget of recipients per clock hour,
`OPENWOP_EMAIL_CHAIN_RECIPIENTS_PER_HOUR` (default 300; `0` = off; unset/blank =
default). Spent only by a send that passed the sender check and the egress
guard, so a replay or a refused send costs nothing. Over budget:
`email_chain_rate_limited`. Per-instance fixed window, like the test-send meter:
with N instances the effective cap is N×, accepted for an abuse brake.

## Alternatives weighed

- **Bind `from` to one org's sender and refuse when unconfigured.** The issue's
  first shape. Refuses every chain send in every tenant without Email Marketing
  set up — most of prod — to close a gap the provider already narrows. Rejected.
- **Refuse a non-admin `transactional`.** Turns an author's mislabel into a run
  failure. Demotion gives the same protection (consent applies) and only fails
  the sends consent would have refused anyway.
- **A durable meter.** Needs a sweep the opt-in retention lane does not give it
  (the ADR 0848 D5 reasoning). Deferred until a cap ever needs to be exact.

## Residue

- No sender configured ⇒ free `from` (provider-side verification only).
- The meter is per instance.

## Implementation record

| Decision | Code | Test |
|---|---|---|
| D1 | `host/chainEmailPolicy.ts` `bindChainSender`; `features/email/emailService.ts` `listVerifiedSenders`; registered in `features/email/feature.ts` | `test/adr0895-chain-email-policy.test.ts` D1 (5 cases) |
| D2 | `resolveChainPurpose` (`assertRunOrgScope` on the root) | D2 (3 cases) |
| D3 | `takeChainSendBudget` | D3 (2 cases) |
| lane | `executor/executor.ts` `lane: 'chain'`; `host/emailAdapter.ts` | non-chain lane unchanged (1 case) |

Sabotage-witnessed: disabling both `lane === 'chain'` branches in the adapter turns
6 of the 11 cases red (every refusal, the blank-from fill and both demotions); the
other 5 assert pass-through behaviour that must hold either way.
