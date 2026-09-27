# ADR 0584 — Forms submission honesty: quarantine, don't discard

Status: implemented

## Context

A single-feature `/grade-code`, `/grade-ux` and `/grade-workflows` pass over Forms
(2026-08-18) graded it **B / B / A** and produced four UX Blockers plus a set of
correctness findings on the app's **only internet-facing data-entry surface**. The
findings share one shape: *the system tells someone a thing happened when it did
not.* This ADR records the decisions taken to close them.

Forms is not a peripheral feature. It is the app's standalone capture primitive:
one renderer serves the hosted `/f/:formId` page, the CMS `form` section and every
funnel step; the public submit route is unauthenticated; and a submission fans out
to CRM, email consent, funnels, service-desk and webinars through the ADR 0330 sink
seam. A lie told here is told to a stranger, at the moment they hand over their name
and email.

## Decision 1 — an abuse-control trip QUARANTINES the submission (FORM-UX-1)

**What shipped before.** A honeypot trip or a submit-guard denial answered
`200 {ok:true}` and persisted **nothing**. The renderer treated any 2xx as success,
so the respondent saw *"Thanks — your submission was received"*, a funnel step
advanced, and the lead existed nowhere. The only artifact was a backend `WARN` line
(`honeypot_dropped` / `guard_denied`) that **no operator surface reads** — so a form
losing 100% of its leads to a false-positive honeypot was indistinguishable from a
form nobody submits. The behaviour was **test-pinned in both workspaces**, as
desired behaviour, in the tests-that-pin-defects shape.

**The argument for the old posture, and why it does not survive contact.** The
silent 200 was chosen so the endpoint would "never become a spam oracle". But the
two responses were already trivially distinguishable: a clean submit answered `201`
**with** a `submissionId`, and a trip answered `200` **without** one. The oracle the
posture existed to prevent was already open. Meanwhile the cost was paid entirely by
real people — browser extensions, password managers and AT tooling that fill every
input are exactly what trips a hidden decoy, and the ADR 0338 §D4 guard seam exists
for CAPTCHA providers, which have real false-positive rates.

**Decided.** A trip **stores the submission, marked `flagged: 'honeypot' | 'guard'`**,
and answers exactly as a clean submit does.

- Nothing is silently lost — a false positive is recoverable by a human.
- The response is now **byte-identical** to a success, which is a strictly *better*
  anti-oracle posture than the one it replaces.
- A quarantined row runs **no sinks and emits no host event**: no CRM contact, no
  ticket, no consent write, no funnel completion. It is stored, and nothing more,
  until a person decides otherwise.

> **CORRECTION (2026-08-18, FORM-FUNNEL-1) — "no funnel completion" was HALF
> TRUE when it was written, and three places in the code asserted it.**
> `funnel.step_completed` has **two** emitters. The ADR 0332 submission sink
> never runs for a held row (`recordSubmission` returns before the sinks) — but
> the funnel viewer advances on the renderer's `onSubmitted`, and the public
> `GET …/funnels/:slug/next` route emitted a completion regardless, because it
> had no idea which submission it was advancing off. `routes.ts` returns a real
> `submissionId` for a flagged submission (deliberately — see the anti-oracle
> argument), so the client invariant "no id ⇒ no advance" never bit. Bot volume
> and false-positive holds both landed in the durable conversion rollup, while
> `formsService.ts`, `formsClient.ts`'s `Submission.flagged` docblock and
> `FormDetailPage.tsx`'s chip comment all said otherwise.
>
> **The behaviour moved, not the claim.** The viewer passes the id it was handed
> (`…/next?submission=<id>`); the route consults a new tenant-scoped
> `isSubmissionHeld` and withholds the completion event for a held row. Three
> properties are preserved deliberately, and this is the reasoning the obvious
> fix would have lost:
>
> 1. **The submit response stays byte-identical.** Signalling `flagged` to the
>    client — the direct reading of "have the funnel not advance on it" — hands a
>    bot the decoy's name and defeats the honeypot outright. The suppression
>    therefore lives on the server, where the respondent cannot observe it.
> 2. **The visitor still advances.** A held submission is often a REAL person
>    (an extension or password manager filled the decoy). Blocking their step
>    would rebuild the gate-with-no-exit shape Decision 3 of this same ADR exists
>    to remove. What is suppressed is the analytics event — the half that
>    inflates conversion — not the person's progress.
> 3. **An unknown or cross-tenant id reads as not-held**, i.e. as today's
>    behaviour: a public caller must not be able to provoke a refusal.
>
> The three comments are corrected in place to say "no funnel-completion
> **event**", each pointing at the emitter it does not itself own. The
> `funnels → forms` import is the ADR 0330 integrator→primitive direction funnels
> already takes in `formsAttributionSink.ts`.
- Quarantined rows are metered against their **own budget** (`MAX_FLAGGED_PER_FORM`
  = 1 000), deliberately separate from the 50 000 lead ceiling, so bot volume can
  never crowd out real capture.

