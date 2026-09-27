# ADR 0540 — the job-search domain: an application is a CRM deal, the digest is not

Status: implemented

Parent: [ADR 0539](0539-job-search-vertical-strategy.md). Composes: CRM (ADR 0008 + 0210/0213),
Documents & Templates (ADR 0053), `host/weightedScoring.ts` (ADR 0534 P0), `entities` (ADR 0257).

Module: `features/job-search/domain/` · Toggle: **`job-search`** (the ONE vertical flag, default **OFF**, bucket `tenant`, **sellable bundle** — ADR 0539 D0)

## Context

ADR 0539's audit established that most of the prior art already has an owner here. This ADR
settles the part that does not: **where the job-search domain actually lives.**

The temptation is a self-contained `Application` store shaped like the prior art's. That would
duplicate pipelines, stages, stage history, dedupe/merge, CSV export, the board UI and the
record timeline — all of which CRM ships — and the two would drift.

## Decision

### D1 — An application IS a CRM `Deal`

Verified against `features/crm/entities/deals.ts:37-57`, not against prose:

| Application concept | `Deal` field | Fit |
|---|---|---|
| job title | `title` | direct |
| applied → screening → interviewing → offer | `pipelineId` + `stageId` | direct; stage history + weekly snapshots come free (ADR 0210) |
| employer | `companyId` → CRM `Company` | direct |
| recruiter / hiring manager | `contactId` → CRM `Contact` | direct; identity resolution + merge free |
| offer / rejected | `status: open \| won \| lost` | direct — and derived at write time from the stage name |
| salary | `amount` + `currency` | **genuine**, not a forced fit |
| owner (whose application) | `owner` (opaque subject id, RFC 0048) | direct — and the multi-applicant answer for OQ-2 |

Scalar job fields — `jobUrl`, `board`, `matchScore`, `matchReason`, `appliedAt`,
`resumeVariantId` — become **CRM typed custom fields**. `FieldType` is
`string | number | boolean | date | enum | reference` (`crm/entities/fieldDefs.ts:26`), so
`reference` carries the resume-variant pointer natively and `enum` carries the board.

### D2 — The job digest is NOT a custom field

`Deal.customFields` is `Record<string, string | number | boolean>` — **scalars only**. A
digest is structured (`skills[]`, `requirements[]`, `responsibilities[]`,
`descriptionExcerpt`). Serialising it into a string field would put a parser on every read,
defeat the typed-field system, and be invisible to CRM's own validation.

The digest is owned by **this feature**, keyed by the deal it describes, in its own
`DurableCollection`. It is derived data — re-derivable from the listing — so it carries a
retention policy and is never the source of truth for anything CRM shows.

### D3 — Reports honesty: a job pipeline is not a revenue pipeline (resolves 0539 OQ-1)

CRM's weighted-pipeline and forecast reports compute `Σ(amount × stage probability)`. For a
job search that number is **meaningless and actively misleading** — you do not "expect" the
sum of every salary you applied for. Shipping the Reports tab unchanged over a job pipeline
would be a dishonest surface, which this repo treats as a defect, not a cosmetic issue.

**Decision:** the pipeline carries a `kind` discriminator (`revenue` — today's behaviour and
the default — or `non-revenue`). A `non-revenue` pipeline renders **count-based** reports
(conversion by stage, aging, time-to-stage) and **suppresses** currency rollups. This is a
small, honest change to a shipped feature rather than a fork of it, and it generalises: any
future non-revenue pipeline (hiring, grants, applications of any kind) gets it free.

Amount stays populated — a single application's salary is real and useful on the record; it
is only the *rollup* that is nonsense.

### D4 — Resume variants are Documents, tailoring rules are ours

Documents & Templates already owns a versioned store with prompt-template binding and
`outputSchema` validation. A resume variant is a document version; the *tailoring rules* —
the prior art's genuinely valuable part — are ours:

