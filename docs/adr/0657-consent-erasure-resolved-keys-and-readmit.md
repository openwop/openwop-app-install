# ADR 0657 — Consent & Compliance: erasure reaches every resolved key, the tombstone out-ranks the toggle, and an erased subject gets an honest door back

Status: implemented (2026-09-11, feature loop it.11; D9's boot-line / `expiresAt` / session-secret items and D12's bounded concurrency NOT shipped — recorded below)
Date: 2026-09-11
Feature: Consent & Compliance (ADR 0020 feature; ADR 0227 channel specifics; ADR 0381 subject-key resolution; ADR 0464 erasure semantics; ADR 0586 erasure integrity; ADR 0655 recipient egress floor) · FEATURES.md ordinal 11 of 71 · feature loop 2026-09 it.11
Plan input: `docs/steward/WORKFLOWS-ASSESSMENT.md` § "Consent & Compliance — Grade: B → C+ (2026-09-11)", gaps `CNWF-1..15`; `/grade-ux` 2026-09-11 rows `CONS-UX-23..33`
Related: ADR 0651 D3 (analytics stamp resolver seam), ADR 0655 D1/D3 (the floor and the preference-token rule this ADR completes)

## Context

The 2026-08 pass closed four Blockers in the erasure lane and graded it the strongest part
of the feature. Re-graded 2026-09-11 against `origin/main @ c16de2464`, the erasure lane has
two holes the requested-key vantage could not see, the node pack is misclassified, and the
ADR 0655 work this loop shipped a week earlier created a public promise no surface can keep:

1. **`CNWF-1` — a DSAR tombstones and deletes the consent record for the REQUESTED key
   only.** `deleteSubject` (`consentService.ts:604-606`) writes the tombstone and deletes
   `${tenant}:${subjectKey}`, then calls `eraseSubject`, where ADR 0381 resolution happens
   (`subjectErasure.ts:173`) — and Consent registers **no** `SubjectEraser`, so nothing
   revisits the resolved keys. Erase `alice@x.test`: the CRM resolver yields `crm:c123`, the
   CRM rows go, and the `consent:record` keyed `crm:c123` (`marketing:true`, the raw key,
   `region`, `purposes`) survives untombstoned. `campaign-connectors/audienceService.ts:51`
   reads that stale grant and uploads the erased person's hashed email to an ad platform.
2. **`CNWF-2` — `DELETE /users/:id` calls `eraseSubject` directly** (`users/routes.ts:365`)
   with no consent participation: the account's consent record (keyed by userId) is never
   deleted or tombstoned, and if it were deleted the no-record branch falls to the policy
   default — the CONS-1 flip, reopened on the second DSAR door.
3. **`CNWF-3` — `feature.consent.nodes` is not in the side-effect floor.** `role:"action"`,
   `capabilities:[]` (`pack.json:18-19,27-28`) ⇒ absent from `MANIFEST_SIDE_EFFECT_FLOOR` and
   `MANIFEST_FAST_PATH_SERVED`; the pack docblock and the 2026-08 inventory row claimed the
   opposite (the prior pass read `DECLARED_TYPE_IDS` as the floor). A `:fork` would re-execute
   `record` live and merge a historical run's consent over current state.
4. **`CNWF-4` — the toggle-OFF `return true` (`consentService.ts:663-664`) precedes the
   tombstone check (`:678`)**: on the shipped default, `isAllowed` answers `true` for an
   ERASED subject. The DSAR route was deliberately un-toggle-gated; the refusal erasure
   writes was not.
5. **`CONS-UX-24` — an erased subject on the preference page is told to "reply to the sender
   and ask to be re-subscribed"** (ADR 0655 D3's `refused-suppressed` copy), and **no route or
   UI can honour it**: `clearErasureTombstone` fires only from consent writes
   (`consentService.ts:240,374`), which the tombstone-first sinks (it.8, it.10) refuse for an
   erased subject; `consent/routes.ts` has no authed consent-write route; the only writer is a
   workflow-surface op. A tombstoned person can never come back. `CONS-UX-23`: the erasure
   console never says erasure is now a permanent egress refusal.

### The boundaries audit

- **One erasure fan-out** (`host/subjectErasure.ts`): erasers are called once per RESOLVED
  key (`:188-190`), under the legal hold (`:172`), from both DSAR doors (`deleteSubject`,
  `users/routes.ts:365`). A consent eraser registered there is the single cure for
  `CNWF-1` and `CNWF-2`; it does not replace `deleteSubject`'s up-front tombstone (CONS-1
  ordering: refusal before destruction) — it adds the same pair for every resolved key.