> **CORRECTION (2026-08-18, FORM-BUDGET-1) — the budget shipped as a LIFETIME
> tally, so the recovery promise above expired PERMANENTLY.** `flaggedCount`
> only ever incremented and **nothing in `backend/typescript/src` decremented
> it**: the retention purger deleted rows without touching `forms:subcount`, the
> eraser anonymizes and keeps rows, and there was no per-submission delete path
> at all. The only reset was `deleteForm`, which destroys every real lead with
> it. So a public form that accrued 1 000 lifetime honeypot trips — routine over
> months, and forceable in about seventeen minutes from a single IP at the
> default `OPENWOP_RATELIMIT_IP_REQS_PER_MIN=60` — sent **every subsequent trip
> down the drop path forever**, and a real respondent whose password manager
> filled `_hp_ref` got a 429, no row, and no recovery. The headline claim of this
> ADR ("stored so a false-positive lead can be recovered by a human") held only
> for the first 1 000 trips in a form's life, and no surface said so.
>
> **Fixed as OCCUPANCY.** `count` and `flaggedCount` are now "rows this form
> currently holds in each bucket" — the `crm:suppression` / `entities` ±delta
> precedent already in this codebase — and every path that removes a row credits
> them back: the retention purger, and a NEW `deleteSubmission` (service +
> `DELETE …/submissions/:submissionId` + a per-row **Discard** on held rows in
> the inbox). The delete path is not a convenience: with retention off on two
> independent default switches, occupancy without an operator lever is no better
> than the tally it replaced. `droppedCount` stays a lifetime tally on purpose —
> it counts submissions that have no row, so nothing's removal could credit it.
> Pinned by `forms-submission-honesty.test.ts` (a purge frees budget — proved
> non-vacuous by sabotage; a single delete frees exactly one unit; the delete is
> tenant+org+form-guarded and floors at 0).
- Past that budget the submit is **refused honestly (429)** — never answered with a
  thank-you — and a `droppedCount` keeps the operator's ratio truthful even for the
  submissions that have no row.
