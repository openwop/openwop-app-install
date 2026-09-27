# ADR 0586 — Consent & Compliance: erasure integrity, legal hold, and the public capture lane

Status: implemented

Supersedes nothing. **Corrects four decisions recorded in
[ADR 0020](0020-consent-compliance.md)** — the correction notes are inline
there, per the repo's "correct, don't rewrite history" rule.

## Context

The 2026-08-19 single-feature assessments graded Consent & Compliance **C**
(code, `CONS-1..18`), **C+** (UX, `CONS-UX-1..22`) and **B−** (workflows,
`WF-CONS-1..14`), with 15 Blockers across the three. Four of them share one
shape and are the subject of this ADR: **a compliance control that destroys or
fabricates state it cannot reconstruct.** The rest are recoverable by doing the
work later and are tracked in the assessments.

The four:

1. **`CONS-1` — a DSAR erasure RE-CONSENTED the subject.** `deleteSubject`
   deletes `consent:record` first; `isAllowed` with no record falls through to
   `policy.defaultMode === 'opt-out'`. On an opt-out tenant the erasure flipped
   `analytics`, `marketing`, `marketing.sms` and `marketing.push` from DENY to
   ALLOW. Email survived only incidentally (CRM deliberately retains
   `crm:suppression`); WhatsApp only because `STRICT_EXPLICIT_OPT_IN`
   short-circuits. Unrecoverable: the erased subject cannot re-opt-out.
   *The general shape: when a default is fail-open, DELETION becomes a GRANT.*
2. **`CONS-4` / `WF-CONS-1` — the tenant legal hold reached 2 of 6 destructive
   lanes.** `getRetentionHold` had four call sites, all in the run/workflow
   lane; `host/subjectErasure.ts`, `host/retentionPurger.ts` and
   `host/kvAgeOut.ts` contained zero references to it. `deleteSubject`
   affirmatively wrote a `retention` decision with `outcome: 'allow'` for a held
   tenant. GDPR Art. 17(3)(b)/(e) makes a hold OVERRIDE erasure, so this failed
   in the unrecoverable direction (spoliation).
3. **`CONS-2` — unauthenticated consent forgery.**
   `POST /v1/host/openwop-app/public-consent/:orgId` took `subjectKey` from the
   request body with no proof-of-possession and called latest-wins
   `recordConsent`, which REPLACES wholesale — into a keyspace shared with CRM
   contactIds, `User.userId`s, email addresses and (since ADR 0394) raw E.164
   numbers. `GET …/:orgId/:subjectKey` was the matching anonymous oracle.
4. **`CONS-3` — a form EMAIL opt-in GRANTED sms and push.**
   `formsConsentSink` wrote a fresh record that hand-preserved `analytics` and
   dropped every other specific; `isAllowed` falls back to the `marketing`
   umbrella when a specific is ABSENT, so a dropped `false` became ALLOW. Same
   class in `surface.record` and the public POST.

Plus **`WF-CONS-14`**, which is one line but the same family: `isAllowed` wrote
the RAW `subjectKey` into the durable governance decision log, three lines below
a sibling log call that hashes it for exactly that reason.

## Decision

### D1 — an erasure tombstone, keyed by a tenant-salted digest

`deleteSubject` writes a row into a new `consent:erasure-tombstone` collection
BEFORE it deletes the consent record. `isAllowed` consults it on the
no-record path — the exact path that previously fell through to the policy
default — and denies.

**Options weighed.**

| Option | Verdict |
|---|---|
| Deny-by-default (drop the `opt-out` fallback) | **Rejected.** It changes the verdict for every subject who never consented. `opt-out` is a legitimate operator posture, not a bug. |
| A terminal all-false `consent:record` instead of a delete | **Rejected.** The row is keyed `${tenantId}:${subjectKey}`, so the subject's RAW identifier — possibly an E.164 number — would survive the erasure inside the store the erasure is supposed to clear. A tombstone that re-identifies the subject defeats the erasure. |
| **A separate, PII-free tombstone keyed by `sha256(tenantId:subjectKey)`** | **Chosen.** The digest is derivable from `(tenantId, subjectKey)` at check time, so the gate answers "erased ⇒ deny" without the store ever holding the key. It is the same pseudonymisation primitive the governance rows already use (`hashSubjectKey`), so the two agree rather than each inventing one. |