- **One consent evaluator** (`isAllowed`, `consentService.ts:639-690`) with thirteen callers;
  only the order of its first two branches changes.
- **The public preference page already has a refused state machine** (ADR 0655 D3); the fix
  is a third reason, not a new page. The operator door is a NEW authed route on the consent
  feature (it owns tombstones) and a control on the existing erasure console.
- **Public capture budget**: the it.9 `takeOrgBeaconBudget` shape (per-org fixed window,
  env-tunable, after the org resolved).
- **Destructive-lane census**: `registerRetentionPurger` (34), `registerKvAgeOut` (7),
  `registerSubjectEraser` (92), `registerTenantPurgeHook` (5, `hostExtPersistence.ts:128`),
  the run sweeper, the transient GC, `pruneEngineTables`, the idempotency prune, anon-tenant
  teardown, account teardown — thirteen kinds; `legal-hold-gates-erasure.test.ts` pins seven
  by hand.

## Decision

### D1 — a consent eraser on the fan-out: every resolved key is deleted AND tombstoned (`CNWF-1`, `CNWF-2`, Blockers)

`features/consent/erasure.ts` registers `consentSubjectEraser(tenantId, key)` (a named
function, pinned in `host/subjectEraserManifest.ts`, registered toggle-independently from
`consentFeature.registerRoutes` — the ADR 0655 D1 precedent — importing the tombstone helpers
from `consentService` rather than re-declaring the collection): delete `consent:record` for
the key, write the erasure tombstone for the key's forms (`tombstoneKeyForms`, stamped with
the DSAR's `dsarHash` — D7), return `{ rowsTouched }` = **record rows deleted only** (a
tombstone write is not counted, or `foundNothing` — `reporting > 0 && rowsTouched === 0` —
becomes unreachable; `/architect` Blocker 3). `writeErasureTombstone` is get-then-put: an
existing row keeps its original `erasedAt`. The ADR 0464 gate's `REVIEWED_EXEMPT['consent:record']`
row (whose "cannot also be an eraser without recursing" claim is false — the eraser never calls
`eraseSubject`) is deleted and the store moves to `EXPECTED_COVERED`. Measured: no eraser
imports `isAllowed`/`isErasureTombstoned`, so eraser order does not change behaviour. `deleteSubject` keeps its CONS-1 ordering for the requested key (tombstone
→ delete → fan-out) — the eraser makes the same pair land on every ADR 0381-resolved key,
and on the userId the users lane erases. Idempotent (a second DSAR deletes nothing and
re-writes the same tombstone hash). Witness: erase an email that resolves to a CRM contact ⇒
the contact-keyed record is gone and tombstoned and `buildAudienceUpload` excludes it;
`DELETE /users/:id` ⇒ tombstone for the userId, no record.

### D2 — the tombstone out-ranks the toggle (`CNWF-4`)