- The inbox surfaces `flaggedCount` / `droppedCount` from the **server's counter
  row** (not the loaded page, so the ratio is the form's true one), and a
  quarantined row wears a distinct "Held" chip naming which control held it.

> **CORRECTION (2026-08-18, FORM-CSV-1) — the chip landed on the inbox row and
> NOT on the CSV export, which is the bulk path OUT.** `exportCsv` walks the
> cursor to completion, so it collected every held row, and neither the header
> nor the row builder emitted a `flagged` column. Before this ADR the CSV was
> clean *by construction* — honeypot trips were not stored at all — so
> quarantining them turned the most likely path from Forms into a CRM or mail
> tool into a carrier for bot and false-positive rows, byte-indistinguishable
> from real leads. That defeats the "no CRM contact, no email" property the
> quarantine exists to provide, one manual import later.
>
> **Both halves of the review's suggestion were taken, and the default is the
> decision worth recording: held rows are EXCLUDED by default**, with an explicit
> "Include held submissions" opt-in rendered only when there are held rows. The
> export is an import path, so its default must be the set that is safe to
> import. A **`Held` column always exists** (empty on a clean row, naming the
> control on a held one) so a deliberate opt-in export — triage in a spreadsheet,
> which IS the recovery this feature promises — arrives labelled rather than
> mixed. The inbox also gained a **Held (n) filter** and a per-row **Discard**
> (FORM-UX-1b / FORM-BUDGET-1): a thousand held rows must not bury real leads
> with no way to narrow or remove them.

**The client-side invariant, stated separately because it is the durable one:**
a submission id is the only proof the server stored anything, so **nothing
downstream of "we received this" may happen without one.** A 2xx carrying no id is
now a typed failure in the renderer. The server no longer produces such a response,
which is precisely why the client must be honest about it: a client that trusts an
id-less 2xx re-opens the whole defect the moment any surface produces one.

> **Alternative rejected — "make the guard reject visibly."** Answering 403 to a
> tripped honeypot tells a bot exactly which field is the decoy, and tells a
> false-positive human that their submission was refused for a reason we cannot
> explain without teaching the bot. Quarantine gives the human the same outcome
> they wanted (their answers are safe) and the bot no information at all.

## Decision 2 — the respondent's draft is scoped to a VISIT and expires (FORM-UX-3)

Save-and-resume wrote the whole answer bag to `localStorage` **on every keystroke**,
under a key derived from the form id alone, with no TTL, no expiry, no visitor
scoping and no clear-on-abandon — cleared only on a successful submit or an explicit
"Start over". On any shared device (a public terminal, a lent tablet, the kiosk /
table-top flow the "Submit another response" button was explicitly built for) the
**next person was shown the previous person's name, email and free-text answers**,
under copy asserting they were theirs.

**Decided.** Two changes, both required:

1. **Visit scoping.** The key carries a per-visit id held in `sessionStorage`, which
   the browser scopes to one tab and discards when that tab closes. A different
   person is, by construction, a different visit — the bleed cannot happen rather
   than being unlikely to.
2. **A TTL** (30 minutes). A visit that stays open for hours — a kiosk tab nobody
   closes — is the case scoping alone does not cover.

Plus a **migration**: legacy unscoped keys already sitting on real devices are
*purged* on mount, never read. Without it the fix would not reach the devices that
already carry someone else's answers, which are the only devices with the problem.

> **CORRECTION (2026-08-18, FORM-DRAFT-1) — the migration was a data-loss
> regression.** The key is `owp-form-draft:<formId>:<visitKey>`, but the purge
> loop spared only the **exact current key**, so every OTHER form's draft **from
> the same live visit** was deleted on mount. A funnel with a form on step 1 and
> a different form on step 2: the visitor part-fills step 1, clicks Continue,
> step 2 mounts under a new `formId`, the effect re-runs and wipes step 1 — and
> the in-page Back then shows an empty form **that resumed correctly before this
> PR**. Same on a CMS page rendering two forms, or on either re-mounting through
> the new Retry. Scoping is about the VISIT, not the form: the loop now spares
> every `…:${visit}` key and applies the TTL to each of them individually.
> Pinned in both directions (a sibling form's mount must not wipe this visit's
> draft; another visit's keys and this visit's stale ones must still go), and the
> two-form test was proved non-vacuous by restoring the one-key spare.

## Decision 3 — an unavailable form renders a designed state everywhere (FORM-UX-4)

`renderUnavailable` defaulted to rendering **nothing**, and only the hosted page ever
passed one. So a deleted, unpublished or toggled-off form vanished from a public
marketing page while its own eyebrow and heading stayed on screen — the visitor read
"Get in touch" over blank space — and on a **funnel step**, where advance fires only
on submit, it became a **dead end with no exit**.

**Decided.** The renderer draws its own designed unavailable state; `renderUnavailable`
becomes an override, and an embedding surface may supply one through the embed
context. The funnel supplies a version that carries **the way forward** — a step
nobody can complete must not be a step nobody can leave.

The uniform-404 property is preserved: the copy is the *same sentence* for deleted,
unpublished and toggled-off, so a draft's existence still never leaks. Rendering
nothing under an intact heading was never the honest reading of that posture — it
was the false-empty state.

## Decision 4 — Forms registers a subject eraser; the docblock is corrected (FORM-1)

`forms:submission` is the app's highest-volume store of **public-visitor PII** and
registered **zero** erasers. The opt-out was explicit and named a compensating
lifecycle falsified on all three legs: the CRM precedent it cited had itself been
*overturned* as the CRM-2 defect; the "CRM erasure path via the contact" never
reached forms (the delete hook strips the `contactId` pointer, which if anything
makes the residual PII harder to find); and the retention fallback is off on **two**
independent default switches.

**Decided.** `features/forms/erasure.ts` registers an eraser that **anonymizes rather
than deletes** — the row survives as the org's record that an enquiry arrived, every
*answer* becomes a tombstone (keys retained, so the inbox still renders), and the
whole `meta` tracking bag goes. A submission is reached by `contactId`, by
`meta.sessionKey`, or by an **exact, case-folded match of an email-shaped subject key
against a submitted value** — the last is the leg that matters, because
`createToContact` is opt-in and off by default, so most respondents never become a
CRM contact and would otherwise be unreachable by any DSAR.

> **CORRECTION (2026-08-18, FORM-ERASE-1) — the ledger claimed more coverage
> than the mechanism delivers.** The values leg fires only when the subject key
> `includes('@')`. A respondent to a form capturing name + phone and nothing
> else, who never became a CRM contact and whose page sent no analytics session
> key, is reached by **none of the three legs**: `eraseFormsSubject` logs
> `rows: 0`, and because a `SubjectEraser` returns `Promise<void>`, the DSAR
> fan-out reports **success over data still sitting in `values`**. Meanwhile the
> `RECORDED_DEBT` entry this change deleted had said, correctly, that "the
> free-text `values` map is the store that actually holds the PII".
>
> **Not closed by widening the match**, and that is a decision rather than an
> omission: comparing a non-email subject key against free text means testing an
> opaque id or a digit string against every answer on every row, which
> over-erases a stranger's submission on a coincidence — and over-erasure is
> unrecoverable in a way under-erasure is not. The honest cure is a per-form
> declaration of which field carries the respondent's identity (the
> `emailOptInField` precedent: the owner names the field, the eraser matches only
> that one), which is a forms-owner decision this change may not make by default.
>
> **The record is restored instead**, in a new third state. `RECORDED_DEBT`
> cannot hold it — the "a store that HAS an eraser is not also recorded as debt"
> gate is correct and stays — so `subject-erasure-feature-stores.test.ts` gains
> **`PARTIAL_COVERAGE`**: a store an eraser reaches with a NAMED residual, with
> its own shrink-only ceiling (1), asserted to have an eraser (else it is plain
> debt) and to state the same residual in that eraser's own source (else the
> claim lives only in a test file nobody edits). The ceiling arithmetic is
> restated with it: **8 + 1 = 9** recorded gaps. The `DEBT_CEILING` move 9 → 8 is
> true of that ledger and, on its own, overstated what shipped — one gap moved
> from "no eraser at all" to "an eraser with a named residual", which is real
> progress and is not the same as coverage.