**Lawful basis for retaining anything at all:** Art. 17(3) / Recital 65 — the
controller may keep the minimum needed to keep honouring the erasure/objection.
`crm:suppression` is the same argument, already accepted in this repo; this row
keeps strictly less than that one does.

**Residual, stated rather than implied.** SHA-256 over a low-entropy identifier
is dictionary-reversible by someone who already holds the store, because the
salt is the tenantId and is not secret. It is a re-identification COST, not a
barrier. A keyed HMAC would close it, but the only host secret available
(`readSessionSecret`) is rotatable and ephemeral in dev, so a rotation would
silently drop every tombstone and fail OPEN — the exact direction this decision
exists to prevent. Trading a silent fail-open for a reduced-but-real
re-identification cost is the wrong trade on a compliance control.

**Deliberate over-restriction.** Erasing a subject who never recorded anything
still tombstones them: an erasure request IS an objection to processing. It is
per-subject, so a bystander who never asked for anything is untouched — both
arms are test-pinned.

**The symmetric half.** `recordConsent` and `mergeConsentCategories` clear the
tombstone, so an erased subject who affirmatively opts in again is permitted.
Without it the fix would be a permanent shadow-ban — a different defect wearing
this one's fix.

**Which writes may clear it — the full list (review F8).** "Every category
write" was the original rule, and it is too broad: clearing is only justified
for a write that IS an act of consent. The complete set of clearing paths, each
named rather than left to a grep:

| Clearing path | Act of consent? | Verdict |
|---|---|---|
| public `POST /public-consent/:orgId` | yes — the visitor themselves | clears |
| `formsConsentSink` | yes — a form the subject submitted | clears |
| preference centre + one-click unsubscribe (added by F4) | yes — the subject clicked | clears |
| `surface.record` (the `consent.record` workflow node) | **caller-asserted** | clears — see the residual below |
| `foldConsentOnMerge` (CRM contact merge) | **no** — operator bookkeeping | **does NOT clear** (`clearTombstone: false`) |

`foldConsentOnMerge` was the one that had to change. It cannot GRANT (it only
ever writes `false`), which is why this is narrower than CONS-1 — but the
tombstone is exactly the marker `isAllowed`'s NO-RECORD branch denies on, so
erasing it means a later record-less state falls back to the permissive policy
default. That contradicts the fold's own MOST-RESTRICTIVE-WINS rule: a
bookkeeping operation may narrow a permission, never widen one. The flag is
honoured on the CAS path AND on `mergeConsentCategories`'s
retries-exhausted fallthrough into `recordConsent` — otherwise the opt-out would
hold on the fast path and silently not hold under contention, which is the worst
shape of gap because the rare path is the one nobody exercises.

**The `surface.record` residual, stated not fixed.** The `consent.record`
workflow node takes a caller-supplied `subjectKey` and can clear-and-grant, so
any workflow or agent holding that node can un-erase a subject. It is left
clearing because a workflow recording consent on a subject's behalf is a real
capture path (a call-centre agent, a kiosk), and refusing it would be a gate
with no exit for that legitimate use. The control is therefore the NODE's
availability — node packs are allowlisted per ADR 0315 — not the write. Recorded
here so the next reader does not have to rediscover that this lane is broader
than the others.

**Lifecycle: the tombstone has none, deliberately (review F9).**
`consent:erasure-tombstone` has no age-out registration, no retention purger and
no subject eraser — the same position that made `consent:record` a finding
(CONS-18), so it must be justified rather than left to look like an oversight:

- **no age-out / no purger** — an objection does not expire. Art. 17(3) /
  Recital 65 is the same basis the row is retained under at all: the controller
  may keep the minimum needed to keep honouring the erasure. A TTL would
  silently restore the fail-open default on a schedule, which is precisely the
  defect D1 exists to close;
- **no eraser** — a subject eraser over this store would delete the record of
  the subject's own erasure, i.e. the erasure would undo itself. `crm:suppression`
  is the identical argument, already accepted in this repo;