Precedence (`/architect` Blocker 4 made it explicit — the draft said "before the toggle" but
not "before the record", and today a record out-ranks a tombstone): `necessary` → strict →
**tombstone (deny)** → toggle-off (permit) → record → policy default. A record NEVER out-ranks
a tombstone. A tombstone is a refusal that erasure wrote, not a feature a tenant buys (the
same reasoning that un-toggle-gated the DSAR route). Witnesses born red: toggle OFF +
`deleteSubject` ⇒ `isAllowed` false; toggle OFF + tombstone + a record ⇒ false. Cost, stated
precisely (SHOULD 8): +1 point `get` (+1 more for email-shaped keys) on every toggle-OFF
caller; an EMPTY key short-circuits (never tombstoned — the beacon's `''`); a KV outage now
throws where toggle-OFF never touched storage — D5 covers the batch callers, the rest run
inside a route `catch` (caller table in the assessment).

### D3 — the node pack is classified honestly (`CNWF-3`)

`feature.consent.nodes` 1.1.0 → 1.2.0: `record` is `role:"side-effect"` +
`["side-effectful"]` (served from the recorded outcome on replay), `check` is `role:"read"`
(re-executes; a gate verdict is live by design and the docblock says so). `feature.ts:37` pin,
steward manifest and `sideEffectFloor.generated.ts` move in lockstep;
`consent-node-replay.test.ts` pins the five sibling legs plus the fork leg.

### D4 — the public capture never mints on an empty body, and has a per-org budget (`CNWF-5`)

`POST /public-consent/:orgId`: a body with no `categories` object or an empty one is a
400 (`validation_error`) — the surface's `requireCategories` rule applied at the route — and
never mints a `visitor:` token; a per-org fixed-window budget
(`OPENWOP_CONSENT_CAPTURE_ORG_REQS_PER_MIN`, default 600, read per call, `0` disables) answers
429 + `Retry-After` after the org resolved (the uniform 404 stays for unknown/toggle-off).

### D5 — a consent READ error is per-recipient, never a batch abort (`CNWF-6`)

`audienceService.ts:51` and `journeyService.ts:206` wrap `isAllowed`; a throw excludes the
recipient with a counted `consent_unreadable` reason (never included, never aborting the
batch); the analytics beacon answers 503 on a consent read error, not 500. The remaining
callers already degrade closed or run inside a route `catch` (recorded in the assessment's
caller table).

### D6 — DSAR authorization and receipt idempotency (`CNWF-7`, `CNWF-8`)

> **CORRECTED 2026-09-11 by the `/architect` pass (Blocker 1 + SHOULD 6) before any code.**
> The first draft gated on `workspace:admin` — a scope with ZERO occurrences in `src`
> (`accessControlService.ts:90-191`), so the text could not type-check — and its "OR the key
> resolves inside the caller's org" arm was a no-op grant: `Contact` carries `tenantId` only
> and `requireOrgScope` already binds the org to the active tenant, so every key trivially
> satisfied it and a `workspace:write` editor could erase anyone. The `requestId`/`already_erased`
> receipt was dishonest (a repeat fan-out CAN touch rows re-created since) and unnecessary
> (the tombstone's `erasedAt` is the durable prior-erasure evidence).

`DELETE …/subjects/:subjectKey` and `POST …/readmit` require **`host:members:manage`** on the
org — the scope the users erase door (`users/routes.ts:325`) already requires, so BOTH doors
onto `eraseSubject` share ONE authority; a scope miss is the existing `forbidden_scope` 403.
`GET …/subjects/:subjectKey` stays `workspace:read`. `assertSubjectKey` on the path. Repeat
detection reads the PRIOR tombstone row before writing: a repeat whose fan-out found nothing
records `erasure_repeat_no_data_found` (a fourth outcome, never a flip of the first receipt);
every repeat carries `detail.repeat:true` + `priorErasedAt`. No `requestId`. `WF-CONS-5`
(DSAR as a run) stays open; this is its cheap half.

### D7 — an erased subject gets the truth, and the operator gets an audited door back (`CONS-UX-23`, `-24`, `-25`, `-26`)

- Public preference page: a third refused reason `refused-erased` (409) whose copy says the
  address was removed at the recipient's request and cannot be re-enabled from any link; no
  "reply to the sender" instruction (strings ×4 in `publicPageStrings.ts`). The forms opt-in
  sink and the D3 preference rule keep refusing (tombstone-first).
- **Operator re-admit**: `POST …/consent/orgs/:orgId/subjects/:subjectKey/readmit` —
  `host:members:manage` (D6), body `{ attestation: string }` (≥ 20 chars, the operator's
  statement that the subject asked to return). **It reverses exactly what the DSAR wrote**
  (`/architect` Blocker 2): every tombstone written by one DSAR carries
  `dsarHash = tombstoneId(tenantId, requestedKey)` (hash→hash, no PII), and readmit deletes
  every tombstone in the tenant slice whose `subjectHash` OR `dsarHash` equals
  `tombstoneId(tenantId, key)` — the requested key's forms, every resolved key (which the
  resolvers can no longer recover at readmit time: `eraseCrmSubject` deletes the ident rows,
  `deleteUser` the user row), and any resolver over-reach. The receipt reports
  `tombstonesCleared`; `not_erased` when nothing matched. Audit: a tenant-chain row
  (`consent.readmit`: `subjectHash`, `tombstonesCleared`, the attestation in plaintext — the
  operator's statement IS the evidence; the UI tells the operator not to put personal data in
  it) + a governance row (`kind:'retention'`, `reason:'readmit'`, `subject` hashed,
  `attestationHash`). It clears tombstones ONLY — no consent is granted; the subject's next
  affirmative opt-in (form, public capture, preference link) is what re-grants. **Readmit is
  the ONLY clearer**: `clearTombstone` is removed from every writer (Blocker 4 / D10). Erasure console: a "Re-admit subject"
  control on the `foundNothing`/tombstoned receipt with a typed attestation confirm.
- Erasure console copy (`eraseConfirmBody`, `receiptOk`, ×4): erasure also blocks every
  marketing send and every public re-subscription for this subject until an administrator
  re-admits them. Run-detail hint for `email_recipient_erased` links the consent console, not
  the suppressions panel (`CONS-UX-25`).

### D8 — the destructive-lane census is enumerated from source (`CNWF-11`, `CNWF-10`)

`test/destructive-lane-census.test.ts` derives the population by scanning `src` for the
registration seams (`registerRetentionPurger`, `registerKvAgeOut`, `registerSubjectEraser`,
`registerTenantPurgeHook`) and the named entry points (`eraseSubject`, `deleteSubject`,
`users/routes.ts` DELETE, `purgeRetained`, `__runKvAgeOutOnce`, `runRetentionSweeper` ×2,
`workflowComposeTool` reconcile, `routes/account.ts` teardown, `pruneAbandonedAnonTenants`,
`purgeTenantHostExt`, `pruneEngineTables`, `pruneIdempotentResponses`) and asserts each is in a
hand-kept map that states HOW it consults the legal hold (`asserts` / `skips-held` /
`inherits-from:<lane>` / `exempt:<reason>`). A new entry point with no map row fails the
test. `pruneEngineTables` and the idempotency prune are recorded `exempt` with the reason
(engine rows and a host-global cache carry no subject data), `registerTenantPurgeHook`
`inherits-from:account-teardown`. The users lane gets its own hold witness.

### D9 — small honest fixes in the same PR

`CNWF-14` `shouldStartRetentionLoop()` + a boot line naming what the loop will and will not
do on this install; `CNWF-15` `expiresAt` honoured by `isAllowed` (expired ⇒ absent) and
accepted by the writers; `CNWF-13` the session-secret "MUST be set" is a boot `warn` in
non-production and a refusal under `NODE_ENV=production`, and `tombstoneKeyForms` folds
phone-shaped keys through the E.164 normaliser the WhatsApp lane uses; `CONS-UX-19` fr/pt-BR
labels; `CONS-UX-27` `missing[]` typed and rendered with its own localized label;
`CONS-UX-28` `rowsTouched` rendered; `CONS-UX-29` the receipt's Retry keeps focus (the receipt
stays mounted, busy); `CONS-UX-30` the receipt announces (politely; the `foundNothing` line
names the home-workspace step); `CONS-UX-31` the toggle-off copy states that marketing consent
is not enforced while off; `CONS-UX-33` `held` is a durable refused state on the page;
`CONS-UX-5` busy on Erase; `CONS-UX-32` `typeToConfirm` on the DSAR confirm.