`forms:submission` leaves `RECORDED_DEBT` (ceiling 9 → 8, and enters
`PARTIAL_COVERAGE` — see the correction below) and `forms:def` leaves
`ACTOR_ATTRIBUTED_DEBT` (17 → 16). The second needs care: the ADR 0464 ratchet
resolves coverage at **module** level, so registering here makes `forms:def` read as
covered although the eraser deliberately does not touch it (a form definition is a
public page's config that must keep working when its author leaves; the honest cure
is re-attribution, which needs a target this change cannot choose). A new assertion
pins that decision **against the eraser's own source**, so the inference cannot be
mistaken for a claim.

## Decision 5 — public `meta` is bounded (FORM-2) and the idempotency guard is atomic (FORM-3)

- **FORM-2.** `meta.utm` and `meta.referrer` were unbounded in key count, key length
  and value length on the **unauthenticated** write path — two lines below a
  `context` field capped "because public input is never trusted to grow storage",
  and under a type docblock claiming "the meta.utm posture" of a module that runs UTM
  through a closed allowlist. They now take that posture for real: a closed six-key
  allowlist and a 1 024-char cap, matching the analytics beacon.
- **FORM-3.** The at-most-once guard was read-then-write, so concurrent same-key
  submits both read `null`, both fell through the cap and the counter, and **both ran
  the sinks** — producing exactly the duplicates the key exists to prevent, in the
  exact scenario it is for (a double-click on a slow connection). It is a
  `compareAndSwap` claim now. The claim writes the **real row**, not a placeholder,
  so there is no window in which a successful claim is followed by a failed write —
  the compensation problem is removed by construction rather than handled. A lost
  race resolves to the winner's row, which *is* the replay answer; a claim we cannot
  read back is a typed failure, never a success.
- The counter itself became a real CAS with a bounded retry (**FORM-4**), because its
  docblock said "best-effort CAS" over a blind read-modify-write whose drift grows
  with contention — precisely the load the ceiling exists to stop.

## Decision 6 — workflow findings (WF-FORM-1…4)

- **WF-FORM-1.** The chain's declared output `cardId` was **structurally
  unreachable**: `outputRole:'primary'` lands on the `done` noop, which returns only
  `{value: ctx.inputs.value}`, and the `file → done` edge was bare. Every run
  reported `{value: undefined}`, so the ADR 0247 OQ-2 *graceful degrade* (bound list
  deleted) was byte-identical at the run boundary to a successful file.
  Port-qualifying both ends (`file.cardId → done.value`) makes the declared output
  reachable **and** the two paths distinguishable in one change.
