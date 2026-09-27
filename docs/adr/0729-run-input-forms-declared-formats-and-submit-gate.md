# ADR 0729 — The run-input form tells the user a value is invalid, then submits it anyway

Status: implemented

**Feature:** Run input forms (`FEATURES.md` ordinal 223) · ADR 0197/0434 · feature-loop 2026-09 it.55
**Closes:** `RIU-1` (grade-ux 2026-08-28) and `RIC-2` (grade-code 2026-08-28) — two halves of ONE defect

## Context

When a workflow declares an `inputSchema`, the launch surface renders a typed form. The form validates what it renders: `validateInputs` (`lib/formEngine.ts:105-136`) checks required, number, integer, enum, **email** (`EMAIL_RE`) and **uri** (`new URL()`), and `SchemaInputForm` renders a localized per-field error for each (`:43,88`).

**Nothing acts on those errors.** `SchemaInputForm` computes `errors` and never reports validity upward; `RunsIndexPage.onSubmit` (`:223`) parses the JSON and posts. So the product shows the user "that is not a valid email", in their language, beside the field — and then submits the value.

And the server does not catch it either: the run-input gate compiles with `validateFormats: false` (`host/runInputValidation.ts:17`), so a declared `format: email` is enforced **nowhere**. The two filed rows are the two ends of the same hole:

| filed as | where | what it is |
|---|---|---|
| `RIU-1` | client | the inline error is advisory; submit is not gated |
| `RIC-2` | server | `format` is declared but enforced nowhere at the gate |

A value the app has already told the user is wrong should not reach a run. Today it reaches the executor.

### Measured blast radius

`ajv-formats@^3.0.1` is **already a dependency** — enabling formats needs no new package. Walking structurally for `format` in SCHEMA position (beside `type`/`enum`) across `packs/`, `examples/` and both `src` trees: **25 `inputSchema` objects, ZERO formats.** So server-side format enforcement changes the behaviour of **no shipped workflow**.

**An unknown format cannot break a schema — probed, not assumed.** The dangerous version of D2 would be one where a schema declaring `format: "sku"` (a name Ajv does not know) throws at compile time, because the gate's existing fail-open `catch` would then drop validation ENTIRELY for that workflow — D2 weakening validation, the opposite of its intent. Measured on this host's Ajv 8 + `ajv-formats` v3 with `strict:false`: an unknown format **compiles and is ignored** with a console notice; a known format is enforced (`"nope"` fails `format: email`, which today passes). D2 is therefore additive-only: schemas declaring a known format gain enforcement, every other schema is untouched.

**The tenant-facing half IS a behaviour change, and is not measurable from this repo.** The builder authors `inputSchema` as raw JSON (`builder/inspector/WorkflowInspector.tsx`, `JSON.parse(raw)`), so tenants can declare formats nothing here can see. A saved workflow declaring `email`/`uri`/`date-time` will 400 on values accepted the day before. That is the intent of the fix — a declared format is a contract the author asked for — but it is stated here rather than discovered in support. D2 is two lines and reverts independently of D1, whose risk is UI-local.

## Decision

### D1 — the form gates its own submit, and moves focus to the first invalid field

`SchemaInputForm` reports validity to its owner; `RunsIndexPage` refuses to submit while the schema form has errors and focuses the first invalid control instead.

**The gate is MODE-SCOPED, and that is load-bearing.** `SchemaInputForm` holds real `mode` state (`:36`), and the gate reads it: in `json` mode the form reports itself submittable, because a user who switched to "Edit as JSON" has explicitly left the typed form and that is the documented way to post something the form would reject. Without this the escape hatch quietly closes, so a witness leg pins it.

