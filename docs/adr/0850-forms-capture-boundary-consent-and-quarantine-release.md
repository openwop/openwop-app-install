# ADR 0850 — Forms: the capture boundary holds per org, consent is never a condition of submitting, and a held lead can be released

Status: implemented (2026-10-07; Accepted after the pre-code `/architect` pass, then corrected by `/grade-ux` + `/grade-code` — see the correction notes and the implementation record; feature loop round 2 row 32, branch `feat/fl2-32-forms`)

Builds on ADR 0017 (forms), ADR 0330 (the standalone capture primitive and the
submission-sink seam), ADR 0338 (the email opt-in field and submit guards), ADR 0584
(quarantine-not-discard, occupancy budgets), ADR 0648 (writer replay classification,
erasure resurrection), ADR 0808 (conditional visibility), ADR 0832 / 0837 (the org floor),
ADR 0849 (an email checkbox grants `marketing.email` only; consent proof), and the service-desk
intake (ADR 0422 P2).

## Context

Round 1 closed Forms at WF/UX/CODE **A− / B+ / A−**. This pass re-measured it on `origin/main` @
`16a9aab7a`. Each claim below was read at the cited line, and the four marked **RED** were
witnessed failing by `backend/typescript/test/adr0850-forms-capture-boundary.test.ts` on that
commit before any fix.

Forms is the app's capture primitive. Its rows are the highest-volume store of public-visitor
PII, and every destination feature reads them through the sink seam
(`features/forms/submissionSinks.ts`). The seam's rule (ADR 0330) is that each integrator
decides for itself whether it acts. That is where the new findings sit.

1. **A form lead crosses orgs through the ticket sink (RED).** `service-desk/intake.ts:114-140`
   files **every** submission in the tenant as a ticket in `cfg.defaultOrgId`, with the
   submitted values verbatim in the first message (`:122-126`). The intake config is set by
   an admin of ONE org (`service-desk/routes.ts:58-61`, `host:members:manage` in the addressed
   org; it stores that org as the target). So an admin of org A reads every lead of every
   private form in org B, in a queue org B cannot see. Webinars (the only other sink that
   files into an org) checks that the bound form is in the event's org
   (`webinars/routes.ts:77`). Round 1 filed this as `FRMWF-13`, a Nice-to-have, before round 2
   established that an org is an access boundary (rows 29 and 31).
2. **A required checkbox can be designated the email opt-in (RED).**
   `sanitizeEmailOptInField` (`formsService.ts:413-419`) checks only that the field exists and
   is a checkbox. A required checkbox must be TRUE to submit (R2 F4, `:578-582`). So the
   form cannot be submitted without ticking it, and the email sink records the tick as
   `legalBasis: 'consent'` (`email/formsConsentSink.ts:51-61`). Consent that is a condition of
   the service is not freely given (GDPR Art. 7(4), Recital 43). The builder offers any
   checkbox (`FormDetailPage.tsx:824-836`) and shows no warning. The consent receipt's
   `source` is `form-optin:<formId>`, which names the form but not the submission that is the
   proof.
3. **A held lead cannot be released.** ADR 0584 quarantines a honeypot- or guard-flagged
   submission "so a false-positive lead can be recovered by a human"
   (`formsService.ts:126-134`). The only operator action on a held row is **Discard**
   (`FormDetailPage.tsx:1029-1032`). There is no route that clears the flag and delivers the
   lead (`grep release` over `features/forms` returns nothing). So the recovery the
   quarantine exists for is a manual re-key into CRM. The market's shape is Typeform's spam
   folder with "Not spam" (UX_UPGRADE-forms R2 market refresh).
4. **The post-sink write can undo an erasure or a delete (RED ×2).**
   `recordSubmission` persists the row, runs the sinks, and then writes the **in-memory**
   row back if any sink returned a marker (`formsService.ts:718-720`). A DSAR erasure
   (`erasure.ts:142`) or an operator delete (`deleteSubmission`) that lands while the sinks
   run is overwritten: the erased values come back, or the deleted row is re-created without
   its counter. The CRM contact-unlink handler (`formsService.ts:221-231`) is the same shape:
   it writes rows from a tenant listing, so a row erased or deleted after the listing is
   restored. This is the "state machine is not a CAS" class.
