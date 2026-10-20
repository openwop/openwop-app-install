# ADR 0933 — Campaign ops: content rules on every change set

Status: Proposed

Program: agency campaign operations (ADRs 0921–0928, 0933, 0934). Amends
ADR 0923 (change set) and ADR 0924 (approval). Port items **A1**, **A2** and
**B4** of `MYNDHYVE-PORT-SWEEP.md` §1 (2026-10-18), which the owner approved
("Proceed with your recommendations"). This is a **port**: the baseline is
MyndHyve's rule sets, read from `myndhyve` `origin/main`, read-only, limited to
the files named below. PRD features F5, F6 and F18.

## Context

A change set (ADR 0923) proposes field edits to a client's landing page and email
draft. Before an approver sees it, the edits must be checked for the claims a
client-facing change must not introduce: invented scarcity ("Only 2 seats
left!"), hidden costs, fake testimonials, confirm-shaming, vague urgency,
regulated-category claims ("guaranteed returns", "clinically proven"), and bad
links (http, shorteners, malformed). MyndHyve has these as three rule sets.
openwop-app has none of the trust rules, none of the regulated-category rules and
none of the link rules; `docs/steward/MYNDHYVE-GAP-ANALYSIS.md:248` wrongly marks
trust guardrails "COVERED".

## MyndHyve baseline (read-only, `origin/main`)

Files: `src/canvas-types/campaign-studio/trust-guardrails/{rules.ts (R),
TrustGuardrailService.ts (S), types.ts}`, `…/ads-studio/approval/AdComplianceBridge.ts
(B)`, `…/validation/PlatformComplianceValidationService.ts (P)`, and their tests.

**Trust guardrails: 13 rules over 10 categories.**

| # | id | category / severity | trigger (S line) |
|---|---|---|---|
| 1 | `fake-scarcity-countdown-reset` | fake_scarcity / critical | countdown with `resetsOnRefresh` (S:435) |
| 2 | `fake-scarcity-unverified-quantity` | fake_scarcity / critical | quantity claim not verified (S:459) |
| 3 | `fake-scarcity-past-deadline` | fake_scarcity / high | countdown deadline in the past (S:483) |
| 4 | `misleading-pricing-inflated-original` | misleading_pricing / high | (original − sale) / original > 70% (S:508) |
| 5 | `misleading-pricing-hidden-fees` | hidden_costs / critical | an undisclosed fee (S:537) |
| 6 | `misleading-pricing-unclear-recurring` | forced_continuity / high | recurring price with no cancellation terms, or a trial under 3 days (S:562) |
| 7 | `fake-social-proof-unverified-testimonials` | fake_social_proof / medium | an unverified testimonial (S:590) |
| 8 | `fake-social-proof-generic-quotes` | fake_social_proof / medium | ≥ 50% and ≥ 2 generic quotes (S:620) |
| 9 | `dark-patterns-pre-checked-optins` | dark_patterns / critical (GDPR Art. 7) | a pre-checked opt-in (S:645) |
| 10 | `dark-patterns-confirm-shaming` | confirm_shaming / medium | a shaming phrase in opt-out text (S:675) |
| 11 | `false-urgency-vague-deadline` | false_urgency / medium | vague urgency with no deadline (S:706) |
| 12 | `hidden-costs-undisclosed-fees` | hidden_costs / high | **the same check as rule 5** (S:730) |
| 13 | `forced-continuity-hidden-subscription` | forced_continuity / critical | a trial with no cancellation terms (S:742) |

Phrase lists (S:609-618, 664-673, 696-704), the regulatory references
(R:14-44: FTC 16 CFR 255, FTC deceptive pricing, FTC negative option, GDPR
Art. 7), the recommendation texts (R:65…312) and the trust score (severity
weights 25/15/8/3/1 × category weights, S:46-77; grades S:79-86) are the
baseline and are ported verbatim. **The declared `conditions` in R are not what
runs** (S:376-425 dispatches by rule id to hand-written checkers); the checkers
are ported, not the conditions.

**AdComplianceBridge.** Regex extractors that turn copy into the structures the
trust rules read (B:281 discounts, B:294 prices and intervals, B:327 quantity,
B:340 urgency), and `checkAgainstPolicy` (B:153-254): policy-supplied banned
phrases (block, critical), a hard-coded regulated-category map of **17**
keywords over 6 categories (B:185-192: finance, health, housing, employment,
alcohol, gambling; block when strict, else needs-review), and policy-supplied
proof-requirement patterns.

**PlatformComplianceValidationService.** 22 rule codes; the text and link ones
apply to a page or email: `https_required` (P:851), `blocked_domain` over 7
shorteners `bit.ly, tinyurl.com, goo.gl, t.co, ow.ly, is.gd, buff.ly` with
subdomain matching (P:868-885, defaults P:184-198), `exceeds_max_length` 2048
(P:888), `invalid_format` (P:903), `required_field_missing` (P:268), and
`invalid_cta` against per-platform presets (P:348). The media codes (aspect
ratio, fps, size, duration, format) do not apply to text change sets.

### MyndHyve warts not inherited

| Wart (evidence) | Correction |
|---|---|
| Rules 5 and 12 run the same check, so one undisclosed fee costs 56 points (S:724-736) | One rule `hidden-costs-undisclosed-fees`; id 5 kept as an alias for traceability; scored once |
| Four in-memory Maps and a singleton (S:190-193, 1213-1230); results are non-deterministic (`randomUUID`, `new Date()`) | Pure functions; findings stored on the change set; finding ids are deterministic (D4) |
| Acknowledgments match by title and are lost after the second rescan (S:271-285) | Acknowledgments bind to the deterministic finding id on the approval decision (D5) |
| `setRuleEnabled` mutates the shared rule objects (S:1201-1206) | Rules are frozen; enablement is per-client config (D6) |
| `severityOverrides` never applied; `strictness` never read | Not ported; per-client strictness is read (D6) |
| Substring matching: `cure` matches "secure" (B:194-213) | Word-boundary matching for every phrase list |
| A shared `/gi` regex reused across fields skips matches (B:168-226) | A fresh matcher per field; all matches reported, not only the first |
| `regulatoryStatus.ftc` counts only two FTC categories (S:1155-1170) | Every finding with an FTC reference sets the FTC flag |
| Proof rules flag a match without checking for proof (B:216-238) | A match is `needs_review` unless the change set's request supplies evidence (D3) |

## openwop-app audit (state on `origin/main`)

- **No rule engine or shared finding type exists** in `host/`
  (`grep PolicyFinding|RuleFinding|ruleId`); each feature defines its own
  (`ChainPinFinding` `host/chainPinRule.ts:59`, `AngleValidationFinding`
  `features/campaign-brief/angleService.ts:66`, brand `ComplianceIssue`
  `features/brand/types.ts:224-242`). `host/governanceService.ts:1-20` configures
  enforcement points and is "never a second evaluator".
- **`ads.policy.check`** (`packs/vendor.myndhyve.ads-policy/index.mjs:34-277`)
  has 7 built-in claim rules, accepts `trustGuardrailChecks[]` that nothing
  produces, and **has no callers** (only `executor/sideEffectFloor.generated.ts:697`).
  `vendor.myndhyve.ads-creative-validate/index.mjs:26` duplicates its rule list.
- **Link checks are scheme checks only:** `safeUrl` (`host/boundedStrings.ts:84-89`),
  CMS `safeLink` (`features/cms/cmsService.ts:423-428`) and `httpsMediaUrl`
  (`:449-464`, 2048 cap), email `isSafeRedirect` (`features/email/routes.ts:604-609`),
  funnels (`features/funnels/funnelsService.ts:272`). No shortener list, no
  https requirement on CTA links. CTA presets live in
  `packs/vendor.myndhyve.ads-platforms/index.mjs:45, 532` (ad placements only).
- **Brand compliance (A2):** `scoreComplianceDeterministic(content, brand, …)`
  (`features/brand/scoring.ts:61-127`) via
  `ctx.features.brand.checkComplianceDeterministic({brandId, content, orgId,
  channel})` (`features/brand/surface.ts:106-111`); the node adds an optional
  40% LLM tone judge (`packs/feature.brand.nodes/index.mjs:84-178`).
- **Consistency (A2):** `feature.campaign-orchestration.nodes.consistency-check`
  compares drafts to the brief kernel, deterministic token presence plus an
  optional 40% LLM judge (`packs/feature.campaign-orchestration.nodes/index.mjs:33-93`).
  It needs a brief and returns a neutral 100 with no drafts (`:52-53`).
- **Claim verification (A2):** **no `knowledge.verify` exists** (the sweep's
  name is wrong). The nearest deterministic check is `verifyClaims(claims,
  contexts)` → `uncited|supported|unsupported`
  (`packs/feature.campaign-channels.nodes/platformLimits.mjs:99-140`) over
  already-retrieved `kb.rag` results; the LLM `feature.kicktodo.nodes.claim-verify`
  is KickTodo-scoped.
- **Comment-only permission (B4):** no comment scope exists; custom roles carry
  protocol scopes only (`host/accessControlService.ts:93-110, 224-226`), and
  comments write with `workspace:write` (`features/comments/routes.ts:70, 92, 108`).

## Decision

### D1 — One content-rules library, pure and versioned

`backend/typescript/src/host/contentRules/` (host, so later consumers such as the
ads lane can use it without importing a feature):

```ts
interface ContentRulesInput {
  asOf: string;                         // ISO; the only clock input (rule 3)
  entries: Array<{
    assetId: string; destination: 'openwop.cms.page' | 'openwop.email.template';
    fields: Array<{ path: string; role: FieldRole; before: string; after: string }>;
    structure?: AssetStructure;         // D2: sections, forms, testimonials, pricing
  }>;
  policy: ContentPolicy;                // D6
  evidence?: Array<{ claim: string; source: string }>; // from the request (ADR 0923)
}
interface ContentFinding {
  id: string;                           // D4, deterministic
  ruleSet: 'trust' | 'regulated' | 'link' | 'policy' | 'brand' | 'consistency' | 'claims';
  ruleId: string;                       // MyndHyve id where ported
  severity: 'critical' | 'high' | 'medium' | 'low';
  action: 'block' | 'needs_review' | 'info';
  assetId: string; field: string; span?: { start: number; end: number; text: string };
  introduced: boolean;                  // present in `after`, absent in `before`
  message: string; recommendation?: string; regulatoryRef?: string;
}
interface ContentRulesReport {
  rulesetVersion: string;               // bumped on any rule change
  findings: ContentFinding[];
  trustScore: { overall: number; grade: string };  // informational
  regulatoryStatus: { ftc: 'clear' | 'issues_found'; gdpr: 'clear' | 'issues_found' };
  digest: string;                       // sha256(canonicalJSON({rulesetVersion, findings}))
}
```

`checkContent(input) → ContentRulesReport` is pure and deterministic. The rule
tables (phrase lists, keyword map, shortener list, weights, recommendation texts)
are frozen data modules ported verbatim, each with the MyndHyve file:line it came
from.

### D2 — Text extractors adapted to pages and emails

Ten of the 13 trust rules read structured fields. For a change set:

- **From text** (MyndHyve's bridge extractors, B:281-340, with fresh matchers and
  word boundaries): quantity scarcity → rule 2; urgency and deadlines → rules 3
  and 11 (a parsed past date is rule 3, evaluated against `asOf`); "was $X now $Y"
  and "N% off" → rule 4; `$N/month`, "free trial" → rules 6 and 13 when no
  cancellation terms appear anywhere in the asset's target text.
- **From CMS structure:** testimonial/social-proof sections → rules 7 and 8
  (a quote with no attribution source is unverified); form sections with a
  checkbox defaulting to checked → rule 9; decline/opt-out link text → rule 10.
- **From email:** the body's unsubscribe/opt-out text → rule 10.
- Rule 1 (countdown resets on refresh) needs runtime behaviour a text diff cannot
  see. It is carried as a rule but fires only when a CMS countdown component is
  configured to reset; otherwise it is `not_applicable` and listed as such.

### D3 — The rule sets, merged

1. **Trust** (D2): 12 rules after merging 5/12, MyndHyve severities.
2. **Regulated categories:** the 17 keywords, word-bounded. Per-client
   `regulatedCategories` (D6) and `strictness`: `strict` → `block`, otherwise
   `needs_review`. `alcohol` stays review-only, as in MyndHyve.
3. **Links:** for every URL in an edited `href`/`url` field or in edited text:
   `invalid_format`, `https_required`, `blocked_domain` (the 7 shorteners, host
   equals or ends with `.`+domain), `exceeds_max_length` 2048. All `block`. These
   sit alongside ADR 0923's `value_not_in_request` rule, which stays.
4. **Policy:** per-client banned phrases (`block`) and proof-requirement patterns
   (`needs_review`, `block` if configured). A proof match is downgraded to `info`
   when the request supplies evidence naming that claim. Patterns over 200
   characters are refused when the policy is saved (MyndHyve's ReDoS guard,
   S:829-835).
5. **Required fields:** an edit that empties a field the destination requires
   (a page title or headline, an email subject) is `block`.
6. **CTA presets:** not applied in v1. They are per ad placement, and v1
   destinations are pages and emails. They apply with the first ad destination,
   from `vendor.myndhyve.ads-platforms`.

### D4 — Introduced vs pre-existing, and deterministic ids

Rules run on both `before` and `after`. A finding present in `after` but not in
`before` is `introduced: true`; only introduced findings can be `block` or
`needs_review`. A pre-existing finding is `info` ("already on the page"), so an
agency is not blocked from fixing a date on a page that already says "limited
time". `id = sha256(ruleId, assetId, field, normalized span text)`, stable across
rescans.

### D5 — Where it runs, and how it binds to approval

- **At proposal** (ADR 0923 D5, after the edit validator): `checkContent` runs
  on the change set; the report is stored on the change set as
  `contentRules: {rulesetVersion, asOf, digest, findings}`. It is not in the
  change-set hash (the hash names what is written; ADR 0923 D6).
- **Any introduced `block`** stops the change set from entering review
  (`requestApproval` → 409 `content_rules_blocked`, listing findings). The
  operator edits the request or the asset and regenerates. There is no override
  for `block` in v1.
- **`needs_review` findings** appear on the diff and on the approval page,
  internal and client (ADR 0924 D5), each with its message and recommendation.
  The approver must acknowledge each one; the approval decision carries
  `acknowledgedFindings: id[]`, which must equal the set of introduced
  `needs_review` ids. Approve without them → 409 `findings_not_acknowledged`.
- **At decide** (ADR 0924 D2, new check 7): the server recomputes the report
  with the stored `asOf`; a different `digest` (the ruleset changed during
  review) → 409 `content_rules_changed`, the approval stays pending, and the UI
  shows the new findings. Recomputing is cheap; no model is involved in gating.

### D6 — Per-client content policy

`ClientAccount.contentPolicy` (ADR 0921 D1): `{ strictness: 'strict' | 'moderate',
regulatedCategories: Category[] (default all six), bannedPhrases: string[],
proofRules: ProofRule[] }`. Brand-kit banned phrases are **not** copied here;
they come from the brand (D7). Edited by `host:members:manage` on the client
org; audited.

### D7 — Composing the existing checks (A2)

The same validation step calls, per asset, and folds the results into the report
as `ruleSet: 'brand' | 'consistency' | 'claims'`:

- **Brand:** `ctx.features.brand.checkComplianceDeterministic({orgId, brandId,
  content: after-text, channel})` for the client's brand. A banned phrase that is
  introduced → `block`; brand `error` issues → `needs_review`; warnings → `info`.
  The optional LLM tone judge is not called in the gating path (determinism); it
  may be shown as `info` later.
- **Consistency across assets** (deterministic, new, ~40 lines): for every intent
  value in the request, every asset in the change set that held the old value
  must hold the new one in its target, and none may keep the old value
  (`consistency.stale_value_remaining`, `needs_review`). This is the "new date on
  the page but not the email" case. The existing kernel-based consistency node is
  composed only when the campaign has a brief, and its divergences are `info`.
- **Claims against the client's knowledge base:** numeric and superlative claims
  introduced by the edit are checked with `verifyClaims` over `kb.rag` results
  from **the client org's collection only** (owner decision 2026-10-18: shared
  knowledge is per client org, never per agency). `unsupported` →
  `needs_review`; `uncited` → `info`. `verifyClaims` is moved from the
  campaign-channels pack into `host/contentRules/claims.ts`, and the pack imports
  the host copy, so there is one implementation.

