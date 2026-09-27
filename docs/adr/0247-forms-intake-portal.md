# ADR 0247 — Self-serve intake portal: forms → priority-matrix idea intake (STRAT-PORTAL)

Status: implemented (Phases 1–4, 2026-07-04)

Date: 2026-07-04

Relates to: ADR 0014 (forms feature), ADR 0058/0232 (priority-matrix intake + `submit-idea`), ADR 0208 (host event dispatcher + event→workflow bindings), ADR 0152 / RFC 0013 (workflow chain-pack loader), ADR 0079 (feature import-direction discipline), docs/research/strategy-gap-analysis.md (§8 E3, `STRAT-PORTAL`), docs/steward/CODEBASE-ASSESSMENT.md (`STRAT-PORTAL`).

> Numbering note: drafted as 0245 → 0246 → **0247** as parallel-session ADRs
> merged first and took each slot (0245 ad-targeting, 0246 intel-email-provenance)
> — the docs/adr/README.md first-created-is-canonical rule. The `ADR 0246`
> references in the STRAT-PORTAL commit message + code comments predate this final
> renumber; the ADR FILE (0247) is canonical.

## Why this exists

The strategy remediation (E3) shipped the *substance* of demand intake — intake
fields, evidence links, dedupe/merge, promote-to-initiative provenance, comments,
score history, and chat-drivable node verbs (ADR 0232). The one deliberately-open
piece (`STRAT-PORTAL`, graded E3=B− in strategy-gap-analysis.md §8, **not**
overclaimed as A) is the **self-serve public front door**: an anonymous person
submits a public form and the submission becomes a triaged idea on a priority-
matrix list, with no operator hand-entry.

The batch architect review correctly ruled this is **not a strategy tail** — it is
a *forms-feature* capability plus a bridge, because:

- `formsService.recordSubmission` persists the submission + best-effort creates a
  CRM contact but emits **zero** host events (grep-confirmed) — nothing downstream
  can react to a submission.
- No form→intake-list binding exists — a bridge can't derive *which* list or which
  field is the idea title.

This ADR designs that bridge on the existing seams. It is **wire-free host work**
(host-extension surfaces + the ADR 0208 host-ext binding registry, which its own
header states is explicitly NOT the RFC 0099 `/v1/trigger-subscriptions` wire) —
**no new RFC required.**

## Decision

Bridge the two features **through events and a chain, never through an import.**
Forms emits a host event; a chain (node-level) reads the submission and calls
priority-matrix's existing `submit-idea`. `forms` and `priority-matrix` remain
import-independent in both directions (the ADR 0079 discipline, achieved here by
the ADR 0208 dispatcher as the decoupling seam rather than a direct call).

Three additive pieces + one chain:

### 1. Forms host-event emission (owned by `forms`)

A new `features/forms/emit.ts` mirroring the `features/crm/emit.ts` precedent.
`recordSubmission` (after its final `submissions.put`) fires:

```ts
void emitHostEvent({
  type: 'host.forms.submission.created',
  tenantId: form.tenantId,
  payload: { formId: form.formId, submissionId: submission.submissionId, orgId: form.orgId },
});
```

Ids-only by the ADR 0208 payload discipline (and the dispatcher's PII-strip is a
belt-and-suspenders backstop). Fire-and-forget by contract — `emitHostEvent` never
throws, so a fanout failure can't fail the submission. Follows the
`host.<feature>.<entity>.<verb>` naming (like `host.crm.deal.stage-changed`).

### 2. A form→intake binding, on the `FormDef` (owned by `forms`)

Add an optional field to `FormDef`, managed through the existing `createForm`/
`updateForm` routes (no new route):

```ts
intakeBinding?: {
  listId: string;        // the priority-matrix list this form feeds
  titleField: string;    // which form field key becomes the idea title (REQUIRED)
  requesterField?: string;
  notesField?: string;
};
```

