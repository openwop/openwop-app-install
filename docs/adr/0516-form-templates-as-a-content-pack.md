# ADR 0516 — Form templates ship as a `form-content` pack

Status: Accepted (Phases 1 + 2a landed; Phase 2b — registry publish — outstanding)

**Date:** 2026-08-03
**Depends on:** ADR 0017 (Forms), ADR 0347 5a (canvas-content packs — the pattern
copied here), ADR 0246 (intake binding), ADR 0011 (KB collections, for the
`catalogDependencies` precedent).
**RFC gate:** host work only — **no RFC**. See §RFC gate.

## Context

Creating a form starts from an empty field list. Every real first form is one of a
handful of shapes — Contact us, Event RSVP, Job application — so the first minutes
of the feature are spent retyping a known thing. The ask was for templates, and
specifically for templates that are **distributable via packs.openwop.dev** rather
than hard-coded, so an operator or a third party can ship their own.

## What already existed (audited before deciding)

- **`canvas-content` (ADR 0347 5a)** — a HOST-PRIVATE pack kind whose payload is a
  `kits[]` array. Each kit carries `kitId` / `version` / `label` / `description` /
  `variables[]` (typed, with defaults) / `catalogDependencies` plus its typed body,
  keyed to a target by `canvasTypeId`. **This is already a generic, parameterised
  content-template shape.** A form template is the same object with `fields[]` where
  a canvas kit has `screens[]`.
- **`features/documents/seedTemplates.ts`** — an in-tree template mechanism for
  Documents (`listSeedTemplates` / `instantiateSeedTemplate`). Not distributable.

So this is a **second instance of an established pattern**, not new ground.

## Decision

**A form template is a kit in a `kind:"form-content"` pack**, loaded by
`host/formContentPackLoader.ts` — a sibling of `canvasContentPackLoader.ts`
following its stated pattern verbatim: *scan roots, kind-filter, bounded validation,
in-process registry*, plus the clear-then-load reload and the first-root-wins
de-duplication that loader learned the hard way (AB-DATA-3).

**Instantiation goes through `createForm`, never a direct row write.** This is the
entire safety story and it is not optional — see §Security.

### Why a sibling kind rather than widening `canvas-content`

A canvas kit's body is `canvasTypeId` + `screens` + `connectors` — canvas-shaped.
Widening that kind to also carry form fields would make one loader serve two
unrelated body schemas, so its bounded validator would have to branch on kind-within-
kind. A sibling kind with its own bounded validator is cheaper and more honest, and
it keeps each loader's caps meaningful.

### Why not in-tree seed templates

Documents already has one template mechanism and canvas-content has another. A third
would be a parallel system for a concept that already has an owner — and it would
foreclose the distributable goal that motivated the request.

### Why this is NOT a workflow chain

The chains-or-stacks doctrine governs things that **run**. A form is a data
definition plus a public surface; instantiating a template is a create, not an
execution. `canvas-content` is the settled precedent that content templates are a
legitimate pack kind alongside the 55 chain packs. If a form later needs *behaviour*
on submit, that binding is `intakeBinding` (ADR 0246) and/or a chain — kept separate
from the template.

## RFC gate — none required

`host/canvasContentPackLoader.ts:1-10` is the governing precedent, and it is
explicit:

> "A **HOST-PRIVATE** pack kind … promotion of this kind to a normative cross-host
> contract is an **RFC first** (the standing ADR 0342 watch-item); until then
> **unrecognized hosts simply kind-filter these packs out**."

The pack-kind vocabulary is host-local. An unrecognised kind is skipped, not failed,
so nothing is advertised that is not honoured — the wire-honesty rule is satisfied
by construction.

**⚠️ WATCH-ITEM (ADR 0342, inherited):** the moment cross-host form templates become
a *promised contract* — i.e. another host is expected to understand
`kind:"form-content"` — that promotion needs an Accepted RFC in `../openwop/RFCS/`
BEFORE it is claimed. Recorded here so the trigger is not rediscovered later.

## Security