Accepted residuals, stated: `CNWF-12` — `governance_decision` rows live in the global
tamper-evident `audit_log`; they carry a hashed subject and no PII by construction
(`governance-decision-subject-pii.test.ts`), which is the deletion-vs-evidence trade the chain
exists for; a tenant column is recorded as the follow-up, not a deletion. `CNWF-9` (sms /
slack / notify in the egress floor) is `EMWF-19`'s scope and stays open.

### D10 — the tombstone is the CAS barrier: no consent write can undo an erasure (`CONS-25`, Blocker — `/grade-code` 2026-09-11)

`mergeConsentCategories` (`consentService.ts:356-381`) and `recordConsent` re-check
`isErasureTombstoned` INSIDE the swap window whenever the read is `null` (a lost CAS retried
from a deleted row is exactly the DSAR interleaving) and REFUSE with a typed
`subject_erased` — never re-insert. The `clearTombstone` option is REMOVED from the write
contract: a consent write never clears a tombstone; the ONLY clearer is D7's attested
re-admit. Consequences stated: the workflow surface op (`surface.ts:99-104`) and any public
writer (WhatsApp STOP `compliance.ts:92`, one-click unsubscribe `engagementService.ts:465`,
the preference page, the banner) can no longer resurrect an erased subject by racing the
DSAR; `deleteSubject` additionally re-deletes the record after the fan-out (belt) so a write
that slipped in before the barrier landed is still gone. Witness: park a merge between its
read and its swap, run `deleteSubject`, release — the record must not exist and the tombstone
must survive; the parked writer gets `subject_erased`.

### D11 — the audit chain never carries a raw subject key (`CONS-26`, Blocker)

