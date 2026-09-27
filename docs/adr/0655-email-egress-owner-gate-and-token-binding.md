# ADR 0655 — Email Marketing: one gated egress owner, typed send failures, and a preference token that cannot un-erase

Status: implemented (2026-09-11; reserved as 0654, renumbered to 0655 before merge — a peer branch held 0654 unmerged; `check-adr-refs --next` saw it)
Date: 2026-09-11
Feature: Email Marketing (ADR 0019 feature; ADR 0193 brokered egress; ADR 0227 preference center; ADR 0582 gate legs) · FEATURES.md ordinal 10 of 71 · feature loop 2026-09 it.10
Plan input: `docs/steward/WORKFLOWS-ASSESSMENT.md` § "Email Marketing — Grade: C+ → C (2026-09-11)", gaps `EMWF-1..17`
Related: ADR 0651 (Analytics — the click-token first-use claim this ADR's D3 mirrors), ADR 0596 (typed failure, never success-with-empty), ADR 0464 (erasure semantics), ADR 0338 §D3 (sink registration order), ADR 0619 (egress idempotency ledger)

## Context

The 2026-08 pass fixed the *graph*: every `core.openwop.integration.email-send` node in the
corpus now sits behind a single `{truthy approved}` edge from a human gate, with a
`falsy → core.flow.noop` completion leg, and a registry-derived behavioural ratchet keeps it
that way. It did not touch the *floor* the graph stands on. Re-graded 2026-09-11 against
`origin/main @ 8c6af0923`, five findings meet this loop's Blocker bar:

1. **`EMWF-1` — the one composition owner for email egress is empty.** `makeEmailAdapter`
   (`host/emailAdapter.ts:203-272`) is constructed at exactly three sites — the executor
   (`executor/executor.ts:856`, binding `ctx.email` for every node of every run) and the
   campaign route's brokered provider (`email/brokeredProvider.ts:70,133`) — and it reads
   no suppression, consent, unsubscribe or erasure state. The route lane's four gates
   (`emailService.ts:531-556`: consent, suppression, frequency, no-email) sit *above* it, so
   the chain lane skips the floor. Ten send nodes bind `"to": "{{params.recipientEmail}}"`.
   A contact who unsubscribed is skipped by `campaign-journeys.welcome-series` and mailed by
   `commerce.post-purchase-thankyou`.
2. **`EMWF-2` — the WF-EM-6 fork-resend fix is unshipped, and production installs the OLD
   pack over the vendored fix.** `core.openwop.integration` is 1.1.2 in-repo and 1.1.0 live
   (`packs.openwop.dev`, probed); the fix landed in 1.1.1. The live Cloud Run env
   (PROBE-EM-3, read 2026-09-11) pins `core.openwop.integration@1.1.0` under
   `OPENWOP_STRICT_REGISTRY=true`; boot mounts the vendored packs (`index.ts:422`) and
   then `ensureRegistryPacksInstalled` (`:444`) installs the pinned version. `:fork`
   re-mails in production while the tracker shows `WF-EM-6 ✅`.
3. **`EMWF-3` — the preference-center token is an unbound, never-expiring re-consent
   credential that clears erasure tombstones.** `resolvePreferencesToken`
   (`engagementService.ts:233-241`) has no claim and no TTL — by design, the purger exempts
   `preferences` (`:151-163`) so an old email's link keeps working — and `POST /p/:token`
   (`routes.ts:410-490`) calls `mergeConsentCategories` whose `clearTombstone` defaults to
   CLEAR (`consentService.ts:331-353`). A forwarded newsletter, or a mailbox archive years
   later, re-grants the original recipient's marketing consent and un-erases them. ADR 0651
   D1 bound the click token; this sibling was not bound.
4. **`EMWF-4` — `feature.email.nodes.list-templates` reports success with `[]` on a missing
   `orgId`** (`packs/feature.email.nodes/index.mjs:20-22` coerces to `''`; `surface.ts:38`
   uses the coercing `surfaceStr`), and all three nodes read `ctx.inputs` only. The
   `ANLWF-2` class ADR 0651 D2 closed for analytics.
5. **`EMWF-5` — a failed send is reported as success.** `emailSend` returns
   `status:'success', sent:false` (`index.mjs:100-110`) for `email_not_connected`,
   `email_provider_unsupported`, timeouts and provider errors; no chain branches on `sent`.

### The boundaries audit

- **Egress owner.** `makeEmailAdapter` has three constructors (executor + brokeredProvider ×2)
  AND — **corrected by the pre-implementation `/architect` review, B1** — one direct SMTP caller
  that bypasses it: `host/emailApprovalDelivery.ts:185` → `sendViaSmtp`. D1 routes that caller
  through the adapter with `purpose:'transactional'` and a ratchet pins `sendViaSmtp` to exactly
  one importer (`emailAdapter.ts`). THEN the gate is in one place.
- **Import direction.** `host/emailAdapter.ts` is host code; `suppressionBlocksSend` lives in
  `features/crm/suppressionService.ts`, `isAllowed`/`isErasureTombstoned` in
  `features/consent/consentService.ts`. Host must not import features (ADR 0446). The
  established shape for this is a **registered seam** the owning feature arms at boot —
  `analytics/experimentStampResolver.ts` (ADR 0651 D3), `hostEventDispatcher` (ADR 0208).
- **Consent is contact-keyed; the chain lane has only an address.** `isAllowed(tenant,
  contactId, 'marketing.email')` needs a contact. `crm/contactsService` resolves a contact
  by normalized email; the guard can hop when a contact exists and must state what it
  does when none does.
- **Suppression kinds.** `crm:suppression` rows carry a `kind` (`bounced`, `complained`,
  `unsubscribed`, `manual`); `suppressionBlocksSend` returns `'suppressed' | 'unreadable' |
  'clear'` without the kind. Bounce/complaint/manual apply to every purpose; only
  `unsubscribed` is marketing-specific.
- **The preference page today can only be reached with the token**, and CAN-SPAM/GDPR require
  the *opt-out* to keep working indefinitely — the never-expiring token is correct for
  narrowing. Only *widening* is the hazard.
- **Registry install vs vendored mount.** `bootstrap/mountLocalPacks.ts:404-409`
  `shouldShadow` prefers the LOCAL copy only when it is strictly newer than what is
  installed at mount time; `bootstrap/installRegistryPacks.ts:49-86` then attempts every
  env-listed target. The downgrade happens in the second step.

## Decision

### D1 — one gated egress owner: a registered guard the adapter consults per recipient (`EMWF-1`, Blocker)

`host/recipientEgressGuard.ts` (new, host; **channel-generic per review S5** — `makeSmsAdapter`
has the identical gap, recorded as `EMWF-19`, not this PR) exports
`registerRecipientEgressGuard('email', fn)`, `consultRecipientEgressGuard({channel:'email', …})`
and `__resetRecipientEgressGuardsForTests()` (the `experimentStampResolver.ts:64` seam — review
B3). The guard signature:

```ts
type EmailEgressPurpose = 'marketing' | 'transactional';
type EmailEgressVerdict =
  | { ok: true }
  | { ok: false; code: 'email_recipient_suppressed' | 'email_recipient_erased'
                    | 'email_recipient_no_consent' | 'email_suppression_unreadable' };
type EmailEgressGuard = (input: { tenantId: string; address: string; purpose: EmailEgressPurpose }) => Promise<EmailEgressVerdict>;
```

`features/email/feature.ts` registers the guard at boot (toggle-independent — the guard is
a refusal floor, not a feature capability). The guard, in order, for each recipient:

1. **Erasure tombstone** — `isErasureTombstoned(tenantId, address)` on the raw AND the
   `normalizeEmail`-folded address (the it.8 `FRMCD-1` lesson: one witness per arm) ⇒
   `email_recipient_erased`.
2. **Suppression** — `suppressionBlocksSend(tenantId, address)`: `'suppressed'` ⇒
   `email_recipient_suppressed` for every purpose (v1 does not relax `unsubscribed` for
   transactional sends — the kind is not exposed; recorded as `EMWF-18` below);
   `'unreadable'` ⇒ `email_suppression_unreadable` (never send on an unreadable store).
3. **Consent, when a contact resolves** — `purpose === 'marketing'` and the INDEX-ONLY lookup
   (`resolveContactIdByIdentifier` + `resolveContactSurvivor`; never `findContactByEmail`, whose
   miss path is a tenant scan — review S1) finds a contact ⇒
   `isAllowed(tenantId, contactId, 'marketing.email')` must be true, else
   `email_recipient_no_consent`. No contact ⇒ consent cannot be evaluated; the send proceeds
   past this leg (suppression + tombstone already applied) and the verdict is logged with
   `consent: 'unresolvable'`. Stated residuals: a marketing send to an address the CRM has
   never seen is not consent-checked (the route lane only sends to contacts — same posture,
   now explicit); a pre-index legacy contact reads as "no contact"; **with the `consent`
   feature OFF (the shipped default) `isAllowed` is permissive, so leg 3 always passes and the
   floor is legs 1–2** (review S2); when the index maps the address to a different (unmerged
   duplicate) contact than the route lane's `contactId`, the adapter refuses (fail-closed) and
   `email_egress_refused` logs both ids. Leg 1 uses `subjectKeyForms` (review N2), not a
   hand-listed raw/folded pair.

`makeEmailAdapter.send` (host) calls the guard for every `to`/`cc`/`bcc` address AFTER the
ledger `priorSend` short-circuit (a prior row is a recorded fact, bounded by
`OPENWOP_EMAIL_LEDGER_TTL_DAYS` — review N1) and BEFORE `reserveSend` (a refusal must never
hold a reservation). **All-or-nothing:** a refusal for ANY recipient refuses the message
(one `to[]` is one provider call; stripping would need the ledger key recomputed — review S6);
the verdict carries the refused COUNT, never an address. A refusal returns
`{ sent: false, provider, error: <code> }` and logs `email_egress_refused` (tenant, purpose,
code, count). **No guard registered ⇒ marketing sends are refused with
`email_egress_guard_missing`;** transactional sends proceed with a warn. A fail-open default
is a shape (ADR 0651 D4 lesson). Every `createApp` boot registers the guard
(`features/index.ts` calls the email feature's `registerRoutes` toggle-independently), so
the ~800 route tests are unaffected; the direct-adapter tests (`email-adapter.test.ts`,
`smtp-send.test.ts`) register a shared permissive guard from `test/helpers/` (review B3).

**`purpose` (review B2).** `EmailSendArgs.purpose?: EmailEgressPurpose`; the ADAPTER default
for an absent value is `'marketing'` (the only fail-closed choice). Every caller declares:
the core pack node `emailSend` defaults `'marketing'` and exposes `config.purpose` for
transactional chains (receipts, resets); `makeBrokeredCampaignProvider` gains a REQUIRED
`purpose` dep — the campaign route passes `'marketing'`, `inviteDelivery` passes
`'transactional'`; `sendBrokeredTransactionalEmail` (commerce receipts, billing invoices) and
`emailApprovalDelivery` pass `'transactional'`. A witness per caller pins the purpose it
sends (an unsubscribed address still receives an org invite). The route lane keeps its own
gates as defence-in-depth; the ledger key does not include `purpose`.

### D2 — a failed send is a typed node failure (`EMWF-5`, Blocker)

`emailSend` (`packs/core.openwop.integration/index.mjs`) throws
`{ code: result.error ?? 'email_send_failed', provider }` whenever `result.sent !== true`;
`outputs.sent` stays for the success path (always `true` now) and `outputs.error` stays
OPTIONAL in `email-send.output.json` (removing it would be a schema narrowing). Pack
1.1.2 → 1.2.0 (behavioural change on a node's failure contract; host-owned pack, no wire
RFC). Blast radius stated: a tenant with no provider configured sees the run FAIL at the
send node instead of completing green over nobody mailed; the demo provider still sends;
`workflow-chain-campaign-journeys-execution.test.ts:334-341` (pins `completed` +
`email_not_connected`) flips to `failed` (review N6). **Retry classification (review B5 —
`recoverable` was an invention nothing reads):** the executor's classifier is
`NON_RETRYABLE_NODE_ERRORS` keyed on `error.code` (`executor.ts:436-438`); a pack node's
thrown `.code` survives the tarball wrapper (`tarballLoader.ts:182-197`). The codes
`email_recipient_suppressed | email_recipient_erased | email_recipient_no_consent |
email_provider_unsupported | email_egress_guard_missing` join that set so a `config.retry`
node makes exactly ONE attempt; `email_timeout` / `email_request_failed` /
`email_suppression_unreadable` / `email_send_in_flight` stay retryable by omission.

### D3 — the preference token can narrow forever and widen only when fresh and clean (`EMWF-3`, Blocker)

`POST /p/:token`:

- **Narrowing** (every submitted category ≤ its stored value) is accepted with the token as
  today — forever, unclaimed. The opt-out must keep working.
- **Widening** is defined on EFFECTIVE values, not stored keys (review S3):
  `effective(ch) = rec?.categories['marketing.'+ch] ?? rec?.categories.marketing ?? false`;
  widening ⇔ some submitted `on` where `effective(ch) === false`. It requires ALL of: the
  token row's `createdAt` within `OPENWOP_EMAIL_PREFERENCE_WIDEN_DAYS` (default 30; an
  unparseable `createdAt` reads as stale — every row has one, review N3); the row carries an
  `email` (a row without one cannot run the suppression leg ⇒ widening refused); no
  `crm:suppression` row for that address (`suppressionBlocksSend === 'clear'`); no erasure
  tombstone for the contact or the address. Otherwise the page renders a new `refused` state
  of `renderPreferencesPage` (HTTP 409; NOT a `sendPublicError` widening — review N4; one
  `publicPageStrings` key ×4 locales) that says this link cannot re-enable messages and how
  to ask (reply to the sender). Stated residual: a fresh (<30 d) clean token may widen
  `sms`/`push` for an email-only contact — a first-time opt-in through a fresh campaign
  email is the designed ADR 0227 flow, and a later opt-in needs a new email.
- **`clearTombstone: false` always** on this route — a public, unauthenticated form never
  un-erases a subject. Re-consent after erasure is an operator act through the authed
  consent API (existing).
- The unsubscribe token (`/u/:token`) is unchanged: opt-out only.

Alternatives weighed: claim-on-first-use like the click token (rejected — the preference page
is legitimately revisited from the same email over time; a claim would lock the second
visit out of narrowing); a TTL on the whole token (rejected — breaks the indefinite opt-out).

### D4 — `feature.email.nodes` refuse a missing `orgId` typed and merge config+inputs (`EMWF-4`, Blocker)

`email/surface.ts` uses `requireString(args.orgId, 'orgId')` on every op (the ADR 0651 D2
shape); the three nodes read `{ ...ctx.config, ...ctx.inputs }` and let the surface's
`validation_error` propagate as a typed node failure. `list-templates` can no longer answer
`[]` for nobody. Pack 1.1.0 → 1.2.0; `feature.ts:37` pin and the steward manifest move in
lockstep. The docblock's "outputs recorded so replay/fork read the recorded result" is
corrected (the three reads are not replay-served — `EMWF-14`) and their role becomes
`read`; `sideEffectFloor.generated.ts` is regenerated and the fork leg of
`email-node-replay.test.ts` pins live re-execution (review S7 — no `run.metadata` or
definition-shape change anywhere in this ADR; D6 mints new tenant workflows and leaves
instantiated ones untouched). `{...ctx.config, ...ctx.inputs}` (inputs win) matches the one
chain consumer, which binds via `inputs` (`marketing/pack.json:172`); `requireString` throws
`OpenwopError('validation_error')`, already non-retryable (review N5).

### D5 — a registry install never downgrades an image-vendored pack (`EMWF-2`, host half)

**Corrected by review B4 before implementation — two premises moved.** (a) The
mechanism IS real (fresh instance → mount symlinks vendored 1.1.2 → the installer finds no
marker on a symlink, `rmSync`s it and installs the 1.1.0 pin, every boot), but `EMWF-2`'s
STATED HARM is not reachable: `core.openwop.integration.email-send` is in
`MANIFEST_FAST_PATH_SERVED`, so a `:fork` serves the recorded outcome and never reaches the
adapter — the WF-EM-6 key only matters where `runId` is unchanged. The pin matters for
**D2 instead**: production keeps serving success-with-`sent:false` until it moves. (b) A
"vendored newer ⇒ skip" rule in STRICT mode would serve unsigned local code — an inversion
of what `OPENWOP_STRICT_REGISTRY` exists for. Decision: in strict mode the installer
**REFUSES the downgrade loudly** (boot-summary error `registry pin below vendored`, the pack
stays at the pin — policy holds, the drift is visible) and `scripts/preflight-deploy.sh`
runs `check-pack-pin-drift.mjs` and fails on `pin < vendored`; in non-strict mode it skips
the install and keeps the vendored copy. The operational half — publish
`core.openwop.integration@1.2.0` and re-pin — stays with the release runner (`EMWF-17`,
`DEPLOY.md`). Witnesses: strict + vendored>pin ⇒ refusal logged + preflight red; non-strict ⇒
skip; and a real-executor `:fork` of a run with a recorded send ⇒ served, adapter not
reached (bounds `EMWF-2`).

### D6 — the lighthouse pair gets the ADR 0582 legs and the witness population widens (`EMWF-6`, `EMWF-7`)

`lighthouse.lead-triage` and `lighthouse.post-meeting` gain `config.actions`, a
`gate-reject` noop and the `falsy approved` edge (pack 1.1.7 → 1.1.8).
`terminalRejectGates()` in `workflow-chain-email-reject-witness.test.ts` enumerates every
`core.chat.approvalGate` upstream of a send node, not only those with a falsy edge, so an
empty gate is inside the population.

### D7 — small honest fixes in the same PR

`EMWF-8` one key shape for `email:engagement` (the seed writes the service's key);
`EMWF-9` `agentTools.ts` through `resolveReadOrgScope`/`resolveActionOrgScope` +
`checkTenantEntitlement`; `EMWF-10` `publish-email-sequence` idempotency base drops
`runId`; `EMWF-11` `formsConsentSink` — **decided (review S4: `clearTombstone:false` is
inert once a record exists, the tombstone is consulted only on the no-record branch):** the
sink checks `isErasureTombstoned` FIRST and SKIPS the consent write for a tombstoned
contact (logged `forms_consent_skipped_erased`) — an erased subject's checkbox on a public
form is not fresh consent, mirroring D3; asserted afterwards via `isAllowed`, not the flag;
`EMWF-14` `email-node-replay.test.ts`; `EMWF-15` exhaustive provider switch; `EMWF-16`
purgers over the tenant index.

### D8 — the send spine: a reservation is not a send (`EM-23`, Blocker — `/grade-code` 2026-09-11)

`makeEmailAdapter.send` writes the ledger reservation with `messageId: ''` BEFORE the
provider call (`emailAdapter.ts:222`) and the pre-flight `priorSend` (`:213`) plus the CAS
loser branch (`:223-224`) both return `{ sent: true, messageId: '' }` — a reservation read as
a delivery. Crash leg: an instance killed between reserve and accept leaves the reservation
for the ledger TTL (30 d); "Continue sending" then reports the contact delivered without a
provider call, terminally (`priorTerminal`). Race leg: the loser claims off a reservation the
winner may `releaseSend` a moment later. Decision: a prior row with `messageId === ''` is
**in-flight, not sent** — the adapter returns `{ sent: false, error: 'email_send_in_flight' }`
(retryable; the campaign loop counts it in `passFailed`, never terminal); the CAS loser
re-reads once after a bounded wait and otherwise returns in-flight; reservations older than
`OPENWOP_EMAIL_RESERVATION_STALE_S` (default 300) are released on read. Witness: reserve →
kill (no accept) → second send ⇒ `sgRequests === 1`, stats never `sent`
(`reserveSend`/`releaseSend` had no test — `EM-11`).

### D9 — the route lane's honesty gaps (`/grade-code` 2026-09-11, all S)

`EM-6` the test send now passes through D1's floor by construction (adapter) — witness;
`EM-7` a consent read error is per-recipient `passFailed`, not a batch abort; `EM-8` a
failed bounce-suppression write answers 5xx so the provider retries; `EM-19` an unsubscribe
mint failure REFUSES the marketing send (typed, `passFailed`) — a marketing email without an
unsubscribe line is non-compliant, not a warning; `EM-24` `deleteSubjectSends` returns
`{removed, failed}` like its two siblings so one bad row cannot pin the address-bearing
token store; `EM-17` retention purgers for `email:sendlog` and `email:soft-bounce-count`
(tenant-indexed); `EM-18` `declarePiiFields` for `email.sendlog`; `EM-20` `recommends:
['consent']` + a header stating the permissive default; `EM-26` five docblocks corrected
(two claim "no public surface" over six unauthenticated endpoints); `EM-27` public-token
refusals logged (never the token); `EM-28` webhook config row written before its KMS secret.

### D10 — the operator can see and release a suppression; the public page tells the truth (`/grade-ux` 2026-09-11)

`EM-UX-23` (Blocker, live): a suppressed recipient re-ticking Email is told "saved" and
never hears from the sender again, and `removeSuppression` has zero frontend clients
(`EM-UX-5`, seven routes). D3's refused state closes the false success; the remedy needs a
surface: the `/email` hub gains a **Suppressions** panel (list with kind/reason/date, search
by address, **Release** with a confirm naming the consequence) over the existing
`crm/suppressions` routes. `EM-UX-24`: the `refused` state ×4 and an `expired` (stale-token)
state ×4 on the preference page, with the 404 copy no longer blaming the mail client for a
token that resolved. `EM-UX-25`: `host/i18n/errorMessages.ts` gains the email codes so
`/runs/:id` explains `email_recipient_suppressed` and links the Suppressions panel.
`EM-UX-26` three silent Notices announce; `EM-UX-27` a failed provider-status read renders
a failed state, not absence; the S rows `EM-UX-6/-7/-8/-9/-13/-20/-21/-22/-28/-29`.

## Alternatives weighed

- **Gate in the core pack node instead of the adapter.** Rejected: the node is one of two
  egress callers (the route lane bypasses it), and a pack node cannot import feature
  services; the adapter is the choke every lane already shares.
- **Refuse unresolvable consent (no contact ⇒ refuse marketing).** Rejected for v1: it
  would refuse every chain send to a non-CRM address, which is most of the corpus's
  `{{params.recipientEmail}}` use (a demo operator mailing themselves). Recorded as the
  stated residual; a later ADR can flip it per tenant.
- **Fail open when no guard is registered.** Rejected (ADR 0651 D4 lesson: a fail-open
  default is a shape that reappears at the next level).

## Open questions

- `EMWF-18` (new): expose the suppression `kind` so transactional sends can pass an
  `unsubscribed`-only row. Not in this PR.
- Whether `email_recipient_no_consent` should also apply when the contact exists but has
  no consent record at all (today `isAllowed` is permissive with `consent` OFF — ADR 0651
  D4 wording applies here too).

## Phased plan

| Phase | Decision | Gap ids |
|---|---|---|
| P1 | D1 + D2 (same node, same executor harness; a real-executor witness with a suppressed recipient) | `EMWF-1`, `EMWF-5` |
| P2 | D3 (+ `EMWF-11`, the second re-consent door) | `EMWF-3`, `EMWF-11` |
| P3 | D4 + `EMWF-14` + `EMWF-10` (pack honesty, one bump) | `EMWF-4`, `-10`, `-14` |
| P4 | D6 | `EMWF-6`, `-7` |
| P5 | D5 + the D7 remainder | `EMWF-2` (host half), `-8`, `-9`, `-15`, `-16` |
| P6 | D8 (send spine) + D9 (route lane) | `EM-23`, `EM-6/-7/-8/-17/-18/-19/-20/-24/-26/-27/-28` |
| P7 | D10 (frontend + public strings) | `EM-UX-23/-24/-25/-26/-27` + S rows |

Not in this ADR: `EMWF-12` (daemon entitlement, M), `EMWF-13`, `EMWF-17` (release runner),
`WF-EM-8` (RFC-gated), `WF-EM-12`, `WF-EM-16`, `WF-EM-17`.

## Pre-implementation review (2026-09-11, `/architect`, before any code)

Five Blockers and seven SHOULDs in the Proposed text, all folded above in place: **B1** a
fourth egress path (`emailApprovalDelivery.ts:185` → `sendViaSmtp`); **B2** no default for an
absent `purpose` while every route caller omits it; **B3** no test seam for the guard-missing
refusal; **B4** D5 inverted strict-registry policy and `EMWF-2`'s fork harm is unreachable
(the send node is fast-path served) — the pin matters for D2; **B5** `recoverable` was an
invention, the executor classifies retry by `NON_RETRYABLE_NODE_ERRORS`. SHOULDs: S1
index-only contact hop, S2 leg 3 inert with `consent` OFF, S3 widening on effective values,
S4 the forms sink must decide (tombstone-first skip), S5 channel-generic seam, S6
all-or-nothing recipients, S7 regenerated floor + fork leg. The born-red checklist the review
produced is the implementation order.

## Implementation record (2026-09-11, feature loop it.10, one PR)

| Decision | Landed | Witness (born red unless noted) |
|---|---|---|
| D1 | `host/recipientEgressGuard.ts` (channel-generic seam); `makeEmailAdapter.send` consults it per recipient after `priorSend`, before `reserveSend`, all-or-nothing; `email/egressGuard.ts` registers tombstone → suppression → index-only consent at boot; `purpose` REQUIRED on both brokered constructors (campaign `marketing`, invite/receipt/approval `transactional`); `emailApprovalDelivery` rides the adapter; consent tombstones written/read on the folded email form | `email-egress-guard.test.ts` (9: seam posture, real adapter + SendGrid mock — suppressed/erased/clean/no-reservation, D8 in-flight + stale, `sendViaSmtp` one-importer ratchet); `workflow-chain-campaign-journeys-execution.test.ts` real-executor suppressed recipient ⇒ `node.failed` before the provider |
| D2 | `core.openwop.integration` 1.2.0 — `emailSend` throws typed; refusal codes in `NON_RETRYABLE_NODE_ERRORS` | journeys: no Connection ⇒ run `failed` with `email_not_connected` (the old `completed`+`sent:false` pin flipped); the happy path now needs a REAL send target |
| D3 | `POST /p/:token` widening on effective values; fresh ≤30 d + clean address + no tombstone, else 409 `refused-stale`/`refused-suppressed` (strings ×4); `clearTombstone:false` always | `email-preference-widening.test.ts` (6 — incl. the corrected premise: a DSAR erases the link itself, 404) |
| D4 | `email/surface.ts` `requireString`; `feature.email.nodes` 1.2.0 role `read`, config+inputs merge, `nodes` map kept | `email-node-replay.test.ts` (6 legs) |
| D5 | `installRegistryPacks.ts` `classifyRegistryInstall` (strict ⇒ refuse loud, non-strict ⇒ skip); `preflight-deploy.sh` runs `check-pack-pin-drift.mjs` under a deploy env (`--allow-pin-drift`); the gate harness blanks the env | `registry-install-downgrade.test.ts`; PROBE-EM-3 (live pin 1.1.0 measured) |
| D6 | lighthouse 1.1.8 — both chains `config.actions` + `gate-reject` + falsy edge; witness population = every gate upstream of a send ∪ the falsy-edge gates | `workflow-chain-email-reject-witness.test.ts`, `workflow-chain-lighthouse.test.ts` |
| D7 | seed key shape; agent tools via `resolveRead/ActionOrgScope` + `checkTenantEntitlement`; `publish-email-sequence` content-anchored + `side-effect` (1.12.0, floor regenerated); forms sink tombstone-first; exhaustive bounce dispatch; indexed purgers | `email-agent-tools-entitlement.test.ts` (own boot — plan config is read at startup), `email-forms-consent-sink-erased.test.ts`, `campaign-channels-publish.test.ts` (the `runId:nodeId` pin flipped) |
| D8 | reservation = in-flight (`email_send_in_flight`, retryable); stale released; CAS loser re-reads once | in `email-egress-guard.test.ts` §3 |
| D9 | EM-7/-8/-17/-18/-19/-20/-24/-26/-27/-28 | `email-bounce-failed-write.test.ts` (mocked write ⇒ `failed:1`, route 503), `email-retention-and-erasure-outcome.test.ts` |
| D10 | Suppressions panel (list/search/Release with an ATTESTED forced release for bounce/complaint/unsubscribe — `DELETE …/suppressions/:email?force=true`), announces, failed/empty states, danger confirms, run-detail `nodeErrorHint_*` ×4, notice-announce baseline 174 → 173 | `adr0654D10.test.tsx` (14) + email folder 49 green |

Not in this PR (recorded): `EMWF-12` (daemon entitlement), `EMWF-13`, `EMWF-17` (release runner: publish `core.openwop.integration@1.2.0`, lighthouse 1.1.8, campaign-channels 1.12.0, feature.email.nodes 1.2.0 and re-pin), `EMWF-18` (suppression kind), `EMWF-19` (SMS guard), `WF-EM-8/-12/-16/-17`, `EM-12/-13/-15`.
Lesson carried: the first draft of the erased-subject witness expected 409 where the code correctly answers 404 (the DSAR erases the token row) — the premise was wrong, the code was right; and my registration guard duplicated an upstream fix that landed while the branch was open (#3740).