**Pack-sourced fields are sanitised because instantiation goes through `createForm`**
(`features/forms/formsService.ts:233-234`):

```ts
const fields = sanitizeFields(input.fields ?? []);
const intakeBinding = sanitizeIntakeBinding(input.intakeBinding, fields);
```

That matters because a form template defines a **public, unauthenticated submission
surface** (`/public-forms/:formId`). A careless or hostile template could otherwise
declare PII-harvesting fields, or an `intakeBinding` routing submissions somewhere
unexpected. Routing it through `createForm` means:

- fields are sanitised by the same code path user input takes;
- `sanitizeIntakeBinding` is validated **against the sanitised fields**, so a binding
  cannot reference a field the sanitiser dropped;
- the row is tenant/org-stamped by the caller's authorised context, never by the pack.

**A template MUST NOT carry an `intakeBinding`.** Routing submissions into a CRM list
is a decision about the operator's data, not something a third-party template gets to
make on their behalf. The loader rejects kits that declare one.

**Signing:** registry installs ride the existing Ed25519/SRI-verified installer path
(the canvas-content trust posture); in-tree/vendored packs are trusted source, the
chain-pack rule. Tombstones (`host/packTombstones.ts`) apply, so a bad template pack
can be withdrawn.

**Bounded validation** mirrors the canvas caps: at most 20 templates per pack, 40
fields per template, 12 variables. The field cap is what stops a hostile
10,000-field template from becoming a denial-of-service on the public form page.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | `formContentPackLoader` + `core.openwop.forms.starters` (in-tree) + the picker on the Forms page, instantiating through `createForm` | **landed** |
| 2a | bound the authored strings a template can ship; resolve the `placeholder` claim | **landed** |
| 2b | publish the starters pack to packs.openwop.dev via the signed flow; third-party templates | outstanding |

**The gate between them is not size — it is the first THIRD-PARTY template.** The
moment a pack the operator did not author can define a public submission surface, the
caps and the sanitiser need to be proven under adversarial input rather than under
our own starters. Phase 1 forecloses nothing: same kind, same loader, same
instantiation path; only distribution is deferred.

## Phase 2a implementation record — bounding authored strings

**Phase 2 is a security phase, not a publish step.** The installer
(`packs/registryInstaller.ts:9,141-145`) verifies **provenance** — Ed25519 + SHA-256
SRI, and it is **kind-agnostic** (verified: no `kind` allowlist anywhere in that
file, so `form-content` is covered exactly as `nodes` is). It says nothing about
**content**: a legitimately signed pack from a real publisher can still carry a 10 MB
label. That gap is what the phase gate named.

**Threat model, verified against `sanitizeFields` rather than assumed:**

| Threat | Before 2a |
|---|---|
| XSS via `label`/`options` | already covered — no `dangerouslySetInnerHTML` in `features/forms/`; React escapes |
| Envelope-key collision | already covered — `formsService.ts:168` reserves `HONEYPOT_FIELD`; `:167` key regex |
| Duplicate keys · unknown type · field count | already covered (`:169`, `:171`, `MAX_FIELDS`) |
| **`label` length** | **UNBOUNDED** — stored verbatim |
| **`options` count + per-entry length** | **UNBOUNDED** — type-filtered only |
| **`title` length** | **UNBOUNDED**, on create *and* update |
| Phishing labels, homoglyph/RTL | **not fixable by any validator** — see residual risk |

Now bounded: `MAX_LABEL` 1000, `MAX_TITLE` 200, `MAX_OPTIONS` 250, `MAX_OPTION_LEN`
200, `MAX_SUBMIT_MESSAGE` 2000.

**Two of those numbers are corrections from code-review, and the corrections matter
more than the caps.** The first draft used 200/200/100/200:

- **`MAX_OPTIONS` 100 → 250.** A country picker has ~195 entries and a currency
  picker ~180 — both ordinary form fields. At 100 a country select would have been
  **silently truncated**: a product regression wearing hardening's clothes, and
  invisible because the cap truncates rather than throws. A 195-option regression
  test now pins it.