- **it is not unbounded** — the row is one digest + one timestamp per erased
  subject, and tenant teardown removes it with everything else (the collection
  declares `tenantOf`), so the growth is bounded by erasure requests, not by
  traffic. That is what makes "no lifecycle" affordable here and not for
  `consent:record`.

### D2 — the legal hold moves out of the run lane and gates the destructive lanes enumerated below

> **CORRECTED 2026-08-19 (review F2).** This heading read "**gates every
> destructive lane**", and the code did not. Two lanes that destroy an ENTIRE
> TENANT — `DELETE /v1/host/openwop-app/account` (`routes/account.ts`) and the
> abandoned-anon-tenant teardown (`host/retentionSweepDaemon.ts`) — contained
> **zero** hold references and appeared nowhere in the table below, while both
> are strictly *more* destructive than the per-subject consent lane the table
> did list. The word "every" asserted a completeness the implementation did not
> have, which is worse than an admitted gap: a reader auditing the hold would
> have stopped at this heading. The heading now names what the table names, and
> the two lanes are gated (rows added below) — but the honest general claim is
> "**the lanes enumerated here**", not "every lane", because nothing in the
> build enforces that this list is exhaustive. The related "2 of 6 destructive
> lanes" figure in the PR body was likewise wrong in the denominator: the real
> population is at least the **nine** rows below, and a tenth (`purgeTenantKanban`
> and friends) is reachable only *through* the account lane, so it inherits that
> lane's gate rather than owning one.
>
> **What would make "every" true**, recorded as open work rather than claimed:
> a registration seam (every whole-tenant destroyer declares itself, the way
> `registerSubjectEraser` and `registerRetentionPurger` already do) plus a
> source-scanning gate over `deleteAllTenantData` / `purgeTenant*` call sites,
> in the shape of `test/subject-eraser-manifest.test.ts`. Today the census below
> is hand-kept, and a hand-kept census drifts — that is the honest residual.

The store moves from `host/runRetentionSweeper.ts` to a leaf module
`host/retentionHold.ts`. **Its old placement is the whole explanation for the
defect**: the other destructive lanes could not import it without a cycle, so
they never asked. `runRetentionSweeper.ts` re-exports the surface, so every
existing importer is unchanged.

| Lane | Posture | Why that posture |
|---|---|---|
| `eraseSubject` | THROW `RetentionHoldError` before any eraser runs | An operator is waiting. A `failed: 0` no-op would be indistinguishable from a clean erasure. |
| `deleteSubject` | assert FIRST, then record a governance DENY (`erasure_refused_legal_hold`) | Relying on the seam's throw alone leaves a D1 tombstone behind for a subject who was not erased — a partial fix inverting a safety property. |
| `purgeRetained` | skip + report `ok:false, error:'legal_hold:…'` | A background time sweep with nobody waiting. A bare `[]` would be indistinguishable from "no purgers registered". Same choice `runRetentionSweeper` already made (`skippedHold`). |
| `kvAgeOut` | resolve each ROW's tenant, skip held ones | Per-STORE global sweep with no tenant parameter — the reason the hold never reached it. |
| `runRetentionSweeper` | skip + count `skippedHold` | Pre-existing; the ONE lane that always had the gate, because the store lived inside it. |
| HTTP (`DELETE …/subjects/:subjectKey`, `DELETE …/users/:id`) | 409 `legal_hold` with `{ held, reason, since }` | A refusal the operator can act on. `/users` asserts it too because it destroys the profile BEFORE calling `eraseSubject`. |
| **`DELETE …/account`** (review F2) | 409 `legal_hold`, asserted after the ≥1-owner refusal and BEFORE the first mutation | Self-service, whole-tenant, irreversible, and a human is waiting — so it refuses out loud rather than skipping. See the spoliation note below. |
| **anon-tenant teardown** (review F2) | skip + log `anon_teardown_skipped_hold` | Whole-tenant, but a background sweep with **nobody** waiting. A throw would abort the batch and starve the unheld tenants queued behind a held one, so it takes `purgeRetained`'s posture, not the account lane's. |

**The spoliation argument, which is why F2 was not merely a missed lane.**
`retention-hold` is a `DurableCollection` that declares a `tenantOf`, so
`purgeTenantHostExt` deletes the hold's own row in the same pass that deletes
everything else. Ungated, both whole-tenant lanes destroyed *the evidence that
the hold ever existed* — self-service and untraceable on the account lane, and
with no operator in the loop at all on the teardown lane. Both tests therefore
assert the hold ROW survives the refusal, not just that the data does.