- **`extract` never improves.** Parsing a résumé is verbatim; inventing a field is a defect.
- **`tailor` may reword, never fabricate.** Every reworded bullet is diffed against its
  original; numbers, scope and tech cannot be added. **This is the design, not a prompt
  instruction** — the prior art enforces it server-side in `resume/rewrite.ts` and derives every
  date server-side in `structure.ts`, whitelisting umbrella employer names. Port the
  *enforcement*, not the instruction.
- Output is validated against the template's `outputSchema` before it can be persisted.

### D4a — Cover letters are a document kind with the SAME guards

*(Added in the completeness audit — cover letters were missing entirely, and they are part of
applying, not an extra.)*

A cover letter is a **Documents** kind bound to a prompt template with an `outputSchema`,
exactly like a résumé variant, and it inherits the D4 guards: it may assemble and reword
material the profile and résumé already support, and it may **not** introduce an employer, a
date, a metric, or a claim of experience that is not evidenced. The same server-side diff
that keeps a reworded bullet honest applies to a generated paragraph.

Two rules that keep it from becoming noise:

- **Only when asked for.** Many ATS forms make it optional; an unrequested letter is
  unrequested. If the field is optional and the user has not opted in, skip it (0545 D3).
- **Reused like a variant, not generated per job.** A small set of letter bases, selected by
  the same reuse-vs-create score. A letter regenerated for all 200 applications is 200
  chances to drift and reads like what it is.

### D5 — Eligibility rules are a named, tested list

The sharpest operational insight in the prior art is that **what is NOT a skip matters more than what
is**. Ported verbatim as a rule table with tests: onsite/other-city, a thin JD, 1099,
defence/federal absent a stated bar, being over-qualified, and a JD *silent* on sponsorship
are **never** skips. Only a JD-stated bar the applicant cannot clear (citizenship,
clearance, or explicit no-sponsorship when sponsorship is required) disqualifies — and the
reason quotes the posting verbatim.

Scoring composes `host/weightedScoring.ts`; this feature contributes a criteria set and a
projector, exactly as `work-selection` does (ADR 0534 D1). **No second scoring engine.**

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package** | `src/features/job-search/domain/` — a MODULE of the one package, not its own. Composes `crmEntitiesService`, `documentsService`, `weightedScoring`. Core untouched. |
| 2 | **Toggle** | **`job-search`** — the ONE vertical flag (ADR 0539 D0), default **OFF**, `bucketUnit: 'tenant'`, and a **priced marketplace bundle**, so every authed route inherits the entitlement gate at the central choke. |
| 3 | **Workflow surface** | `ctx.features['job-search']`: `scoreFit(digest)`, `checkEligibility(digest)`, `listApplications(filter)` (read); `recordOutcome(dealId, outcome)` (write, the ONE terminal write). |
| 4 | **Node pack** | `feature.job-search.nodes` — `score-fit`, `check-eligibility`, `record-outcome`, `tailor-resume`. Signed via the registry pipeline. |
| 5 | **Envelopes** | **None.** No new envelope kind — that would be wire and need an RFC. Chat drives this through tools + the agent pack (ADR 0543). |
| 6 | **Agent pack** | **None here** — the persona lives in ADR 0543 (`career-agent`), so one agent owns the vertical rather than each package shipping its own. |
| 7 | **Public surface** | **None.** The public job index is ADR 0542's. |
| 8 | **RBAC** | Reads `workspace:read`, writes `workspace:write`, org-scoped via `authorizeOrgScope`. Deal writes go through `crmEntitiesService` so CRM's own authz and events apply — never a direct collection write (the Forms→`crmService` precedent). |
| 9 | **Replay/fork** | Fit scores and eligibility verdicts are **recorded on the deal at decision time**, never recomputed at read — a re-scored application would silently rewrite history. Digest rows are immutable per version. |
| 10 | **Frontend** | A job-pipeline view over CRM's existing deal board (kind-aware per D3) + a résumé-variant panel in Documents. No new board component. |

