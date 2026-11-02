# ADR 1013 — interrupt form rules

Status: Accepted

## Context

RFC 0255 §E moves a form onto the `clarification` interrupt: `data.form` carries it, `questions` is the fallback, and a host must not raise a form that fails `interrupt-form.schema.json` or has an input `id` outside `questions[].id`. `interrupt.md` §Re-entry and resume values says a host must accept `{ answers: [{ id, answer }] }` on any clarification, with or without a form.

This host has four form producers and none uses that shape. Each puts `catalogVersion` and `surface` at the root of `data`:

- `local.openwop-app.a2ui-clarify` (`bootstrap/nodes.ts`)
- `feature.kicktodo.nodes` (replan clarification)
- `feature.campaign-autopilot.nodes` (preflight checklist)
- `feature.assistant.nodes` (calendar and email clarification)

Their resume is `{ action, ...values }`, built by `A2uiSurfaceCard`, and each pack reads `values[fieldId]`.

`core.clarificationGate` reads `config.question` only. It ignores `config.questions` and `config.form`. So the three `conformance-interrupt-form*` fixtures are withheld, and those rows record `inapplicable`.

RFC 0255 no longer depends on this ADR, because the reference host witnessed §E (openwop #2068). The withhold on this host is still debt.

`formV1` in the schema is `{ catalogVersion, surface }`, so the existing 0.9.1 surfaces move into `data.form` unchanged. No producer has to be rewritten as A2UI v0.9.

## Decision

1. `core.clarificationGate` takes `config.questions` and optional `config.form`, and raises `data.questions` and `data.form`, the form verbatim. A definition with `config.question` raises one `questions` entry, because stored tenant workflows and the `app-builder` chain carry that key. `data.question` is no longer written. `ClarificationDialog`, the card for a clarification with no form, shows the first question and keeps resuming with `{ answer }`: the `app-builder` chain and Book AI read that value.
2. One host check refuses a bad form: it fails the schema, has an input `id` outside `questions[].id`, or asks for a secret. It runs where the interrupt is created, not in the gate, so `ctx.suspend` cannot bypass it. The run fails with a typed error and no interrupt is raised.
3. The four producers raise `{ questions, form }`. Each form input's `id` is a `questions[].id`, and `questions` always has an entry, as the schema requires. Autopilot preflight has no inputs, so it raises one question and resumes with `answers: []`. Root `catalogVersion` and `surface` are deleted.
4. `A2uiSurfaceCard` and `A2uiV09Surface` resume a clarification with `{ answers: [{ id, answer }] }`. Each producer reads answers by `id`. The button id is no longer sent: every surface here has exactly one resume button (measured 2026-10-31, five surfaces).
5. `interruptBridge` reads `data.form` only. The root-key branches are deleted: openwop-dev has never stored a form interrupt (measured 2026-10-31, see Open questions).
6. Register `conformance-interrupt-form`, `-refused` and `-unbound` together, and delete `fixtureRaisesForm`. The positive fixture alone leaves `-refused` blocked.

7. The host does not reshape or restrict a resume value. It still passes the value to the node, validated against the node's `resumeSchema` when one is declared. Decision 4 changes what this host's form cards send, not what a node may receive, so a distribution's own closed resume shape survives. Book AI's `{ answers: [{ id, answer, skipped }], receiptId }` is one. `ctx.suspend` still takes root `questions` and `resumeSchema`, and the form check in Decision 2 runs only when `form` is present.

8. Resolving a `clarification` refuses an unknown question id. When the stored interrupt has `questions` and the resume value has an `answers` array, every `id` in it must be a raised `questions[].id`; otherwise the resolve fails `400 validation_error` naming the id, and the interrupt stays open. This is the one narrowing of Decision 7, and it follows `interrupt.md` ("each `id` a `questions[].id`"). A value with no `answers` array is unchanged, so an interrupt stored with only `question` still resolves. Before the fix, `conformance-clarification` raised `ask` and accepted an answer to `q1` (measured 2026-10-31, run `3e9891b9`). The check lives in the one resolve path, not in nodes, and needs its own test because raising the right questions does not prove an unknown id is refused. Decisions 1 and 8 land in the same PR: `v2-clarification-resume-answers` resolves with `q1`, so Decision 8 alone turns that row from pass to fail. The build's cut prediction names that row.

## Alternatives

- **Rewrite the producers as A2UI v0.9.** Rejected as unneeded. `formV1` is valid and the surfaces render today.
- **Keep the root keys as a second accepted shape.** Rejected. Delete, don't deprecate.
- **Check the form in each producer.** Rejected. Four copies of a security rule drift, and `ctx.suspend` would stay open.

## Consequences

- Packs change, so `feature.kicktodo.nodes`, `feature.campaign-autopilot.nodes` and `feature.assistant.nodes` publish new versions. KickTodo takes them through the mirror.
- A form interrupt left open across an upgrade keeps its old shape. It renders as the plain card, and its `{ answer }` resume fails the node with a typed error (`clarification_answer_invalid`, or `validation_error` from the assistant), except the autopilot, which re-reads its checklist. The user sees the failure and re-runs. No run is silently wrong. This decides the kicktodo-prod question below, so no count gates this ADR, and a one-off migration, which needs a new `Storage` write across both adapters, is rejected as more than that case is worth.
- During a rollout, a browser tab on the old SPA sends the old resume to a new interrupt and fails the same way until it reloads.
- Six clarifications exist in openwop-dev, all plain `question`. Two are still open from September. Their `data` stays as stored, so readers keep `data.question` until those two close.

## Open questions

- [x] Stored open form interrupts on openwop-dev: none, ever. Read-only 2026-10-31: 2,037 interrupts, 6 clarifications, 0 with root `surface`, `surfaces` or `version`.
- [x] The same count on kicktodo-prod and myndhyve-prod: not needed. Consequences says what one such interrupt does, and that is safe at any count (decided 2026-11-01, user: "figure it out and proceed"). Neither count was read. Book AI raises no form (`yolo.mjs:93`).
- [x] `ClarificationData` re-read from the pinned 2.46.38 `spec/v2/core/interrupt.md` §Forms before coding.
- [x] Decision 8 against Book AI and the suite (read 2026-10-31). Book AI's `yoloAnswers` raises `questions[].id` from `x.id` and parses answers against those same questions (`yolo.mjs`). Book AI's session confirmed the rest on 2026-10-31, as its report and not read here: `yoloRuns.ts` runs `parseAnswers` before the resume, `checkAnswer` requires the same length and ids in order, and `ClarificationDialog` sends `{answer}`, which has no `answers` array, so Decision 8 does not apply to it. Nothing changes on either side. In the 2.46.38 scenarios, three resolve a clarification with `q1`: `interrupt-clarification` (keyed object, so Decision 8 skips it), `v2-clarification-resume-answers` and `v2-interrupt-form-rules` (both need Decision 1 raising `q1`). Grep for `answers: [` and `answers: {`, so a value built another way would not show.
- [ ] What are the two open September clarifications? If they are test runs, close them and delete the `data.question` readers.

## Implementation record

| Phase | Result | Witness |
| --- | --- | --- |
| Build | gate, check, resolve refusal, 3 packs, cards, bridge, fixtures, `exchange` deleted | `adr1013-interrupt-form-rules.test.ts`, `a2ui-clarify-node.test.ts` (route), major-2 lane 209/0 with `v2-interrupt-form-rules` executing (5 runs, 2 refused) |