### D8 — B4: the commenter role

MyndHyve's `commenter` (comment and approve, no edit) maps to the **ADR 0924
client approver**, not a fifth built-in role: the client approver already sees
one package, comments and approves or rejects, and has no session. For an
**agency member** who should only comment, no scope can express it today
(`workspace:write` covers comments and edits). That is recorded as a follow-up
(a `comments:write` protocol scope in `accessControl`), not built here, because
campaign-ops approval eligibility already uses `approvals:respond`, which a
custom role can carry without edit rights.

### D9 — Fix the gap-analysis claim

`docs/steward/MYNDHYVE-GAP-ANALYSIS.md:248` changes from COVERED to
**PARTIAL → ported by ADR 0933**, with the evidence that nothing produced
`trustGuardrailChecks` and nothing called `ads.policy.check`.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Library in `host/contentRules/` (pure, no feature imports); wiring in `features/campaign-ops/` (ADR 0923/0924 seams). |
| 2 | Toggle | None of its own; runs wherever `campaign-ops` runs. |
| 3 | Workflow surface | `ctx.features.campaignOps.checkContent({orgId, changeSetId})` (read; returns the stored report). |
| 4 | Node pack | `feature.campaign-ops.nodes.check-content` (pure), placed after `propose` in the `campaign-ops.change-request` chain. |
| 5 | Envelopes | None. |
| 6 | Agent pack | The change planner's propose prompt is told the rule families so it avoids them, but the rules gate, not the prompt. |
| 7 | Public surface | The client approval page shows `needs_review` findings and requires acknowledgment (ADR 0924 D5). |
| 8 | RBAC | Policy edits need `host:members:manage` on the client org. |
| 9 | Replay / fork | Deterministic: `asOf` stored, no model in the gate, report digest recomputed at decide. |
| 10 | Frontend | Findings on the change-set card and the diff (ADR 0926), with severity, the span highlighted, and the recommendation. |