- **`MAX_LABEL` 200 → 1000.** A GDPR consent checkbox's label IS its legal text and
  routinely exceeds 200 characters. Truncating consent copy is materially worse than
  allowing a long label — it is the one case where truncation could change meaning in
  a way that harms the reader rather than merely looking odd.
- **`submitMessage` was missed entirely** in the first pass — authored, rendered on
  the public page after submission, and completely unbounded on both create and
  update. Now capped and sabotage-verified.

The lesson worth keeping: **a silent cap set too low is indistinguishable from a
feature that does not work.** Every cap here needs a regression test proving the
LEGITIMATE maximum still passes, not just that the hostile one fails.

**Two placement decisions that carry the weight:**

1. **The bounds live in `sanitizeFields`/`createForm`, not in the pack loader.** The
   loader can only bound what a PACK ships; a hand-typed 10 MB label is the same
   attack on the same page. Bounding at the shared choke point gives pack input and
   typed input identical treatment — which is the property that makes "instantiate
   through `createForm`" worth anything.
2. **Truncate, never throw** — the `MAX_DESCRIPTION` precedent. An existing form with
   an over-long label must keep saving. A cap that threw would turn a hardening
   change into a migration. Structural problems (bad key, duplicate key) still throw;
   that distinction is tested.

Each cap is sabotage-verified **independently** — removing any one reddens exactly
one test, and a regression case asserts ordinary content is left untouched so
"truncate everything to empty" could not pass.

**A Phase-1 defect this phase found and fixed.** The loader advertised
`placeholder` on `FormTemplateField`, and the starter pack set it on 3 of 4
templates — but `sanitizeFields` never reads it, so every one was silently dropped.
`FormField` already has `description` for exactly that purpose ("help text under the
control on the public fill surface", wired to `ui/Field`'s `help` →
`aria-describedby`). `placeholder` was a duplicate concept that did nothing; it is
removed and the starters now use the field that actually persists and renders.

**Field-cap drift closed.** The loader capped at 40 while `sanitizeFields` capped at
50 — two numbers for one concept. A loader stricter than the service silently forbids
templates the product allows; the reverse lets a template through that the service
then rejects. Now one number.

**The author sees every cap.** A server-side truncation the editor does not mirror is
a UI that silently disagrees with what was typed — you write 2000 characters, save
succeeds, and 1000 come back with no signal.

> **Correction (2026-08-04).** The paragraph that stood here claimed "every other
> capped field now does the same — title 200, field label 1000, submit message
> 2000." **That was false.** Only `description` was ever mirrored
> (`FormDetailPage.tsx:332` — and the original text cited the wrong file, naming
> `FormsPage.tsx` for an input that lives in `FormDetailPage.tsx`). The editor's
> title, field-label, and submit-message inputs had NO `maxLength` at all, so the
> exact failure this section describes was live the whole time the ADR asserted it
> was fixed.
>
> A grading pass had explicitly asked whether the record overstated what was
> verified, and this survived it — a claim written in the past tense reads as
> evidence, which is why the caps are now pinned by a test that asserts the
> RENDERED DOM (`__tests__/formCapMirror.test.tsx`) rather than the constant. A
> constant that is never passed to an input is precisely the bug that shipped.

> **Second correction (2026-08-05).** The paragraph that stood here said "all four
> capped fields now carry `maxLength`". **That is no longer true, and the mechanism
> it described was wrong anyway.** `maxLength` silently discards the tail of a
> PASTE — it destroys the user's content at paste time to avoid the server
> destroying it at save time. The researched pattern is the opposite: *"This
> component does not stop the user entering information. The user can enter more
> than the character limit, but they're told they've entered too many characters"*
> (NHS/GOV.UK design system).
>
> **Note what happened here: this is the THIRD time a claim in this ADR, written
> in the past tense, outlived the code it described.** First the Phase 2a caps
> that were never applied; then the correction that fixed them; now the
> correction itself, invalidated the moment `maxLength` was removed and left
> standing. A record written as completed reads as evidence, and each time it took
> a grading pass to notice. The durable fix is not better prose — it is that
> `formCapMirror.test.tsx` asserts the rendered DOM, so the CODE is now the claim.

