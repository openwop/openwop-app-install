/**
 * ADR 0464 §Correction — the subject-erasure tripwire EXTENDED TO FEATURE PACKAGES.
 *
 * WHY THIS FILE EXISTS. `subject-erasure-coverage.test.ts` is the ADR 0464
 * structural cure, and it has one hard-coded root: `src/host`. A collection
 * declared under `src/features/**` is therefore STRUCTURALLY INVISIBLE to it —
 * it can never fail the classification assertion, and would in fact be rejected
 * as a stale entry if someone added it to a registry there.
 *
 * That blind spot has now cost something real. `walkthrough-progress` stores a
 * `userId` and shipped with NO eraser at all, while its own docblock claimed the
 * residue was "all reclaimed by account erasure" — true for TENANT deletion,
 * false for the per-subject DSAR case ADR 0464 exists for. It was found by an
 * adversarial `/grade-code` pass, which is precisely the "found after shipping"
 * outcome the ADR wrote the tripwire to prevent. Worse: `tutorial-progress` was
 * modelled on that store and had to SELF-POLICE, documenting in its own header
 * that the ratchet could not see it. When a module has to write "the build gate
 * cannot check me", the gate is the thing to fix.
 *
 * SCOPE — deliberately narrower than the host gate, and here is the honest reason.
 * `src/features/**` declares 312 DurableCollection namespaces, ~106 of which carry
 * some subject-shaped field (`createdBy`, `actor`, `ownerId`, …). Classifying all
 * 106 into ERASED / DEBT / EXEMPT is a real audit, and guessing at it would
 * produce exactly the false-coverage claim this ADR is about. So this gate binds
 * the UNAMBIGUOUS signal: a row type that declares `userId: string` is storing a
 * subject identifier, full stop. That is 11 stores today — small enough to audit
 * honestly, and it is the exact shape of the defect that got through.
 *
 * Widening to the other ~95 subject-shaped fields is genuine follow-on work, NOT
 * something this file quietly claims to have done.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FEATURES_ROOT = join(__dirname, '..', 'src', 'features');

/** Same matcher as the host gate (quoted-literal namespaces only). */
const STORE_RE = /new DurableCollection(?:<([\s\S]*?)>)?\s*\(\s*['"]([^'"]+)['"]/g;
/** The unambiguous subject signals this gate binds. `userId` was the original
 *  (ADR 0464 §Correction); `subjectKey` is the R3 CN-SP-8 widening — the
 *  consent lane's own identifier shape, which previously ESCAPED this gate
 *  entirely (a new subjectKey-keyed store was invisible to erasure coverage).
 *  Population at widening time: exactly one store (`consent:record`) — pinned
 *  below as the signal's non-vacuity tripwire. */
/**
 * EM-4a — WHY THESE ARE NOT `^\s*`-ANCHORED ANY MORE.
 *
 * Every signal below used to start `^\s*`, i.e. the field had to be the first
 * thing on its LINE. A one-line interface declaration therefore matched NOTHING,
 * and the gate reported the store clean — not covered, not debt, not exempt,
 * simply invisible. That is a FORMATTING dependency masquerading as a coverage
 * rule, and it hid stores holding raw email addresses:
 *
 *   interface SoftBounceCount { key: string; tenantId: string; email: string; … }
 *
 * `email:soft-bounce-count` (raw address in the row AND the key, no eraser, no
 * purger, no age-out) and `email:sendlog` were both invisible this way.
 * Mechanically verified before the change: `grep -E '^[[:space:]]*contactId\??:'
 * features/email/emailService.ts` → no output.
 *
 * MEASURED BEFORE WIDENING (the measure-first rule this file enforces on
 * itself). **OLD 94 → NEW 102: eight stores became visible, none was lost.**
 *
 *   assistant:commitment  assistant:decision  assistant:meeting
 *   assistant:stakeholder  commerce:cart  commerce:saved-pm
 *   email:sendlog  email:soft-bounce-count
 *
 * CORRECTED (review MEDIUM-1): the first version of this note said "92 → 96,
 * four newly-visible stores", in three places, and every figure was wrong — it
 * had been carried over from an earlier draft of the regex rather than
 * re-derived. RE-DERIVE IT, do not copy this number. The command that produced
 * the pair above (it needs the file's own enumeration, so it runs a temporary
 * copy of THIS file truncated at the first `describe(`, with `FIELD_START`
 * switched between the two forms, dumping `[...stores.keys()]`):
 *
 *   MEASURE_ANCHOR=old node node_modules/vitest/vitest.mjs run test/<copy>.test.ts
 *   MEASURE_ANCHOR=new node node_modules/vitest/vitest.mjs run test/<copy>.test.ts
 *   # then diff the two key dumps
 *
 * Of the eight: the two `email:*` are genuinely erased as of EM-3;
 * `commerce:saved-pm` was already covered by `deleteSavedPaymentMethodsForContact`;
 * `commerce:cart` was NOT covered and the widening would have manufactured a
 * FALSE clean bill for it (review HIGH-2) — closed by `deleteCartsForUser`
 * rather than papered over; the four `assistant:*` are genuinely uncovered and
 * are RECORDED_DEBT below.
 *
 * The boundary is `^` OR a `{`/`;`/`,` — the three characters a TS field
 * declaration can follow — so both layouts match and the signals stay anchored
 * to a field position rather than matching an arbitrary substring.
 */
const FIELD_START = String.raw`(?:^|[{;,])[ \t]*`;
/**
 * COS-1 — the userId signal was EXACT-MATCH while the email signal beside it has
 * always been suffix-tolerant (`\\w*(?:email|Email)`). That asymmetry was a
 * blind spot, not a policy: a row spelling its subject `approvedByUserId` /
 * `editedByUserId` / `ownerUserId` / `principalUserId` was invisible — not
 * covered, not debt, not exempt.
 *
 * `assistant:pending-action` is the store it hid, and it is the worst store in
 * the assistant feature: `draft` is a literal outbound message body, `payload.to`
 * and `recipientDiff` are raw addresses, and `approvedByUserId`/`editedByUserId`
 * are two `User.userId`s. It appeared on NO prior ledger and was named by the
 * assessment as "still invisible to the gate".
 *
 * MEASURED BEFORE BINDING (the measure-first rule this file enforces on itself),
 * with the two-run recipe in the `FIELD_START` docblock: population
 * **117 -> 121**, ADDED 4, LOST 0. By name:
 *   assistant:pending-action   (`approvedByUserId`) — COVERED by features/assistant/erasure.ts
 *   kicktodo-wearable-link     (`providerUserId`)   — COVERED (eraseWearableLinksForSubject),
 *                              but BOUND FOR THE WRONG FIELD — see the note below
 *   strategy:cadence           (`ownerUserId`)      — COVERED (eraseSubjectStrategy -> eraseCadenceSubject)
 *   insights:config            (`principalUserId`)  — NOT covered; recorded as debt below
 * Do not copy those figures; re-derive them.
 *
 * `kicktodo-wearable-link` IS BOUND COINCIDENTALLY, and saying so is the point.
 * The `USER_ID_FIELD` widening matched `providerUserId` — which
 * `wearableLinkService.ts` explicitly documents as "the provider's OWN account
 * id for this user — opaque to us, not our subject". The row's real subject
 * field is `ownerSubject`, a bare `ownerSubject: string` matching NONE of the
 * field patterns (`subjectKey` / `subjectId` / `managerSubjectId` / an email /
 * a `*userId` suffix), so the gate still does not bind it. There is no false
 * clean bill — `eraseWearableLinksForSubject` really does filter on
 * `ownerSubject` (`wearableLinkService.ts:112`), so the coverage is genuine —
 * but the gate holds this store for a reason that is not the reason, and a
 * rename of `providerUserId` would drop it out of the census with its coverage
 * unchanged. The durable cure is an `ownerSubject`-shaped pattern; that is a
 * WIDENING, and this file's own rule is that a widening is measured before/after
 * rather than smuggled into an unrelated change. Recorded here so the next
 * widener does not have to re-derive it.
 *
 * THREE SIGNAL CHANGES THE "ADDED 4, LOST 0" LINE DOES NOT SHOW. That figure is
 * true of the POPULATION (which stores are enumerated) and says nothing about
 * their CLASSIFICATION. The same widening silently reclassified three already-
 * enumerated stores from `actor` to `topic` — `crm:booking-link`,
 * `strategy:record` and `strategy:revision`, all on `ownerUserId`, all now
 * matching `USER_ID_FIELD`. MEASURED, by running `enumerateSubjectBearing
 * FeatureStores` under both regexes and diffing the whole map (not by reading
 * the three names off the diff and assuming they were all): narrow 117 / wide
 * 121, ADDED 4 / LOST 0, and EXACTLY three signal flips, all `actor -> topic`,
 * all the ones named. It is harmless and the direction is right: `topic`
 * WINS when a row carries both (the rule stated at `enumerateSubjectBearingFeature
 * Stores`), and it is the STRONGER claim, so moving toward it can only ask more
 * of a store, never less. All three carry erasers, so neither the debt ledger nor
 * the CONS-7 ceiling moves. Stated anyway, because a population count that holds
 * while classifications move underneath it is precisely the shape in which a
 * regression hides from an "ADDED n, LOST 0" summary.
 *
 * The three that read COVERED were each hand-verified against the eraser rather
 * than inferred from feature-directory `hasEraser` — the EM-4b lesson, where a
 * directory-level inference produced a FALSE clean bill for `commerce:cart`.
 * `eraseCadenceSubject` is called at `strategyService.ts eraseSubjectStrategy`
 * and `registerSubjectEraser(eraseWearableLinksForSubject)` is at
 * `wearableLinkService.ts` module scope; both are asserted by name below.
 */
const USER_ID_FIELD = new RegExp(`${FIELD_START}\\w*(?:userId|UserId)\\??:\\s*string`, 'm');
const SUBJECT_KEY_FIELD = new RegExp(`${FIELD_START}subjectKey\\??:\\s*string`, 'm');
/**
 * R3 (territories deferral) — the M2 class: `subjectId`/`managerSubjectId`
 * are subject identifiers by name, and stores using them were invisible to
 * this gate. Widening measured 12 declarations across 4 features before
 * binding (the measure-first rule).
 *
 * AGMEM-4 — THE NINTH BLIND MECHANISM, and it is the nastiest one yet: this
 * pattern bound every DECORATED spelling of "subject" (`subjectKey`, `subjectId`,
 * `managerSubjectId`) and **not the bare field name `subject`** — which is the
 * spelling the subject-memory / consent / dashboard lanes all standardised on
 * (`subjectMemory.ts` `MemorySubject`, `grantService.ts` `subject`,
 * `dashboardService.ts` `subject`). **The gate was blindest exactly where the app
 * is most subject-aware.** The store that exposed it, `memextract:grant`, keyed a
 * person's userId in the key AND in `subject` AND in `grantedBy`, had no eraser,
 * and entered NO denominator — not covered, not debt, not exempt — so a DSAR
 * erased the person's memory and left a live grant authorising future writes to it.
 *
 * MEASURED BEFORE BINDING with the two-run recipe in the `FIELD_START` docblock,
 * on the merged tree (2026-08-19): population **121 -> 129, ADDED 8, LOST 0**.
 * Do not copy these figures; re-derive them. By name, each HAND-VERIFIED against
 * the eraser rather than inferred from directory-level `hasEraser` (the EM-4b
 * lesson, where a directory inference produced a FALSE clean bill):
 *
 *   cms:localegrant          COVERED — cmsService.ts erases by `g.subject` and
 *                            re-attributes `g.updatedBy`
 *   dashboardlayout          COVERED — eraseDashboardSubject point-deletes all
 *   dashboardnote            COVERED — three by `${tenantId}:${subjectKey}`
 *   dashboardbriefing        COVERED —   ''
 *   kicktodo-cohort-seats    COVERED — eraseSubjectCohortData filters `s.subject`
 *   memextract:grant         COVERED — the AGMEM-4 eraser, landed in the commit
 *                            BEFORE this widening so the two are separable
 *   navigation-settings:config  NEWLY COVERED — it had no eraser and would have
 *                            become the 10th debt entry. A six-line point-delete
 *                            is cheaper and more honest than a ceiling raise, so
 *                            `eraseNavigationSettingsSubject` ships with this
 *                            widening rather than a RECORDED_DEBT line. The
 *                            TENANT layer is deliberately NOT erased (it is the
 *                            workspace's config, and deleting it on one member's
 *                            DSAR would reset every other member's menu).
 *   commerce:ucp-token       EXEMPT — its `subject` is `ucp:${clientId}`, a
 *                            MACHINE client principal, never a person
 *                            (`ucpClientStore.ts:102`). Recorded in
 *                            REVIEWED_EXEMPT rather than covered, because
 *                            manufacturing an eraser for a non-person subject is
 *                            the false-coverage shape in the other direction.
 *
 * ONE SIGNAL FLIP the "ADDED 8, LOST 0" line does not show — that figure is true
 * of the POPULATION and silent about CLASSIFICATION, which is precisely the shape
 * in which a regression hides from an ADDED/LOST summary. Measured by diffing the
 * whole map under both regexes, not by eyeballing the added names:
 * `email:template` flips `actor -> topic`. `topic` is the STRONGER claim and WINS
 * when a row carries both, so the move can only ask more of the store, never less;
 * it carries an eraser, so neither ledger nor ceiling moves.
 *
 * THAT FLIP IS A FALSE POSITIVE, and the ledger-neutrality above is not a reason
 * to leave it unsaid. `EmailTemplate.subject` (`emailService.ts:32`) is an email
 * SUBJECT LINE — a mail header — not a person. So of the NINE signal changes this
 * widening produces (8 added + 1 flip), TWO match a non-person `subject`:
 * `commerce:ucp-token` (a `ucp:${clientId}` machine principal, caught and routed
 * to REVIEWED_EXEMPT) and `email:template` (a mail header, ledger-neutral and
 * therefore invisible). **Precision is 7/9, not the 8/9 an ADDED/LOST-plus-one-
 * exemption reading implies.**
 *
 * The standing risk that number is here to name: `subject` is the most overloaded
 * identifier in the tree, and the two false positives were each caught by a
 * DIFFERENT accident — one by a hand-review that happened to open the store, one
 * by nothing at all. A future store with a mail-header `subject` inside a feature
 * directory that ALREADY erases would read COVERED off directory-level
 * `hasEraser` without any human ever opening it (the EM-4b shape). If you add a
 * bare-`subject` store, hand-verify what the field NAMES before trusting the
 * classification.
 *
 * NEITHER `DEBT_CEILING` NOR `PARTIAL_COVERAGE_CEILING` MOVES for this widening,
 * and that is a measured outcome rather than a goal: 6 of the 8 were already
 * covered, 1 is exempt, and the 1 that would have been debt is covered instead.
 */
const SUBJECT_ID_FIELD = new RegExp(`${FIELD_START}(?:subject|subjectId|managerSubjectId)\\??:\\s*string`, 'm');
/**
 * CRM-2 — the two signals that made a whole feature package invisible.
 *
 * `contactId` is a LIVE subject key in the ADR 0381 fan-out
 * (`analytics/identityLinkService` expands to it; `email/emailService` erases by
 * it), so a store keyed on it holds subject-linked data by construction — yet the
 * gate did not bind it, and CRM's eight PII-bearing collections were classified
 * by nobody. An email-shaped field is the other half: `crm:suppression` and
 * `crm:booking` key a real person's address and matched none of the id signals.
 *
 * MEASURED BEFORE BINDING (the measure-first rule): 23 stores across the two
 * signals, of which 9 already sit in eraser-registering features. The 5
 * genuinely-new debt entries are recorded below and the ceiling raised
 * deliberately — a widening that quietly re-classified other features' stores as
 * covered would be exactly the false-coverage claim this file exists to prevent.
 */
const CONTACT_ID_FIELD = new RegExp(`${FIELD_START}contactId\\??:\\s*string`, 'm');
const EMAIL_FIELD = new RegExp(`${FIELD_START}\\w*(?:email|Email)\\??:\\s*string`, 'm');

/**
 * ANL-3 — the ANALYTICS signal, and the third time in this loop that a whole
 * store family was invisible to this gate rather than classified by it.
 *
 * `analytics:event` is the app's largest PII-bearing append-only store: each row
 * carries `sessionKey` (which IS the consent `subjectKey`), `visitorHash` (the
 * ADR 0569 cookieless visitor identity), `clickIds` (gclid/fbclid/ttclid/
 * li_fat_id — cross-site ADVERTISING identifiers), `owx`, a full `referrer` URL,
 * a `path` that may carry a query string, and free-text `props`. It matched NONE
 * of the signals above (`subjectKey` is not `sessionKey`), so the gate reported
 * clean over it: not covered, not debt, not exempt. Its sibling
 * `analytics:identity-link` was visible only INCIDENTALLY, because it happens to
 * declare `contactId`.
 *
 * MEASURED BEFORE BINDING (the measure-first rule this file enforces on itself).
 * Population 93 → 94. The widening adds EXACTLY ONE store — `analytics:event` —
 * and it reads COVERED, because `features/analytics/analyticsService.ts` has
 * always registered a subject eraser. NO ledger and NO ceiling moves: both
 * `DEBT_CEILING` and `ACTOR_DEBT_CEILING` are untouched by this widening, which
 * is the arithmetic stated in place. (The eraser's REACH was separately too
 * narrow — see ANL-2 — but that is a defect in the eraser, not in this
 * classification, and fixing the gate first is what makes the fix visible here.)
 */
const ANALYTICS_SUBJECT_FIELD = new RegExp(`${FIELD_START}(?:sessionKey|visitorHash)\\??:\\s*string`, 'm');

/**
 * KB-3 — the ACTOR-ATTRIBUTION signal, and the reason this gate reported silence
 * over a whole feature family.
 *
 * Every signal above binds a field that NAMES A SUBJECT AS THE RECORD'S TOPIC.
 * Knowledge Base rows name a subject as the record's AUTHOR: they carry only
 * `createdBy`/`updatedBy`. So no KB namespace was ever enumerated — not classified
 * as covered, not classified as debt, not counted against the ceiling; the gate was
 * simply blind, and reported clean, over a feature that ingests uploaded PDFs and
 * Office docs, image OCR, audio transcripts, fetched URLs and scheduled Drive /
 * OneDrive folders.
 *
 * MEASURED BEFORE BINDING (the measure-first rule this file enforces on itself).
 * Population went 44 → 93 stores. Of the 49 the widening ADDS, 29 already sit in
 * eraser-registering features and read as covered; 20 do not. Two of those 20 are
 * KB's own (`kb:collection`, `kb:document`) and are COVERED by the eraser this
 * change ships. The remaining 18 are pre-existing, previously-invisible debt in
 * other features and are recorded below — see `ACTOR_ATTRIBUTED_DEBT`.
 *
 * WHY A SEPARATE LEDGER AND CEILING. This class asks a genuinely different
 * question from the ones above ("does a DSAR for X reach a record X AUTHORED?"
 * rather than "…a record ABOUT X?"), and the honest answer is usually
 * re-attribute rather than delete. Folding 18 entries into `DEBT_CEILING` would
 * have moved 9 → 27 and made a number that means "subject-identifier stores we owe
 * an eraser" mean two things at once. It is tracked separately, with its own
 * shrink-only ceiling, and the arithmetic is stated in place.
 */
/**
 * MPL-7 — the SEVENTH gate-blindness mechanism, and the widening that does NOT
 * close it.
 *
 * The actor signal bound exactly three NAMES — `createdBy`, `uploadedBy`,
 * `authorId` — so a store spelling its actor anything else was invisible: not
 * covered, not debt, not exempt. Marketplace/Commerce-Connect spell it `by`
 * (`commerce-connect:listing-tombstone`; the listing's nested `stateMeta.by`) and
 * `disabledBy` (`marketplace:pack-disable`).
 *
 * MEASURED BEFORE BINDING (the measure-first rule this file enforces on itself).
 * Population **102 → 105**, LOSING nothing. The three added, by name:
 *   commerce-connect:listing-tombstone   (`by`)
 *   commerce-connect:paid-listing        (nested `stateMeta: { by: string; … }`)
 *   marketplace:pack-disable             (`disabledBy`)
 * All three are COVERED by the erasers `features/{marketplace,commerce-connect}/
 * erasure.ts` ship with this change, so NEITHER ceiling rises. `marketplace:review`
 * — the one store of the thirteen that was already visible — LEAVES
 * `ACTOR_ATTRIBUTED_DEBT` because the work landed, and `ACTOR_DEBT_CEILING`
 * ratchets 16 → 15.
 *
 * Re-derive with the same two-run recipe the `FIELD_START` note describes,
 * switching this regex between the two forms. Do not copy the numbers above.
 *
 * ── THE STRUCTURAL FINDING, recorded because the widening is a TREADMILL ──────
 *
 * This is the SEVENTH signal, and the honest measurement is that it closes
 * **4 of the 13** marketplace/commerce-connect namespaces. The other NINE stay
 * invisible after it (`dispute`, `fee-config`, `order`, `order-by-intent`,
 * `order-by-seller`, `payout`, `seller`, `seller-by-account`, `webhook-event`) —
 * asserted by name in the MPL-7 case below, so the limit is a pinned fact rather
 * than a paragraph. Adding an eighth signal would not close them either: they
 * carry TENANT identifiers, and the question they raise ("is a personal
 * workspace's owner a subject?") is a classification decision, not a field name.
 *
 * The HOST gate (`subject-erasure-coverage.test.ts`) does not have this weakness
 * by construction: its denominator is EVERY `new DurableCollection` under
 * `src/host/**`, and the row body is evidence for the classification rather than
 * the trigger for being classified at all. Adopting that model here is the real
 * cure and it is NOT what this change does — measured cost, so the deferral is a
 * number and not a shrug:
 *
 *   # the denominator the host model would impose on this file — MULTI-LINE
 *   # aware (CONS-31, ADR 0657 D12). The form recorded here before was a
 *   # line-based `grep -o`, so a declaration written as
 *   # `new DurableCollection<T>(\n  'ns',` was invisible to it and it silently
 *   # UNDER-COUNTED (MEASURED 2026-09-11: 235 with the old one-liner, 329 with
 *   # this one — same tree). `perl -0777` slurps each file so the match may span
 *   # lines; macOS grep has no `-P`/`-z`, which is why it is not a grep.
 *   find src/features -name '*.ts' ! -name '*.test.ts' -print0 | xargs -0 perl -0777 -ne \
 *     "while (/new DurableCollection(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*'([^']+)'/g) { print \"\$1\n\" }" \
 *     | sort -u | wc -l
 *
 * MEASURED 2026-08-19: **327** namespaces, against 105 enumerated then.
 * RE-MEASURED 2026-09-11 (CONS-31, multi-line aware): **329** namespaces, against
 * **131** enumerated today (`stores.size`). Flipping the denominator means
 * classifying 198 further stores into ERASED / DEBT /
 * EXEMPT in one change — and this file's own scope note already says why that is
 * not a thing to do by inference: "guessing at it would produce exactly the
 * false-coverage claim this ADR is about." So the widening ships, the limit it
 * leaves is asserted rather than implied, and the denominator flip is named here
 * as the cure with its price attached.
 */
const CREATED_BY_FIELD = new RegExp(`${FIELD_START}(?:createdBy|uploadedBy|authorId|by|disabledBy)\\??:\\s*string`, 'm');

/**
 * Feature stores that declare `userId` and are COVERED — each registers an
 * ADR 0464 eraser in its own module (the self-policing pattern, which is what a
 * feature package must do until/unless the host gate absorbs them).
 * This map is documentation; the assertion re-derives coverage from source.
 */
const EXPECTED_COVERED = new Set([
  'consent:record', // ADR 0657 D1 — `consentSubjectEraser` (features/consent/erasure.ts); was REVIEWED_EXEMPT on a false no-recursion claim
  'tutorial-progress',
  'walkthrough-progress',
  'users:user',
  'users:canonical',
  'profiles:profile',
  // SCC-1 — moved out of ACTOR_ATTRIBUTED_DEBT: `eraseScheduledChatsSubject`
  // disables the schedule + tombstones `createdBy` (ordinal 207, ADR 0125).
  'schedchat:config',
  // ADR 0622 D6 (`ORGINV-8`) — moved out of RECORDED_DEBT: `eraseOrgInvitationsSubject`
  // (`features/orgs/invitationsService.ts`) deletes the recipient's row on an
  // email key AND scrubs/tombstones the inviter's `createdByName`/`createdBy`
  // on a userId key; the users feature's userId→email resolver makes the
  // email key reachable from the users erase route.
  'orgs:invite',
]);

/**
 * SHRINK-ONLY debt: audited, subject-bearing, no eraser yet. Each entry states
 * what is actually true today — never a coverage claim. A new entry here is a
 * promise to cover, and the ceiling below stops the list growing quietly.
 */
const RECORDED_DEBT = new Map<string, string>([
  ['connections:connection', 'OAuth connection rows carry the connecting userId alongside tokens. Erasure needs a decision the audit did not settle: whether to delete the connection (breaking a workspace-shared integration another member relies on) or re-attribute it. Reclaimed today only by tenant teardown.'],
  ['notifications:prefs', 'Per-user notification preferences. Safe to delete on erasure; simply has no eraser yet.'],
  ['settings:user-prefs', 'Per-user settings. Safe to delete on erasure; simply has no eraser yet.'],
  ['computer-use:session', 'FOUND BY the R3 subjectId widening (the territories-deferral M2 class): durable session rows carry applyContext.subjectId (the job-search subject whose campaign drove the session) + createdBy, with no TTL, no purger and no eraser. Erasure needs a decision: sessions are also audit evidence for automated submissions (ADR 0541), so redact-the-subject vs delete needs the computer-use owner. Until then reclaimed only by tenant teardown.'],
  // ── FOUND BY the CRM-2 contactId/email widening. Each was read individually; none
  //    is a coverage claim. They are recorded rather than covered because each needs
  //    a decision from its owning feature that this CRM change is not the place to make.
  ['campaign-journeys:enrollment', 'FOUND BY the CRM-2 contactId widening: an enrollment row keys `${tenantId}::${journeyId}::${contactId}` and is the ADR 0299 exclusivity-arbitration state. Deleting it on erasure would let a NEW enrollment of the same person into an exclusive group win arbitration it already lost; keeping it leaves the contactId. The right cure is to re-point on erasure the way it now re-points on merge, which needs the journeys owner. Reclaimed today only by tenant teardown.'],
  ['podcasts:show', 'FOUND BY the CRM-2 email widening: `ownerName`/`ownerEmail` are the RSS-required podcast owner contact, which is published in the feed itself. Erasure semantics are genuinely unclear (removing them breaks the feed the directories validate), so this needs the podcasts owner rather than a guess made here.'],
  ['production:vendor', 'FOUND BY the CRM-2 email widening: `contactEmail` is an EXTERNAL person\'s address on a vendor row (already declared PII by PROD2-M6). A vendor is an org business record like a CRM contact, so the cure is the same anonymize-do-not-delete shape crm/erasure.ts now uses — it just needs the production owner to confirm which fields are relationship vs person.'],
  // ── FOUND BY the COS-1 userId-suffix widening (see USER_ID_FIELD above).
  //    `insights:config` keys per-tenant suite config by `principalUserId` — the
  //    RFC 0048 opaque principal the suite is scoped to. Its own module states
  //    "DELIBERATELY no registerSubjectEraser … no declared PII", and that
  //    reasoning is about the TALENT SNAPSHOT (a run output, not persisted), not
  //    about this row: the config row IS durable and IS keyed to a person.
  //
  //    AND THE FIELD-LEVEL ANNOTATION IS OVERRIDDEN TOO, explicitly — rebutting
  //    only the module-level comment would leave the narrower claim standing and
  //    reading as unchallenged. `insightsSuiteService.ts` annotates the field
  //    itself: "The user the suite is scoped to (opaque principal id, RFC 0048 —
  //    not PII)". OPACITY IS NOT NON-IDENTIFIABILITY. An RFC 0048 principal id is
  //    opaque to a READER, but it is the stable, durable handle that identifies
  //    exactly one person to this system — which is why erasure keys on it. The
  //    same reasoning would exempt every `userId` in this census. The annotation
  //    is correct that the value carries no in-band personal data and should NOT
  //    join the global log-mask union; it is wrong that this puts the row outside
  //    a DSAR's reach. Both the module- and field-level notes are recorded as
  //    rebutted, so a later reader does not find one of them and stop. On
  //    that person's erasure the honest act is to re-point or delete the suite
  //    scoping, which changes who a scheduled weekly variance run acts as — an
  //    insights-suite owner's decision, not one an assistant change should make.
  //    Recorded rather than guessed at. Reclaimed today only by tenant teardown.
  ['insights:config', 'FOUND BY the COS-1 userId-suffix widening: `principalUserId` scopes the suite (and keys `weeklyScheduleJobId`), so erasing that person leaves a durable row naming them AND a scheduled job running as them. The module\'s existing "deliberately no eraser" note is about the talent SNAPSHOT (a run output), not this row. Delete-vs-re-point is the insights-suite owner\'s call. Reclaimed today only by tenant teardown.'],
]);

/**
 * REVIEWED EXEMPT — a technical justification, each carrying its reason. Most
 * are short-lived rows whose own TTL reclaims them, so a DSAR eraser would be
 * covering a window measured in minutes; `commerce:ucp-token` is exempt for a
 * different reason (its subject is not a person at all).
 */
const REVIEWED_EXEMPT = new Map<string, string>([
  ['commerce:ucp-token', 'FOUND BY the AGMEM-4 bare-`subject` widening. Its `subject` is a MACHINE client principal, not a person: `ucpClientStore.ts:102` writes `subject: `ucp:${c.clientId}``, minted from a registered UCP client id and never from a user session. A DSAR subject key can never equal it, so registering an eraser would add a code path that cannot fire while making the store READ as covered — the false-coverage shape in the other direction. The row is also short-lived (`expiresAt`). Revisit if a UCP token is ever minted on behalf of a named end user.'],
  ['connections:pendingAuth', 'Single-use OAuth handshake row: consumed (deleted) on the first callback, TTL-expired after 10 minutes otherwise. Never a durable record of the subject.'],
  ['voice-realtime-session', 'Ephemeral realtime-session registry with an explicit expiresAt + opportunistic per-tenant expiry sweep; rows are torn down with the session and reachable by the ADR 0284 tenant purge via its tenant extractor.'],
]);

/**
 * KB-3 — SHRINK-ONLY debt for the ACTOR-ATTRIBUTION class (`createdBy` /
 * `uploadedBy` / `authorId`). Every entry here was ALREADY debt; it was invisible.
 * None is a coverage claim, and none is a guess dressed as an audit: where the
 * erasure decision is genuinely the feature owner's to make, the entry says so
 * instead of inventing one.
 *
 * The shared fact behind most of them — stated once rather than paraphrased 18
 * times: the row is an ORG business record (a form definition, a funnel, a saved
 * brief, a share link) that a person happens to have authored, so the honest
 * erasure is RE-ATTRIBUTE, not delete, and re-attribution needs a target the
 * owning feature has to choose. Reclaimed today only by tenant teardown.
 */
const ACTOR_ATTRIBUTED_DEBT = new Map<string, string>([
  ['cad:mesh', 'A CAD mesh asset authored by a member. Deleting it on erasure would destroy the org\'s model; re-attribution needs the cad owner.'],
  ['campaign-brief:ad-angle', 'Saved campaign-brief artifact. Org marketing collateral authored by a member — re-attribute, do not delete.'],
  ['campaign-brief:hook', 'Saved campaign-brief artifact. Same shape as ad-angle.'],
  ['campaign-brief:targeting-pack', 'Saved campaign-brief artifact. Same shape as ad-angle.'],
  ['campaign-brief:voc-evidence', 'Saved voice-of-customer evidence. May quote THIRD-PARTY prose, which an id-keyed eraser cannot reach either way — recorded so that limit is visible, not implied.'],
  ['chatwidget:config', 'A public chat-widget configuration (`createdBy` + a minted token). The widget must keep working when its author leaves, so this is re-attribute-or-transfer, not delete.'],
  ['creative-briefs:render', 'A render job/output row carrying its requester. Short-lived in practice but has no TTL, so it is debt rather than exempt.'],
  ['creative-video:job', 'A video job row carrying its requester. Same shape as creative-briefs:render.'],
  ['devkey:record', 'An API KEY row (`createdBy` is also the visibility predicate — `listApiKeys` filters non-admins to their own). This one is NOT re-attribution: erasing the person should plausibly REVOKE the key, which is a security decision the developer-keys owner must make, not a default this widening should pick.'],
  ['discovery:collection', 'Merchandising collection authored by a member; org storefront config.'],
  ['discovery:merch-rule', 'Merchandising rule authored by a member; org storefront config.'],
  ['funnels:funnel', 'A funnel definition — org config authored by a member.'],
  // ── `knowledge-sync:source` WAS RECORDED HERE and is not any more, and the
  //    removal is the point rather than a tidy-up. ADR 0605 Tier 3 added
  //    `SyncSource.createdBy`, which made the store actor-attributed and visible
  //    to this gate for the first time; the first attempt at closing that wrote a
  //    debt line, and `ACTOR_DEBT_CEILING` refused it (22 -> 23). That refusal was
  //    CORRECT: a batch may not grow the ledger to pay for a field it introduced
  //    in the same batch, which is the one thing the ceiling exists to stop.
  //    Covered instead by `eraseKnowledgeSyncSubject` (ADR 0605 R2, `KSC-21`) —
  //    asserted below, decisions and residuals argued at the function itself.
  ['prompts:entry', 'A shared prompt-library entry authored by a member; org content.'],
  ['reco:placement', 'A recommendations placement — org storefront config authored by a member.'],
  // ── FOUND BY the CONS-7 cross-file type resolution (mechanism 6). Every one of
  //    these declares `createdBy: string` in a sibling `types.ts`, imported into
  //    the service — the repo's DOMINANT convention — so `typeBodyIn`'s
  //    same-file-only lookup returned an empty body and the census walked past
  //    them entirely. None was covered, debt, exempt, or counted against any
  //    ceiling. HAND-VERIFIED individually against the gate's own matcher before
  //    being recorded (a detector's zero is evidence about the detector until you
  //    check one), and all seven sit in features that register NO eraser.
  //    Recorded rather than covered for the reason this ledger always gives:
  //    the row is an ORG business record its author happens to have created, so
  //    the honest erasure is RE-ATTRIBUTE, and re-attribution needs a target the
  //    owning feature has to choose.
  ['advisory:board', 'FOUND BY the CONS-7 cross-file widening. `AdvisoryBoard.createdBy` (advisory-board/types.ts). The board is a tenant\'s simulation configuration — personas, turn policy, a `livingPersonaAck` right-of-publicity acknowledgement. Deleting it on erasure would destroy the org\'s configured board; the acknowledgement in particular is a COMPLIANCE record about a decision, which argues for re-attribute rather than delete. Needs the advisory-board owner. Reclaimed today only by tenant teardown.'],
  ['bi:metric', 'FOUND BY the CONS-7 cross-file widening. `MetricDef.createdBy` (bi/metricTypes.ts). A metric DEFINITION is org analytics config that dashboards and scheduled reports resolve by id; deleting it on erasure would break every consumer. Re-attribute, which needs the bi owner to choose a target.'],
  ['brand:brand', 'FOUND BY the CONS-7 cross-file widening. `Brand.createdBy` (brand/types.ts). A brand record is the tenant\'s identity config, referenced by campaigns, briefs and publishing. Delete is plainly wrong; re-attribution needs the brand owner.'],
  ['campaign-brief:brief', 'FOUND BY the CONS-7 cross-file widening. `CampaignBrief.createdBy` (campaign-brief/types.ts). Org marketing collateral — the same shape as the `campaign-brief:*` artifacts already on this list, which is itself the tell that the family was only PARTLY visible before.'],
  ['campaign-brief:persona', 'FOUND BY the CONS-7 cross-file widening. `Persona.createdBy` (campaign-brief/types.ts). An audience persona is org marketing config, not a person\'s own data (the persona DESCRIBES a market segment). Re-attribute.'],
  ['campaign-orchestration:campaign', 'FOUND BY the CONS-7 cross-file widening. `MarketingCampaign.createdBy` (campaign-orchestration/types.ts). A live campaign is org marketing state with sends, versions and journey enrollments hanging off it. Delete would be destructive well beyond the erased person; re-attribution needs the campaign-orchestration owner.'],
  ['creative-briefs:brief', 'FOUND BY the CONS-7 cross-file widening. `CreativeBrief.createdBy` (creative-briefs/types.ts). Same shape as campaign-brief: org creative collateral authored by a member.'],
]);

/** NO-GROWTH for the actor-attribution class, tracked separately from `DEBT_CEILING`
 *  so neither number means two things. ARITHMETIC, stated in place: the widened
 *  matcher went from 44 stores to 93. Of the 49 added, 29 already sit in
 *  eraser-registering features (covered); 20 do not. TWO of those 20 are KB's own
 *  (`kb:collection`, `kb:document`) and are covered by the eraser this change ships,
 *  which is the whole point of the widening. 20 - 2 = 18 recorded above.
 *
 *  LOWERED 18 → 17 (SHARE-2, 2026-08-18): `sharing:link` is REMOVED from the
 *  ledger because the work landed, not because the gate stopped seeing it —
 *  `features/sharing/sharingService.ts` now registers `eraseSubjectSharing`. That
 *  entry's own note asked the sharing owner to choose between revoking and
 *  re-attributing; the decision (REVOKE the departing minter's live links, THEN
 *  anonymize `createdBy`) is argued in full beside the registration. Debt shrinks
 *  when work lands.
 *
 *  LOWERED 17 → 16 (FORM-1 / ADR 0584, 2026-08-18): `forms:def` is REMOVED
 *  because `features/forms/erasure.ts` now registers an eraser, and this gate
 *  resolves coverage at MODULE level. That is exactly the accepted trade stated
 *  at `hasEraser` — and it is the one place where an accepted trade could read
 *  as a coverage claim, because the forms eraser deliberately does NOT touch
 *  `forms:def` (a form definition is a public page's config that must keep
 *  working when its author leaves; the honest cure is re-attribution, which
 *  needs a target). So the decision is asserted below against the eraser's own
 *  source rather than left to be inferred from this ledger's silence. */
/*  CONS-7 — 16 -> 23, and the arithmetic is stated because a raised ceiling is
 *  the easiest place in this file to hide a widening that made things worse.
 *
 *  MEASURED, both models, with the command below:
 *    same-file resolution (before) : 102
 *    cross-file resolution (after) : 114     ADDED 12, LOST 0
 *
 *  Of the 12 that became visible, FIVE read COVERED and are (`priority-matrix:list`,
 *  `priority-matrix:session`, `service-desk:legacy-none`, `strategy:revision`,
 *  `strategy:record`). The remaining SEVEN sit in features that register no
 *  eraser at all and are recorded above: 16 + 7 = 23.
 *
 *  NOT ONE of the seven is a store that was previously classified. They were
 *  INVISIBLE — which is strictly worse than debt, because debt is at least
 *  counted. The number went up because the gate can see more, not because
 *  coverage got worse.
 *
 *  A FALSE POSITIVE WAS CAUGHT AND REMOVED BEFORE THIS NUMBER WAS WRITTEN, and
 *  it is the reason the "hand-verify one instance" rule exists. The first
 *  cross-file run returned 105 with `campaign-orchestration:campaignversion`
 *  among the additions. Its row type declares only `actor: string`. The match
 *  came from `typeBodyIn` finding `type CampaignStatus = 'draft' | …;` — a
 *  string UNION with no body — and then taking the NEXT `{` in the file, which
 *  is `MarketingCampaign`'s body, which declares `createdBy`. Same-file that bug
 *  was one wrong body; a WHOLE-TREE index makes it a wrong body everywhere. The
 *  `;`-before-brace guard in `typeBodyIn` fixes it, and fixing it is what moved
 *  the honest figure from 105 to 114.
 */
/*  MERGE (MPL-7 × CONS-7, 2026-08-19): 23 -> 22. Two INDEPENDENT widenings of
 *  this gate landed in parallel and both are preserved here:
 *    • CONS-7 (origin/main) widened the DETECTOR — cross-file row-type
 *      resolution — raising the census 102 -> 114 and this ceiling 16 -> 23.
 *    • MPL-7 (this branch) widened the SIGNALS (`by`/`disabledBy`) and shipped
 *      `eraseMarketplaceSubject`, which COVERS `marketplace:review` and so
 *      removes exactly one entry from the ledger.
 *  22 = 23 - 1 and it was MEASURED after the merge, not computed from those two
 *  sentences: the merged run reports debt 22 and census 117 (= 114 + MPL-7's
 *  three, ADDED 3 / LOST 0). The two figures landing exactly where each side
 *  independently predicts is the evidence that the widenings are orthogonal and
 *  that neither swallowed the other. Had they disagreed, the right move would
 *  have been to re-derive from the enumerator rather than to pick a number that
 *  makes the suite green.
 *
 *  `marketplace:review`'s removal is coverage, not concealment: the decision
 *  (ANONYMIZE — the free-text `body` is the person's own words and goes; the
 *  RATING stays, because a pack's average is other people's information and an
 *  erasure request must not be a way to move a competitor's score) is argued in
 *  full beside the registration in `features/marketplace/erasure.ts`. */
/*  UNCHANGED at 22 (ADR 0605 R2 / `KSC-21`, 2026-08-24) — stated because a ceiling
 *  that does NOT move across a change which ADDED a store to the census is exactly
 *  as suspicious as one that does, and the reason it holds is the point.
 *
 *  ADR 0605 Tier 3 added `SyncSource.createdBy`, so `knowledge-sync:source` entered
 *  the ACTOR census for the first time — MEASURED with the two-run recipe in the
 *  `FIELD_START` docblock: population 129 -> 130, ADDED 1, LOST 0 — with no eraser
 *  reaching it. The first cut recorded it as debt, taking the ledger 22 -> 23, and
 *  THIS GATE REFUSED IT. That refusal was correct and is the behaviour to preserve:
 *  a batch may not raise this ceiling to pay for a field it introduced in the SAME
 *  batch, or the number stops meaning "debt we inherited" and starts meaning "debt
 *  we are willing to create" — the one thing a shrink-only ledger cannot survive.
 *
 *  So the store is COVERED instead (`eraseKnowledgeSyncSubject`, asserted in the
 *  `KSC-21` case below) and the ledger is back at 22. Ledger 22, ceiling 22,
 *  census +1.
 *
 *  SCC-1 (2026-08-27, ordinal 207): `schedchat:config` moved from this ledger to
 *  EXPECTED_COVERED — `eraseScheduledChatsSubject` now disables the schedule and
 *  tombstones `createdBy`. The ledger SHRINKS 22 -> 21, so the ceiling ratchets
 *  down with it (no slack left behind — a covered store must not leave room for a
 *  silent re-add). Ledger 21, ceiling 21. */
const ACTOR_DEBT_CEILING = 21;

/** NO-GROWTH: debt may only shrink. Raising this is a deliberate, reviewable act.
 *  RAISED 4→5 (2026-08-15, the R3 subjectId widening): the WIDENED matcher found
 *  `computer-use:session` — debt that already existed and was invisible; the
 *  entry above records it rather than the gate staying blind. The ceiling
 *  ratchets back down as entries are covered.
 *  RAISED 5→9 (CRM-2, the contactId/email widening): the widened matcher went
 *  from seeing 12 stores to 23. CRM's are COVERED by the eraser this change
 *  ships — including `crm:gmailsync`, which was debt and is now REMOVED from the
 *  list (debt shrinks when work lands) — and the 5 added are pre-existing,
 *  previously-invisible debt in other features, each read and recorded above.
 *  Widening a gate and then hiding what it finds would be the false-coverage
 *  claim this file exists to prevent, so the number moves and says why: 5 - 1 + 5.
 *
 *  LOWERED 9 → 8 (FORM-1 / ADR 0584): `forms:submission` is REMOVED because the
 *  work landed, not because the gate stopped seeing it. Its note asked the forms
 *  owner for a per-field decision; the decision (KEEP the row as the org's record
 *  of the enquiry, tombstone every ANSWER, drop the whole `meta` tracking bag) is
 *  argued in full beside the registration in `features/forms/erasure.ts`.
 *
 *  READ THAT LINE WITH `PARTIAL_COVERAGE` BELOW (ADR 0584 §Correction,
 *  FORM-ERASE-1). The arithmetic 9 → 8 is true of THIS ledger and was, on its
 *  own, an overstatement of what shipped: the entry it removed said in terms
 *  that "the free-text `values` map is the store that actually holds the PII",
 *  and the eraser reaches that map only for an EMAIL-SHAPED subject key. So the
 *  number of ACKNOWLEDGED gaps did not fall — one moved from "no eraser at all"
 *  to "an eraser with a named residual", which is real progress and is not the
 *  same as coverage. Recorded gaps across both ledgers: 8 + 1 = 9. */
/*  EM-4a — 8 → 12, and the arithmetic is stated because a raised ceiling is the
 *  easiest place in this file to hide a widening that made things worse. It did
 *  not: de-anchoring the signal regexes moved the enumerated population
 *  **94 → 102** (MEASURED — see the re-derivation command in the FIELD_START
 *  note above; the figures this comment first carried, "92 → 96", were wrong),
 *  LOSING nothing. Of the EIGHT stores that became visible, three —
 *  `email:sendlog`, `email:soft-bounce-count`, `commerce:saved-pm` — read
 *  COVERED and are; one, `commerce:cart`, read covered and was NOT (the gate
 *  resolves `hasEraser` at feature-DIRECTORY level, so a store in an
 *  already-erasing feature reads clean without its own eraser line — the trade
 *  stated at `hasEraser` below, and the first time it produced a FALSE clean
 *  bill). That one is closed with a real eraser (`deleteCartsForUser`), NOT
 *  recorded as debt: a false coverage claim is worse than the invisibility it
 *  replaced, and recording it here would ALSO have tripped the
 *  "a store that HAS an eraser is not also debt" gate below. The remaining four
 *  (`assistant:*`) are genuinely uncovered and are recorded above.
 *  NOT ONE of the four new debt entries is a store that was previously
 *  classified: they were INVISIBLE, which is strictly worse than debt, because
 *  debt is at least counted. The number went up because the gate can see more,
 *  not because coverage got worse. */
/*  COS-1 — 12 -> 9, and the arithmetic is stated because a ceiling edit is the
 *  easiest place in this file to hide a regression. It moves in BOTH directions
 *  at once and the two must not be netted silently:
 *    -4  the four `assistant:*` stores leave the ledger because the WORK LANDED
 *        (`features/assistant/erasure.ts` registers `eraseAssistantSubject`),
 *        not because the gate stopped seeing them. Each one's recorded note
 *        asked for "a decision the assistant owner must make"; the decisions are
 *        argued per store in that module's header and asserted below.
 *    +1  `insights:config`, found by the userId-suffix widening. It was
 *        INVISIBLE, which is strictly worse than debt, because debt is counted.
 *  12 - 4 + 1 = 9. MEASURED after the change, not computed from this sentence.
 */
/*  ADR 0622 D6 (`ORGINV-8`) — 9 -> 8: `orgs:invite` leaves the ledger because the
 *  WORK LANDED (`eraseOrgInvitationsSubject`, `features/orgs/invitationsService.ts`
 *  — both the recipient email key and the inviter `createdBy` key), not because
 *  the gate stopped seeing it. Reachability by a userId key comes from the users
 *  feature's new `SubjectKeyResolver` (userId -> email). MEASURED: 8 entries.
 */
const DEBT_CEILING = 8;

/**
 * ADR 0584 §Correction (FORM-ERASE-1) — PARTIAL COVERAGE: a store that DOES
 * have an eraser and still has a named, un-erased residual.
 *
 * This class had no home, and its absence is what let a ledger read as
 * "covered" over a store the eraser reaches on only one of its identity
 * spaces. `RECORDED_DEBT` cannot hold it — the "a store that HAS an eraser is
 * not also recorded as debt" gate below is correct and stays — and
 * `REVIEWED_EXEMPT` would be a lie in the other direction. So the third state
 * is named rather than rounded to one of the two that existed.
 *
 * The entry is only honest while the OWNING eraser states the same residual in
 * its own source (asserted below): a ledger line nobody maintaining the code
 * will ever read is how a stale claim survives a refactor.
 */
const PARTIAL_COVERAGE = new Map<string, string>([
  ['forms:submission', 'ADR 0584 §Correction. `features/forms/erasure.ts` reaches a submission by `contactId`, by `meta.sessionKey`, or by an exact case-folded match of the subject key against a submitted VALUE — the last ONLY when the key is email-shaped. A respondent to a form capturing name + phone and nothing else, who never became a CRM contact and whose page sent no session key, is reached by NONE of the three: the eraser logs `rows: 0` and, because a SubjectEraser returns void, the DSAR fan-out reports success over data still in `values`. Not closed by matching non-email keys against free text (that over-erases a stranger\'s row on a digit-string coincidence, and over-erasure is unrecoverable). The honest cure is a per-form declaration of the identity field — the `emailOptInField` precedent — which is a forms-owner decision.'],
  ['email:soft-bounce-count', 'EM-3 §RESIDUAL (review HIGH-3). `features/email/bounceWebhooks.ts` `deleteSubjectBounceCounts` erases this store — but ONLY for an EMAIL-shaped subject key, because the row id is `${tenantId}:${email}`. NO SHIPPED DSAR ENTRY POINT SUPPLIES ONE: `consent/consentService.ts` deleteSubject passes a contactId, `features/users/routes.ts` passes a userId, and the ADR 0381 identity expansion cannot bridge the gap because the only registered resolver (`crm/erasure.ts` resolveCrmSubjectKeys) is one-directional email/phone → contactId and returns [] otherwise. So on every entry point the product ships, the eraser is a no-op — the same residual SHAPE as forms:submission (an eraser that reaches only one of the identity spaces its subject can arrive in). The eraser\'s own docblock claimed the opposite; that claim is corrected in source, which is the condition this ledger enforces below. The cure is a contactId→email resolver — a CRM-owned identity-graph decision whose blast radius is every registered eraser, not an email-lane change.'],
]);
/** NO-GROWTH for partial coverage, tracked separately so it cannot be netted
 *  off against `DEBT_CEILING` (netting is how "8" would have read as progress
 *  it was not).
 *
 *  EM-3 — 1 → 2. This is a ceiling RAISE, which this file treats as the most
 *  suspicious edit in it, so the arithmetic: the new entry is
 *  `email:soft-bounce-count`, a store that was INVISIBLE to this gate before the
 *  EM-4a de-anchoring (one-line interface). It is not a store that moved from
 *  covered to partial, and it is not a residual that grew. The alternative was
 *  to let it read fully COVERED on the strength of an eraser that no shipped
 *  caller can reach — which is exactly the false-coverage claim the third state
 *  was invented to prevent. */
const PARTIAL_COVERAGE_CEILING = 2;

/**
 * CMNT-11 — NOT-ENUMERABLE: a subject-bearing store this gate's denominator
 * cannot see AT ALL.
 *
 * A FIFTH gate-blindness mechanism, and it differs in kind from the four on
 * record. Those were mis-CLASSIFICATIONS of stores the walk found: a row type
 * declaring none of the recognised subject field names; `^\s*`-anchored regexes
 * that cannot see a one-line interface; `hasEraser` resolving at
 * feature-DIRECTORY level; and a `hasEraser` regex that counted a COMMENTED-OUT
 * registration. This one is an ABSENCE: `enumerateSubjectBearingFeatureStores`
 * walks `src/features/**` for `new DurableCollection<…>`, so a store that is
 * neither a `DurableCollection` nor under `src/features/` never enters the
 * census — it is not covered, not debt, not exempt, and a clean report over it
 * reads exactly like a store with nothing to erase.
 *
 * Entries here are stores in that position. Each names the module that DOES
 * erase it; the assertion below reads that module and fails if the registration
 * is not really there, so this ledger cannot become a comfortable claim about
 * code that changed underneath it. It carries no ceiling because it is not a
 * debt list — every entry is COVERED, just invisibly so.
 *
 * CORRECTION 2026-08-19 (CONS-6) — THE LEDGER NOW HOLDS TWO REASONS, and the
 * name `NON_COLLECTION_STORES` is accurate for only the first.
 *
 *   (a) NOT A `DurableCollection` / not under the walked tree — the original
 *       reason, `storage:notifications`;
 *   (b) A `DurableCollection` under `src/features/` that the walk DOES visit and
 *       the matcher cannot BIND, because the subject identity lives inside an
 *       untyped `Record<string, unknown>` — the assessment's "mechanism 8".
 *       `cdp:collected-event` is the case: it TAGS ITS OWN PII AT INGEST, so the
 *       row says in writing that it holds PII, while its declared type carries
 *       no subject-identifier field of any shape. No widening of the signal set
 *       can ever reach it; only a hand-written eraser can.
 *
 * The ledger is shared rather than split because the CONTRACT is identical for
 * both — "the census cannot see this store, here is the module that erases it" —
 * and the three assertions below check exactly that contract. Splitting would
 * give two ledgers with one meaning, which is how a number comes to mean two
 * things (the DEBT_CEILING/ACTOR_DEBT_CEILING lesson, in reverse).
 */
const NON_COLLECTION_STORES = new Map<string, { eraser: string; why: string }>([
  ['storage:notifications', {
    eraser: 'src/host/notificationSubjectErasure.ts',
    why: 'CMNT-11. The notification inbox is a SQL table behind the `Storage` interface '
      + '(`insertNotification`/`listNotifications`), in `src/storage/`, so it is neither a '
      + '`DurableCollection` nor inside the walked tree. Rows name a subject in '
      + '`recipient_user_id`, `metadata.actorId` and `metadata.recipientId` — the comments '
      + 'emitter writes all three — and before this the ONLY reclamation was '
      + '`deleteAllTenantNotifications` ("used by account-delete"), tenant-level and never '
      + 'per-subject, so a DSAR erased the comment and left a notification naming its author. '
      + 'Fixed rather than migrated: moving a SQL-indexed, high-volume, cross-feature table '
      + 'onto the KV seam purely to be visible to this gate would be larger, riskier and worse '
      + 'to serve. RESIDUAL, stated: `title`/`message` are free text that may quote a THIRD '
      + 'PARTY, which no id-keyed eraser reaches — the same limit named for '
      + '`campaign-brief:voc-evidence`.',
  }],
  ['cdp:collected-event', {
    eraser: 'src/features/cdp/erasure.ts',
    why: 'CONS-6, reason (b) above. The app\'s raw first-party ingest store. Its row type is '
      + '`{ eventId; tenantId; eventType; payload: Record<string, unknown>; piiFields: string[]; at }` '
      + '— the subject identity lives INSIDE `payload`, so no field-name signal can ever bind '
      + 'it, and the census walks past it reporting nothing. Meanwhile `tagPiiFields` computes '
      + 'the payload\'s PII keys AT INGEST: this is the one store in the app that self-declares '
      + 'it holds PII, and `features/cdp/` registered ZERO erasers and zero resolvers. Its only '
      + 'lifecycle was a retention purger that is opt-in and default-off (triple-gated behind '
      + 'OPENWOP_RETENTION_SWEEP_ENABLED, listGovernedTenants() and a set window), so on a '
      + 'default install the rows were reachable by NOTHING. RESIDUALS, stated: the eraser '
      + 'matches only a payload field that is an identity field BY NAME or one the ingest '
      + 'itself flagged, and only on an EXACT case-folded value match — deliberately narrow, '
      + 'because matching a subject key against free text over-erases a stranger\'s row on a '
      + 'coincidence and over-erasure is unrecoverable (the forms:submission reasoning). And a '
      + 'DSAR keyed by a contactId does not expand to that person\'s email, because '
      + 'resolveCrmSubjectKeys is one-directional email/phone -> contactId (CONS-11).',
  }],
]);

/**
 * KB-3 (found while sabotage-proving the widening) — COMMENTS ARE NOT CODE.
 * `hasEraser` was a bare `/registerSubjectEraser\s*\(/` over the raw file, so
 * COMMENTING OUT a registration left the store reading as covered: the sabotage
 * probe that was supposed to turn this gate red came back green. Same family as
 * the repo's "ratchet gates count comments" lesson, in the gate whose whole job
 * is to notice a missing eraser. Stripped before every source probe below.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('__tests__')) out.push(p);
  }
  return out;
}

/**
 * CRM-2 — resolve ONE level of nested types (`signers: Signer[]`).
 * `crm:sign-request` holds `signers[].email`, so a body-only scan reported it as
 * carrying no subject signal at all. One level is deliberate: it is what the real
 * miss needed, and each further level widens the false-positive surface without a
 * measured case to justify it.
 *
 * CONS-7 — nested types resolve ACROSS FILES too, for the same reason the
 * top-level ones now do. Measured: without it the population is 104, with it 105
 * (`campaign-orchestration:campaignversion` needs it).
 */
function expandNestedTypes(src: string, body: string): string {
  let out = body;
  for (const m of body.matchAll(/:\s*([A-Z]\w*)(?:\[\])?\s*;/g)) {
    const nested = resolveTypeBody(src, m[1]!);
    if (nested) out += `\n${nested}`;
  }
  return out;
}

/**
 * CONS-7 — MECHANISM 6: `typeBodyIn` was SAME-FILE ONLY, and that is a blind
 * spot, not a limitation.
 *
 * The repo's dominant convention is row types in a sibling `types.ts`, imported
 * into the service. Such a store yielded an EMPTY body, therefore no signal,
 * therefore never entered the denominator — not covered, not debt, not exempt,
 * and not counted against any ceiling. That is strictly WORSE than debt, because
 * debt is at least counted, and it is the exact state the EM-4a note says this
 * widening programme exists to end.
 *
 * `resolveTypeBody` tries the declaring file first (unchanged, and it wins on a
 * name collision — a locally-declared type is the one the `new
 * DurableCollection<T>` at that site actually refers to), then a whole-tree index
 * of `interface`/`type` declarations under `src/features/**`.
 *
 * It also accepts the INLINE and INTERSECTION forms the old `:411` guard
 * rejected (`<{ key: string; … }>`, `CheckoutSession & { tenantId: string }`).
 * MEASURED SEPARATELY, and stated because a widening that finds nothing should
 * say so rather than be assumed to have helped: that half adds **ZERO** stores
 * today (105 either way). It is included because it closes the mechanism for the
 * next store, not because it found one.
 *
 * WHAT THIS DOES NOT FIX, named so the gate's remaining blindness is not implied
 * to be gone:
 *   - MECHANISM 7 — `STORE_RE` matches a QUOTED literal namespace only, so a
 *     template-literal or variable namespace is outside the denominator. (The
 *     host gate states the same and accepts it; this one now states it too.)
 *   - MECHANISM 8 — PII inside an untyped bag, which no field-name matcher can
 *     EVER bind. `cdp:collected-event` is the live case; it is covered by a
 *     hand-written eraser and recorded in `NON_COLLECTION_STORES`.
 * Both are why the STRUCTURAL cure remains the host gate's classify-everything
 * model (`subject-erasure-coverage.test.ts` classifies EVERY store and uses the
 * body only as a severity hint, so it has no invisible class). That is a
 * different, larger change — 327 distinct namespaces under `src/features/**`
 * would each need a classification — and this fix is deliberately the narrower
 * one: it does not add a SEVENTH SIGNAL, it makes the existing six actually see
 * the bodies they were written for.
 */
const CROSS_FILE_TYPE_INDEX: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const file of walk(FEATURES_ROOT)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\b(?:interface|type)\s+([A-Za-z_]\w*)/g)) {
      const body = typeBodyIn(src, m[1]!);
      if (body && !out.has(m[1]!)) out.set(m[1]!, body);
    }
  }
  return out;
})();