## RFC verdict

**Host extension, no RFC.**

## Phased plan

Ordered after the pipeline P0s (owner decision 2026-10-18: pipeline first, then
rules).

| Phase | Scope |
|---|---|
| P0 | `host/contentRules/` with the trust (D2 text extractors), regulated, link and required-field rules; MyndHyve fixtures ported as tests (positive and negative per rule); deterministic ids; introduced vs pre-existing |
| P1 | Wiring into ADR 0923 D5 (stored report, `content_rules_blocked`) and ADR 0924 D2 (acknowledgment, `content_rules_changed`); findings in the UI |
| P2 | A2: brand compliance, cross-asset consistency, `verifyClaims` moved to host and wired to the client's KB collection |
| P3 | Per-client `contentPolicy` editing; CMS-structure extractors (testimonials, forms) |
| Later | CTA presets with the first ad destination; `ads.policy.check` produces from this library instead of its own list (and its duplicate in `ads-creative-validate` is removed) |

## Alternatives weighed

- **Port the three MyndHyve services as they are.** Rejected: in-memory state,
  double-counted fees, lost acknowledgments, substring false positives.
- **Extend `ads.policy.check`.** Rejected: it is a vendor pack with no callers,
  its own rule list is duplicated in another pack, and packs cannot be imported
  by host code. It becomes a consumer later.
- **An LLM judge for claims.** Rejected for the gate: not deterministic, and the
  approval must bind to a reproducible report. LLM judgments may be `info`.

## Open questions

- [ ] **Q1** Should `needs_review` acknowledgment be per finding (proposed) or one
      checkbox for all?
- [ ] **Q2** Should a client be able to turn off a whole rule family (for example
      `alcohol` for a brewery client)? Proposed: regulated categories yes,
      trust rules no.
- [ ] **Q3** `comments:write` scope (D8): who owns that follow-up? Proposed: a
      TODO row against `accessControl`.
- [ ] No `/architect` pass has been run on this ADR.
