# ADR 0558 — Multi-page forms: the minimum credible floor

Status: Proposed
Date: 2026-08-13
Origin: UX_UPGRADE-forms round 3 (/feature-refinement) over F-G4, deferred in
R1 and R2 as "a feature program, not a UX pass". The R2 market refresh
(2026-08-08, cited in the tracker) defined the floor this ADR scopes: **named
steps, Next-gated per-step validation, back-preserves-data, conditional skip**
— Tally ships all of it on the free tier.

## Decision (proposed)

Extend the `forms` feature (toggle unchanged) with a `pageBreak` FIELD TYPE —
a **deliberate ADR 0516 catalog change**, exactly the shape the enforced-closed
catalog exists to make explicit rather than drive-by:

- **Model**: `pageBreak` joins `FIELD_TYPES` carrying `label` (the step name)
  and an optional `skipIf?: { field: string; equals: string | boolean }` — one
  condition, one target field, referencing an EARLIER field key (validated in
  `sanitizeFields` the way `IntakeBinding` cross-validates field refs today).
  No nested logic trees in the floor: Tally's own floor is single-condition
  skip, and an expression language is a later program.
- **Fill renderer**: fields partition into steps at each `pageBreak`; Next
  runs `validatePublicValues` over the CURRENT step's fields only (the
  existing per-field machinery, filtered); Back preserves values (state
  already lives in one `values` map — nothing to build); a skipped step is
  never rendered and its values are EXCLUDED from submit (a skipped step's
  stale values leaking into the submission would be the silent-loss family).
- **Progress**: step N of M with the authored names; the localStorage resume
  (R2's F-G5 Tally model) keys per form and restores the step index.
- **Server**: `validateValues` is UNCHANGED for values — it already validates
  the whole form; `pageBreak` fields carry no submitted value (the honeypot
  precedent: a reserved non-data field). Skip conditions are re-evaluated
  SERVER-SIDE at submit so a hand-crafted POST cannot smuggle values into a
  step the authored logic skipped (fail-closed: values for skipped fields are
  rejected, not dropped — dropping would be silent loss of what the client
  sent; rejection names the mismatch).
- **Builder**: a `pageBreak` row authors the step name + the one skip
  condition from a dropdown of earlier fields.

## Boundaries audit

- Catalog: `FIELD_TYPES` is the single owner (`formsService.ts:24-30`), closed
  and ratchet-enforced (ADR 0516); this is the sanctioned extension path.
- Validation: `validatePublicValues`/`validatePublicField`
  (`deriveFields.ts`) already validate arbitrary field subsets — step gating
  is a FILTER, not new machinery.
- Resume: the R2 localStorage resume owns device-side persistence; the step
  index is one more key in the same record.
- No route changes; no new toggle; **no wire** (host frontend + the existing
  submit endpoint). RFC verdict: **host-ext, no RFC**.

## Alternatives weighed

- **A separate `pages[]` model** (fields grouped by page object) — rejected:
  it forks the field list every consumer walks (inbox, CSV export, intake
  bindings, the agent lane) and makes single-page forms a special case. A
  break-marker in the EXISTING list keeps every walker working unchanged.
- **Full conditional logic** (per-field show/hide expressions) — deferred; the
  floor is per-STEP skip with one condition. The catalog stays closed until
  the next deliberate change.
- **Do nothing** — the market row stands against it; every leader ships this
  free, and single-long-page is the top abandonment complaint in the cited
  practice.

## Open questions

- [ ] Does `pageBreak` count toward `MAX_FIELDS` (proposed: yes — it is a row
      the builder manages)?
- [ ] Analytics: per-step abandonment needs the funnels seam; deferred to the
      funnels feature rather than grown here.
- [ ] The agent lane (`forms` chat tools) should AUTHOR page breaks — phase 2,
      after the human surface proves the model.

## Phased plan

| Phase | Scope | Verify |
|---|---|---|
| P1 | Model + sanitize (`pageBreak`, skipIf cross-validation) + server-side skip re-evaluation (fail-closed rejection) | backend tests + probes |
| P2 | Fill renderer partition/Next/Back/skip + progress + resume step index | renderer tests incl. the skipped-values exclusion |
| P3 | Builder authoring row + i18n ×4 + inbox/CSV walkers verified unchanged | builder tests; export goldens |
| P4 | Agent-lane authoring + per-step abandonment (funnels seam) | deferred until P1-P3 prove the model |