5. **The public submit's only volume guard is per IP.** The global limiter trusts the
   leftmost `X-Forwarded-For` (#4516). With a forged header, one client can submit clean
   rows until the per-form ceiling (50 000, `:269`) is full. After that the form answers 429
   to everyone until an operator deletes rows one at a time. The honeypot catches naive bots
   only.
6. **The agent's submission read is unbounded and includes held rows.**
   `openwop:forms.list-submissions` (`agentTools.ts:100-111`) returns every submission of the
   form (up to 50 000) into the model's context, quarantined bot content included.
7. **Conditional logic cannot be authored.** ADR 0808 shipped the `when` model, the server
   evaluator and the renderer. The builder only displays a "Shown only when…" chip
   (`FormDetailPage.tsx:709-716`). Logic is table stakes at every leader in the competitive
   set (UX_UPGRADE-forms R1/R2); only pack templates can carry it today.
8. **Docblocks that state a posture the code no longer has.** `submitGuards.ts:5-7` says a
   deny is "silent 200, no row" (ADR 0584 made it a quarantine). `agentTools.ts:10-12` says
   the tool and the route use the same predicate (`FRMWF-9`: they do not). The test docblocks
   named by `FRMWF-15` are still stale.

## Decision

> **Accepted after the pre-code `/architect` pass (2026-10-07): 2 Critical, 5 High and 6 Medium,
> all in the first draft's decision text.** The decisions below are the corrected ones. What
> each finding changed is recorded in §"What the `/architect` pass changed", so the reasoning
> trail survives.

### D1 — A support ticket is a per-form opt-in, filed in the form's own org

> **SUPERSEDED in part by the user's decision (2026-10-07), after `/architect` and before merge.**
> The accepted text read "file only the intake org's forms" (architect H3). That stopped the
> leak, but it still let one org's admin decide ticket intake for a whole org's forms, and
> nobody had asked for every lead on every form to become a ticket. The user decided: **off by
> default, opt-in per form, routed only to the form's own org desk.**

`FormDef.createTicket` (boolean, absent = false) is set on create or by `PATCH` (`workspace:write`
in the form's org; a non-boolean is ignored). The service-desk sink files a ticket only when the
form opted in, only into `form.orgId` (`submission.orgId` must agree), and only while the tenant's
`service-desk` toggle is on. That makes it the last sink to gain a toggle read (`FRMWF-13`). The
intake config no longer decides where a FORM lead goes. It still names the org for the channels
that carry none (WhatsApp, the widget; see the H4 residue), and it supplies SLA hours when it
exists. The builder shows a "Create a support ticket" checkbox while the service desk is on, and
a passive notice when the flag is set but the desk is off (the CRM opt-in pattern). The
service-desk "intake unconfigured" copy no longer says forms depend on it.

**Migration: none, because nothing relied on the old routing.** The user's decision called for a
one-time, logged pass to set the flag on existing forms that depended on ticket creation. The
orchestrator measured prod read-only on 2026-10-07:
- service-desk intake config rows: **0**;
- `host_ext_kv` values with `"channel":"form"`: **0**;
- `forms:submission`: 20 rows in one demo-seeded tenant, the latest from 2026-07-09;
- `forms:def`: 5 rows.

The old sink returned early when no intake config existed, so with zero configs it could never
have filed a ticket. That holds even if kernel ticket rows (type `service-desk-ticket`) live
outside the scanned store, so the scan does not need to be exhaustive. So no form relied on
ticket creation, and the flag ships alone, default false. No dormant migration path was written
(`FRM2CD-13`, closed).

### D2 — Consent is never a condition of submitting, and the proof records what was shown

- **Authoring.** `sanitizeEmailOptInField` refuses a **required** checkbox on create. On
  update, the service refuses a TRANSITION into the conflict: re-designating onto a required
  checkbox, or making the designated checkbox required. A save that leaves an existing
  (legacy) conflict unchanged still passes, because the builder sends `emailOptInField` on
  every save and a title edit must not be blocked (the FRM2-1 lesson). The builder names a
  legacy conflict on load and offers both fixes: make the checkbox optional, or clear the
  opt-in.
- **Capture snapshot.** When a form designates an opt-in, `recordSubmission` stamps
  `optIn: { field, label, required }` onto the submission, from the form as the visitor saw
  it. Held rows get it too.
- **The sink reads the snapshot.** The email sink records consent only from a snapshot with
  `required: false` whose field value is `true`. A row with no snapshot (written before this
  ADR) falls back to the live form at capture time only, and records nothing on release.
- **No re-grant over a later change.** The sink records nothing when the subject's consent
  record changed after `submission.createdAt`, for example by an unsubscribe. This applies to
  every capture, and is what makes a release safe.
- **Receipt.** `source` becomes `form-optin:<formId>:<submissionId>`. The record's `ts` is the
  write time (for a release, the release time). The submission's `createdAt` and its `optIn`
  snapshot carry the time and the wording of the tick.

### D3 — An operator can release a held submission

`POST …/forms/:formId/submissions/:submissionId/release` (`workspace:write`, the same tier as
Discard). `releasedBy` is the `user` that `authorizeOrgScope` returns, never a second
caller-resolution. The service:

1. reads the row under the tenant+org+form guard (uniform 404);
2. refuses an erased row with 409 `submission_erased`. The eraser now stamps `erasedAt`, so the
   test is the marker, not a scan for tombstone values;
3. is idempotent: a row that is not held returns `200 {released: false}`;
4. applies the 50 000 lead ceiling (429), because the row moves into that bucket;
5. clears the flag with a CAS against the row it read, stamping `releasedAt` and
   `releasedBy`, and moves one unit from `flaggedCount` to `count` in ONE swap of the counter
   row;
6. runs the same post-persist delivery as a clean capture (`deliver(form, submission)`): the
   sinks, then the host event. Consent follows D2: the snapshot plus the no-re-grant rule.

A release does not re-run the submit guards. A guard judges a request, and the human release
is the override of that judgement.

### D4 — Every later write to a submission is a bounded CAS

- `patchSubmission(id, fn)` reads, applies `fn`, and swaps, with at most 5 attempts. It
  **never falls back to `put`**. A missing row writes nothing. The post-sink marker write, the
  contact unlink, the eraser and the release all use it.
- The marker write merges only `contactId` / `error` onto the CURRENT row, so it neither
  re-creates a deleted row nor restores erased values.
- The eraser throws if it runs out of attempts on a row. The fan-out then reports a failure
  instead of `rowsTouched` silently missing that row.
- **Removal is a claim.** `deleteSubmission` and the retention purger go through
  `removeSubmission`. It CASes the row it read to `removing: true`, deletes it, and then
  credits the bucket of the row that was claimed. A release racing a delete therefore fails
  one of the two swaps, and occupancy cannot drift.
- The counter moves through one `adjustCounts(formId, deltas)` swap.
- A crash between the row swap and the counter swap leaves bounded drift, clamped at 0. That
  is accepted, as in ADR 0584.

### D5 — A per-form burst ceiling that does not depend on the client's IP, and denies nobody

An in-process sliding window per published `formId` counts only submissions that would become
CLEAN rows: after the honeypot, the guards and `validateValues`. Past
`OPENWOP_FORMS_SUBMIT_PER_MIN` (default 120 per minute per instance), the submission is
**quarantined** as `flagged: 'burst'`, with the same `201` and the same body as any other
submission. It is metered against the 1 000-row quarantine budget and can be released (D3).
> **CORRECTED by `/grade-code` (FRM2CD-3).** The draft's next sentence said a forged-header
> flood "can no longer fill the 50 000 real-lead ceiling, and it cannot deny the form to real
> visitors either". Both halves were overclaims. The ceiling still fills, at the window's rate
> (about 7 hours per instance at the default). Once the quarantine budget is full, flagged
> submits, including real visitors held by the window, get 429. What D5 does do: it **slows**
> the flood from unbounded to the window's rate, and it makes its casualties **recoverable**
> (held, releasable) for as long as the quarantine budget lasts. The window map holds only resolved, published
forms and is bounded (oldest entry evicted beyond 10 000 forms).

### D6 — The agent's submission read is bounded and excludes held rows by default

`list-submissions` takes `limit` (default 50, max 200) and `includeHeld` (default false). It
returns newest first, with `total`, `heldCount`, `truncated`, and a `note` that states the
truncation in words ("the newest 50 of 1 240"). The persona prompt is NOT edited, so the agent
pack is not version-bumped. Its documented inputs (`{ formId, orgId? }`) stay a true subset of
the schema, and its "report total submissions" instruction is now answered by `total`, which
holds the true count. A test pins the prompt's input names to the tool's schema, so the
hand-copied text cannot drift unseen.

### D7 — Conditional logic is authorable in the builder

Each field after the first gets a "Show only when" editor: an earlier field, then an operator
and a value suited to that field's type:

- checkbox: `truthy` / `falsy` only;
- select: `equals` / `notEquals` against one of the controller's options;
- text, email, number, textarea: `equals` / `notEquals` / `contains`, with a string value
  (submitted values are strings when the condition is evaluated).

It writes the ADR 0808 `when` shape, which the server already sanitizes. A rename of the
controller follows the key. A save is blocked, with the reason named, when:

- a reorder or delete leaves the controller later than the dependent, or removes it;
- the controller's type changes;
- the condition's option is removed.

### D8 — Docblock honesty

Correct the docblocks in point 8 of the context, and the two test docblocks named by
`FRMWF-15`.

### What the `/architect` pass changed

| Finding | Draft said | Now |
|---|---|---|
| C1 (Critical) | release records consent at release time | the no-re-grant rule (D2): nothing over a record that changed after the tick |
| C2 (Critical) | consent read from the current form | the `optIn` snapshot at capture; a legacy row records nothing on release |
| H1 | a pre-honeypot 429 window | count clean rows only; overflow is quarantined (`burst`), never refused. The draft would have let ~2 requests a second with a forged XFF deny the form to everyone, with no row as a trace |
| H2 | delete and purge credit the bucket of a stale read | removal is a claim; one counter swap |
| H3 | file the ticket in the form's org | file only the intake org's forms. Org B never opted in, so the draft's objection to this ("drops tickets silently") described the correct state. **Then superseded by the user's decision:** a per-form opt-in, default off, filing in the form's own org |
| H4 | "WhatsApp has no org of its own" | false: connections can be org-scoped (`connectionsService.ts:192`), and the widget lane has the same shape. Both are named as service-desk residue |
| H5 | refuse a required opt-in on every update | refuse only a transition into the conflict; the builder offers both fixes |
| M1 | detect erasure by its values | an `erasedAt` marker |
| M2 | — | a crash after the release swap and before delivery leaves the lead released but undelivered. Recorded as residue: re-delivering could fire the host event twice |
| M3 | — | bounded, with no `put` fallback; the eraser throws |
| M4 | the renderer reads `Retry-After` | moot: D5 no longer answers 429. The global limiter's 429 copy and its CORS exposure are residue |
| M5 | "agent pack unchanged" | the prompt stays as it is (its inputs remain a true subset, and `total` answers its "total" ask) and is pinned to the schema by a test; no pack bump, so no repo-vs-registry drift |
| M6 | operator/value unspecified | typed per controller field type |

## Evaluation matrix (extension of `forms`; toggle id unchanged)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Extends `features/forms` (`FormDef.createTicket`). D1 edits `features/service-desk/intake.ts` and D2 edits `features/email/formsConsentSink.ts`: each integrator owns its sink (ADR 0330), so the fix goes where the sink lives. No core route or nav edits. |
| 2 | Toggle | `forms` stays as it is (OFF, `tenant`). Release and the editor ride it. There is no new toggle: these are corrections plus one operator action on an existing inbox. |
| 3 | `ctx.features.forms` | Unchanged. The surface stays read-only. Release is a human act on the inbox, not a run capability: a run that could un-quarantine bot content would defeat the quarantine. |
| 4 | Node pack | Unchanged (`feature.forms.nodes@1.2.1`). `FRMWF-11` (input schemas) is carried. |
| 5 | Envelopes | None. |
| 6 | Agent pack | Unchanged: the allowlist, the prompt and the version stay as they are. D6 bounds the existing `list-submissions` tool with new optional inputs (additive). The prompt's inputs are pinned to the tool schema (M5). |
| 7 | Public surface | The public submit gains the D5 per-form ceiling. Tenant still comes from the form, not the request, and every miss is still a uniform 404. The release route is authed, not public. |
| 8 | RBAC | Release is `workspace:write` in the form's org, the same tier as Discard, and `releasedBy` comes from the authorized `user`. Setting `createTicket` is `workspace:write` in the form's org, and the ticket files into that org only (D1). |
| 9 | Replay | No run-path change. A held row never fired the host event, so a release fires it exactly once: the CAS clears the flag once, and a second call is `released:false`. The one exception is the M2 residue (a crash between the swap and delivery), which leaves the lead undelivered rather than delivered twice. |
| 10 | Frontend | A "Release" action beside Discard on held rows in `FormDetailPage`. The opt-in picker excludes required checkboxes. The opt-in picker refuses a required checkbox, and a legacy conflict is named with both fixes offered. A per-field "Show only when" editor, typed per controller field. A `burst` held reason. Strings go in the forms namespace in all 4 locales. |

**RFC verdict: host extension, no RFC.** Every route is under `/v1/host/openwop-app/*`. The
`when` shape is the already-normative `form-content-packs.md` §"Conditional visibility" (ADR
0808); the editor only authors it. The host event `host.forms.submission.created` is unchanged.

**Boundaries audit.**
- Single owners: submissions belong to `formsService` (the eraser shares its namespace by
  design, `erasure.ts:102-106`); tickets belong to `service-desk/tickets.ts`; consent belongs
  to `consentService.mergeConsentCategories`.
- No new store and no new route prefix. `…/submissions/:submissionId/release` sits under the
  existing authed `ORG` prefix, beside the delete route (`routes.ts:200`).
- The per-form ceiling is local to forms. `middleware/rateLimit.ts` keys only by IP, API key
  and session, and has no per-resource bucket to reuse.

## Not decided here (residue)

- **Multi-page (ADR 0558)** stays Proposed. It is a field-catalog change with server-side skip
  re-evaluation, and the conditional editor (D7) is its prerequisite.
- **`FRMWF-11`** (input schemas on the node pack) and **`FRMWF-10`** (bind the chain witness to
  the seeded lane) are carried.
- **#4516** (the leftmost-XFF trust in the global limiter) is out of scope.
- **`FRM2CD-10`** — the consent sink's newer-record check is a read before the merge, not part of
  the merge's CAS, so an unsubscribe in that narrow gap is overwritten. The fix is a
  `mergeConsentCategories` precondition (a consent-service API change).
- **Service-desk WhatsApp and widget intake** (H4) file into `cfg.defaultOrgId` even when the
  connection or widget belongs to another org (`intake.ts:86`, `widgetRoutes.ts:135`). That is
  the same shape as D1, but the lanes belong to service-desk, not forms, so they are handed to
  its row.
- **M2.** A crash after the release swap and before delivery leaves a released, undelivered
  lead. A `deliveredAt` marker plus a re-deliver path is the fix, and it needs the host event
  to be idempotent first.
- **The global limiter's 429** shows the renderer's "capacity" copy, and `Retry-After` is not
  CORS-exposed for third-party embeds (`cors.ts:245`).

## Phased implementation

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1, D2 (server), D4 | `adr0850-forms-capture-boundary.test.ts` (born red on `16a9aab7a`) |
| P2 | D3 (route + service + inbox action), D5 (server) | release + burst tests |
| P3 | D6, D7, D2 (builder), D8 | tool test; builder tests |

## Implementation record

Commits are cited by subject, not by sha, because a rebase moves shas (the ADR 0826 lesson).

| Phase | Commit (subject) | Witness |
|---|---|---|
| P1 + P2 server (D1, D2, D3, D4, D5) | `fix(forms): capture boundary per org, consent never a condition, held-lead release, CAS-only submission writes, per-form burst quarantine` | `test/adr0850-forms-capture-boundary.test.ts`. Born red on `16a9aab7a`: D1, D2, D4 ×2. Six sabotage probes went red: D1 guard, no-re-grant, marker `put`, burst, snapshot fallback, required skip |
| P3 server (D6, D8) | `fix(forms): bounded agent submission read + docblock honesty` | the same file, D6 block (page, held exclusion, prompt↔schema pin) |
| P3 frontend (D2, D3, D5, D7) | `feat(forms): release held leads, required opt-in refused, conditional-visibility editor` | `frontend/…/forms/__tests__/adr0850FormsBuilder.test.tsx`; three sabotage probes went red |
| `/grade-ux` closures | `fix(forms): grade-ux closures — …` | `FRM2UX-1..12` (UX-ASSESSMENT.md) |
| `/grade-code` closures | `fix(forms): grade-code closures — …` | `FRM2CD-1` (Blocker, in this ADR's own D4 code) through `-11`; a `delete` that throws once, sabotage-probed red (CODEBASE-ASSESSMENT.md) |

> **CORRECTED by `/grade-code` (FRM2CD-1) — D4 as first implemented carried the next Blocker.**
> The removal claim (`removing: true`) was written so a release racing a delete could not drift
> the counters. A `delete` that threw after the claim then left the row, and its PII, behind.
> Every reader hid it, and `patchSubmission` skipped it, so the DSAR eraser reported success
> while the PII stayed. D4 now reads: **a claimed row is finished, never skipped.** Whoever
> meets it resumes the delete, and occupancy is credited only by the call whose `delete()`
> returned true.

## Open questions

- [x] D1: where does a form lead's ticket go? **Decided by the user (2026-10-07):** a per-form
  opt-in, default off, filed in the form's own org.
- [ ] D5: is 120 per minute per instance the right default? Overflow is quarantined rather
  than refused, so a launch burst costs an operator a release, not a lost lead.
