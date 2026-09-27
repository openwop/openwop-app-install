# ADR 0749 — A2UI v0.9 surfaces at major 2 (RFC 0209)

Status: implemented

- **Implements:** openwop RFC 0209 (`Active`, 2026-09-22) — `ui.a2ui-surface` per-kind
  schema version 2 carries A2UI v0.9 messages; the 0.9.1 tree stays readable.
- **Wire:** rides an `Active` RFC whose shape is locked and which does not gate
  advertisement, so no new RFC. Host honours the behaviour it now advertises
  (see §Witness).
- **Program:** RFC witness program 2026-09, workstream WS5.

## Context

RFC 0209 gives openwop-app two jobs. The first is the one the RFC assigns to it by
name: a render-side probe that a v0.9 surface does not render until its fold holds
`root` (`openwop.requirement.0209.render-needs-root`, `tier: reference-impl`). The
second is optional, and the steward adopted it: make this host the behavioural witness
for the seam-gated rows. Those are `version-selects-branch`, `fold-guarded`,
`catalog-equality`, `legacy-readable` and `taint-sticky`.

What the code looked like before this ADR (measured at `bfd8b8545`):

- The v2 discovery root advertised no `supportedEnvelopes`, `schemaVersions` or
  `envelopeStrictness`. Under `events.md` §"The envelope-kind catalog", an absent
  catalog means "refuse every non-universal kind", so at major 2 this host claimed
  nothing about `ui.a2ui-surface`.
- `acceptEnvelope` validated every kind against the v1 file
  (`schemas/envelopes/<kind>`), whatever its `schemaVersion`. It ran the floor check
  *after* payload validation.
- The only emit seam was the v1 one (`{runId, surface}`, schema version forced to 1).
  The v2 seam address aliased onto it, which is a different contract (WS0 turns that
  alias into a 404).
- The chat renderer understood the 0.9.1 tree only.

## Decision

### Server

**D1 — one admission path.** `host/a2uiSurfaceAdmission.ts` `admitA2uiSurface` is the
only way a `ui.a2ui-surface` envelope enters a run under the major-2 catalog. It runs:

1. the catalog: kind, then floor, then strictness, composed inside `acceptEnvelope`
   (still the host's one envelope validator);
2. the §A.2 cross-field rules;
3. the §C.9 fold guard;
4. an append to the real run event log.

The catalog values live in the constant `V2_A2UI_ENVELOPE_CATALOG`. Both the admission
path and the discovery advert read that constant, so the advert cannot claim anything
the admission does not enforce.

**D2 — the version selects ONE branch, and the floor is read first.** For
`ui.a2ui-surface`, `acceptEnvelope` compiles `$defs/payloadV1` and `$defs/payloadV2`
from the vendored `schemas/v2/envelopes/ui.a2ui-surface.schema.json` as separate
validators. It never compiles the `anyOf` union. A version with no branch (≥3) fails
closed.

The floor check moved ahead of payload validation, as `events.md` requires ("one flow,
read in that order"). The version the catalog settles is what picks the branch:
- an above-floor envelope reports `unknown_schema_version`, not `envelope_invalid`;
- a below-floor `warn` envelope is validated against the *advertised* version.

`payloadV1` is byte-identical to the v1 file, so a version-0 or version-1 envelope is
judged exactly as before on both majors. Only an envelope that is invalid *and*
off-floor now reports a different reason.

**D3 — what gets recorded.** An admitted envelope is appended as a run event of type
`ui.a2ui-surface`:
- the root `nodeId` is the envelope's `nodeId`, which is the binding;
- the payload is the whole admitted envelope, with a normalized `meta.contentTrust` and
  an SR-1-redacted `payload`.

The version-1 seam keeps its flat recorded shape, because the RFC 0114 delta transport
reads it.

**D4 — the fold is derived, never stored.** The fold guard and the taint check both
fold the run's recorded version-2 envelopes back out of the event log. There is no
side table and no migration. A `:fork` copies the `[0, fromSeq)` prefix, so it folds
exactly the prefix (§C.11).

Read-fold-append is serialised per run, in process. That is sufficient today because
the only emitter is the env-gated seam (see Residual R1).

**D5 — taint is sticky, and it is checked at the one resume choke point.**
`resolveAndResume` refuses an `approval` interrupt when any version-2 surface bound to
its node carries an untrusted envelope anywhere in its recorded history. The refusal is
`403 untrusted_content_blocks_approval`; at major 2 the code is vendor-prefixed,
because it is not in the v2 registry.

Why that location: every human path goes through `resolveAndResume` (both resolve
routes, the email action, `/reviews`, MCP), so no path can route around the check.

What is refused:
- **Every resolution, not only `accept`.** Approval actions are gate-defined strings,
  so "which one is safe" is not a judgement to leave to an untrusted surface.
- **A deleted surface still taints.** Failing closed costs nothing here.

The fail-safe exits stay open: cancelling the run, and the gate's own timeout
auto-reject (which writes the store directly and does not pass through this check).

**D6 — the v2 seam has its own handler.** `emitA2uiSurface` takes `{runId, envelope}`,
while the v1 seam takes `{runId, surface}`. The body shapes differ, so the seam gets a
separate route (`/v1/host/openwop-app/a2ui/v2/emit-surface`) rather than sniffing the
body.

Its alias is the first rule in `SEAM_ALIASES`, so it is matched before the generic
`sample/` rule. It rewrites into `/v1/host/sample/…`, which keeps `guardSeam` on it.
It is listed in `SEAM_OPERATIONS` (`served: true`, `floor: false`).

The run is addressed by its tenant-bound wire id (`<tenant>/<opaque>`). The seam
decodes that id and holds the run to the tenant it names. The seam space has no tenant
context, so `loadOwnedRun` would refuse every run. A terminal run answers
`409 run_terminal`.

**D7 — the advert goes last, in the same PR.** The v2 root now carries three records,
all printed from `V2_A2UI_ENVELOPE_CATALOG`:

- `supportedEnvelopes {kinds: ["ui.a2ui-surface"]}`
- `schemaVersions {kinds: {"ui.a2ui-surface": 2}}`
- `envelopeStrictness {mode: "warn"}`

`media.*` is **not** listed. Nothing at major 2 admits it, and the v1 root keeps that
claim. `a2uiSurface.deltaTransport` is **never** advertised at major 2
(RFC 0209 §D.15). The v1 root keeps a floor of 1. The two majors are separate
contracts, so different floors for one kind on one host is correct.

### Frontend

**D8 — the v0.9 renderer lives inside the existing chat card.** No new panel.
`A2uiSurfaceCard` dispatches on the shape of the payload:
- `version: "v0.9"`, or `{surfaces: [...]}` (several envelopes of one surface, folded
  in order), goes to `v09/A2uiV09Surface`;
- everything else stays on the 0.9.1 renderer, unchanged (legacy-readable).

`interruptBridge` carries a v0.9 payload out of interrupt data. It keeps only the
payload's own keys, because the closed profile would refuse the free-text `question`
fallback.

The renderer is split into three modules:
- `v09/profile.ts` is the fail-closed allowlist of the ten components. It mirrors
  `$defs` and is parity-pinned to the vendored schema by a test.
- `v09/fold.ts` is the pure fold (JSON-Pointer set/remove, prototype-chain tokens
  refused).
- `v09/A2uiV09Surface.tsx` walks from `root` with cycle and depth guards.

Craft decisions (frontend-design pass):
- **`primaryColor` is ignored.** An agent-supplied color painted into app chrome is a
  way to dress an untrusted surface as the host's own UI.
- **`agentDisplayName` is shown** as a one-line provenance note.
- **Agent headings are `role="heading"`**, offset below the chat's outline, as in the
  0.9.1 renderer.
- **Controls use existing primitives.** `chips` become small `ui/Button` toggles with
  `aria-pressed`, because a raw chip button is ratcheted debt. Everything else uses
  `ui/Field` primitives and tokens only.
- **`validationRegexp` is never evaluated in script** (ReDoS, RFC 0209 unresolved
  question 2). Only the pure `required` check gates submission.

A Button submits its `event.context` resolved against the data model, or the whole
model when it has no context (§C.10).

## /architect verdict (recorded before code)

Tracks A and B together: the change is host code, and it also advertises on the wire.

| Decision | Verdict | Note |
|---|---|---|
| D1 single admission path | accept | composes the existing acceptor; no second validator |
| D2 floor-before-payload | accept | spec-ordered; v1 lanes re-run as the tripwire (payloadV1 byte-identical) |
| D3 record the whole envelope | accept | the poll must return the payload byte-equal; key order is preserved because the payload object is carried unchanged |
| D4 derived fold + in-process lock | accept with residual | no migration and fork-safe by construction; multi-instance arbitration is owed once a production emitter exists |
| D5 taint at `resolveAndResume` | accept, **scope widened** | the design had placed the check in three routes; the review moved it to the shared choke point after finding `/reviews`, MCP and inbound-webhook resumes that the per-route plan missed |
| D6 own handler | accept | a body sniff would make one route serve two contracts |
| D7 kinds = `["ui.a2ui-surface"]` | accept | an absent catalog and a catalog without `media.*` make the same claim about `media.*` (refuse it). Only the kind with a major-2 admission path belongs in the list |
| D8 renderer in the existing card | accept | the single-chat rule |

Blocking issues: none. One fix was applied before code: the D5 scope change.

## Witness (local major-2 lane, 2026-09-24)

`OPENWOP_TARGET_MAJOR=2 npm run test:conformance -- --filter "RFC 0209"`, suite 2.36.1:

| Row | Result | Sabotage (the row went red) |
|---|---|---|
| `0209.version-selects-branch` | pass | validate against the `anyOf` union |
| `0209.fold-guarded` | pass | fold guard disabled |
| `0209.catalog-equality` | pass | cross-field catalog check disabled **and** payload validation skipped. With validation on, the schema's single-member `catalogId` enum refuses the foreign id first, so the cross-field check is defence for the day the enum widens |
| `it.…surface-id-equality` | pass | cross-field surfaceId check disabled |
| `0209.taint-sticky` | pass | taint check disabled |
| `0209.legacy-readable` | inapplicable | needs a floor of exactly 1; this host's v2 floor is 2 |
| `it.…recorded-as-recorded` | **red** | at 2.36.1 this was a corpus defect: the leg forked at a `fromSeq` that named no event. At 2.38.0 it was a host gap: the fork landed in a suspended checkpoint and got `501 fork_checkpoint_unsupported` (R4). *Passes since ADR 0751.* |
| `0209.render-needs-root` | pass (`a2ui-v09-render-needs-root.test.tsx`) | `renderable: live` without the `root` condition |

## /code-review findings and dispositions

An independent reviewer read the diff cold. Every finding was applied or is recorded
as a residual below.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | The fold and taint classified recorded events by the envelope's `schemaVersion` stamp. A version-1 stamp on a v0.9 body (admitted under `warn`) escaped both | **fixed**: classify by the validated body; a test covers it |
| 2 | HIGH | The MCP `requestState` path CONSUMES the interrupt before `resolveAndResume`, so a taint refusal stranded it | **fixed**: `assertApprovalSurfaceTrusted` runs before the claim |
| 3 | HIGH | Timer sweep vs the 403 | verified exempt: the sweep resolves only `kind: timer`, and the check fires only for `approval`. The comment now names both claim paths |
| 4 | MED | The taint/fold read used the request's contract, so an era-2 `ui.a2ui-surface` row could 500 a v2 approval | **fixed**: read in host vocabulary (`contract: 1`) |
| 5 | MED | An absent `schemaVersion` skipped the floor check | **fixed**: absent is 0 (`ai-envelope.schema.json`) |
| 6 | MED | No correlation dedup | **fixed**: a recorded `correlationId` returns the recorded outcome |
| 7 | MED | Callers that pass no floor now judge version ≥2 against its branch | intended: a version-2 body is validated as version 2 everywhere. Version 0 and 1 are unchanged |
| 8 | MED | The recorded payload is the raw one (no normaliser exists for this kind), and the seam passes no SR-1 canaries | residual **R5** |
| 9 | MED | `MessageFeed` resolved on every action, including `exchange` | **fixed**: `exchange` routes to the card's registered exchange handler |
| 10 | MED | Advert unconditional while only the env-gated seam admits | **fixed**: `a2uiV2AdmissionReachable()` gates the three records |
| 11 | LOW | Seam tenant check: a leading `/`, and the self-compare | **fixed** |
| 12 | LOW | `c.id in literals` hit the prototype for ids like `constructor` | **fixed**: `Object.hasOwn`; a test covers it |
| 13 | LOW | A11y: empty button name; fieldset error not described; single-choice chips as toggles; a11y label overriding visible text | **fixed**: recursive text label with fallback, `aria-describedby`, `radiogroup`/`radio`, visible text wins |
| 14 | LOW | ISO values don't seed native date inputs; duplicate child keys | **fixed** |
| 15 | LOW | `partial: true` not honoured | residual **R6** |
| 16 | LOW | The remount key missed same-length replacements | **fixed**: keyed on the serialised fold |
| 17 | LOW | Removing below a missing parent conjured `{}` parents | **fixed** |
| 18 | LOW | Parity test pins keys, required sets and enums, not limits | residual **R7** |
| 19 | LOW | No visible untrusted indicator | residual **R8** |

## Browser pass (2026-09-26, follow-up)

The v0.9 card was rendered in headless Chromium through a throwaway harness page that
was not committed. The page used the real stylesheet and `A2uiSurfaceCard` with every
profile component, and was captured in light and dark (screenshots differ; the root
carried the `theme-dark` class). The ARIA tree was walked, and one surface was filled
in and submitted.

Findings, all fixed:
1. A fieldset `<legend>` rendered in body type beside mono-uppercase field labels.
   Fixed with `legend.field-label` in the label register (`global.css`) and zero
   padding.
2. Single-choice chips carried `role="radio"` without the arrow-key/roving-tabindex
   contract a radio group promises. They are now `aria-pressed` toggles named by the
   group legend.
3. A failing required check disabled the `exchange` button too, so "Ask a question"
   was blocked until the form was complete. Only `resume` is gated now.

Verified with no change needed:
- the agent's `primaryColor` does not leak into the page;
- headings are `role=heading` at level 5 for an h2, and there is no real `h1`–`h3`;
- the focus ring is visible in dark mode;
- submit resolves with the whole data model when the button has no `context`.

## Residuals

- **R1 — cross-instance fold arbitration.** The per-run lock is in-process. A
  production emitter on a multi-instance deployment needs the store to arbitrate, for
  example with a unique `(runId, surfaceId, generation)` claim. The only emitter today
  is the env-gated seam.
- **R2 — era-2 logs read at major 2. RESOLVED (2026-09-26, follow-up PR).**
  `ui.a2ui-surface` has a v1 spelling but no valid v2 one. Its first segment `ui` is
  not a registered org, and RFC 0209 §D.14's `ui.*` carve-out covers envelope *kinds*,
  not event *types* (events.md §Types). As a result, an era-2 log failed every major-2
  read with `500 event_type_unmapped`, and an era-3 log served an invalid type.

  The `/architect` options pass:

  | Option | Verdict |
  |---|---|
  | (A) pass `ui.*` through verbatim | rejected: emits a type that fails v2 validation |
  | (C) project the legacy payload into v0.9 | rejected: rewrites recorded history, which breaks replay byte-equivalence |
  | (B) host vendor spelling row | **chosen** |

  Option (B) is a host-owned codemap row, `ui.a2ui-surface` ⇄
  `openwop-app.a2ui-surface`, in `storage/eventEra.ts` `HOST_VENDOR_ROWS`. It follows
  the ADR 0682 precedent, and ADR 0688's "does the protocol already name it?" check
  finds no codemap row for a recorded surface. The row is consulted by both the writer
  and the reader rule, and only the type's SPELLING is translated:
  - the payload is byte-equal on poll, SSE and `:fork`;
  - the v1 wire still reads `ui.a2ui-surface` from either era;
  - an era-3 row written before the fix is forwarded too.

  The row refuses to load if it ever collides with a corpus row. If the corpus
  registers a protocol type for recorded surfaces, retarget the row to it; that is a
  steward question RFC 0209 leaves open.

  **Data note (end-grade-data).** From this merge on, an era-3 append stores
  `openwop-app.a2ui-surface`, and an era-3 row written earlier keeps
  `ui.a2ui-surface`. A run that spans the deploy therefore holds both spellings.
  Every reader goes through `toContractVocabulary`, which folds them, but raw SQL or a
  probe filtering on `events.type` MUST match both.

  Witness: `test/adr0749-r2-legacy-surface-event-readable.test.ts`. It plants the
  real pre-change row (the v1 emit seam's exact shape) through `seedEra2EventLog`. It
  went red in all three legs with the row removed.
- **R3 — no production v0.9 producer.** The KickBot `a2ui-clarify` node still emits
  the 0.9.1 tree. The renderer and admission are ready for a node that emits v0.9.
- **R5 — SR-1 on the seam.** Admission accepts `byokCanaries` and records the
  redacted payload, but the seam has no run secret scope to draw canaries from.
- **R6 — `partial`.** Interrupt-borne surfaces are final by construction. A
  streaming emitter must thread the envelope's `partial` into the card so actions
  stay disabled until it finalises.
- **R7 — limit parity.** The render profile's `maxLength`/`maxItems` values match the
  schema today but are not test-pinned.
- **R8 — trust in the UI.** The card cannot see `contentTrust`, because interrupt data
  does not carry it. An untrusted surface finds out only through the 403 on resolve.
- **R4 — the known-red leg.** *(Corrected 2026-09-25 at the 2.38.0 pin.)* This row was
  first read as a corpus defect: the leg forked at a `fromSeq` that named no event.
  Suite 2.38.0 (openwop#1538) fixed that, and the leg now forks at a later recorded
  envelope. That fork lands inside the suspended `conformance-approval` run, and this
  host refuses it with `501 fork_checkpoint_unsupported`: `snapshotFromEventPrefix`
  returns null for any prefix that has an open interrupt. `replay.md` licenses no such
  refusal, so this is a **host** `:fork` gap. It is outside A2UI's scope and stays
  admitted until a fork can inherit an open interrupt.
  > **RESOLVED 2026-09-25 by ADR 0751.** A fork at a suspended checkpoint now
  > inherits the open gate as state (fresh token, the source's deadline) and
  > resumes through the normal resolve path; `fork_checkpoint_unsupported` is
  > retired. `recorded-as-recorded` passes on main's code and the known-red line
  > is deleted in the same change.

## Phase → commit

| Phase | Commit |
|---|---|
| Reserve | `d9d12b9a9` |
| Server admission, branch, fold guard, taint, seam | `9e3183386`, `0bcc31e99` |
| v2 advert (last) | `bee150567` |
| Frontend renderer + render-needs-root | `13d5b2910` |

## Follow-up (2026-09-26, ADR 0755 — END `/grade-code` pass)

- **The renderer had no expansion bound (Blocker, WIT-A2UI-1).** `children` may
  legally repeat an id, and `render`/`textOf` guarded only cycles and depth, so
  four components (root→256×a, a→256×b, b→256×c) expanded to ~16.7M elements and
  froze the tab. The card now refuses a surface whose expansion exceeds
  `MAX_RENDER_NODES = 2048` (4 × the 512-component profile cap) with the same
  fail-closed `a2uiUnsafe` notice as a profile refusal (new reason
  `a2uiV09RejectTooLarge`, four locales), via a counted walk that stops at the
  budget; the renderer's own walks also stop spending past it. Witness:
  `a2ui-v09-render-budget.test.tsx` (sabotage: disabling the pre-check reds it).
- **The approval-resolve taint read is skipped where nothing can record a v0.9
  surface (WIT-A2UI-4).** `assertApprovalSurfaceTrusted` read the run's whole log
  on every approval resolve for rows only `admitA2uiSurface` writes, whose only
  caller is the env-gated seam; it now returns early when
  `a2uiV2AdmissionReachable()` is false — the predicate a production emitter
  flips on, so the two move together.
- **The §C.12 block is now route-witnessed (WIT-A2UI-5).**
  `test/adr0755-a2ui-approval-taint-route.test.ts`: the run-scoped resolve answers
  `403 untrusted_content_blocks_approval` with the interrupt still open; the MCP
  `resumeInterrupt` refuses before its claim; a trusted control is not refused.
- `foldKey` (a `JSON.stringify` of every message on every feed render) is memoised
  with the parse and fold on payload identity (WIT-A2UI-7).
- **Not changed — the envelope's own `contentTrust` still outranks the run
  boundary (WIT-A2UI-2).** `ai-envelope.md` §"Trust boundary" states a meet rule
  ("one untrusted input taints the envelope, and no transformation raises it"),
  but the corpus scenario `aiEnvelope.trustBoundaryPropagation.test.ts:100-120`
  pins the opposite as normative ("per-emission contentTrust MUST take precedence
  — trusted envelope emitted after MCP tool result does NOT inherit untrusted").
  A host cannot honour both; the tension is a corpus question, not a host fix.
- Residuals: `spaceAround`/`spaceEvenly`/`stretch` still degrade (no
  `u-justify-around`/`-evenly`/`u-items-stretch` utility exists — WIT-A2UI-6);
  interrupt-borne v0.9 surfaces bypass admission and so taint (R3/R8,
  WIT-A2UI-3 — no producer yet).
