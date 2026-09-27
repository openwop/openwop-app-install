# ADR 0544 — application intent attestation: sell scarcity, not volume

Status: implemented

Parent: [ADR 0539](0539-job-search-vertical-strategy.md). Composes:
[0541](0541-apply-grant-bounded-auto-submit.md) (human-confirmed submit),
[0540](0540-job-search-domain-and-crm-mapping.md) (the tailoring guards),
`host/auditChainService.ts`, capability tokens (ADR 0448), obligation ledger (ADR 0447).

Module: `features/job-search/attestation/` · Toggle: **`job-search`** (the ONE vertical flag).

## Context

The market this vertical enters is in the middle of a collapse in signal.

- Application volume is up roughly **45%**, mostly from AI agents.
- Employers are openly discussing **charging money to apply** as a spam defence.
- Applicants who send at high volume are **auto-rejected, deprioritised in the ATS, and
  silently flagged "do not contact."**

Every incumbent tool makes this worse, because every incumbent sells the same thing:
*more applications, faster*. That is a tragedy-of-the-commons product — each additional
user degrades the channel for all of them, including for themselves.

**The scarce good is not applications. It is credible intent.** Nobody currently sells it,
and — this is the part that matters architecturally — almost nobody *can*, because proving
intent requires an audit chain the applicant cannot forge and a submission path a human
provably touched. This host has both, for reasons entirely unrelated to job search.

## Decision

**Every application this product submits can carry a verifiable attestation of how it was
made.** Not a marketing badge — a signed, checkable claim backed by records the applicant
did not author.

### D1 — What is attested

Only facts the host can prove from its own records:

| Claim | Backed by |
|---|---|
| **A named person authorised this campaign, its targeting policy and its volume** | the ADR 0541 grant — issued by a human, bounded, revocable, attributable |
| *(when true)* A human reviewed this specific application before it was sent | the approval card on tiers B/C — asserted **only** for those applications |
| The résumé was derived from a verified profile, not fabricated | the ADR 0540 D4 tailoring guards: extract-verbatim, rewrites diffed against the original, dates derived server-side |
| **Of N applications this campaign, M were made through a warm path** | the ADR 0546 D0 path records — a RATIO, not a raw count |
| This applicant sent **N** applications **through this host** in the campaign window | the grant ledger + the deal records |
| The application was prepared against **this** posting | the listing's canonical id (ADR 0542 Tier-1 source) |

**Nothing subjective is attested.** No "strong match", no "highly motivated" — those are
claims the host cannot check, and one unfalsifiable field would poison the credibility of
the falsifiable ones.

**Correction (after ADR 0545).** An earlier draft attested "a human reviewed and submitted
this" unconditionally. Under Tier-A autopilot (ADR 0541) that is **false** — the whole point
is that no human sees the application. Attesting it anyway would have made the one claim
most likely to be checked the one most likely to be a lie, which would destroy the
credibility of every other claim with it.

The honest split is above: **authorisation** is always true and always attestable;
**per-application review** is attested only where it actually happened. An employer reading
"authorised by a named person under a bounded policy, 9 applications this week" gets a real
signal — arguably a *better* one than "a human clicked submit", which any spammer clicking
fast can also claim.

### D2 — Attest the RATIO, not the raw count

*(Revised: a bare count invites judgement in both directions, and the number that actually
carries signal is the mix.)*

"4 of 9 applications through a warm path" is a quality claim an employer can act on. "9
applications" is just a number about which a reader will invent a story — and for a heavy
but legitimate searcher it is actively unfair. The ratio also aligns the product with
ADR 0546 D0: the thing worth attesting is the thing worth doing.

The window is the **campaign**, never a lifetime total — a figure that only grows is not a
signal, it is a countdown.

This is the design's spine: it makes the product's incentive *align* with the user's real
interest, rather than against it. A tool that sells volume must inflate the number; a tool
that sells intent must restrain it. That is why ADR 0541 caps preparation and why velocity
is an explicit anti-goal there — those decisions are not caution, they are the product.

### D3 — Verification is a capability token, not a database lookup

The attestation travels as a **capability-token-shaped** artifact (ADR 0448): a bearer
secret hashed at rest, resolving to a uniform 404 when unknown, with tenant derived from the
resource. An employer who receives an application can resolve the token to a verification
page **without an account and without learning anything about the applicant beyond the
attested claims**.

This matters: the verifier is an unauthenticated third party we have no relationship with.
The design must therefore leak nothing, require no onboarding, and be safe to expose at
whatever volume a large employer would hit it with — which is exactly the public-surface
posture the host already implements (`PUBLIC_PATH_PREFIXES`, rate limits, payload caps).