`kvAgeOut` reads holds from the **explicit `Storage` it is handed**
(`listHeldTenantsFrom`), not the ambient host-ext handle: the two diverge in the
seam's own tests, and a hold read that can throw either fails open (sweeping
under a hold) or freezes all size hygiene on a wiring detail. Its residual is
COUNTED, not hidden: a row with neither a `tenantId` field nor a
`${tenantId}:`-shaped id cannot be attributed, so it is swept and reported as
`heldUnresolved` at warn. Freezing every unattributable row across all
registrations for the duration of any one tenant's hold would turn a litigation
hold into unbounded growth in stores whose entire purpose is size hygiene.

**Scope, stated.** Placing and lifting a hold stays on the superadmin ops
surface. The compliance console gets a READ-ONLY `legalHold` on
`GET …/consent/orgs/:orgId/policy`, so it can state the block with the exit
named before the operator commits — it does not become a hold-management UI
(that is `CONS-UX-6`, still open).

### D3 — the public capture lane gets its own identity space

`POST /public-consent/:orgId` no longer accepts a caller-chosen `subjectKey`.
It MINTS an HMAC-signed `subjectToken` bound to the tenant, stores the record
under `visitor:<uuid>`, and returns the token; later writes and the read require
it.

**Why this does not fail closed on the only capture path the host ships.** A
gate with no exit is a defect. A visitor arriving with no token gets one minted
and handed back — strictly MORE usable than before, where the caller had to
invent a key. A supplied-but-invalid token is a 400, never a silent fresh mint:
silently minting would write a brand-new record while the caller believes they
updated theirs — a fabrication with a green status code. A body `subjectKey` is
likewise REFUSED with a message naming the replacement, not ignored.

The read answers a uniform 404 for anything that is not a valid token — a
distinct 400 would confirm which tokens are well-formed for this tenant, i.e. a
smaller oracle.

**What an operator loses, and where it comes back.** Keying consent by their own
visitor cookie so it lines up with CRM is no longer possible on this lane. That
join is `analytics:identity-link`'s job (ADR 0381), and it is what the DSAR
fan-out already expands over, so a `visitor:`-keyed record and a contact-keyed
one are still reached by one erasure.

**No expiry, deliberately.** An expired token would strand the visitor from their
OWN consent record and the next POST would mint a second, orphaning the first —
worse than a long-lived bearer credential whose entire authority is "read and
set my own consent categories".

### D4 — `mergeConsentCategories` is the default write path

Every category write that does not mean "replace this person's entire record"
goes through the CAS merge: the public POST, `formsConsentSink`,
`surface.record`, and — **added by review F4** — the two PUBLIC email lanes,
`features/email/routes.ts`'s ADR 0227 preference centre and
`engagementService.recordUnsubscribe`'s one-click unsubscribe.
`partialCategories()` keeps an unmentioned key ABSENT all the way in, so the
STORED value governs.

The merge gains `region` / `legalBasis` / `purposes` as additive inputs —
previously only the stored value survived, which is why the public lane kept
using the wholesale write.

