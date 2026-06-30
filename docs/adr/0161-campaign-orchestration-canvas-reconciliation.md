# ADR 0161 — Campaign Studio: reconcile the orchestration engine with the canvas artifact

| Field | Value |
|---|---|
| **Status** | implemented (2026-06-27) |
| **Date** | 2026-06-27 |
| **Feature(s)** | `campaign-orchestration` (ADR 0158) + `campaign-studio` canvas artifact (ADR 0153) |
| **Depends on** | ADR 0158 (orchestration + `MarketingCampaign` + finalize), ADR 0153 (`canvas.campaign` artifact type), ADR 0055/0083 (artifact workbench + typed run-output) |
| **RFC gate** | None — host work over an already-registered artifact type. **No new RFC.** |

## Context

Two parallel sessions independently built "Campaign Studio" facets that landed on `main` as **separate** features (the cross-session naming collision resolved in PR #977/#978):

- **`campaign-studio`** (ADR 0153) — a **`canvas.campaign` artifact type**: the agent emits structured JSON (name, channels, funnel, assets) that **renders inline in the chat artifact workbench**. The *picture*.
- **`campaign-orchestration`** (ADR 0158) — the **runnable engine**: brand → brief → kernel → 5 channel sub-workflows → consistency → a persisted `MarketingCampaign`. The *process*.

They coexist but don't connect. A user who runs a full campaign through the orchestration gets a `MarketingCampaign` record + channel artifacts, but **not** the canvas visualization; a user who asks the canvas agent gets a picture with **no** durable campaign behind it. This ADR connects them: the engine produces the picture.

## Decision

**The orchestration's `finalize` node also emits a `canvas.campaign` artifact** derived from the finalized `MarketingCampaign` + its kernel — so a finalized campaign renders inline in chat through the existing artifact workbench (ADR 0055/0083), exactly like the canvas agent's output.

1. **A pure mapper** `campaignToCanvas(campaign)` in `campaign-orchestration` → the `canvas.campaign` payload:
   - `name` ← campaign.name; `objective` ← campaign.objective; `audience` ← (kernel tone / persona summary, optional).
   - `channels[]` ← the campaign's enabled channels, mapped to the canvas channel enum (`landing_page`→`content`, `ad_variants`→`display`, `email_sequence`→`email`, `creative_briefs`→`content`, `social_posts`→`social`).
   - `assets[]` ← one per enabled channel, seeded from the kernel (`headline`, `supportingStatement`→body, `primaryCta`→cta).
   - `funnel[]` ← a minimal awareness→consideration→conversion seeded from the kernel proof points + CTA.
2. **`finalize` returns** `outputs.artifact = { artifactTypeId: 'canvas.campaign', payload, title }` (the proven ADR 0153 emit shape) **in addition to** `outputs.campaign`. The host validates the payload against the registered `canvas.campaign` schema (AJV) and renders it.
3. **Soft, data-level dependency only.** `canvas.campaign` is registered at boot unconditionally (registration is toggle-independent, ADR 0001), so the emit always has a target. If the canvas feature were ever absent, the artifact output is inert data the host ignores — `finalize` never fails on it. No code import between the two features; the shared contract is the artifact-type **id + schema** in the host registry.

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Direction | Engine → picture (finalize emits the canvas), not picture → engine | The orchestration is the source of truth (it persisted the campaign); the canvas is a view of it. |
| Coupling | Artifact-type id + schema via the host registry; no cross-feature import | The artifact registry is the sanctioned shared seam (ADR 0055); avoids a feature→feature dependency. |
| Channel vocab | Map my 5 channels → the canvas's 8-value enum | The two taxonomies differ; a small deterministic map keeps both honest. |
| Failure mode | Emit is best-effort; a missing/disabled canvas type never fails finalize | Honest degradation; the campaign record is the durable outcome, the canvas is additive. |

### Non-goals

- Merging the two features into one (they have distinct lifecycles — an entity+workflow vs an artifact type). Reconcile by data contract, not by merger.
- The reverse direction (canvas agent → create a real campaign) — a possible follow-on.

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **1** | `campaignToCanvas` pure mapper + `finalize` node emits the `canvas.campaign` artifact + unit/pack test (payload validates against the schema; channel-vocab mapping) | backend tsc + tests; the canvas type validates the payload |

Single phase (a contained change). `/architect` before · `/code-review` after. `/ux-review` N/A (the artifact renders through the existing workbench — no new UI).

## Alternatives considered

1. **Merge the two features.** Rejected — an artifact type and an entity+workflow are different kinds of thing with different toggles/lifecycles; a forced merger muddies both.
2. **Cross-feature code import (orchestration imports the canvas feature).** Rejected — the artifact registry is the designed shared seam; an import would couple two independently-toggled features.
3. **Do nothing (leave them disconnected).** Rejected — that's the status quo the collision left; users get either a record or a picture, never both.

## Consequences

- A finalized campaign now renders as a `canvas.campaign` in chat — the engine and the canvas become one coherent "Campaign Studio" experience.
- Establishes the artifact-type registry as the reconciliation seam for future cross-session overlaps.

## Implementation log

| Phase | Status | Evidence |
|---|---|---|
| 1 | ✅ Done | `campaignToCanvas` mapper + `finalize` emits the `canvas.campaign` artifact (channel-vocab map; assets+funnel from the kernel); 2 tests incl. Ajv2020 validation against the canvas feature's registered schema. Also fixed the test's `parallelUpgrade` assertion (RFC-0106→0118, from #978). 75/75 cluster tests. /architect (artifact-registry seam, best-effort emit) + /code-review (0). |