**It cannot over-block, which is what makes gating safe at all.** `deriveFields` (`lib/formEngine.ts:77`) walks only top-level `properties`; nested objects, arrays and unions degrade to a `json` kind that `validateInputs` does not check, and `isRenderableSchema` (`:53`) falls back to the raw textarea unless the schema is an object with properties. The form therefore UNDER-reports and never over-reports — it can only block a payload it has already told the user is wrong. (The one sharp edge, `uri` validated with `new URL()`, rejects relative URIs, which matches JSON-Schema's own absolute-URI rule.)

### D2 — the run-input gate enforces a declared `format`

`addFormats` is registered on the run-input Ajv instance and `validateFormats` becomes `true`, so `format: email` / `uri` / `date-time` are enforced where the schema declares them. This is the same courtesy gate ADR 0197 established (fail-open on no/uncompilable schema); it now honours the whole of what a schema says rather than the parts Ajv checks by default.

**With a logger, because the notice lands on a hot path.** Ajv emits its unknown-format notice on every COMPILE, and this file already documents (in `RIC-1`'s dedupe comment) that the ADR 0474 published-launch path deserializes a FRESH `inputSchema` object per request — defeating the `compiled` WeakMap. A tenant schema with a custom format would otherwise log once per run-create. The Ajv instance therefore gets a `logger` routed through the module logger and de-duped by schema content, reusing the mechanism `RIC-1` already established rather than inventing a second one.

### D3 — the envelope path is NOT touched, deliberately

`host/envelopeAcceptor.ts:62-66` documents a considered position: it avoids registering `ajv-formats` and says hosts wanting strict format validation should register it themselves. That path is wire-adjacent and RFC-governed; this ADR changes the host's own run-input courtesy gate only, and leaves that policy and its reasoning intact. The other `validateFormats: false` instance (`features/cdp/eventSchemaService.ts:17`) is likewise out of scope — a separate surface with its own contract.

## Alternatives weighed
- **Document the asymmetry instead (the `RIC-2` row's second option).** Rejected: the client already renders a localized "invalid email" error, so documenting would mean writing down that the product knowingly accepts what it tells the user is wrong.
- **Make the client error a hard block only, leaving the server lax.** Rejected: it fixes the form and leaves every non-form caller (API, MCP, a programmatic run-create) posting unvalidated values against a declared contract.
- **Enforce formats globally across all Ajv instances.** Rejected: `envelopeAcceptor` has a documented, wire-adjacent reason to stay as it is, and a blanket change would overturn it silently.

## Known divergence, named rather than silently left

This host now has three Ajv instances with three format policies, and that is a deliberate state rather than drift:

| instance | policy | why |
|---|---|---|
| `host/runInputValidation.ts` | formats ENFORCED (this ADR) | a host courtesy gate over an author-declared contract |
| `host/envelopeAcceptor.ts` | formats off, documented | wire-adjacent and RFC-governed; `:62-66` records the position and tells hosts wanting strict formats to register `ajv-formats` themselves |
| `features/cdp/eventSchemaService.ts` | formats off | a separate surface with its own contract; not examined here |

The CDP instance is the one with no recorded reasoning; it is left alone and noted so the next reader sees an open question rather than an accident.

## RFC verdict

Host-only. ADR 0197 established this gate explicitly as a host courtesy, not a wire rule (`runInputValidation.ts:1-6`). No capability advertisement, run-event field or endpoint contract changes. No RFC.

## Implementation plan

| Phase | Change | Witness |
|---|---|---|
| D1 | `SchemaInputForm` reports validity; `RunsIndexPage` gates submit + focuses the first invalid field | a form with an invalid email does not submit, and focus lands on that field |
| D2 | `runInputValidation.ts` — `addFormats(ajv)` + `validateFormats: true` | a declared `format: email` 400s on a bad value; a schema with no `format` behaves exactly as before |
| D3 | — | a test pins that the envelope acceptor's policy is unchanged, and that JSON mode still submits what the form would reject |

## Review record

An adversarial `/architect` pass on this text before implementation returned **0 Blockers and 3 SHOULDs**, all folded in: the Ajv logger on the fresh-schema launch path, the mode-scoping of the submit gate (with a witness), and stating the tenant-facing behaviour change explicitly. The pass independently reproduced the zero-format count and ran the Ajv probe that establishes an unknown format is ignored rather than thrown — the fact D2's safety rests on.

## Implementation record

Landed in one PR. Witnesses: `backend/typescript/test/run-input-declared-formats.test.ts` (5 legs, born red on the format leg) and `frontend/react/src/runs/__tests__/schemaInputFormGate.test.tsx` (3 legs, born red on 2 — the gate AND the escape hatch).

The unknown-format leg is the one that earns D2 its safety: it asserts that a schema with an unrecognised format still validates the REST of itself, which is what proves the guard survived rather than being silently dropped through the fail-open catch.

## Open questions
- [ ] `RIU-2` (the server 400 is surfaced as a raw SDK message, not field-mapped or localized) stays open; with D1 in place the common case no longer reaches it, which lowers its frequency but not its rudeness.