Validated at write time (in `updateForm`/`createForm`): `titleField`/
`requesterField`/`notesField` MUST name real field keys on the form; `listId` is
stored **opaquely** (well-formedness only). Its org-ownership is deliberately NOT
checked at bind time — that would require `forms` to import priority-matrix. It is
enforced instead at the **write boundary**: `submitIdea(..., expectedOrgId)` (and
its surface verb, fed the form's org by the chain) asserts the target list is in
that org, so `forms` stays priority-matrix-import-free at BOTH config and runtime.
This binding is the **structural agent-write safety boundary**:
the anonymous submitter never chooses a target list; an authenticated form *owner*
pre-authorizes exactly one list via `updateForm`. The chain reads `listId` from the
form's binding, **never** from submitter-supplied values — so a public submission
can only ever file into the owner-authorized list. (The capability firewall can't
see the chain's node calls; this is why the safety is structural + owner-configured,
not firewall-enforced — the same invariant as ADR 0232's ghost-card guard.)

### 3. A submission-read surface verb + node (owned by `forms`)

Add `getSubmission` to `buildFormsSurface` (beside the existing `getSubmissions`),
returning `{ values, intakeBinding }` for one submission, tenant+org-scoped
(absent/cross-tenant ⇒ empty, no probe — the established forms-surface posture).
Expose it as a `get-submission` node in the existing `feature.forms.nodes` pack.
This is the "re-fetch under authz" half of the ids-only discipline: the event
carries no values; the chain fetches them here.

### 4. The bridge chain (an RFC 0013 chain pack)

A new `examples/workflow-chain-packs/forms-intake/` pack:

```
trigger: core.trigger.event (host.forms.submission.created)
  → forms.get-submission        (payload {formId, submissionId, orgId} →
                                   projects idea-shaped fields per the binding:
                                   willFile, listId, title, description, orgId)
  ├─[willFile == 'yes']→ priority-matrix.submit-idea  (listId, title, description,
  │                                                    orgId → the write-boundary guard)
  └─[willFile != 'yes']→ core.flow.noop               (no binding ⇒ clean no-op)
```

The dynamic `values[binding.titleField]` index a static edge can't express is done
**inside `get-submission`** (forms owns the binding→idea mapping): the node emits
`willFile` + the projected `title`/`description`/`listId`. Two terminal branches
(`submit-idea` when bound, `core.flow.noop` when not) are required because
`inspectDisposition` (`scheduler.ts`) marks a run `failed` unless **≥1 terminal
node completed** — a lone conditional edge to `submit-idea` would leave the run's
only terminal condition-skipped (and thus failed) for every unbound form. The
`noop` else-branch gives the no-binding case a completing terminal. (Discovered by
the e2e test — the STRAT-A1 pattern earning its keep again.)

Wired per tenant via a `HostEventBinding` (`host.forms.submission.created` → the
installed chain workflow), created through the existing ADR 0208 binding routes.
The single bound chain serves every form in the tenant; forms without an
`intakeBinding` short-circuit at the guard (a real submission with no configured
list is a no-op, not an error).

Provenance: `submit-idea` stamps `sourceChannel: 'form'` and (new, optional) the
originating `submissionId` on the intake overlay, so a triaged idea links back to
its raw submission.

## Alternatives weighed

| Option | Verdict | Why |
|---|---|---|
| **A. Events + chain (chosen)** | ✓ | Zero cross-feature imports; reuses `submit-idea`, the 0208 dispatcher, and the 0013 loader. Each feature owns its half. Reversible (delete the binding). |
| B. Direct import: `forms` calls `priorityMatrix.submitIdea` in `recordSubmission` | ✗ | Creates a `forms → priority-matrix` import edge (a second cross-feature dependency to maintain), couples the public submit path to PM availability, and hides the bridge from the operator (no binding to enable/disable). Violates the events-not-imports decoupling. |
| C. A generic "submission → any feature" rule engine | ✗ | A parallel automation system beside the 0208 dispatcher — exactly the "second system" this repo forbids. The dispatcher + chains already are that engine. |
| D. Put the binding in a new store, not on `FormDef` | ✗ | A second owner for "what this form does." The binding IS form config; it belongs on the form (single source of truth). |
| E. Carry submission values in the event payload | ✗ | Values contain PII (the dispatcher would strip `email`/`*Email`); and it breaks the ids-only "re-fetch under authz" discipline. Re-fetch via `get-submission`. |

## Trade-offs accepted

- **Duplicate submissions → duplicate ideas.** A resubmission files a new idea each
  time (no dedup on `submissionId` in v1). Acceptable: the intake feature already
  ships dedupe/merge (ADR 0232) for operators to collapse them. Recorded as an open,
  not silent (OQ-3).
- **Spam vector.** A public form auto-creating ideas is abusable, but bounded by
  three *existing* controls, not new ones: the per-IP rate-limit + honeypot on the
  public submit route (forms/routes.ts), the **autonomous-run budget** the dispatcher
  already checks before triggering (`checkAutonomousRunBudget` in emitHostEvent), and
  the per-list idea cap in priority-matrix. No new budget primitive needed; noted so
  it isn't rediscovered as a gap.
- **Eventual, not synchronous.** The idea appears a beat after submission (triggered
  run). Correct for the use case; the submitter gets the form's own success response
  immediately.

## Phased implementation plan

- **Phase 1 — Forms emit + binding config.** `forms/emit.ts` + the `recordSubmission`
  call; `FormDef.intakeBinding` + `updateForm`/`createForm` validation
  (`assertListInOrg` + field-key checks). Route test: bind a form, submit, assert the
  event fires (spy) and the binding round-trips; bad listId/field ⇒ 400.
- **Phase 2 — Read surface + node.** `getSubmission` on `buildFormsSurface`;
  `get-submission` node in `feature.forms.nodes` (+ pack version bump + count-lock
  test). Optional `submissionId` provenance on the PM intake overlay.
- **Phase 3 — The chain pack.** `examples/workflow-chain-packs/forms-intake/`;
  a `strategy-chain-execution`-style e2e that expands + edge-walks the chain end to
  end (real forms + PM nodes, the pattern that caught the board-pack bug in STRAT-A1).
- **Phase 4 — FE binding config.** A small "route submissions to a priority list"
  section on `FormsPage` (pick a list + map the title/requester/notes fields);
  reuses `ui/` primitives, i18n ×4. Installing the chain + creating the binding is an
  operator action surfaced here (or via the existing bindings admin).

Each phase is independently shippable and behind the `forms` + `priority-matrix`
toggles already gating both features; no new toggle required (the binding's presence
is itself the opt-in).

### Shipped (Phase → artifact)

| Phase | Artifacts |
|---|---|
| 1 | `features/forms/emit.ts` (`formSubmissionCreated`) wired into `recordSubmission`; `FormDef.intakeBinding` + `sanitizeIntakeBinding` (field-key validation; `listId` opaque) in `createForm`/`updateForm`; route pass-through in `forms/routes.ts` |
| 2 | `getSubmission` service fn + `buildFormsSurface.getSubmission` verb; `feature.forms.nodes.get-submission` node (pack v1.1.0; `requiredPacks` bumped) projecting `willFile`/idea-fields; `submitIdea(..., expectedOrgId)` write-boundary org guard + surface/node `orgId` pass-through |
| 3 | `examples/workflow-chain-packs/forms-intake/` chain (`core.trigger.event` → `get-submission` → `submit-idea` \| `core.flow.noop`); `forms-intake-chain-execution.test.ts` e2e (bound files an idea; unbound cleanly no-ops) |
| 4 | `FormsPage` intake-routing section (list picker + title/requester/notes field mapping, i18n ×4); `formsClient.listIntakeLists` (FE-composition). Tenant-wide enable rides the existing `EventBindingsPage` + `/workflows/from-chain` — no new installer route (OQ-4 resolved: reuse, don't rebuild) |

Tests: `forms-surface.test.ts` (binding validation + `get-submission` projection),
`forms-intake-chain-execution.test.ts` (e2e both paths). Gates: backend tsc + suites
green; FE build (tsc + token/CSS + i18n ×4) + lint 0 + vitest green.

## Open questions / decisions

- [x] **OQ-1 — field mapping shape. RESOLVED:** v1 maps title (required) +
      requester + notes. `sourceChannel`/`estimatedValue` mapping deferred (the
      idea lands with title + notes; operators enrich via the existing intake UI).
- [x] **OQ-2 — stale binding. RESOLVED via RFC 0125 (2026-07-04).** A deleted bound
      list makes `submit-idea` 404. The clean-skip fix needed chain-level
      **error-routing** (`triggerRule` on a terminal edge so the run completes whether
      an upstream failed) — which the chain-pack manifest schema
      (`workflow-chain-pack-manifest.schema.json`, `$id` `openwop.dev/spec/v1/...`,
      `additionalProperties:false`, RFC 0013-governed) did not expose. That gap was
      closed by **RFC 0125** (`FragmentEdge.triggerRule`, Active 2026-07-04, mirrors
      `WorkflowEdge.triggerRule`; openwop/openwop #822). Host realization here:
      (a) the loader carries `FragmentEdge.triggerRule` verbatim through expansion on
      the same edge-map seam as `condition` (`workflowChainPackLoader.ts`); (b) the
      vendored manifest schema is re-synced so a `triggerRule` edge validates; (c) the
      `forms-intake` chain (v1.1.0) adds a `done` terminal reached from `file` by an
      `all_complete` edge, so a 404 completes the run **cleanly** instead of failing.
      Verified end-to-end (real `executeRun`) by the flipped
      `forms-intake-chain-execution.test.ts` deleted-list case + the
      `workflow-chain-triggerrule-expansion.test.ts` carry-through unit test. The
      fire-and-forget floor still holds independently (submission captured before the
      emit). RFC 0125 → Accepted follows on this host witness.
- [ ] **OQ-3 — dedup. DEFERRED (layer decision, 2026-07-04).** "Idempotent by
      `submissionId`" only dedups event REDELIVERY / run-retry — a genuine user
      resubmission gets a NEW `submissionId`, so it isn't caught. Redelivery-
      idempotency belongs to the run/event layer, not a per-feature intake scan; in
      practice `recordSubmission` emits once per HTTP submit and the executor never
      re-runs a completed node, so double-filing is unlikely. Operator dedup is the
      ADR 0232 **merge** tool. OQ-5's `sourceSubmissionId` makes a scan-based dedup
      tractable IF redelivery ever proves real. Deferred as the correct layer, not
      scope-cut.
- [x] **OQ-4 — who installs the chain + binding. RESOLVED:** reuse the existing
      `EventBindingsPage` (settings) + `/workflows/from-chain` — NOT a bespoke
      installer. The `FormsPage` intake section links operators to it
      (`intakeEnableHint`). "No second system."
- [x] **OQ-5 — provenance link. RESOLVED (2026-07-04).** The idea's intake overlay
      now carries `sourceChannel:'form'` + `sourceSubmissionId` (a new
      `IdeaIntake.sourceSubmissionId` field). The `get-submission` node outputs
      `sourceSubmissionId`; it rides the existing `get→file` edge; the **submit-idea
      surface verb** (same feature — imports both `submitIdea` + `upsertIdeaIntake`,
      NO cross-feature import) stamps the overlay after creating the card,
      best-effort. No chain-structure change, no new node — so it sidestepped the
      OQ-2 schema gate. Verified end-to-end (`forms-intake-chain-execution.test.ts`).

## No-RFC determination

Wire-free host work. The event rides the ADR 0208 host-extension dispatcher (whose
header states its binding registry is host-ext only, **not** the RFC 0099
trigger-subscriptions wire); `submit-idea`, the chain loader, and the forms surface
are all existing host-ext surfaces; no run-event field, capability advert, event
type on the wire, endpoint contract, or normative MUST changes. Per CLAUDE.md, a
feature riding already-accepted seams needs no new RFC. `host.forms.submission.created`
is a host-ext event type (the `host.*` namespace), not a wire event.