function resolveTypeBody(src: string, typeParam: string): string {
  const raw = typeParam.trim();
  if (!raw) return '';
  // An inline object literal IS its own body.
  if (/^\{[\s\S]*\}$/.test(raw)) return raw;
  // An intersection: resolve each member and concatenate.
  if (raw.includes('&')) {
    let out = '';
    for (const part of raw.split('&')) out += resolveTypeBody(src, part);
    return out;
  }
  const local = typeBodyIn(src, raw);
  if (local) return local; // same-file wins — it is what this call site refers to
  return CROSS_FILE_TYPE_INDEX.get(raw.replace(/<.*$/, '').trim()) ?? '';
}

/** The `{...}` body of `interface Name {` / `type Name = {` within one file. */
function typeBodyIn(src: string, typeName: string): string {
  const bare = typeName.replace(/<.*$/, '').trim();
  if (!/^[A-Za-z_]\w*$/.test(bare)) return '';
  const decl = new RegExp(`\\b(?:interface|type)\\s+${bare}\\b`).exec(src);
  if (!decl) return '';
  const open = src.indexOf('{', decl.index);
  if (open < 0) return '';
  // CONS-7 — the `{` must belong to THIS declaration.
  //
  // FOUND BY HAND-VERIFYING ONE OF THE STORES THE CROSS-FILE WIDENING ADDED,
  // which is the whole reason that rule exists. `type CampaignStatus = 'draft' |
  // 'active' | …;` is a string UNION with no body, so `indexOf('{')` ran past it
  // and returned the body of the NEXT interface in the file
  // (`MarketingCampaign`, which declares `createdBy`). That made
  // `campaign-orchestration:campaignversion` read as actor-attributed when its
  // own row type carries only `actor: string`, and the nested-type expansion
  // propagated the wrong body wherever `CampaignStatus` appeared.
  //
  // The bug predates this change — it was reachable same-file — but a WHOLE-TREE
  // index turns one wrong body into a wrong body everywhere, so it is fixed
  // here rather than inherited. A declaration that ends (`;`) before any brace
  // has no object body; say so instead of guessing.
  if (src.slice(decl.index, open).includes(';')) return '';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

interface FeatureStore { ns: string; file: string; hasEraser: boolean; signal: 'topic' | 'actor' }

/** Every feature-owned store whose ROW TYPE declares a subject-IDENTIFIER field
 *  (`userId`/`subjectKey`/`subjectId`/`contactId`/email — signal `topic`) or, since
 *  KB-3, an ACTOR-ATTRIBUTION field (`createdBy`/`uploadedBy`/`authorId` — signal
 *  `actor`). The two are classified against different ledgers below, because they
 *  ask different questions of erasure. `topic` WINS when a row carries both: the
 *  stronger claim is the one that must be answered. */
function enumerateSubjectBearingFeatureStores(): Map<string, FeatureStore> {
  const found = new Map<string, FeatureStore>();
  for (const file of walk(FEATURES_ROOT)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(STORE_RE)) {
      const ns = m[2]!;
      const body = expandNestedTypes(src, resolveTypeBody(src, m[1] ?? ''));
      const topic = USER_ID_FIELD.test(body) || SUBJECT_KEY_FIELD.test(body) || SUBJECT_ID_FIELD.test(body)
        || CONTACT_ID_FIELD.test(body) || EMAIL_FIELD.test(body) || ANALYTICS_SUBJECT_FIELD.test(body);
      const actor = CREATED_BY_FIELD.test(body);
      if (!topic && !actor) continue;
      if (found.has(ns)) continue;
      found.set(ns, {
        ns,
        file: file.slice(FEATURES_ROOT.length + 1).split('\\').join('/'),
        // Self-policing: the owning MODULE must register the eraser. R3 — the
        // check is now MODULE-level (any file in the same feature directory),
        // not same-file: entity/service splits (territories/entities/quota.ts
        // vs territories/erasure.ts) register the eraser beside the store's
        // feature, which is what "owning module" always meant. The trade —
        // a future store in an already-erasing feature reads covered without
        // its own eraser line — is accepted and stated here.
        hasEraser: /registerSubjectEraser\s*\(/.test(stripComments(src)) || featureRegistersEraser(file),
        signal: topic ? 'topic' : 'actor',
      });
    }
  }
  return found;
}

/** Feature dirs (first segment under src/features) with ANY registerSubjectEraser call. */
const ERASING_FEATURES: Set<string> = (() => {
  const out = new Set<string>();
  for (const file of walk(FEATURES_ROOT)) {
    if (/registerSubjectEraser\s*\(/.test(stripComments(readFileSync(file, 'utf8')))) {
      out.add(file.slice(FEATURES_ROOT.length + 1).split('/')[0]!.split('\\')[0]!);
    }
  }
  return out;
})();
function featureRegistersEraser(file: string): boolean {
  return ERASING_FEATURES.has(file.slice(FEATURES_ROOT.length + 1).split('/')[0]!.split('\\')[0]!);
}

const stores = enumerateSubjectBearingFeatureStores();

describe('ADR 0464 — feature-owned subject-bearing stores', () => {
  it('the enumeration is NON-VACUOUS (a broken walker would pass everything)', () => {
    // KB-3 raised the floor with the widening: 44 topic-signal stores + 49 added by
    // the actor signal. A floor below the pre-widening population would let the new
    // signal silently break and still pass.
    // ANL-3 raised it 90 → 94: MEASURED 93 before the analytics widening, 94 after
    // (exactly one store added — `analytics:event`).
    // EM-4a raised it 94 → 102 (review MEDIUM-1). Leaving it at 94 was the actual
    // defect, and it is MEASURED rather than argued: with `FIELD_START` reverted
    // to `^[ \t]*` — i.e. the ENTIRE de-anchoring undone, all eight newly-visible
    // stores invisible again — this assertion at 94 STILL PASSED. A floor that
    // survives the removal of the thing it exists to protect is decorative. (The
    // named tripwires below did catch that revert; the floor did not, and the
    // floor is what the widening's non-vacuity claim rested on.)
    // Re-derive with the two-run command in the `FIELD_START` docblock above.
    // CONS-7 raised it 102 -> 114 (cross-file row-type resolution, mechanism 6).
    // MEASURED, not argued (probe RUN, 2026-08-19): with `resolveTypeBody`
    // reverted to same-file-only — the entire widening undone — and this floor
    // left at 102, THIS ASSERTION STILL PASSED. The only check that reddened was
    // "registry entries are not stale", and only because the seven new debt
    // entries then name namespaces the census can no longer see. So a floor at
    // 102 is decorative with respect to this widening, exactly the way the 94
    // one was before EM-4a, and the named tripwires below are what actually
    // discriminate.
    //
    // RE-DERIVE both figures with the script below (it is the gate's own
    // enumerator, run twice; a bare count in a comment is not evidence):
    //
    //   cd backend/typescript && node -e "$(cat <<'X'
    //   const {readFileSync,readdirSync,statSync}=require('node:fs');
    //   const {join}=require('node:path');
    //   // copy STORE_RE / FIELD_START / the six signals / typeBodyIn /
    //   // expandNestedTypes / resolveTypeBody out of this file, then flip
    //   // resolveTypeBody's cross-file fallback on and off and print found.size
    //   X
    //   )"
    //
    // Simpler and exact: temporarily `return ''` from the
    // `CROSS_FILE_TYPE_INDEX.get(...)` line and re-run this file — the count in
    // the failure message IS the same-file population.
    // MERGE (MPL-7 × CONS-7): 114 -> 117. CONS-7's cross-file resolution took
    // this 102 -> 114; MPL-7's `by`/`disabledBy` actor signals add exactly three
    // more on top of it (ADDED 3, LOST 0), measured on the merged tree. Both
    // widenings are live below — the CONS-7 tripwires and the MPL-7 ones each
    // guard a different half, which is why neither set was collapsed into a
    // single representative.
    // COS-1: 117 -> 121. The userId-suffix widening adds exactly four
    // (ADDED 4, LOST 0), measured with the two-run recipe above. Note the
    // standing caveat this floor carries: a floor has TWICE failed to
    // discriminate a widening being reverted (94 at EM-4a, 102 at CONS-7). The
    // named tripwire below is what actually guards this one.
    // AGMEM-4: 121 -> 129. The bare-`subject` widening adds exactly eight
    // (ADDED 8, LOST 0, one classification flip), measured with the two-run
    // recipe above.
    //
    // THIS FLOOR SHIPPED AT 121 IN THE FIRST CUT OF THE WIDENING, AND THAT WAS
    // THE THIRD TIME. Review caught it; the probe is recorded here because a
    // claim is not evidence. MEASURED (probe RUN, 2026-08-19): with `subject|`
    // deleted from `SUBJECT_ID_FIELD` — the ENTIRE widening undone, population
    // back to 121 — and this floor left at 121, THIS ASSERTION STILL PASSED,
    // and so did all four tripwire blocks below. The ONLY check that reddened
    // was "registry entries are not stale", firing on `commerce:ucp-token`,
    // whose REVIEWED_EXEMPT entry was added for an unrelated reason and which
    // any future maintainer may delete (its `subject` is a machine principal) —
    // after which the widening would be COMPLETELY unguarded. Raising the floor
    // to 129 and naming the two tripwires below is what actually closes it;
    // re-run that probe before touching either.
    expect(stores.size).toBeGreaterThanOrEqual(129);
    // AGMEM-4 widening tripwires. Named individually because each exercises a
    // DIFFERENT half, and neither appeared in ANY assertion in the first cut —
    // they were named only in the docblock above, which no gate reads.
    //   `memextract:grant` is the store the widening FOUND, and the ninth blind
    // mechanism ADR 0587 is named for: it keyed a person's userId in the key AND
    // in `subject` AND in `grantedBy`, entered no denominator at all, and left a
    // live grant authorising future writes to memory a DSAR had just erased.
    expect(stores.has('memextract:grant'), 'the bare-`subject` signal — the ninth blind mechanism').toBe(true);
    expect(stores.get('memextract:grant')?.signal).toBe('topic');
    //   `navigation-settings:config` is the half that would otherwise have
    // become the 10th RECORDED_DEBT entry; `eraseNavigationSettingsSubject`
    // ships with the widening instead. If the signal stops seeing it, that
    // eraser becomes dead code and the gate reports silence over the store.
    expect(stores.has('navigation-settings:config'), 'the bare-`subject` signal — the store that got an eraser instead of a debt line').toBe(true);
    expect(stores.get('navigation-settings:config')?.signal).toBe('topic');
    // COS-1 widening tripwire — the store the widening FOUND, and the worst
    // store in the assistant feature (a literal outbound message body plus raw
    // recipient addresses). If the suffix-tolerant userId signal ever stops
    // seeing it, this gate goes back to reporting silence over it.
    expect(stores.has('assistant:pending-action'), 'the \\w*UserId signal').toBe(true);
    expect(stores.get('assistant:pending-action')?.signal).toBe('topic');

    // CONS-7 widening tripwires. Named individually because each exercises a
    // DIFFERENT half, and a single representative would let one half go blind:
    expect(stores.has('advisory:board'), 'cross-file type resolution (types.ts sibling)').toBe(true);
    expect(stores.has('campaign-orchestration:campaign'), 'cross-file type resolution').toBe(true);
    expect(stores.has('brand:brand'), 'cross-file type resolution').toBe(true);
    // …and the FALSE POSITIVE that must stay OUT: `CampaignVersion` declares
    // only `actor: string`. It read as actor-attributed because `typeBodyIn`
    // ran past a string-union declaration and grabbed the next interface's
    // body. If this flips true, that guard has regressed.
    expect(stores.has('campaign-orchestration:campaignversion'), 'the string-union false positive must stay out').toBe(false);
    // The two progress stores are the reason this gate exists — if the matcher
    // ever stops seeing them, every assertion below is silently hollow.
    expect(stores.has('tutorial-progress')).toBe(true);
    expect(stores.has('walkthrough-progress')).toBe(true);
    // CN-SP-8 widening tripwire — if the subjectKey signal ever stops seeing
    // the consent ledger, the widened half of this gate is silently hollow.
    expect(stores.has('consent:record')).toBe(true);
    // R3 subjectId-widening tripwire — the store the widening FOUND.
    expect(stores.has('computer-use:session')).toBe(true);

    // CRM-2 widening tripwires. Named individually because each exercises a
    // DIFFERENT half of the widening, and a single representative would let one
    // half go silently blind:
    expect(stores.has('cdp:contact-ident'), 'the contactId signal').toBe(true);
    expect(stores.has('crm:suppression'), 'the email signal').toBe(true);
    expect(stores.has('crm:sign-request'), 'the nested-type expansion (signers[].email)').toBe(true);

    // ANL-3 widening tripwire — the store the widening FOUND. If the sessionKey /
    // visitorHash signal ever stops seeing it, the gate goes back to reporting
    // silence over the app's largest PII-bearing append-only store.
    expect(stores.has('analytics:event'), 'the sessionKey/visitorHash signal').toBe(true);
    expect(stores.get('analytics:event')?.signal).toBe('topic');
  });

  it('ANL-3: the analytics family is CLASSIFIED, and the two stores this gate still cannot see are named', () => {
    // COVERED: `features/analytics` registers erasers in analyticsService.ts
    // (events) and identityLinkService.ts (session↔contact links).
    expect(stores.get('analytics:event')?.hasEraser, 'features/analytics must register a subject eraser').toBe(true);
    expect(stores.get('analytics:identity-link')?.hasEraser).toBe(true);
    // …and neither may be recorded as debt while covered (the debt would be a lie).
    expect(RECORDED_DEBT.has('analytics:event')).toBe(false);
    expect(ACTOR_ATTRIBUTED_DEBT.has('analytics:event')).toBe(false);

    // BLIND SPOTS, stated rather than implied — the `kb:veccache`/`kb:docrev`
    // precedent. Both carry NO subject-identifier field of any shape, so no
    // widening of this gate can see them and it must not be read as proving
    // their coverage:
    //  - `analytics:visitor-salt` holds `{ day, salt, mintedAt }`. It stores no
    //    subject data at all — but it is the RE-IDENTIFICATION KEY for every
    //    `visitorHash`, so its lifecycle matters more than an eraser would. It
    //    is reclaimed by the ANL-1 `registerKvAgeOut` registration (a bounded
    //    TTL that runs without beacon traffic), asserted in
    //    `analytics-visitor-identity.test.ts`, not here.
    //  - `analytics:nav-counts` is counts-only BY CONSTRUCTION (ADR 0512):
    //    (tenant, ISO week, source, route PATTERN) → count. No id, no session,
    //    no timestamp finer than a week — a per-subject trail never exists to
    //    erase. Reclaimed by tenant teardown via the JSON tenantId probe.
    expect(stores.has('analytics:visitor-salt'), 'still invisible — see the comment above').toBe(false);
    expect(stores.has('analytics:nav-counts'), 'still invisible — see the comment above').toBe(false);
    const saltSrc = readFileSync(join(FEATURES_ROOT, 'analytics', 'visitorIdentity.ts'), 'utf8');
    expect(
      /registerKvAgeOut\s*\(/.test(stripComments(saltSrc)),
      'the salt must be bounded by the age-out lane, since no eraser can reach it',
    ).toBe(true);
  });

  it('ANL-3: features/analytics declares its PII fields (the classification seam, not only the erasure seam)', async () => {
    // The compounding half of ANL-3: the store was undeclared to
    // `declarePiiFields` as well as invisible to this gate, so `classificationOf`
    // read it as plain `internal` while it holds advertising identifiers.
    //
    // ANL-3 R2 — asserted through the REGISTRY, not a source grep. The grep this
    // replaces looped over field names and tested `/'visitorHash'/` against the
    // file, which `stripComments` leaves matching the `Pick<>` at
    // `analyticsService.ts:240` — so that iteration passed on an occurrence that
    // has nothing to do with the declaration. A name-in-file test cannot see a
    // declaration at all.
    const { isPiiField, classificationOf } = await import('../src/host/dataClassification.js');
    await import('../src/features/analytics/analyticsService.js'); // module-scope declaration
    for (const field of ['visitorHash', 'clickIds', 'referrer', 'path', 'props', 'owx', 'sessionKey']) {
      expect(isPiiField('analytics.event', field), `${field} must be declared PII on analytics.event`).toBe(true);
    }
    expect(classificationOf('analytics.event')).toBe('confidential-pii');
  });

  it('ANL-3 R2: the declaration SPLIT holds — the generic names stay out of the app-wide log-mask union', async () => {
    // The split (`{ maskGloballyByFieldName: false }` on the second call) was
    // correct and completely UNPINNED: deleting that option leaves every
    // assertion above green while `path` joins the entity-agnostic union and
    // rewrites live operational log keys — `byok/encryption.ts` (the master-key
    // FILE path), `routes/mcp.ts` and `chat-widget/publicGateway.ts` (`req.path`
    // as an enumeration signal) — to `pii_<sha>`, making those logs actively
    // misleading. Same tripwire shape as the CSM `owner` precedent
    // (`csm-privacy-and-concurrency.test.ts`).
    const { isPiiField, isKnownPiiFieldName } = await import('../src/host/dataClassification.js');
    await import('../src/features/analytics/analyticsService.js');
    for (const generic of ['path', 'referrer', 'props', 'sessionKey']) {
      expect(
        isKnownPiiFieldName(generic),
        `\`${generic}\` must stay OUT of the entity-agnostic union — it would mask unrelated log keys app-wide`,
      ).toBe(false);
      // …while the entity-AWARE query still sees it, which is the whole point of
      // the split (erasure / retention / export / masked reads are unaffected).
      expect(isPiiField('analytics.event', generic)).toBe(true);
    }
    // Non-vacuity: the DISTINCTIVE names ARE globally masked, so this is not
    // asserting that the union is simply empty.
    for (const distinctive of ['visitorHash', 'clickIds', 'owx']) {
      expect(isKnownPiiFieldName(distinctive), `${distinctive} is distinctive — global masking is correct for it`).toBe(true);
    }
  });

  it('the CRM stores CRM-2 covers are seen as covered, and the ones it deliberately does not are named', () => {
    // The eraser anonymizes rather than deletes, and `crm:suppression` KEEPS the
    // address on purpose — it is the key that honours the refusal, so deleting it
    // would make the erased person mailable again. That is a real decision, and a
    // ratchet that reported "covered" without it ever being stated would hide it.
    for (const ns of ['crm:contact', 'cdp:contact-ident', 'crm:booking', 'crm:sign-request', 'crm:suppression', 'crm:gmailsync']) {
      expect(stores.get(ns)?.hasEraser, `${ns} must be reached by features/crm/erasure.ts`).toBe(true);
    }
    const erasureSrc = readFileSync(join(FEATURES_ROOT, 'crm', 'erasure.ts'), 'utf8');
    expect(
      /crm:suppression/.test(erasureSrc) && /honours the refusal|honour the refusal/.test(erasureSrc),
      'the suppression retention decision must be stated in the eraser, not implied by its absence',
    ).toBe(true);
  });

  it('the two stores this gate STILL cannot see are named, and the eraser reaches them anyway', () => {
    // Honesty about what the widening does NOT discriminate. `crm:signature-record`
    // carries only `typedName`, and `crm:merge-event` carries `filledFields` (a
    // `Record<string,string>` whose VALUES are emails) plus `absorbedIdentifiers`
    // (a type imported from another file, which the one-level in-file expansion
    // cannot resolve). Both hold real PII, both are covered by the eraser, and
    // NEITHER matches any signal this gate binds — so the gate must not be read as
    // proving their coverage. Asserted as a blind spot rather than left unsaid,
    // because an unstated blind spot is how CRM's whole package went unnoticed.
    expect(stores.has('crm:signature-record'), 'still invisible — see the comment above').toBe(false);
    expect(stores.has('crm:merge-event'), 'still invisible — see the comment above').toBe(false);
    const erasureSrc = readFileSync(join(FEATURES_ROOT, 'crm', 'erasure.ts'), 'utf8');
    expect(/crm:signature-record/.test(erasureSrc)).toBe(true);
    expect(/crm:merge-event/.test(erasureSrc)).toBe(true);
  });

  it('FORM-1: the forms eraser covers the respondent store, and the store it does NOT erase is named', () => {
    // `forms:submission` is the app's highest-volume store of PUBLIC-VISITOR PII
    // and had no eraser at all. It is covered now — and `forms:def` reads as
    // covered too, purely because this gate resolves coverage at MODULE level.
    // That inference is only honest while the eraser SAYS it leaves definitions
    // alone and why, so assert the sentence rather than the silence.
    expect(stores.get('forms:submission')?.hasEraser, 'features/forms must register a subject eraser').toBe(true);
    expect(RECORDED_DEBT.has('forms:submission'), 'covered — the debt entry would now be a lie').toBe(false);
    expect(ACTOR_ATTRIBUTED_DEBT.has('forms:def')).toBe(false);
    const src = readFileSync(join(FEATURES_ROOT, 'forms', 'erasure.ts'), 'utf8');
    expect(
      /forms:def/.test(src) && /RE-ATTRIBUTE/.test(src),
      'the forms:def non-erasure decision must be stated in the eraser, not implied by its absence from the ledger',
    ).toBe(true);
    // …and the anonymize-don't-delete choice must be visible too: an eraser that
    // quietly DELETED the row would destroy the org's record of its own intake.
    expect(/ANONYMIZE, DO NOT DELETE/.test(src)).toBe(true);
    // ADR 0584 §Correction (FORM-ERASE-1) — and the RESIDUAL. Removing this
    // store from RECORDED_DEBT dropped a note that correctly said the free-text
    // `values` map "is the store that actually holds the PII", while the eraser
    // reaches that map only for an EMAIL-SHAPED key. Coverage at MODULE level
    // is not coverage of every identity space, and the difference has to be
    // written down somewhere a maintainer reads.
    expect(PARTIAL_COVERAGE.has('forms:submission'), 'the un-erased residual must stay recorded, not be implied by coverage').toBe(true);
    expect(/RESIDUAL/.test(src), 'the eraser itself must name the residual').toBe(true);
    expect(/emailShaped/.test(src), 'and the mechanism that produces it').toBe(true);
  });

  it('EM-4b: commerce:cart is covered by a REAL eraser, not by feature-directory inference (review HIGH-2)', () => {
    // The de-anchoring made this store VISIBLE, and visible-plus-directory-level
    // `hasEraser` made it read COVERED — over a store nothing erased. That is a
    // false clean bill on a DSAR, which is strictly worse than the invisibility
    // it replaced, so this asserts the eraser EXISTS and is WIRED, not that a
    // sibling file somewhere in features/commerce registers something.
    expect(stores.has('commerce:cart'), 'the de-anchored signal must still see the one-line `interface Cart`').toBe(true);
    expect(RECORDED_DEBT.has('commerce:cart')).toBe(false);
    expect(PARTIAL_COVERAGE.has('commerce:cart')).toBe(false);
    const svc = readFileSync(join(FEATURES_ROOT, 'commerce', 'commerceService.ts'), 'utf8');
    const feat = readFileSync(join(FEATURES_ROOT, 'commerce', 'feature.ts'), 'utf8');
    expect(/export async function deleteCartsForUser/.test(svc), 'the cart eraser must exist').toBe(true);
    // WIRING, not just mechanism (the repo's mechanism-vs-wiring lesson): the
    // registered eraser must actually CALL it. A helper nobody invokes is the
    // same no-op the ledger was hiding.
    expect(
      /registerSubjectEraser\([\s\S]*?deleteCartsForUser\(/.test(stripComments(feat)),
      'eraseCommerce must call deleteCartsForUser — an unreferenced helper erases nothing',
    ).toBe(true);
    // …and it must delete rather than anonymize, stated in source.
    expect(/DELETE, not anonymize/.test(svc)).toBe(true);
  });

  it('EM-3: the soft-bounce eraser NAMES its residual, and the false resolver claim is gone (review HIGH-3)', () => {
    const src = readFileSync(join(FEATURES_ROOT, 'email', 'bounceWebhooks.ts'), 'utf8');
    expect(PARTIAL_COVERAGE.has('email:soft-bounce-count')).toBe(true);
    expect(RECORDED_DEBT.has('email:soft-bounce-count'), 'it HAS an eraser — debt would be the wrong state').toBe(false);
    expect(/RESIDUAL/.test(src), 'the eraser itself must name the residual').toBe(true);
    // The specific falsehood being ratcheted against: the docblock claimed a
    // contactId "reaches this store through CRM's email↔contactId resolver".
    // `resolveCrmSubjectKeys` only maps email/phone → contactId, so no such
    // resolver exists in the direction claimed. Assert the CLAIM is gone rather
    // than that some prose is present — a sentence can be reworded and stay false.
    expect(
      /reaches this store through CRM's email↔contactId resolver/.test(src),
      'the false resolver claim must not come back',
    ).toBe(false);
    // And the source must state the reason it is a no-op today, so a maintainer
    // reading only the eraser is not misled the way the ledger was.
    expect(/resolveCrmSubjectKeys/.test(src), 'name the resolver whose direction is the problem').toBe(true);
    expect(/ONE-DIRECTIONAL/.test(src)).toBe(true);
  });

  it('FORM-ERASE-1: PARTIAL_COVERAGE is a real third state — every entry has an eraser AND states its residual in that eraser', () => {
    // The two halves that keep this ledger from becoming decorative. Without the
    // first, an entry here is just debt wearing a softer word; without the
    // second, the claim lives only in a test file nobody edits when the eraser
    // changes — which is exactly how the ledger came to overstate coverage.
    const noEraser: string[] = [];
    for (const ns of PARTIAL_COVERAGE.keys()) {
      if (!stores.get(ns)?.hasEraser) noEraser.push(ns);
    }
    expect(
      noEraser,
      'PARTIAL_COVERAGE is for a store an eraser REACHES but does not fully cover. With no eraser it is RECORDED_DEBT.',
    ).toEqual([]);
    expect(
      PARTIAL_COVERAGE.size,
      `Partial-coverage residuals may only SHRINK (ceiling ${PARTIAL_COVERAGE_CEILING}). Close a residual instead of recording another.`,
    ).toBeLessThanOrEqual(PARTIAL_COVERAGE_CEILING);
    // No namespace is classified twice across ALL FOUR ledgers.
    expect([...PARTIAL_COVERAGE.keys()].filter((ns) => RECORDED_DEBT.has(ns) || REVIEWED_EXEMPT.has(ns) || ACTOR_ATTRIBUTED_DEBT.has(ns))).toEqual([]);
  });

  it('CMNT-11: every NOT-ENUMERABLE store names an eraser module that really registers one', () => {
    // The whole point of this ledger is that the gate's own denominator cannot
    // check these stores, so the entry is the ONLY link between the claim and
    // the code. Two things keep it from being decorative: the named module must
    // exist, and it must actually call `registerSubjectEraser` — read with
    // comments STRIPPED, because KB-3 proved a commented-out registration reads
    // as covered otherwise. It must also not be in the census at all: if the
    // walk ever DOES see it, this entry is the wrong ledger.
    expect(NON_COLLECTION_STORES.size, 'an empty ledger would make every assertion below vacuous').toBeGreaterThan(0);
    for (const [ns, { eraser }] of NON_COLLECTION_STORES) {
      const path = join(FEATURES_ROOT, '..', '..', eraser);
      expect(existsSync(path), `${ns}: named eraser module ${eraser} does not exist`).toBe(true);
      const src = stripComments(readFileSync(path, 'utf8'));
      expect(/registerSubjectEraser\s*\(/.test(src), `${ns}: ${eraser} does not register a SubjectEraser`).toBe(true);
      expect(stores.has(ns), `${ns}: the census CAN see this store — classify it in the ordinary ledgers, not here`).toBe(false);
    }
  });

  it('every subject-bearing feature store (userId OR subjectKey) is CLASSIFIED (covered, debt, or exempt)', () => {
    const unclassified: string[] = [];
    for (const [ns, s] of stores) {
      if (s.signal !== 'topic') continue;
      if (s.hasEraser || RECORDED_DEBT.has(ns) || REVIEWED_EXEMPT.has(ns)) continue;
      unclassified.push(`${ns} (${s.file})`);
    }
    expect(
      unclassified,
      'These feature-owned stores record a `userId` and are outside the ADR 0464 seam. '
      + 'Register a SubjectEraser in the owning module, or classify the namespace as '
      + 'RECORDED_DEBT / REVIEWED_EXEMPT with a reason that is actually true.',
    ).toEqual([]);
  });

  it('KB-3: every ACTOR-ATTRIBUTED store is CLASSIFIED too (the class that was invisible)', () => {
    const unclassified: string[] = [];
    for (const [ns, s] of stores) {
      if (s.signal !== 'actor') continue;
      if (s.hasEraser || ACTOR_ATTRIBUTED_DEBT.has(ns) || REVIEWED_EXEMPT.has(ns)) continue;
      unclassified.push(`${ns} (${s.file})`);
    }
    expect(
      unclassified,
      'These feature-owned stores record the AUTHORING subject (createdBy / uploadedBy / authorId) '
      + 'and no eraser in the owning feature reaches them. Register a SubjectEraser, or record the '
      + 'namespace in ACTOR_ATTRIBUTED_DEBT with a reason that is actually true — including WHOSE '
      + 'decision is missing when the right answer is re-attribute / revoke / delete.',
    ).toEqual([]);
  });

  it('KB-3: the widening SEES the KB family, and the eraser this change ships COVERS it', () => {
    // The tripwire for the whole widening. If either half stops holding, the gate has
    // gone back to reporting silence over a store that ingests customer documents.
    expect(stores.has('kb:document'), 'the createdBy signal must enumerate KB').toBe(true);
    expect(stores.has('kb:collection')).toBe(true);
    expect(stores.get('kb:document')?.signal).toBe('actor');
    expect(stores.get('kb:document')?.hasEraser, 'features/kb must register a subject eraser').toBe(true);
    expect(stores.get('kb:collection')?.hasEraser).toBe(true);
    // …and KB must NOT be recorded as debt while it is covered (the debt would be a lie).
    expect(ACTOR_ATTRIBUTED_DEBT.has('kb:document')).toBe(false);
    expect(ACTOR_ATTRIBUTED_DEBT.has('kb:collection')).toBe(false);
    // BLIND SPOT, stated: `kb:veccache` and `kb:docrev` carry no subject field at all
    // (they are keyed derivatives — a vector and a content hash), so this gate cannot
    // see them and must not be read as proving their coverage. The eraser reaches them
    // by CASCADE through deleteDocument, and the retention purger reclaims orphans.
    expect(stores.has('kb:veccache'), 'still invisible — see the comment above').toBe(false);
    expect(stores.has('kb:docrev'), 'still invisible — see the comment above').toBe(false);
    const kbSrc = readFileSync(join(FEATURES_ROOT, 'kb', 'kbService.ts'), 'utf8');
    expect(/registerRetentionPurger\s*\(/.test(kbSrc), 'and the retention seam, not only the eraser').toBe(true);
  });

  it('KSC-21: knowledge-sync:source is COVERED — the store a NEW field made visible, closed by an eraser rather than a ceiling raise', () => {
    // ADR 0605 Tier 3 added `SyncSource.createdBy` (the confused-deputy guard), so
    // this store entered the actor census for the first time WITH NO ERASER. The
    // first cut recorded it in `ACTOR_ATTRIBUTED_DEBT`, which took the ledger 22 ->
    // 23 and this gate refused it. NO CEILING MOVES for this change and that is
    // measured, not asserted: the store leaves the ledger by being covered, so
    // `ACTOR_ATTRIBUTED_DEBT` is back at 22 against an unchanged ceiling of 22.
    expect(stores.has('knowledge-sync:source'), 'the createdBy signal must enumerate the sync-source store').toBe(true);
    expect(stores.get('knowledge-sync:source')?.signal).toBe('actor');
    expect(stores.get('knowledge-sync:source')?.hasEraser, 'features/knowledge-sync must register a subject eraser').toBe(true);
    expect(ACTOR_ATTRIBUTED_DEBT.has('knowledge-sync:source'), 'covered — the debt entry would now be a lie').toBe(false);
    expect(RECORDED_DEBT.has('knowledge-sync:source')).toBe(false);

    // COVERAGE IS RESOLVED AT FEATURE-DIRECTORY LEVEL (the `commerce:cart` false
    // clean bill), so assert the eraser's REACH and its DECISIONS from source
    // rather than inferring them from a sibling file registering something.
    const svc = stripComments(readFileSync(join(FEATURES_ROOT, 'knowledge-sync', 'knowledgeSyncService.ts'), 'utf8'));
    expect(/export async function eraseKnowledgeSyncSubject/.test(svc), 'the eraser must exist').toBe(true);
    // DISABLE, not delete and not re-attribute — the decision, stated where a
    // maintainer reads it. A future pass that "simplified" this into a row delete
    // would silently stop an org's folder sync on one member's DSAR.
    const svcRaw = readFileSync(join(FEATURES_ROOT, 'knowledge-sync', 'knowledgeSyncService.ts'), 'utf8');
    expect(/RE-ATTRIBUTE is wrong/.test(svcRaw), 'the eraser must say why re-attribution is not the answer here').toBe(true);
    expect(/DELETE is wrong/.test(svcRaw), 'and why deleting the source is not either').toBe(true);
    expect(/Deletion becomes a grant/i.test(svcRaw), 'and why the FIELD is tombstoned rather than removed').toBe(true);
    // The tombstone, not `undefined` — deleting `createdBy` returns the row to the
    // LEGACY shape, which `runKnowledgeSyncOnce`'s guard skips entirely, re-opening
    // the `KSC-2` deputy hole the field exists to close.
    expect(/createdBy:\s*ERASED_CREATOR/.test(svc), 'the eraser must TOMBSTONE createdBy').toBe(true);
    expect(/delete\s+next\.createdBy|createdBy:\s*undefined/.test(svc), 'it must not DELETE the field').toBe(false);
    // BLIND SPOT, stated: the diff cursor carries no subject field of any shape, so
    // this gate cannot see it and must not be read as proving its coverage.
    expect(stores.has('knowledge-sync:filestate'), 'still invisible — see the eraser docblock').toBe(false);
    expect(/knowledge-sync:filestate|filestate/.test(svcRaw), 'the eraser must name the store it does NOT touch').toBe(true);

    // WIRING, not just mechanism (the repo's mechanism-vs-wiring lesson): an eraser
    // whose module is never imported contributes to NEITHER `total` nor `failed`.
    const feat = stripComments(readFileSync(join(FEATURES_ROOT, 'knowledge-sync', 'feature.ts'), 'utf8'));
    expect(/registerSubjectEraser\(\s*eraseKnowledgeSyncSubject\s*\)/.test(feat), 'the feature must register the eraser').toBe(true);
    const manifest = readFileSync(join(FEATURES_ROOT, '..', 'host', 'subjectEraserManifest.ts'), 'utf8');
    expect(/'eraseKnowledgeSyncSubject'/.test(manifest), 'and the expected-eraser manifest must know its name').toBe(true);
  });

  it('MPL-7: the `by`/`disabledBy` widening SEES the marketplace family, and the erasers COVER it', () => {
    // The tripwire for the whole widening. If any half stops holding, the gate
    // goes back to reporting silence over a feature that moves real money.
    for (const [ns, why] of [
      ['commerce-connect:listing-tombstone', 'the bare `by` signal — the row was reachable by NO eraser, NO purger and NO tenant teardown'],
      ['commerce-connect:paid-listing', 'the NESTED `stateMeta: { by: string }` signal'],
      ['marketplace:pack-disable', 'the `disabledBy` signal'],
      ['marketplace:review', 'already visible via `authorId` — the ONE of thirteen that was'],
    ] as const) {
      expect(stores.has(ns), why).toBe(true);
      expect(stores.get(ns)?.signal).toBe('actor');
      expect(stores.get(ns)?.hasEraser, `${ns} must be reached by its feature's erasure module`).toBe(true);
      // …and none may sit in a debt ledger while covered (the debt would be a lie).
      expect(ACTOR_ATTRIBUTED_DEBT.has(ns), `${ns} is covered — the debt entry would now be false`).toBe(false);
      expect(RECORDED_DEBT.has(ns)).toBe(false);
    }

    // COVERAGE IS RESOLVED AT FEATURE-DIRECTORY LEVEL, so registering one eraser
    // in `features/commerce-connect` makes ALL ELEVEN of its namespaces read
    // covered. That inference is only honest while the eraser SAYS which stores
    // it deliberately leaves alone and why — the `forms:def` precedent. Assert the
    // sentences, not their absence.
    const ccSrc = readFileSync(join(FEATURES_ROOT, 'commerce-connect', 'erasure.ts'), 'utf8');
    expect(/DELIBERATELY DOES NOT ERASE/.test(ccSrc)).toBe(true);
    expect(/statutory retention|Statutory retention/.test(ccSrc), 'name WHY the money-truth stores are exempt').toBe(true);
    for (const ns of ['order', 'payout', 'dispute', 'seller', 'fee-config']) {
      expect(new RegExp(`\\b${ns}\\b`).test(ccSrc), `the eraser must name \`${ns}\` among the stores it does not touch`).toBe(true);
    }
    // The anonymize-don't-delete choice must be visible too: deleting the
    // tombstone would clear a 90-day enforcement cooldown, and dropping
    // `stateMeta` reads as absent-⇒-active and RELEASES an operator hold.
    expect(/NEVER DELETE THE ROW/.test(ccSrc)).toBe(true);
    const mktSrc = readFileSync(join(FEATURES_ROOT, 'marketplace', 'erasure.ts'), 'utf8');
    expect(/ANONYMIZE, DO NOT DELETE/.test(mktSrc)).toBe(true);
    expect(/RESIDUAL/.test(mktSrc), 'the eraser must name the identity spaces it cannot reach').toBe(true);
  });

  it('MPL-7: the widening closes 4 of 13 — the NINE it does not reach are named, not implied', () => {
    // THE POINT OF THIS CASE. A widening that quietly left nine stores of the same
    // feature invisible, while the ledger read clean, would be the false-coverage
    // claim this whole file exists to prevent. So the limit is a PINNED FACT.
    //
    // These nine carry TENANT identifiers (`tenantId`, `sellerTenantId`,
    // `buyerTenantId`, `stripeAccountId`), not subject identifiers. No eighth
    // NAME closes them: the open question is a classification decision — is the
    // owner of a personal `user:` workspace a "subject" for these rows? — and the
    // answer this feature gives is no: they are financial records reclaimed by
    // TENANT teardown, argued in `commerce-connect/erasure.ts`.
    //
    // The structural cure is the HOST gate's model (classify every namespace; use
    // the body as evidence, not as the trigger). Its measured price is in the
    // `CREATED_BY_FIELD` docblock: 329 feature namespaces against 131 enumerated
    // (re-measured 2026-09-11 with the multi-line-aware command, CONS-31).
    const STILL_INVISIBLE = [
      'commerce-connect:dispute', 'commerce-connect:fee-config', 'commerce-connect:order',
      'commerce-connect:order-by-intent', 'commerce-connect:order-by-seller',
      'commerce-connect:payout', 'commerce-connect:seller',
      'commerce-connect:seller-by-account', 'commerce-connect:webhook-event',
    ];
    const unexpectedlyVisible = STILL_INVISIBLE.filter((ns) => stores.has(ns));
    expect(
      unexpectedlyVisible,
      'A store here became visible to the gate. That is GOOD — classify it in a ledger and remove it from this list.',
    ).toEqual([]);
    // Non-vacuity: the list is not simply nine names that never existed. Every one
    // of them IS a declared namespace in the feature, just not an enumerated one.
    const declared = readFileSync(join(FEATURES_ROOT, 'commerce-connect', 'stores.ts'), 'utf8');
    for (const ns of STILL_INVISIBLE) {
      expect(declared.includes(`'${ns}'`), `${ns} must be a real declaration, or this list is decorative`).toBe(true);
    }
    // …and the eraser that cannot reach them must say so, which is the only place
    // a maintainer would ever read it.
    const ccSrc = readFileSync(join(FEATURES_ROOT, 'commerce-connect', 'erasure.ts'), 'utf8');
    expect(/keyed by TENANT, not by subject/.test(ccSrc)).toBe(true);
  });

  it('COS-1: the assistant family is COVERED, its per-store decisions are stated, and the stores this gate STILL cannot see are named', () => {
    // The five namespaces the gate CAN see must all read covered, and none may
    // sit in a debt ledger while covered (the debt would be a lie).
    for (const ns of ['assistant:commitment', 'assistant:decision', 'assistant:meeting', 'assistant:stakeholder', 'assistant:pending-action']) {
      expect(stores.get(ns)?.hasEraser, `${ns} must be reached by features/assistant/erasure.ts`).toBe(true);
      expect(RECORDED_DEBT.has(ns), `${ns} is covered — the debt entry would now be false`).toBe(false);
      expect(ACTOR_ATTRIBUTED_DEBT.has(ns)).toBe(false);
    }

    // BLIND SPOTS, stated rather than implied — and this is the honest answer to
    // "does the fix make the stores visible to the gate, or merely add erasers
    // it cannot count?" FIVE of eight are now counted. THREE are not, and no
    // widening of a field NAME can reach them: `Project` declares no subject
    // field of any shape, and `CommitmentIndexRow` is `{ixId, commitmentId}`.
    // They read as covered ONLY by feature-directory inference, which is exactly
    // the mechanism that produced a false clean bill for `commerce:cart` — so
    // the eraser must SAY it leaves them alone and why, and that sentence is
    // asserted rather than the ledger's silence.
    for (const ns of ['assistant:project', 'assistant:commitment:by-tenant', 'assistant:commitment:by-status']) {
      expect(stores.has(ns), `${ns}: still invisible to this gate — see the comment above`).toBe(false);
    }
    const src = readFileSync(join(FEATURES_ROOT, 'assistant', 'erasure.ts'), 'utf8');
    expect(/DELIBERATELY NOT ERASED/.test(src), 'the non-erasure decisions must be stated in the eraser').toBe(true);
    expect(/assistant:project/.test(src)).toBe(true);
    expect(/assistant:commitment:by-tenant/.test(src)).toBe(true);

    // The per-store SPLIT is the substance of this change, so each of the three
    // different answers is pinned to the eraser's own source. A future pass that
    // "simplified" them into one delete-everything sweep would destroy the org's
    // decision log and strand a live kanban card.
    expect(/DELETE THE ROW/.test(src), 'stakeholder: delete, because the row IS the person').toBe(true);
    expect(/REDACT `decidedBy`, KEEP `statement`/.test(src), 'decision: who vs what').toBe(true);
    expect(/REMOVE THE ELEMENT/.test(src), 'meeting: element-level, not row-level').toBe(true);
    expect(/CANCEL it/.test(src), 'pending-action: the cancel is the load-bearing half').toBe(true);
    // …and the residual an id-keyed eraser genuinely cannot reach.
    expect(/RESIDUAL 1 — RE-INGESTION/.test(src), 'the eraser must name what it cannot reach').toBe(true);

    // WIRING, not just mechanism (the repo's mechanism-vs-wiring lesson): the
    // feature must actually register it, and the manifest must expect it — an
    // eraser whose module is never imported contributes to NEITHER `total` nor
    // `failed`, which is the WF-CONS-2 silent-under-erasure state.
    const feat = stripComments(readFileSync(join(FEATURES_ROOT, 'assistant', 'feature.ts'), 'utf8'));
    expect(/registerSubjectEraser\(\s*eraseAssistantSubject\s*\)/.test(feat), 'the feature must register the eraser').toBe(true);
    const manifest = readFileSync(join(FEATURES_ROOT, '..', 'host', 'subjectEraserManifest.ts'), 'utf8');
    expect(/'eraseAssistantSubject'/.test(manifest), 'and the expected-eraser manifest must know its name').toBe(true);
  });

  it('COS-1: the three stores the userId-suffix widening ALSO exposed are each really covered, not directory-inferred', () => {
    // EM-4b's lesson applied to this widening: a store that becomes visible
    // inside an already-erasing feature reads COVERED for free. Assert the
    // actual reach for the two that are not this change's own, so the widening
    // cannot manufacture a clean bill.
    expect(stores.get('strategy:cadence')?.hasEraser).toBe(true);
    const strat = stripComments(readFileSync(join(FEATURES_ROOT, 'strategy', 'strategyService.ts'), 'utf8'));
    expect(/eraseCadenceSubject\(/.test(strat), 'eraseSubjectStrategy must actually call the cadence eraser').toBe(true);

    expect(stores.get('kicktodo-wearable-link')?.hasEraser).toBe(true);
    const wear = stripComments(readFileSync(join(FEATURES_ROOT, 'kicktodo-integrations', 'wearableLinkService.ts'), 'utf8'));
    expect(/registerSubjectEraser\(\s*eraseWearableLinksForSubject\s*\)/.test(wear)).toBe(true);

    // …and the one that is NOT covered is recorded rather than rounded to covered.
    expect(RECORDED_DEBT.has('insights:config')).toBe(true);
    expect(stores.get('insights:config')?.hasEraser, 'features/insights-suite registers no eraser').toBe(false);
  });

  it('KB-3: a COMMENTED-OUT eraser does not count as coverage (the probe that came back green)', () => {
    // Found while sabotage-proving the widening: the raw-source probe matched the
    // registration inside a comment, so disabling an eraser left its stores reading
    // as covered. One assertion per half so neither can hide the other.
    const commented = '// registerSubjectEraser(async (t, s) => {});';
    expect(/registerSubjectEraser\s*\(/.test(commented), 'un-stripped, the comment DOES match').toBe(true);
    expect(/registerSubjectEraser\s*\(/.test(stripComments(commented))).toBe(false);
    expect(/registerSubjectEraser\s*\(/.test(stripComments('registerSubjectEraser(fn);')), 'real code still matches').toBe(true);
  });

  it('KB-3: actor-attribution debt is shrink-only, and never contradicts an eraser', () => {
    expect(
      ACTOR_ATTRIBUTED_DEBT.size,
      `Actor-attribution debt may only SHRINK (ceiling ${ACTOR_DEBT_CEILING}). Cover a store instead of recording another.`,
    ).toBeLessThanOrEqual(ACTOR_DEBT_CEILING);
    const contradictory = [...ACTOR_ATTRIBUTED_DEBT.keys()].filter((ns) => stores.get(ns)?.hasEraser);
    expect(contradictory, 'This store now registers an eraser — remove it from ACTOR_ATTRIBUTED_DEBT.').toEqual([]);
    const stale = [...ACTOR_ATTRIBUTED_DEBT.keys()].filter((ns) => !stores.has(ns));
    expect(stale, 'Recorded namespace no longer found in src/features/** — remove the entry.').toEqual([]);
    // No namespace may sit in both debt ledgers (which claim is live?).
    expect([...ACTOR_ATTRIBUTED_DEBT.keys()].filter((ns) => RECORDED_DEBT.has(ns))).toEqual([]);
  });

  it('a store claimed as COVERED really does register an eraser', () => {
    const lying: string[] = [];
    for (const ns of EXPECTED_COVERED) {
      const s = stores.get(ns);
      if (!s) continue; // caught by the staleness test
      if (!s.hasEraser) lying.push(`${ns} (${s.file})`);
    }
    expect(
      lying,
      'Listed as covered but the module registers no eraser — the coverage claim is false.',
    ).toEqual([]);
  });

  it('DEBT is shrink-only', () => {
    expect(
      RECORDED_DEBT.size,
      `Subject-erasure debt may only SHRINK. Cover a store instead of recording another (ceiling ${DEBT_CEILING}).`,
    ).toBeLessThanOrEqual(DEBT_CEILING);
  });

  it('no namespace is classified twice (a double entry hides which claim is live)', () => {
    const dupes = [...RECORDED_DEBT.keys()].filter((ns) => REVIEWED_EXEMPT.has(ns));
    expect(dupes).toEqual([]);
  });

  it('registry entries are not stale — every classified namespace still exists', () => {
    const stale = [...RECORDED_DEBT.keys(), ...REVIEWED_EXEMPT.keys(), ...PARTIAL_COVERAGE.keys(), ...EXPECTED_COVERED]
      .filter((ns) => !stores.has(ns));
    expect(
      stale,
      'Classified namespace no longer found in src/features/** — remove the entry so the list stays honest.',
    ).toEqual([]);
  });

  it('a store that HAS an eraser is not also recorded as debt (the debt would be a lie)', () => {
    const contradictory: string[] = [];
    for (const ns of RECORDED_DEBT.keys()) {
      if (stores.get(ns)?.hasEraser) contradictory.push(ns);
    }
    expect(
      contradictory,
      'This store now registers an eraser — remove it from RECORDED_DEBT (debt shrinks when work lands).',
    ).toEqual([]);
  });
});
