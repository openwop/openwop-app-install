# ADR 0727 — Campaign Studio joins the soft-reference warning lane; the model is told what the editor is already told

Status: implemented

**Feature:** Campaign Studio (canvas) (`FEATURES.md` ordinal 220) · ADR 0153/0305/0310/0319 · feature-loop 2026-09 it.52
**Closes:** `CSC-1` (grade-code 2026-08-28, Nice-to-have)

## Context

`CSC-1` filed that `asset.channel` is a free-text label never checked against `channels[].name`: an asset can name a channel that does not exist, and renaming or removing a channel silently orphans it. It is denormalized, so it cannot dangle a pointer or corrupt the doc — filed Nice-to-have, correctly.

What the row did not say is that **the host already has a lane built for exactly this class, and Campaign Studio is simply not on it.**

### The lane, measured at `bb75c6d11`

ADR 0305 Phase C separates two outcomes: a closed-world catalog violation REJECTS the write (422), while a **cross-facet reference issue is a soft warning that saves and reports**. It is wired end to end:

| hop | site |
|---|---|
| validator returns `{errors, warnings}` | `canvasEditorRoutes.ts:57` (`CanvasValidation`) |
| save surfaces them | `canvasEditorRoutes.ts:344` — `res.json({ ...result, warnings: validation.warnings })` |
| restore surfaces them | `canvasEditorRoutes.ts:399` → `canvasSurface.ts:219` |
| client types them | `canvas/canvasClient.ts:105` (`SaveWarning[]`) |
| the editor shows them | `CanvasEditorPage.tsx:1698` — `toast.warning(t('savedWithWarnings', …))` |
| translated | `canvas/i18n/{en,es,fr,pt-BR}.ts` |

**Seven canvas types pass a validator to that factory. Exactly ONE emits a warning:** `validateAppDoc` (13 `warnings.push` sites — missing screen, missing data source, missing connector target), which is the consumer ADR 0305 Phase C was written for. `validateCampaignDoc`, `validateSlidesDoc`, `validateDrawingDoc`, `validateCadDoc`, `validateDocumentDoc` and `validateOutlineDoc` all return `warnings: []` unconditionally.

> **Correction note (made before this ADR shipped):** my first reading of this was "the lane is built, localized ×4 and has NEVER fired" — measured over a hand-picked list of five validators that happened to exclude `app-builder`. The lane is live and has a reference consumer. The denominator was wrong, not the code. Recording it because the grade loop keeps re-learning the same thing: count the population before describing it.

So the finding is not a dead mechanism. It is that **Campaign Studio has the identical shape of cross-facet reference as app-builder's `bind`/`navigateTo`/`connectors`, and does not use the lane that exists for it.**

### The asymmetry that matters more than the label

Campaign Studio is a generation-first feature: the Campaign Strategist agent authors the doc through `render`, and a human edits it afterwards. Today:

- a **human** who saves a campaign with a dangling `asset.channel` gets a warning toast (as soon as the validator emits one);
- the **model** that just wrote that same doc gets `ok: true` and is never told.

The tool already runs `validateCampaignDoc` at authoring time, under a comment saying it does so "so the model gets the defects while it can still react" (`agentTools.ts:153-154`) — but it reads only `v.errors` and drops `v.warnings` on the floor (`:156`). The repair loop the prompt documents covers hard failures only.

## Decision

### D1 — `validateCampaignDoc` emits a soft warning for a dangling `asset.channel`

A non-empty `asset.channel` that matches no `channels[].name` becomes `warnings.push({ path: 'assets[i].channel', message: "references missing channel 'X'" })` — the app-builder phrasing, verbatim in shape. It is a WARNING, never an error: matching is by display label, a mid-edit rename is a normal state, and existing docs must keep saving. Empty/absent `channel` is not a warning (an unassigned asset is legitimate).

### D2 — the tool returns its warnings to the model on SUCCESS, and says so in the note

`render` adds `warnings` to its `ok: true` result when the validator produced any, **capped at 10, mirroring the error path** (`agentTools.ts:163`): `assets` allows 60 entries, and `render` is NOT `schemaCarrying`, so its result is compaction-eligible (`toolResultTransform.ts:176`) — an unbounded array is both context bloat and truncatable.