`appendAudit` entries written by consent (`consentService.ts:244-250, 376-378`) and by the
WhatsApp keyword lane (`compliance.ts:84-96`) carry `subjectHash: hashSubjectKey(tenantId,
key)` instead of `subjectKey` — the same mitigation `recordGovernanceDecision` already uses
three lines away (`:625, :720`); cross-row correlation survives (same hash), tamper-evidence
survives (the hash is what is chained). The WF-CONS-14 gate
(`governance-decision-subject-pii.test.ts`) widens to scan every `appendAudit(` site under
`features/consent` and `features/whatsapp` for a raw `subjectKey`/`from` field. Existing
chain rows cannot be redacted (the chain would break) — recorded as the accepted residual with
the date this stopped, and the audit export (`routes/governance.ts:531-557`) is the reader
that inherits it.

### D12 — the rest of the code re-grade (all S unless noted)

`CONS-28` the merge's retries-exhausted fallthrough asserts purposes only when the CALLER
supplied them (a revocation must never 400 on the rare path); `CONS-29` a hold placed
mid-DSAR: `deleteSubject` catches `RetentionHoldError` around the fan-out and writes a
`retention/deny` decision naming the mutation already performed (tombstone + record delete);
`CONS-30` (M) a per-eraser timeout (`OPENWOP_ERASER_TIMEOUT_MS`, default 10 s) counted into
`failed` with the eraser named — bounded concurrency stays open; `CONS-31` the ADR 0464
gate's recorded derivation command is multi-line-aware and its measured numbers re-stamped;
`CONS-11` the resolver closure: `resolveSubjectKeys` re-feeds derived keys ONE more hop when a
resolver yields a key of a different shape (email from `usersEmailKeyResolver` →
`resolveCrmSubjectKeys`), bounded to two hops, with the same non-subject guard the analytics
resolver has.

### `/architect` review record (2026-09-11, before code)

Four Blockers and eight SHOULD/NITs, all folded above and below: (1) the non-existent
`workspace:admin` scope + the no-op org-resolution arm → D6; (2) readmit could not reach the
resolved-key tombstones → the `dsarHash` group in D1/D7; (3) `rowsTouched` counting tombstones
made `foundNothing` unreachable → D1; (4) clear-on-write rejected in Alternatives but never
retired, and record-over-tombstone precedence → D2/D7/D10. SHOULDs: registration site + the
two ratchet rows (D1); `requestId` dropped (D6); readmit audit shape (D7); the D2 cost table;
D4 reuses `requireCategories` and accepts that a purposes-only update on an existing token is
now a 400; D8 must be STRUCTURAL (map keys equal the derived set both ways, each `asserts` row
proved by a body scan for the hold call, each `inherits-from` names an `asserts` row whose
callee appears in the inheriting body, exempt reasons pinned, floor ≥ 13). NITs: the floor is
generated (say "regenerate"); `check` as `read` matches the journeys "live by design" posture;
no `run.metadata` change; no RFC.

## Alternatives weighed

- **Tombstone the resolved keys inside `deleteSubject` instead of an eraser.** Rejected: the
  users lane never calls `deleteSubject`; the fan-out is the one place both doors meet.
