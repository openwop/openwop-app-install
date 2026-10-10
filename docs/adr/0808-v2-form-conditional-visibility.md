# ADR 0808 — Conditional field visibility, and `forms` declared at major 2

Status: Accepted (implemented)

Related: ADR 0516 (form templates), ADR 0670 (the v2 families, and why `forms`
was ledgered off), ADR 0208 (edge conditions are control flow),
`docs/steward/V2-COMPLETION-PLAN.md` W4.

## Context

`form-content-packs.md` §"Conditional visibility" (RFC 0177 §E.4): a form
field MAY carry `when: <EdgeCondition>`. The grammar is the workflow edge
condition `{ type, left, right }`, and "no second expression language is
accepted".

`forms` sat on `conformance/major2Ledger.ts` with the reason "a field
carrying `when` is not honoured". MEASURED on `ed7d2cc44`, that was true at
every layer:
- the form-content pack loader ignored `when`;
- `createForm`'s `sanitizeFields` dropped it;
- submission validation could not evaluate it;
- the public renderer could not hide a field.

So advertising `forms` at v2 would have claimed a grammar the host does not
implement. Note that the suite scenario only validates fixture packs against
the corpus schema and never calls the host, so it would have passed. The
ledger row was right for a reason the scenario cannot see.

## Decision

1. **One grammar, the host's existing one.** `host/formFieldConditions.ts`
   validates a `when` with `mapEdgeCondition`, the chain loader's own mapper.
   That makes the operator set the host's: `equals`, `notEquals`, `contains`,
   `truthy`, `falsy`. `expression` and `regex` are refused with
   `chain_edge_condition_unsupported`, as on chain edges, so one host has one
   supported set and no field silently always shows. The verdict comes from the
   executor's `evaluateCondition`.
2. **`left` names an earlier field (`fields.<key>`).** Earlier, so visibility
   resolves in one pass in authored order and a cycle cannot be written; and
   another field, because a condition on nothing is dead.
3. **Hidden means neither required nor kept.** `validateValues` evaluates
   visibility first. A hidden field is not required, and a value posted for it
   is dropped, so a value the visitor could not see never persists. A hidden
   controller hides its dependents: it is judged on visible values only.
4. **The loader refuses what `createForm` would refuse.** The same
   `sanitizeWhen` runs at pack load, so a template using an operator this host
   cannot evaluate is refused by name, not at instantiation. It is a host
   module for exactly that reason: the loader may not import a feature.
5. **The public renderer hides by the same rule.** `deriveFields.visibleFields`
   mirrors the server's evaluator. Validation, the error summary, the submit
   payload and the render all read the visible list, so a hidden field is never
   judged, sent or drawn.
   - **Parity is pinned, not asserted.** `whenCases.json` is ONE case table
     that both the server test and the renderer test run. A row they disagree
     on is a field the visitor sees but the server judges hidden.
6. **The builder shows a condition.** A conditional field carries a "Shown
   only when …" chip in four locales. The builder round-trips `when` on save,
   since draft fields are spread whole. Moving or removing a controller makes
   the server refuse the save by name.
7. **Declare `forms` at major 2** with the v1 record's `contentPacks` facet,
   and remove the ledger row in the same commit (RFC 0148 §B).

## Not in this ADR

- **Authoring conditions in the builder UI.** Conditions come from form-content
  packs and the forms API. The builder displays and preserves them but has no
  editor yet. That is a UX feature, not a conformance gap.
- **`expression` / `regex`.** The host refuses them everywhere (chain edges
  too). Supporting them is one decision for both surfaces, and it is not
  needed for the family.

## Alternatives weighed

- **Declare `forms` because the suite scenario passes.** It would have been a
  false claim, as above. Rejected.
- **A form-specific condition evaluator.** That is the "second expression
  language" the spec forbids, and two evaluators drift. Rejected for one
  server evaluator plus a pinned client mirror. The client cannot import the
  server's.

## Implementation record

| What | Where |
|---|---|
| validate + evaluate (host module) | `backend/typescript/src/host/formFieldConditions.ts` |
| `FormField.when`; stored by `sanitizeFields`; judged by `validateValues` | `features/forms/formsService.ts` |
| loader refuses an un-honourable `when` | `host/formContentPackLoader.ts` |
| renderer: `visibleFields`, used for validate / summary / payload / render | `frontend/react/src/features/forms/render/{deriveFields.ts,PublicFormRenderer.tsx}` |
| the shared parity table | `frontend/react/src/features/forms/render/whenCases.json` |
| builder chip, 4 locales | `features/forms/FormDetailPage.tsx`, `features/forms/i18n/*.ts` |
| v2 record + ledger row removed | `routes/discovery.ts`, `conformance/major2Ledger.ts` |
| tests — authoring (accept / refuse incl. forward + self reference), `createForm` round-trip, submission (hidden not required, value dropped, hidden controller), loader accept/refuse, 15-row parity on both sides, renderer show/hide/submit; 2 frontend sabotages red | `test/adr0808-form-conditional-visibility.test.ts`, `__tests__/deriveFields.when.test.ts`, `__tests__/PublicFormRenderer.test.tsx` |
| suite `v2-form-when-reuses-edge-conditions`: executed-pass at major 2 (filtered lane) | `npm run test:conformance -- --filter form`, `OPENWOP_TARGET_MAJOR=2` |
