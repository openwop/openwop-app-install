# Section 07: Recoverable UX, accessibility, localization and first value

Status: Proposed — planning complete for review; no implementation, qualification or approval implied.

| Field | Value |
|---|---|
| Kind | Host product/engineering requirements; /prd five-pass method |
| Date | 2026-10-24 |
| Audit IDs | UX-01, UX-02, UX-03, UX-04, UX-05, LOC-01 |
| Proposed accountable role | Frontend experience / accessibility / localization; staffing unconfirmed |
| Dependencies | 01, 02 |
| Effort | XL; relative scope only, not elapsed schedule |
| Decision records | Existing ADRs in References; umbrella ADR 0970 |
| Companions | [07-ux-accessibility-localization-and-first-value.gaps.md](07-ux-accessibility-localization-and-first-value.gaps.md) · [07-ux-accessibility-localization-and-first-value.risks.md](07-ux-accessibility-localization-and-first-value.risks.md) |
| Program | [Master plan](README.md) · [Coverage](coverage.json) |

## Summary

Repair known error-state defects, then verify every application journey in keyboard, assistive-technology, responsive, theme and supported-language modes. Establish measured first-value and findability outcomes across end users and operators.

## Motivation

BrandPage initial `brands=null` persists through a failed first read and the render checks loading first (:41,58,137). Source gates observed 46 failure cards without recovery action and 128 legacy notice cohort sites without explicit announce; these are not 128 reproduced AT failures. Locale registry explicitly says French/Spanish native review is outstanding. Shared Modal/StateCard/Notice/live-region/nav and token infrastructure already exist. Only the public landing was inspected live; no authenticated task or AT success was established.

## Proposal

Requirements use **shall** for this host plan; uppercase RFC 2119 obligations exist only in the upstream Draft RFC. No requirement is a statement that code already implements it.

- **S07-R1 (UX-01)** — Fix Brand initial/read/retry state so failure terminates loading, announces once and offers Retry. Test failed first load, failed refresh with stale data, feature disabled, org-read failure, retry failure/success and unmount/request races.

- **S07-R2 (UX-02)** — Classify every failure-card/no-recovery candidate and every source-discovered read path. Add targeted retry or meaningful recovery/back action; use explicit stale/partial/offline/permission states and avoid success-with-empty. Reach zero unexplained baseline entries; source scans enumerate candidates, behavior tests prove fixes.

- **S07-R3 (UX-03)** — Review legacy Notice/live-region sites for proper announcement versus described-by; unify through existing shared announcer and avoid double announcements. Cover actionable errors, async result changes, validation summaries and interrupted approvals with VoiceOver/NVDA, preserving focus and form context.

- **S07-R4 (UX-05)** — Set WCAG2.2 AA as the proposed product verification target and use WAI APG interaction guidance. Qualify all primary journeys with keyboard, accessible names, focus visibility/order, modal/menu/canvas controls, measured contrast, reflow/zoom, reduced motion and touch targets. Record criterion-specific results; automated scans alone do not establish conformance.

- **S07-R5 (UX-05)** — Run signed-in owner/editor/viewer and anonymous/disabled/paywall states at 360/768/1440 CSS px, light/dark and text expansion; include workflow canvas/inspector, checkout-return, access, marketplace and long nav. Inspect actual screenshots and computed values; current public landing evidence cannot close these.

- **S07-R6 (LOC-01)** — Externalize showcase strings and all new public UI; commission native review of all advertised French/Spanish namespaces, prioritizing security/money/core tasks first but retaining full coverage. Check Intl/date/number/plural/locale negotiation and authored content separately. Pseudolocale/RTL test infrastructure exposes layout gaps; new languages follow documented demand without removing existing review obligations.

- **S07-R7 (UX-04)** — Persist resumable setup progress through existing user/workspace preferences, display repair in the setup hub and let authority determine available provider actions. Measure first successful workflow/approval/result and navigation tasks in unassisted representative-user sessions. Approve target success/time thresholds before assessing improvement; report sample size and uncertainty.

### Five architect passes

| Pass | Finding / decision |
|---|---|
| Specification | Define every designed state and task outcome; scope first-value separately for end user and host operator. |
| Schema | Use existing preferences, UI state models and locale catalogs; no backend data import into frontend or duplicate feature nav model. |
| Security | Recovery cannot reveal foreign records or resurrect revoked actions; preserve secure payment/provider flows and consent. |
| Conformance | Failure-injected HTTP/browser, actual AT and keyboard journeys; report measured contrast/reflow separately from visual opinion. |
| Compatibility | Keep public deep links, browser history, persisted locale/theme and expected keyboard shortcuts; progressive migration through shared primitives. |