- **Delete the tombstone on any consent write (today's behaviour).** Rejected: it is exactly
  how an erased subject was resurrected by a forwarded link (ADR 0655 D3) — re-admission is
  an operator act, attested and audited.
- **Refuse re-admission entirely (erasure is final).** Rejected: a person who erased and later
  genuinely wants back has a legal right to consent again; a system with no door forces the
  operator to a raw store edit.

## Open questions

- Whether `readmit` should also require the subject's own affirmative act within N days
  (double opt-in) before the tombstone clears. v1: the clear is the operator's; the grant is
  the subject's next opt-in — two acts, two actors.
- `WF-CONS-5`/`-12` (DSAR as a run; export lane) stay open; `openwop:kanban.add-todo` remains
  the sanctioned stack shape for a later ADR.

## Phased plan

| Phase | Decision | Gap ids |
|---|---|---|
| P1 | D1 + D2 (the erasure lane, born-red witnesses) | `CNWF-1`, `-2`, `-4` |
| P2 | D3 (pack honesty + floor + replay test) | `CNWF-3` |
| P3 | D4 + D5 + D6 | `CNWF-5`, `-6`, `-7`, `-8` |
| P4 | D7 (public state ×4, readmit route + console, copy, run hint) | `CONS-UX-23..26` |
| P5 | D8 + D9 | `CNWF-10`, `-11`, `-13`, `-14`, `-15`, `CONS-UX-5/-19/-27..33` |
| P6 | D10 + D11 + D12 (the code re-grade) | `CONS-25`, `-26`, `-28`, `-29`, `-30`(part), `-31`, `-11` |

## Implementation record (2026-09-11)

| Decision | Landed in | Witness (born red) |
|---|---|---|
| D1 consent eraser on the fan-out, `rowsTouched` = records only, DSAR group id on every tombstone | `features/consent/erasure.ts` (new), `consent/feature.ts` (registered from `registerRoutes`), `host/subjectEraserManifest.ts` 89→90, `test/subject-erasure-feature-stores.test.ts` (`consent:record` exempt row → `EXPECTED_COVERED`) | `test/consent-erasure-fanout.test.ts` D1 legs (email→contact; users door; `foundNothing` reachable; repeat) |
| D2 precedence (tombstone before toggle and record; empty key short-circuits) | `consentService.ts` `isAllowed` | fanout D2 legs |
| D3 pack 1.2.0 classification | `packs/feature.consent.nodes/{pack.json,index.mjs}`, `feature.ts` pin, regenerated floor/served-set/steward manifest | `test/consent-node-replay.test.ts` |
| D4 no mint on an empty body + per-org budget | `consent/routes.ts` (`requireCategories` exported from `surface.ts`, `OPENWOP_CONSENT_CAPTURE_ORG_REQS_PER_MIN`) | `test/consent-readmit-route.test.ts` D4 |
| D5 per-recipient consent-read failure | `campaign-connectors/audienceService.ts` (`consentUnreadable`), `campaign-journeys/journeyService.ts` (`consent_unreadable`), `analytics/routes.ts` (503) | existing connector/journey/beacon suites green; typed code added to `types.ts` |
| D6 `host:members:manage` on DELETE + readmit; repeat detection via the prior tombstone | `consent/routes.ts`, `consentService.ts` `deleteSubject` | route test D6 (editor 403 / admin 200); fanout "repeat" leg |
| D7 readmit route + `dsarHashes` group clearing + `refused-erased` public state + console control | `consentService.ts` `readmitSubject`/`writeErasureTombstone`, `consent/routes.ts`, `email/routes.ts` + `publicPageStrings.ts` ×4, `frontend/…/consent/ReadmitSubjectDialog.tsx`, `ConsentPage.tsx`, `consentClient.ts`, i18n ×4 | fanout D7 legs (two-hop group cleared; resolved-key readmit clears only its forms), route test D7, `email-preference-widening.test.ts` leg 6, `ConsentReadmit.test.tsx` |
| D8 structural destructive-lane census | `test/destructive-lane-census.test.ts` (AST-derived, 37 lanes, 5 seams) | three sabotages red; found `CNWF-16`/`-17` |
| D9 phone fold on write AND read; CONS-UX rows | `tombstoneKeyForms`; frontend per the UX section | fanout D9 leg; frontend suites |
| D10 the write barrier + belt | `consentService.ts` `assertNotErased` (entry + post-write re-check in both writers), `deleteSubject` re-delete; `whatsapp/compliance.ts` + `foldConsentOnMerge` treat `subject_erased` as nothing-to-write; `email/routes.ts` maps it to `refused-erased` | `consent-erasure-tombstone.test.ts` (both symmetric-half legs rewritten), fanout D10 leg; sabotage: `assertNotErased` no-op'd ⇒ 6 legs red in 3 suites |
| D11 hashed subject on the audit chain | `consentService.ts` both `appendAudit` sites | `test/consent-audit-chain-subject-hash.test.ts` (behavioural + source scan; sabotage red) |
| D12 CONS-28 / CONS-29 / CONS-30 (timeout) / CONS-31 / CONS-11 (two hops + `currentErasureRequest`) | `consentService.ts`, `host/subjectErasure.ts` | `test/subject-erasure-fanout-adr0657.test.ts` (9 legs) |

**Not shipped, stated:** D9's `shouldStartRetentionLoop` boot line (`CNWF-14`), `expiresAt`
honouring (`CNWF-15`), the session-secret boot refuse, and D12's bounded fan-out concurrency
(`CONS-30` second half). The D8 census surfaced two retention-daemon hold gaps (`CNWF-16`,
`CNWF-17`) that need an adapter-level held-tenant exclusion — recorded, not fixed here.

**Lessons recorded:** the `/architect` pass on the Proposed text found four Blockers before
code for the second iteration running; the barrier sabotage showed the ENTRY check is
redundant and the post-write re-check is the load-bearing one; a test without `createApp`
must register the toggle default by hand or every toggle-dependent leg runs on the
permissive path (three legs were vacuous until the guard threw).