- **WF-FORM-2.** The chain is zero-config, so the seeder mints a tenant-owned,
  picker-runnable copy. Run from `/` there is no trigger payload, so ids coerce to
  `''`, `getSubmission` answers `{found:false}`, the skip branch fired, and the run
  reported **completed with no output and no message** — success-with-empty on a
  surface a user can click. A third branch off `get` (`falsy found` →
  `core.flow.stop-and-error`) makes it a typed failure whose copy names the actual
  mistake. Deliberately **not** fixed by adding required params: params freeze at
  expansion and a per-submission id cannot be frozen.
- **WF-FORM-5 (2026-08-18 correction).** The three branches off `get` were
  **not mutually exclusive**: `equals willFile 'yes'` / `notEquals willFile 'yes'`
  / `falsy found`. On a miss the last two are BOTH true, so `skip` and `refuse`
  fired together — and the WF-FORM-2 test above passed only because
  `core.flow.stop-and-error` terminates the run. It was pinned to a
  terminal-RESOLUTION rule rather than to the routing, so a future change to how
  this host resolves a terminated node beside a completed one could have
  silently re-greened the manual run. This host evaluates
  equals/notEquals/contains/truthy/falsy on chain edges and has no AND, so
  exclusivity had to move into the VALUE: the node emits a three-valued `route`
  (`'file' | 'skip' | 'refuse'`) and all three edges are `equals` on it. Chain
  pack 1.2.0 → **1.3.0**; a new test asserts the exclusivity structurally (one
  discriminator field, all `equals`, distinct values, and no `falsy`/`notEquals`
  creeping back).
- **FORM-QUAR-1 (2026-08-18 correction).** `ctx.features.forms.getSubmission`
  returned a fixed shape with **no `flagged`**, while `getSubmissions` leaked it
  for free through its generic projection. So `feature.forms.nodes.get-submission`
  could not refuse a quarantined row, and the only thing closing the chain lane
  was that `formSubmissionCreated` is never fired for a held submission — an
  **absence, not a guard**. A tenant binding this chain to a different trigger,
  or authoring one over `list-submissions` (which does return flagged rows),
  would file quarantined leads as real intake. The surface returns `flagged`
  now, the node emits it and answers `willFile:'no'` (⇒ `route:'skip'`), and the
  node pack goes 1.1.1 → **1.2.0** with the `feature.ts` pin in lockstep.
  *Operational note: editing pack source requires re-running
  `scripts/gen-steward-manifest.mjs` — an unattested pack fails closed with
  `pack_untrusted` at execution, which reads at the run boundary exactly like a
  branch that never fired.*
- **WF-FORM-3.** `host.forms.submission.created` was absent from
  `KNOWN_HOST_EVENT_TYPES` — the only operator-facing discovery surface for the
  binding this chain needs. Added. The catalog's docstring claiming it was "sourced
  by grepping every `emitHostEvent(...)` call site" is **false for ~15 emitters**
  (forms, dealers, entities, environments, goals, kb, priority-matrix,
  sales-commissions, service-desk, strategy, territories, webinars, whatsapp,
  app-builder/syncWebhook, cdp/segmentEntryDaemon, assistant/actionExecution); the
  docstring is corrected in place. **The other ~14 are deliberately not swept in**:
  one line per miss re-creates the drift the day the next emitter ships. The durable
  cure is a build-time `emitHostEvent` call-site parity gate (the
  `promptCatalogParity` shape) — recorded here as follow-on work, not built here.
- **WF-FORM-4.** `docs/chat-first-port/c10-forms.md` claimed the chain is "not
  seeded" and "not in the deploy `/install` bundle". Both false — `Dockerfile:161`
  COPYs the whole `examples/workflow-chain-packs` tree, and the zero-config seeder
  mints a per-tenant owned copy. The cited grep read true only because the seeder
  iterates `listChains()` generically, so `forms-intake` is never *named* in `src/`.
  Grep the mechanism, not the string. This is not pedantry: the "not seeded" error is
  **why WF-FORM-2 sat unnoticed** — a chain nobody believed was runnable was one
  click away in the picker, where it completed green and empty.

## Decision 7 — failure honesty on the operator surfaces (FORM-UX-5/6/9/10)

- **FORM-UX-5.** Seven localized failure strings were unreachable **by
  construction**: both pages used `e instanceof Error ? e.message : t(…)` over a
  client that only ever threw `Error` (and a network rejection is a `TypeError`,
  which is also one). **28 translations** were dead and every failure a French or
  pt-BR operator saw was raw English. `formsClient` throws a typed
  `FormsRequestError` carrying the status; the pages map it to localized copy and
  demote the server's words to a detail line (the `CsmRequestError` precedent).