## Phased plan

| Phase | Scope | Verification |
|---|---|---|
| **P0** | Pipeline `kind` discriminator + count-based reports for `non-revenue` (D3). | CRM's existing report tests stay green; a `non-revenue` pipeline suppresses currency rollups. |
| **P1** | Digest store + fit scoring (criteria set + projector over `weightedScoring`) + the eligibility rule table. Pure, no I/O. | Unit tests per rule, headed by the never-skip list. |
| **P2** | The CRM mapping: create/advance an application as a deal through `crmEntitiesService`; custom-field definitions seeded. | Route tests through `createApp`; IDOR + org scoping at the HTTP boundary. |
| **P3** | Résumé tailoring over Documents: extract-verbatim, reword-with-diff-guard, server-derived dates. | The guard tests are the phase — a fabricated number/employer/date must fail closed. |
| **P4** | `ctx.features['job-search']` + node pack + read tools (shared access predicate, ADR 0308). | Surface + pack-manifest + runtime tests. |

## RFC gate

**Host work, no RFC.** No wire surface touched. Routes under
`/v1/host/openwop-app/job-search/*` — prefix verified free.

## Open questions

- **OQ-1 — RESOLVED: `non-revenue` belongs to CRM.** It generalises immediately to hiring
  pipelines, grant applications, admissions and any other non-monetary funnel, so CRM is the
  right owner. Forking reporting into `job-search` would give the app two report engines over
  one entity — the outcome the boundaries audit exists to prevent. Still raise it with CRM,
  but as a small additive change, not a negotiation.
- **OQ-2 — whose application is it?** `Deal.owner` is an opaque subject id, so a workspace
  can run job search for several people. But résumés, credentials and inbox are per-person
  and PII-heavy. Does a shared workspace pipeline leak one applicant's data to another?
  Must be settled before any multi-applicant use; single-applicant workspaces are safe now.
- **OQ-3 — digest retention. RESOLVED: 90 days, re-derivable.** The digest is derived data,
  so ageing it out costs nothing that cannot be regenerated from the listing. An expired
  digest degrades **explanation** (the "why did it score 82" breakdown), never the recorded
  score itself — which is stamped on the deal at decision time (D3 / ADR 0534 D3) precisely so
  history cannot be rewritten by a later re-derivation.

## Implementation record

| Phase | Commit | Evidence |
|---|---|---|
| P0 | `a9226db09` | `Pipeline.kind` (optional ⇒ no migration); `non-revenue` reports `null` money, never `0`. Revenue pipelines asserted UNCHANGED. The `null` choice surfaced 3 consumers that would each have rendered a silent wrong zero, and exposed that `createPipeline` could not SET `kind` — the phase would have been inert. |
| P1 | `c402ef30e` | Digest store, fit scoring over the shared engine, D5 rule table. Never-skip list enforced as the ABSENCE of rules + tests against an applicant who clears nothing. Disqualifying set pinned by id. |
| P2 | `c62d2f253` | Applications as CRM deals through `crmEntitiesService`; org-scoped routes. IDOR test made non-vacuous (it first passed only because the toggle was off). |
| P3 | `4a4bb95cf` | Tailoring guards. Two real evasions found by the tests: conjunction-joining merged a fabricated employer into a real one, and bidirectional containment accepted any longer run containing a known name. |
| P4 | this commit | `ctx.features['job-search']` (5 ops, no `submit`) + `feature.job-search.nodes` (4 nodes, all `role:action`). Absence of a submit path is asserted at BOTH layers. |

**Note on P4's absence tests.** The surface and the pack each assert that no
`submit`/`apply`/`send` op exists. That is a security property — such an op would
route around the ADR 0541 grant — so it is tested rather than left to review,
which is the only form in which "we deliberately did not build this" survives.