The four prose fields carry **no** `maxLength`. A counter appears once a value
passes 80% of its cap, reports how far OVER it is beyond that, and **the save is
blocked** with the offending fields named — the block is what makes allowing
overage safe, and without it this would be the original succeeds-but-wrong bug.
Below the threshold the counter stays hidden, which GOV.UK's own research
supports: drawing attention to it early competes with the primary task.

The field **key** keeps its `maxLength`, deliberately — it is an identifier rather
than prose (nobody pastes a key), and it is the one field the server *throws* on
rather than truncating.

## Correction (2026-08-04) — the closed catalog was advertised but not enforced

Phase 2a removed `placeholder` because "the loader advertised a field the service
never read." That was recorded as the fix. It was only the fix for one INSTANCE;
the class went un-enumerated, and the enumeration afterwards found `type` sitting
in the same trap from the other direction — advertised as a bare `string`,
validated as a bare `string`, and then **silently rewritten** by the service
(`sanitizeFields` coerces anything outside `FIELD_TYPES` to `'text'`).

The shipped starter pack was the first victim: `forms.event-rsvp.guests` declared
`type:"number"`, which does not exist. Running the real loader over the real pack
returned `LOADER ERRORS: []` — the defect was invisible to the loader, to the
tests, and to the two grading passes that had already reviewed this feature.

**Coercion is not graceful degradation, which is why this is now a refusal.**
`sanitizeFields` attaches `options` only for `'select'`, so a template declaring
`radio`/`multiselect`/`dropdown` loses its options **entirely** and a closed choice
set becomes an unconstrained free-text box on a public unauthenticated page.
A checkbox-intended type paired with `emailOptInField` instead throws a 400 naming
a field the author did declare. Neither is a smaller version of the intended form;
both are different forms.

The loader now **refuses** an out-of-catalog `type`, and a non-boolean `required`
(same family, milder: the service reads `f.required === true`, so a string `"true"`
silently makes a required field optional). It imports `FIELD_TYPES` from
`formsService.ts` rather than copying it — a second list would be the drift this
ADR already removed once at the 40-vs-50 field cap.

**Deliberate trade, recorded because it is a real cost:** refusal converts a
silently-degraded registry template into a *missing* one. For a public data-capture
surface, missing-and-named beats present-and-wrong — a refused template appears in
`form_content_pack_invalid` with the offending value, and an operator can act on it.
Granularity is per-template, so one bad template never takes down a pack.

> **Superseded (2026-08-05) by RFC 0137.** The paragraph below said the absence
> of a `number` type was "not an RFC gap." That was wrong, and the spec corpus
> corrected it: `form-content` is now a publishable declarative pack kind
> (`RFCS/0137-form-content-packs.md`, `Active`), and its `fields[].type` reuses
> the RFC 0071 portable subset — which **includes** `number`. The host gained the
> type in #2966; the RSVP starter's `guests` field has its honest type back
> instead of a count forced into a bounded select.

The absence of a `number` field type is **not** an RFC gap: forms is a
host-extension feature (ADR 0017 + 0330) under `/v1/host/openwop-app/*`, never on
the wire. Adding one later is host work plus an ADR.

## Residual risk — stated, not solved

**A hostile template can still phish.** A `label` reading "Enter your password to
verify" is well-formed, bounded, correctly typed, and renders perfectly. No validator
catches intent. Homoglyph and RTL-override text in labels are the same class. These
are **curation problems**, not loader problems — they need a review step before a pack
is listed, which is registry policy. Do not let the caps above create the impression
that third-party templates are *safe*; they are *bounded*.

## Falsifiability

If form templates ever need to carry **behaviour** — conditional logic, computed
fields, on-submit actions beyond `intakeBinding` — they stop being content and the
chains-or-stacks doctrine reclaims them. Check any proposed template set against that
line before extending this kind; "job application with conditional follow-ups" is
exactly the case that would flip it.