> **CORRECTED 2026-08-19 (review F4).** CONS-3's census said "all three
> wholesale writers" and **missed two**, both public and unauthenticated. They
> were still in the hand-preserve-`analytics` AUDIT-5 shape this ADR describes
> as removed *as a class*, and because `recordConsent` builds the row from
> `input` alone, **clicking one-click unsubscribe destroyed the subject's
> stored `legalBasis`, `purposes` and `region`** — the Art. 6 lawful-basis
> evidence, i.e. exactly the three fields this decision extended the merge to
> preserve. The lesson is the census method, not the count: "three writers" was
> derived from the writers this ADR's author had already touched, so it could
> only ever re-find them. The re-derivation is
> `grep -rn 'recordConsent(' backend/typescript/src --include='*.ts'`, and it is
> the number that belongs in a claim about a class.
>
> **The trap the fix introduces, and how it is closed.** Under merge semantics a
> stored `marketing.email: true` OUTLIVES a bare `{ marketing: false }`, and
> `isAllowed` prefers the specific over the umbrella — an unsubscribe that does
> not unsubscribe. Replace-semantics hid that by dropping every specific. Both
> opt-out lanes therefore write `fullMarketingOptOut()`, which is DERIVED from
> `MARKETING_CHANNELS` so a channel added later is covered without anyone
> remembering the call site.
>
> **Whatsapp is deliberately asymmetric on the preference centre.** That page
> has no whatsapp control, so a PARTIAL opt-in must not mention it (the
> wholesale write dropped it, silently revoking a strict opt-in the subject
> never spoke to — CONS-3's shape running restrictive); an ALL-OFF submit is the
> subject speaking to the whole umbrella, so it turns every channel off. Both
> directions are test-pinned.
>
> **Second-order, recorded not fixed.** These two are now also
> tombstone-CLEARING paths (D1's symmetric half fires on every merge). The
> resurrection vector is closed today only because `deleteSubjectEngagement`
> deletes the tokens an erased subject's links carry — which does NOT hold on
> the `failed > 0` partial-erasure path. Tracked with D1's residuals below.

### D5 — nothing writes a raw subject identifier into the governance decision log

`isAllowed`'s denial row now uses `hashSubjectKey`, matching its sibling. This
sink is `audit_log`: no tenant column, no eraser, no purger, and explicitly
excluded from ADR 0284 tenant teardown — so a subject could be fully erased and
still be named in every denial row ever written.

Because fixing the one instance leaves the class open, and because BOTH ADR 0464
coverage tripwires are structurally blind here (their denominators are
`new DurableCollection` namespaces; this sink declares none),
`test/governance-decision-subject-pii.test.ts` scans every call site and
requires each `subject:` argument to be a hashing CALL or an explicit allowlist
entry.

## Consequences

- `consent:erasure-tombstone` is a new namespace. It carries no
  subject-identifier-shaped field, so it correctly does not enter the ADR 0464
  feature-store population.
- `OpenwopErrorCode` gains `legal_hold` (409). Host-extension only, same
  precedent as `approval_required`; it never touches the wire.
- The public consent contract changed. Measured before changing it: zero
  consumers repo-wide outside backend tests (the route is one of the 11
  built-but-unreachable compliance routes the UX assessment names).
- `GET …/consent/orgs/:orgId/policy` now returns `{ policy, legalHold? }`. The
  SPA client's return type changed with it.

### D6 — a never-imported eraser is a typed failure (WF-CONS-2)

`eraseSubject` reported `total: erasers.length` — a registration-order artifact
— against no expected set, so an eraser whose module was never imported was
indistinguishable from a clean fan-out. `host/subjectEraserManifest.ts` holds the
expected set, enforced in three layers because each closes a hole the others
structurally cannot see: a SOURCE pin (the manifest cannot drift from the call
sites), a BOOT pin (a real `createApp()`, the only layer that catches a store
present in source but never imported), and RUNTIME (`missing` counts into
`failed` and is named in `failedFeatures`). `registerSubjectEraser` refuses an
anonymous function, because `fn.name` is both the operator-facing label and the
manifest key.

### D7 — the ADR 0464 feature gate resolves row types across files (CONS-7)

`typeBodyIn` was same-file only, so a store whose row type lives in a sibling
`types.ts` — the repo's dominant convention — yielded an empty body, no signal,
and never entered the denominator. Measured 102 → 114 (ADDED 12, LOST 0); seven
of the twelve are new actor-attribution debt, `ACTOR_DEBT_CEILING` 16 → 23.

A false positive was caught by hand-verification and is why the number is 114
and not 105: `typeBodyIn` found `type CampaignStatus = 'draft' | …;` — a string
union with no body — and took the next `{` in the file, which was a different
interface's. Same-file that was one wrong body; a whole-tree index makes it a
wrong body everywhere, so it is fixed with a `;`-before-brace guard and pinned by
a NEGATIVE tripwire.

This is deliberately NOT a seventh signal, and NOT the structural cure. Adopting
the host gate's classify-everything model remains the right end state; its
measured cost is a classification for each of 327 distinct namespaces under
`src/features/**`, which is its own change.

## Still open (recorded, not attempted)

- The 11 built-but-unreachable compliance routes AS A GROUP — consent capture
  ×2, purpose-vocab ×4, legal hold ×3, portability export ×2. Building those
  surfaces is its own feature-sized batch. D2 and D3 make two of them reachable
  in the narrow sense that matters here (a hold is now visible to the operator;
  capture now has a usable contract), which is as far as this ADR goes.
- `CONS-8` / `WF-CONS-12` — there is no DSAR EXPORT at all. The hard half (the
  identity-key closure) is built.
- `CONS-11` — the resolver closure is one hop, not a fixed point.
- `CONS-16`'s `goal` residual — model-summarised text in a possibly multi-party
  conversation. The obvious cascade cannot be done safely from inside an eraser
  (the sibling conversation eraser REDACTS the fields the lookup would read, and
  eraser order is registration order); a `SubjectKeyResolver` would need
  conversationIds in the shared key set, which is the over-erasure hazard the
  identity-link namespace guard exists to stop. Stated and test-pinned in place.
- The seven actor-attribution debt entries D7 made visible. Each needs a
  re-attribution target its owning feature must choose.
- The ADR 0464 gate's mechanisms 7 (quoted-literal namespaces only) and 8 (PII
  in an untyped bag), both now NAMED in the gate rather than implied.
- `kvAgeOut`'s `heldUnresolved` class. The proper cure is a per-registration
  tenant extractor.
- The re-identification residual in D1.

## Implementation record

| Phase | What landed | Tests |
|---|---|---|
| P1 (`CONS-1`) | `consent:erasure-tombstone`, `isAllowed`'s `erased` branch, tombstone clear on re-consent, honest `basis` on the denial rows | `test/consent-erasure-tombstone.test.ts` (5) — 3 sabotage probes run |
| P2 (`CONS-4`, `CONS-UX-2`, `CONS-UX-4`) | `host/retentionHold.ts`, gates on all three lanes + both HTTP doors, `legalHold` on the policy read, confirm/receipt name what is KEPT (×4 locales), `variant="danger"` | `test/legal-hold-gates-erasure.test.ts` (7), `ConsentLegalHold.test.tsx` (5) — 7 sabotage probes run |
| P3 (`WF-CONS-14`) | `hashSubjectKey` on the denial row + the class gate | `test/governance-decision-subject-pii.test.ts` (3) — 2 sabotage probes run |
| P4 (`CONS-2`, `CONS-3`) | `publicSubjectToken.ts`, the token-scoped public lane, `partialCategories`, merge on all three write paths | `test/consent-public-forgery.test.ts` (10), widened `test/forms-email-consent-sink.test.ts` — 4 sabotage probes run |
| P5 (`WF-CONS-2`) | `subjectEraserManifest.ts`, the three enforcement layers, `applyGrant` into the host boot list | `test/subject-eraser-manifest.test.ts` (5) — 6 sabotage probes run |
| P6 (`CONS-6`, `CONS-16`) | `features/cdp/erasure.ts`; the intent-ledger eraser + its corrected exemption | `test/cdp-collected-event-erasure.test.ts` (3), `test/intent-ledger-erasure.test.ts` (6) — 10 sabotage probes run |
| P7 (`CONS-UX-1`, `CONS-UX-3`) | key kept on partial erasure, Retry-erasure control, org-scoped receipt, labelled + invalidated lookup, honest failed-read state | `ConsentLookupHonesty.test.tsx` (10) — 6 sabotage probes run, one of which found a defect in the test |
| P8 (`CONS-5`) | `dsarAuthz` (RBAC without the toggle) on both subject routes; the SPA panel survives the toggle | `test/consent-dsar-ungated.test.ts` (6) — 3 sabotage probes run |
| P9 (`CONS-7`) | cross-file row-type resolution + the string-union guard; 102 → 114; ceiling 16 → 23 | `test/subject-erasure-feature-stores.test.ts` (21) — 3 sabotage probes run |
| P10 (tail: `CONS-9`, `CONS-13`, `CONS-17`, `CONS-18`) | bounded tenant read; age-out returns counters + unconditional heartbeat; pack claim corrected + 1.0.1; subject-key bound | across the suites above — 3 sabotage probes run, one of which retargeted its test |