**Correction note (P3, added during implementation).** D3 says the verifier learns nothing
"beyond the attested claims", and the P2 projection was built to honour that — per-type
whitelists, `grantedBy` replaced by an opaque digest. It still shipped the **campaign id**
verbatim at the top level of the view, and the P3 `/ux-review` caught it. The campaign id is
FREE TEXT THE APPLICANT TYPES into a form field, so it is both a stable correlator across
two attestations (the exact vector the `grantedBy` fix removed) and a place a person may
write something they never decided to disclose. Nothing read it — the verification page does
not render it. Removed in P3, along with millisecond precision on `issuedAt`, which is a
weaker fingerprint of the same kind (day precision is all the page shows).

The instructive part is WHY it survived a P2 `/code-review`: the P2 test **asserted** it
(`expect(view.campaignId).toBe(CAMPAIGN)`). The disclosure had been written down as intended
behaviour, so re-reading the code could not find it. A whitelist projection does not protect
the fields OUTSIDE the whitelisted sub-object, and a test that pins a leak is worse than no
test at all.

### D4 — It is opt-in, per application, and revocable

The applicant decides whether to attach an attestation, per application, at the moment of
submit. Some will not want to disclose their volume — and **that is a legitimate choice the
product must not punish**, so an application without an attestation is unremarkable rather
than suspicious. An applicant can revoke a token later (an offer accepted, a stale claim);
revocation resolves to the same uniform 404, which is why revocation cannot be distinguished
from a bad token.

### D5 — This is the two-sided seam, and it is deliberately not built yet

The verification endpoint is the point at which an *employer* first touches this host. That
is a genuine second market — a spam filter that works, sold to the side currently drowning —
and the same primitives serve it.

**Not in scope here.** Building the employer side before the applicant side has volume would
be inventing demand. What this ADR does is make sure the applicant-side design does not
foreclose it: tokens are resolvable by strangers, claims are machine-readable, and nothing
about the schema assumes the reader is the applicant.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package** | `features/job-search/attestation/` — a module of the one package (ADR 0539 D0). Composes `auditChainService`, `capabilityToken`, the grant ledger. |
| 2 | **Toggle** | **`job-search`** — no toggle of its own. Part of the sold bundle. |
| 3 | **Workflow surface** | `ctx.features['job-search'].attestation.issue(dealId)` (write, human-initiated only) and `.revoke(tokenId)`. **No read op for the token secret** — issuing returns it once. |
| 4 | **Node pack** | **None.** Issuing an attestation is a human act at submit time, not a workflow step. A node would let a chain mint credibility for itself. |
| 5 | **Envelopes** | **None.** A model must never be able to attest. |
| 6 | **Agent pack** | **None.** |
| 7 | **Public surface** | The verification page: `PUBLIC_PATH_PREFIXES` entry, tenant from the resource, uniform 404 for unknown/revoked, rate-limited, payload-capped. No PII beyond the attested claims. |
| 8 | **RBAC** | Issue requires the acting user to BE the subject (`Deal.owner`), never merely org-admin — an attestation asserts a *person's* conduct and cannot be minted on their behalf. Revoke: the subject or org-admin. |
| 9 | **Replay/fork** | Token id stamps onto the run at issuance; a fork never re-issues (issuance is an external-effect-class act guarded by ADR 0531). The attested counts are computed at issuance and **frozen into the token** — recomputing at read would let a later application silently change a past claim. |
| 10 | **Frontend** | A single checkbox at the submit moment, in plain language: *"Attach a verification link — lets the employer confirm a human sent this, and that you've applied to 9 roles this week."* The number is shown before consent, because consenting to disclose an unseen number is not consent. |

**Correction note (P4, added during implementation).** Matrix row 10 puts "a single
checkbox at the submit moment". **There is no such moment on the path this feature
actually runs.** Under tier A/B the host submits through a board's documented API and no
human is present — the same fact that already forced this ADR to stop asserting
`human-reviewed`. A checkbox staged where nobody is standing is not consent, it is a
setting; and it is very likely unimplementable besides, since a third-party board's API has
no field to carry our link.

So the consent moved to where the human is: **per application, on the applicant's own
applications list, after the application went out**. That is the more faithful reading of
row 10's actual requirement, not a weaker one — "the number is shown before consent" is only
satisfiable once the applications exist. At grant time the count is unknown, so a blanket
"attach to everything" switch on the authority page would be consent to an unseen number,
which is precisely what row 10 forbids.

Two further gaps surfaced while building it, both in P2 code that had already passed a
review, and both closed here:

- **The route accepted `campaignId` from the request body**, beside an unrelated `dealId`.
  D1 says a fabricated claim is unrepresentable because the builder derives everything from
  records — true *within* a campaign, while the caller chose *which* campaign. Any
  campaign's numbers could be attached to any application. The campaign is now derived from
  the audit row that recorded the submission (`findAttestableApplication`), so the
  deal↔campaign link is a read, not an assertion.
- **Nothing checked that the application was ever sent.** An attestation could be minted for
  a `deal:` string typed by hand — a fabricated claim with a hash-linked source ref beside
  it, which is the worst available combination. Absent a recorded submission, issuance is
  now a typed refusal.

Matrix row 8's subject rule (`issue` requires the acting user to BE the subject) was also
unenforced; it is now checked in the service, not only the route. Verifying it took a real
`ws:` shared workspace: two sessions in a *personal* tenant resolve to the same `User` by
design, so the obvious two-email test was vacuous.

## Phased plan

| Phase | Scope | Verification |
|---|---|---|
| **P1** | The claim set + issuance from records (D1). No token, no surface. | Every claim traces to a record; a fabricated claim is unrepresentable. Frozen-at-issuance counts asserted. |
| **P2** | Capability-token issuance + revoke. | Hash-at-rest; unknown, revoked and cross-tenant all return an identical 404 (indistinguishability is the test, not the 404). |
| **P3** | The public verification page. | Public-route tests: no PII beyond claims, rate limit, payload cap, uniform 404. **Shipped**: backend route + SPA page at `/verify/:token`. |
| **P4** | The consent UI (**not** at submit — see the P4 correction note). | `/ux-review`; the disclosed number is visible **before** the consent, not after. **Shipped**: per-application share + revoke, previewing through the SAME projection the employer reads. |

## Implementation record

| Phase | Landed as | Pinned by |
|---|---|---|
| **P1** | the claim set derived from records | `job-search-attestation-claims.test.ts` |
| **P2** | capability-token issue/revoke, hash at rest | `job-search-attestation-token.test.ts` |
| **P3** | public route + SPA page at `/verify/:token` | `job-search-public-attestation-route.test.ts`, `__tests__/verifyPage.test.tsx` |
| **P4** | per-application consent + preview + revoke | `job-search-attestation-issue-routes.test.ts`, `job-search-attestation-subject-rule.test.ts`, `__tests__/shareConsent.test.tsx` |

Two decisions were overturned by implementation and carry correction notes above rather than
edits to the original reasoning: **D3's leak boundary** (the campaign id was still being
returned) and **matrix row 10's submit-moment** (no such moment exists on the automated
path). Both were found by the per-phase reviews the work was run under, and both were in
code that had already passed one.

## Alternatives weighed

| Option | Verdict |
|---|---|
| **Do nothing — compete on volume** | Rejected. It is the commons-destroying strategy, it is what every incumbent does, and the evidence says it actively harms the buyer (auto-rejection, DNC flags). |
| **A trust "score"** | Rejected — a computed score is a subjective claim wearing a number's clothing, and it invites gaming. Attest facts; let the reader judge. |
| **Attest by default** | Rejected — disclosing application volume is genuinely sensitive. Opt-in per application, with the number shown first. |
| **Build the employer side now** | Deferred (D5). Inventing demand before the applicant side has volume. |
| **Signed facts, opt-in, verifiable by a stranger (chosen)** | The only option that is both honest and differentiated. |

## RFC gate

**Host work, no RFC.** Capability tokens, public routes, and the audit chain are all existing
host shapes; nothing touches the OpenWOP wire. **Watch:** if an attestation ever needs to be
verifiable by *another OpenWOP host* rather than by a human with a link, that is a wire
claim and needs an RFC first.

## Open questions

- **OQ-1 — does anyone check it? TEST BEFORE BUILDING, and the test is cheap.** A static
  verification page plus ~20 real applications, measuring click-through, costs a day and
  settles it. **If click-through is ~0, the honest response is to keep the audit trail** —
  it is nearly free, entirely true, and useful internally — **and drop the employer-facing
  claim** rather than build P3 on a hypothesis. This test also gates ADR 0539 OQ-5: with no
  clicks there is no employer-side product to build.
- **OQ-2 — volume disclosure. RESOLVED by D2**: attest the warm-path *ratio* and scope the
  count to the campaign window, so a legitimate high-volume searcher is not punished by a
  number that reads badly out of context.
- **OQ-3 — forgeability by omission. RESOLVED by scoping.** The claim says "through this
  host, in this campaign window" — on the token itself, not in a footnote. An applicant can
  still apply elsewhere by hand; the attestation never claims to be their whole search, and
  wording that implied otherwise would be the dishonest part.