**The success `note` must name them.** The tool's `note` (`agentTools.ts:312-314`) is the in-band instruction the model actually follows; a sibling `warnings` field the note never mentions is advisory data with no instruction attached — decorative, and the D3 witness would pass while the behaviour stayed inert (the "gate that does not gate" family this repo keeps re-filing). So the note branches when warnings are present, and the prompt line is reinforcement rather than the sole driver.

This is additive; a model that ignores it is unaffected. **App-builder is not a counter-precedent:** its `warningCount` goes to an export lineage log (`routes.ts:127`), never to a model, so there is no reference behaviour this contradicts. The divergence is justified by the authorship asymmetry above, not by symmetry with the sibling. There is no declared `outputSchema` to violate (`render` declares only `inputSchema`), and neither prompt pin breaks: `promptCatalogParity.test.ts:21,27` is a `toContain` check on the enums and `agent-prompt-tool-ids.test.ts` only resolves `openwop:` ids.

**Accepted cost, stated:** a renamed channel warns on EVERY subsequent save until the asset is edited — the FE renames in place and never cascades. This is identical to app-builder's missing-screen behaviour and is accepted, mitigated by the delivery (a toast, not a blocking dialog) and the cap. A warning that tells the truth beats a cascade that guesses.

### D3 — the witness is the end-to-end lane, not the predicate

A unit test on the validator alone would pass while the warning died at either boundary. The witness therefore asserts FOUR hops on one doc:

1. the validator emits the warning;
2. the tool's success result carries it **and the note names it**;
3. the chassis PATCH returns it in the 200 body — a route-level `createApp` leg, because that hop is what the editor toast depends on and **no test asserts that passthrough for any canvas type today** (app-builder's suites cover doc facets, not the route; campaign is only the second emitter ever, so this wiring has never been exercised end to end);
4. a consistent doc produces none (non-vacuity).

The `promptCatalogParity` pin is re-run because the prompt changes.

## Alternatives weighed
- **Make it an error.** Rejected: it would refuse a save mid-rename and could fail an otherwise-valid generation over a label typo, turning a data-quality nudge into an outage of the authoring path.
- **Rename cascade in the editor.** Rejected for now: it silently rewrites data the user did not select, and the canvas chassis has no cross-collection edit primitive. The warning tells the truth; a cascade guesses.
- **Give every canvas type warnings.** Rejected: five of the seven have no cross-facet references to check. A rule fires where the class exists, not everywhere.

## RFC verdict

Host-only. `canvas.campaign` is a host-extension doc type; the warning rides an existing host-ext response field. Nothing on the OpenWOP wire changes. No RFC.

## Implementation plan

All three phases landed in one PR. Witness `backend/typescript/test/campaign-soft-reference-warnings.test.ts` — **7 legs, born red on 3** (validator, tool, route) against the pre-ADR code; the note assertion is separately sabotage-proved (replacing the branched note with a plain one reds leg 2 alone, nothing else).

| Phase | Change | Witness |
|---|---|---|
| D1 | `validateCampaignDoc.ts` — dangling `asset.channel` → `warnings` | new test: validator leg |
| D2 | `agentTools.ts` — carry `v.warnings` (cap 10) onto the `ok:true` result + branch the `note`; `campaign-strategist.md` gains the line | new test: tool leg + note leg + `promptCatalogParity` |
| D3 | witness the four hops incl. the route-level PATCH passthrough | new test: validator + tool + route + clean legs |

## Review record

An adversarial `/architect` pass on this text before implementation returned 0 Blockers and 3 SHOULDs, all folded in above: cap the warnings (error-path parity + compaction-eligibility), branch the `note` so the advisory is not decorative, and add the route-level passthrough leg. It also verified the blast radius (all four validator call paths branch on `errors.length` only — `canvasEditorRoutes.ts:253,335`, `canvasSurface.ts:232`, `agentTools.ts:157`) and the corrected denominator (`validateAppDoc` is genuinely the validator at `app-builder/routes.ts:96`; the other six return `warnings: []` unconditionally, two of them deliberately per their own docblocks).

## Open questions
- [ ] Should the other five validators with plausible cross-references (slides speaker-notes → slide ids?) be surveyed separately? Not in this ADR's scope; recorded as a follow-up on the code tracker.
