# Insights & Drafting chain pack — version history

The pack's user-facing descriptions say what each workflow does. This file keeps the reasons it changed, moved here by ADR 1102 D10 (the UX re-grade: chain and parameter descriptions shown to users had become changelogs).

## Pack

Insights & Drafting meta-workflows as an RFC 0013 chain pack (migrated from the deprecated ADR 0082/0072 builtins, ADR 0472 Phase 2). Three real source→analysis→LLM→draft→notify pipelines over BYOK-connected sources. chainIds keep the original `openwop-app.insights.*` ids so scheduler/trigger ignition + replay are unchanged; the chains are also gallery-editable. 1.2.0 (ADR 0599 §5): each hard-required value is a chain PARAMETER bound as a WHOLE-VALUE `{{params.X}}` on a top-level node `inputs` entry, and data edges are port-qualified on BOTH sides. NOTIFY AUDIENCE (1.3.0 ADR 0600 §5; STATED in 1.3.1 §Correction 6): `self` resolves from the run's ACTING USER and refuses fail-closed without one, so a scheduled/webhook fire of `talent-prep` or `anniversary-draft` loses its completion notification — deliberate, since the alternative broadcasts a colleague's 9-box score or recognition draft workspace-wide. `weekly-variance` keeps `tenant`: no declared PII, and its only lane is the scheduler. 1.4.0 (ADR 1102): the anniversary draft is approved BEFORE it reaches the mailbox and is drafted from a fenced brief; both Workday reads keep only the subject’s rows; the variance red-team is shown the figures.

## `openwop-app.insights.weekly-variance`

Pull financials → compute variance → human red-team → notify. (1.1.0: the input-less render step was removed — WF-DOC-3. 1.2.0: `sql` is a declared parameter bound into the query node — ADR 0599 §5; the query→compute edge is port-qualified so the variance node receives `rows`, not the BigQuery envelope.) 1.3.0 — ADR 1102 D9: the red-team gate receives `compute.summary`, so the reviewer asked to confirm the figures is shown them, not a business unit and a verdict word.

- `projectId`: BigQuery project for the financials read. Tenant-specific — no default is possible; the scheduled lane supplies it from the suite config's `planSource.projectId`.
- `businessUnit`: Business unit to analyze. Labels the variance result.
- `sql`: The financials read. It MUST return one row per metric with `metric` / `actual` / `plan` columns — that is the contract `variance-compute` consumes, and a result set without them makes the node fail `insufficient_data` rather than report a verdict. Edit this to match your warehouse.

## `openwop-app.insights.anniversary-draft`

Pull milestones → retrieve voice exemplars → LLM drafts → email DRAFT (never sends) → approval → notify. (1.1.0 — ADR 0599 §5: `workdayBaseUrl`, `exemplarQuery`, `recipient` and `draftSubject` are declared parameters bound into the nodes that hard-require them; the generate→emailDraft edge is port-qualified `content`→`body`, because the LLM emits `content` and the draft node reads `body` — supplying only the recipient would have created an EMPTY draft and reported it a success.) 1.2.0 — ADR 0600 §5: notifies at `audience:"self"` rather than telling the whole workspace a recognition draft was made about a named colleague and linking them to it. 1.3.0 — ADR 1102: the draft step is handed a `recognition-brief` (the milestone, the person and the voice exemplars, fenced as untrusted) instead of the bare subject id it used to receive; the Workday read keeps only the subject’s row (`workerId`), so `subjectId` is now required; an empty draft is refused; and the human approves the TEXT before anything is written to the mailbox (`check → approve → emailDraft → notify`), where it used to be written first and approved after.

- `subjectId`: The person being recognized — their Workday worker id. Required (1.3.0, ADR 1102 D1/D2): the milestone read keeps only this person's row, and the draft brief refuses without one.
- `milestone`: The anniversary/milestone, e.g. `10 years`. Optional when the person's Workday row states a `milestone` or a numeric `serviceYears`; the brief refuses when neither does.
- `workdayResource`: Workday resource the trigger reads — defaults to serviceDates; override for other milestone types.
- `workdayBaseUrl`: Your Workday tenant REST base, e.g. `https://{instance}.workday.com/ccx/api/v1/{tenant}`. Tenant-specific and required — ADR 0082 named the connection `instanceUrlTemplate` as the source, and that field is read nowhere in the repo (ADR 0599 §5 retires the claim).
- `exemplarQuery`: What to retrieve from the knowledge base as voice exemplars.
- `recipient`: The mailbox the recognition message is addressed TO. The draft is created in YOUR mailbox and is never sent — nothing leaves until a human sends it by hand.
- `draftSubject`: Subject line for the draft.

## `openwop-app.insights.talent-prep`

Pull performance data → 9-box readiness score → notify. (1.1.0 — ADR 0599 §5: `workdayBaseUrl` is a declared parameter bound into the pull node, and the pull→score edge is port-qualified so the score node receives the review `rows` it derives ratings from rather than the Workday envelope. 1.2.0 — ADR 0600 §5: notifies at `audience:"self"` rather than broadcasting a link to a named person's 9-box score workspace-wide, and the score→notify edge is port-qualified `score.label → notify.message` so the notification body is no longer empty — the two are one decision, since a body is only safe once the audience is one person.) 1.3.0 — ADR 1102 D1: the pull keeps only the subject’s review rows (`workerId`), so a run no longer stores the whole workforce’s performance reviews in its events.

- `subjectId`: The person to score. Required — the score node refuses without it.
- `workdayBaseUrl`: Your Workday tenant REST base, e.g. `https://{instance}.workday.com/ccx/api/v1/{tenant}`.

## 1.4.0 (ADR 1102)

- `anniversary-draft`: the draft step is handed a `recognition-brief` (the person, the milestone and up to five voice exemplars, fenced as untrusted) instead of the bare subject id it used to receive; `subjectId` is required and the Workday read keeps only that person's row; an empty draft is refused; the human approves the TEXT before `core.email.draft` writes it (`check → approve → emailDraft → notify`).
- `talent-prep`: the Workday read keeps only the subject's review rows (`workerId`), so a run no longer stores the whole workforce's ratings.
- `weekly-variance`: the review gate is fed `compute.summary`, labelled "Variance figures", so the reviewer sees the figures.
- All descriptions rewritten in plain language; the history above moved here.