## RFC 0137 — the wire contract this ADR now rides (2026-08-05)

Publishing `core.openwop.forms.starters` was blocked on something no signing key
could unlock: `form-content` was not a publishable pack kind. The canonical
`registry-version-manifest.schema.json` carried a **closed** `kind` enum, did not
declare `templates`, and gated payloads behind an `anyOf` that had no `templates`
branch — so the pack signed cleanly, passed all 8 local registry gates, and was
**rejected by CI**.

That is a spec change, not host work. `RFCS/0137-form-content-packs.md` (`Accepted`,
openwop#882 → #887) closes it, and two of its rulings overturned decisions recorded here:

1. **Field types are WIRE-normative, not host-owned.** This ADR assumed the closed
   catalog was a host UI concern. It is not: `chat-card-packs.md` §"Input fields"
   already defines a closed portable subset for exactly this problem (RFC 0071
   Phase 2, gap G9), and the "unrecognized type MUST degrade to plain text"
   interop contract is only expressible *because* the enum is on the wire.
   Host-owned would mean no degradation contract, hence no portability, hence no
   point publishing. `form-content` reuses that subset verbatim rather than
   minting a second one.
2. **`email` is a validation FORMAT, not a data kind.** The wire says
   `{"type": "text", "format": "email"}`.

**The host does NOT adopt wire names in storage.** `/architect` ruled the wire
enum governs the wire; translation happens once, at the pack boundary
(`formContentPackLoader.wireFieldToHost`). Renaming stored types would mean, on
the next ordinary save of an existing tenant form, a stored `checkbox` coerces to
`text` — and `emailOptInField` **requires** `checkbox` and throws 400, so **every
form with a marketing opt-in becomes unsaveable** (ADR 0338 consent machinery).
`textarea` would collapse to single-line and `email` would lose validation on a
public page. Zero stored rows move. `id` → `key` is wire-only for the same
reason: `FormField.key` is the submission value key and `intakeBinding` maps by
it.

Still open before RFC 0137 graduates `Active → Accepted`, which needs a
reference-host witness: the F1 trust boundary (escaping + `meta.contentTrust:
"untrusted"` propagation — length bounds are explicitly **not** a trust boundary),
and a non-vacuous capability-gated conformance run under
`OPENWOP_REQUIRE_BEHAVIOR=true` against suite `1.59.0`.


## RFC 0137 §F1 — the trust boundary, and the hole it does NOT close (2026-08-05)

F1 says pack-authored strings and template-collected values are untrusted when
they reach a prompt: *a signature proves WHO authored a pack, not that the bytes
are safe*, and *length bounds are not a trust boundary* (so the #2941 caps are a
render-bomb guard only).

**Implementing it exposed a larger gap than the RFC asks about.** Feature
agent-tool results were **not fenced at all** — `conversationToolLoop.ts` carries
zero `contentTrust` references. `mcpClient.ts` fences inbound MCP content and
`agentDispatch.ts` fences knowledge, but nothing guarded the tool-result path. A
form label reading *"Ignore previous instructions and…"* reached the model as
ordinary prompt text.

**Marked at the SINK, not the source** (`/architect`). `submission.values` is
`Record<string, string|number|boolean>` with nowhere to put metadata, and there
are FIVE registered submission sinks (crm, webinars, funnels, email,
service-desk) plus the priority-matrix intake path — threading a flag through all
of them and their downstream stores is exactly the fan-out where **missing one is
worse than marking none**. The tool result is one choke point.

So: `BuiltinTool.contentTrust` is declared per tool and fenced once in
`createAgentToolProvider().executeTool`. Declaration-driven rather than blanket,
because most builtin results ARE host-authored — fencing a schema lookup would be
both wrong and noisy (the codebase already distinguishes tool-output classes via
`SCHEMA_READ_EXEMPT_TOOLS`).

**`originTemplate` turned out to be irrelevant to the values arm, and that is the
stronger reading.** A submission through a HAND-AUTHORED public form is exactly as
attacker-controlled as one collected through a template. RFC 0137 phrases the
obligation around templates because an RFC can only legislate its own kind — not
because hand-authored submissions are safe. Fencing by *tool*, not by provenance,
is simpler and covers more.

### Open risk — `FRMD-F1-1`: sibling tools launder the taint

- [ ] `FRMD-F1-1` (Improvement) **The forms fence is defeated by reading the same
      content through a sibling tool.** `features/crm/agentTools.ts`,
      `features/service-desk/agentTools.ts`, and
      `features/priority-matrix/agentTools.ts` return records the forms submission
      sinks WROTE — the same attacker-controlled bytes, reachable by a different
      tool id, still unfenced. RFC 0137 cannot reach them without over-claiming
      its scope (they are not form-content packs), so this is recorded rather
      than silently inherited. The fix is the same one-line declaration per tool,
      but each needs its own judgement about whether its result is
      externally-authored — a blanket sweep would fence host-authored rows too.
      Effort: M. Blast radius: any agent summarizing CRM/desk/matrix content.


## Closed — RFC 0137 `Accepted`, pack published (2026-08-05)

**RFC 0137 is `Accepted`** (openwop#887, `00e91b2d`) and
**`core.openwop.forms.starters@1.0.0` is live** on packs.openwop.dev
(openwop-registry#43) — the first `form-content` pack on the registry.

Graduation required a reference-host witness, and this host is it: 4/4
`form-content-instantiation` legs pass under `OPENWOP_REQUIRE_BEHAVIOR=true`
against suite 1.61.0.

**The evidence is recorded with its real shape, not as "4/4 PASS".** A sabotage
host — capability advertised, seam wired, NO templates registered — reds legs #1
and #2, which is what makes their pass mean something. But #1/F2 and #3 assert
ABSENCES (no routing, nothing locked) that a refusing host also satisfies, so
that sabotage does not discriminate them; they are witnessed by the upstream
5-mode stub's `routed`/`locked` modes instead. All four legs are witnessed by
**two complementary harnesses rather than one**, and the RFC's own record says so
in those terms.

### What building the witness exposed

- **Feature agent-tool results were not fenced at all.** `conversationToolLoop`
  carried zero `contentTrust` references; `mcpClient` fenced MCP and
  `agentDispatch` fenced knowledge, but the tool-result path had no boundary. F1
  is the RFC's ask; this was strictly larger.
- **The fence belongs at model-message construction, not tool execution.** The
  first attempt fenced inside `executeTool` and broke a legitimate `JSON.parse`
  consumer — that result is a structured contract. Two model-facing sites, not
  one: `runChatToolLoop` (five paths collapse into it) and the voice realtime
  bridge, which calls `executeTool` directly and bypasses the loop.
- **A capability can be advertised and still be invisible.** Spelling the flag
  the way this host spells every other one would have soft-skipped all four legs
  and produced a green that witnessed nothing.
- **Publishing needed more than a signature.** The registry's vendored schema was
  stale, and the pack declared a HOST engine (`openwop-app`) instead of the
  protocol — inert locally, fatal at publish.

### Still open, tracked upstream

- **G13** — the corpus has no general "a tool result is untrusted content" rule.
  `FRMD-F1-1` (sibling `crm`/`service-desk`/`priority-matrix` tools return
  records the forms sinks WROTE — same bytes, different tool id, unfenced) is the
  concrete instance. Needs its own RFC; RFC 0137 cannot reach it without
  over-claiming.
- **G14 / capability spelling** — this host emits `artifactTypes` at the document
  root; `readArtifactTypesCap` reads the dotted `host.artifactTypes`. **Placement
  is conformant** (every family is mirrored at root, verified against a booted
  host); the gap is the NAME. So the RFC 0071 artifact-type behavioral legs have
  never run against this host, and moving to root-level advertisement will not
  fix it. Awaiting a corpus decision on whether helpers should accept the plain
  family name.