- **FORM-UX-6.** The collection page's `error` was set and never cleared, while the
  `<Notice>` rendering it sat *outside* the failed-state branch — so after a
  successful retry the page rendered the forms **and** a red "Failed to load forms."
  above them. The second surface is gone; the read's failure is told once.
- **FORM-UX-9.** The detail page offered **no Retry anywhere** and narrated recovery
  in prose ("Reload to try again") — what §4.6 rule 7 forbids. All three failure
  states get a Retry, each with its own attempt counter so retrying the submissions
  does not refetch the form, and each re-enters *loading* before refetching so the
  window between click and settle shows a skeleton, never a stale empty list.
- **FORM-UX-10.** Three `<Notice variant="error">` sites passed no `announce`, relying
  on `role="alert"` announcing on insertion — which `ui/Notice.tsx:18-21` states is
  "widely reported" but "NOT verified here and MUST NOT be treated as established",
  citing PR 2615 as the bug that shipped from that assumption. The highest-stakes of
  them (the submit-failure notice on the public form) now routes through the global
  live region. **Not closed:** the assertive announcement *storm* — `ui/Field` stamps
  `role="alert"` on every field error and the summary is also one, so a three-error
  submit fires four announcements. That fix touches a shared primitive and belongs to
  the design-system program.

## Consequences

- **Wire:** none. Every route here is a host extension under
  `/v1/host/openwop-app/*`, which is non-normative and never touches the OpenWOP
  wire, so no RFC is required. The `submissionId` field and the `flagged` marker are
  host-extension response shape, not protocol.
- **Data:** `Submission` gains an optional `flagged`; `forms:subcount` gains optional
  `flaggedCount` / `droppedCount`. Both are additive on a JSON-blob store with no
  migration, so existing rows keep their shape and read back unchanged.
- **Replay:** the chain `version` bumps 1.1.0 → 1.2.0; node ids do not move, so the
  seeded definition re-expands to the same shape with the corrected edge.
- **Behaviour change operators will notice:** a form that was silently dropping
  honeypot trips will start showing "Held" rows and a count. That is the point — the
  number was always real; only its visibility is new.

## §Correction — the R2 adversarial-review fold-in (2026-08-18)

The corrections above landed as one pass over PR #3368 after an adversarial
review. Two smaller items are recorded here rather than inline:

- **FORM-429-1.** `PublicFormRenderer` mapped a 429 to "This form is no longer
  accepting submissions", which is a statement about the FORM. After this ADR a
  429 has **two** causes — the 50 000-lead ceiling (permanent, and true of the
  form) and a full quarantine budget (which a **false-positive respondent** hits
  while the form is perfectly healthy for everyone else). The copy now fits both
  and names neither: *"This form isn't accepting submissions right now, so your
  answers weren't saved. Please contact whoever shared this form with you."*
  Refusing to distinguish is deliberate and is stated at the mapping site — a 429
  that identified the quarantine would be the spam oracle the honeypot exists to
  deny — and the recovery it offers (contact the sender) is the one that actually
  exists, unlike "try again", which is futile in the first case.
- **Docblock honesty.** `formsService.ts` described the submission log as
  APPEND-ONLY; with `deleteSubmission` that is now true of the CAPTURE PATH only,
  and the docblock says so rather than keeping a word that has stopped being true.

## Follow-on work (recorded, not built here)

1. **An `emitHostEvent` call-site parity gate** — the durable cure for WF-FORM-3.
2. **A review action on a held submission** ("this was a real person") that releases
   it through the sinks. Today the recovery is manual: the row is visible and
   exportable, but promoting it re-runs nothing.
3. **The FORM-UX-10 announcement storm** and `ui/Field`'s spread-order guard — both
   shared primitives, route through the DS program.
4. **A per-form identity-field declaration for erasure** — the honest close for
   the `PARTIAL_COVERAGE` residual recorded under Decision 4.
5. **Releasing a held submission through the sinks** stays item 2 above; the
   `Discard` shipped here is the *other* half (getting the budget back), not a
   promotion path.
6. **FORM-5** (every submission mints a new CRM contact while `ensureContact` sits
   unused), **FORM-8** (the inbox N+1 over the tenant's entire submission slice) and
   **FORM-9** (rows read back with no runtime validator) — all recorded in
   `CODEBASE-ASSESSMENT.md`, none touched here.