### Proposed data and interface impact

Extend existing user/workspace preference owner for setup state; no second identity/onboarding database. Usability events are content-free, purpose/consent governed and avoid raw prompts/PII. UI request state must distinguish idle/loading/success/failure/stale/disabled, using existing clients/primitives. Locale registry remains the display-locale source of truth.

## Compatibility

UI/host-only; no new protocol contract. WCAG2.2 AA is a proposed design/verification target, not a legal-compliance declaration. Existing advertised locales remain obligations; reducing language availability is a product decision, not a substitute for native review. All colors/strings route through existing tokens/i18n.

## Conformance

The observable and the actor able to cause the condition are separate. A mock, code search or manifest cannot substitute for the stated executable witness.

| Scenario | Observable / acceptance | Who can cause it | Proof scope |
|---|---|---|---|
| S07-T1 | Brand failed initial load visibly ends in announced error; retry succeeds without stale banner | Network failure fixture + React/browser test | New concrete defect witness |
| S07-T2 | Each recoverable failed read has a usable next action; AT hears actionable change exactly once | Fault driver + keyboard/VoiceOver/NVDA operator | Authenticated product flows, not source regex alone |
| S07-T3 | Critical task is completed at viewport/theme/zoom states without inaccessible controls | Browser + assistive-technology reviewer | WCAG criterion checks and screenshot/computed-style evidence |
| S07-T4 | Supported locales reviewed and core first-value task success/time measured | Native reviewers + representative users | Human evidence with sample/role/locale; no fabricated user metrics |

## Alternatives considered

- Only tighten scan baselines: rejected; can silence valid contextual notices and leave runtime defects.
- Per-feature replacement widgets: rejected; forks design and interaction behavior.
- Fix shared patterns and verify each journey: chosen; retains source gates as regression aids, not compliance proof.

## Unresolved questions

1. Which task-success/time thresholds and participant segments are approved? Resolution: Baseline representative users and approve measurable target before remediation comparison. Owner: Product research owner. Blocks: usability grade uplift.
2. Which native reviewers and AT/browser/device matrix can be staffed? Resolution: Assign reviewers/tooling and review all advertised locale namespaces. Owner: Accessibility/localization leads. Blocks: human qualification.
3. Which notification sites need announce versus existing description/focus? Resolution: Classify cohort with actual AT witness and retain justified exceptions. Owner: Accessibility owner. Blocks: announcement baseline closure.

## Implementation notes (non-normative)

| Order | Concrete work / existing owner | Deliverable / verification |
|---|---|---|
| 1 | BrandPage/shared StateCard/client lifecycle | Specific initial-read fix + regression witness |
| 2 | Shared Notice/live region/failure cards + full route census | Per-site recovery/announcement classifications and fixes |
| 3 | Existing nav/setup/preferences and frontend clients | Resumable first value + representative usability study |
| 4 | All feature journeys, tokens and locale catalogs | Authenticated viewport/theme/AT/locale evidence per family |

Sequence schema/atomic persistence before consumers; deploy compatible backend before frontend. For incompatible data changes use an explicit drain/maintenance boundary and a coherent restore, never a blind old-binary rollback. Reuse local CI/merge train; no global shipping freeze or cross-session lock.

## Acceptance criteria

- [ ] Known spinner, recovery cohort and all reviewed announcement problems fixed; source baseline reductions have behavioral evidence.
- [ ] Every sold/advertised journey has a recorded accessibility/theme/mobile/locale result; blockers remain open and cap affected experience grade.
- [ ] Native review and real participant outcomes exist; keys/parity/screenshot appearance alone cannot close them.
- [ ] Attach exact SHA/artifact/config, executed/failed/skipped/blocked dispositions, operator/reviewer and timestamp to each closure record; regrade only the demonstrated scope.
- [ ] Update original IDs UX-01, UX-02, UX-03, UX-04, UX-05, LOC-01 with implementation and evidence links; do not check off because this PRD exists.

## References

- [UX evidence](../../research/platform-audit-2026-10-24/ux.md)
- [BrandPage](../../../frontend/react/src/features/brand/BrandPage.tsx)
- [Locale registry](../../../frontend/react/src/i18n/locales.ts)
- [WCAG2.2](https://www.w3.org/TR/WCAG22/)
- [WAI modal interaction](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)

## GO / NO-GO

**GO for proposed host-plan review. CONDITIONAL for implementation:** resolve the blocking companion questions, accept any new architectural decision, and satisfy any upstream RFC gate first. This is not an Accepted protocol RFC or a production release decision.
