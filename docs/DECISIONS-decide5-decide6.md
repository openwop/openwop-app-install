# DECIDE-5 and DECIDE-6 — resolved 2026-07-28

Two standing decisions from `docs/steward/TODO.md` § "Product / architecture decisions",
resolved via `/architect` reasoning against the code rather than left open.

---

## DECIDE-5 — machine-credential MFA posture (grade item `SEC-G1`)

**Question:** will any tenant need API keys subject to `requireMfa` — and if so,
we owe mint-time MFA stamping on key rows.

**Evidence:** there is no MFA concept on key rows today
(`features/developer-keys/apiKeyService.ts` has zero `mfa` references).

### Decision: **NO — keep the documented exemption. Do not build mint-time stamping.**

The reason is categorical, not a cost trade-off. `requireMfa` governs an
**interactive session**: it asks "did a human present a second factor when they
authenticated?" An API key is a **machine credential** — there is no human in the
loop and no second factor a machine can hold. Stamping "this key was minted by an
MFA'd session" records a fact about a *past human session*, not about the caller
presenting the key. It would let a policy read as satisfied while an unattended
process uses the credential — which is weaker than the honest exemption, because
it looks like control where there is none.

The controls that *are* category-appropriate for machine credentials — scope
limitation, rotation, revocation, and audit — already exist on this surface.

**Re-open trigger (specific, not "if things change"):** a customer contract or
compliance regime that explicitly requires *provenance* of machine credentials —
i.e. "keys may only be minted by an MFA-verified operator". That is a real and
different requirement (it constrains **minting**, not **use**), and mint-time
stamping is the correct implementation *of that requirement*. Nothing in the
current posture asks for it.

**Recorded in:** `docs/steward/TODO.md` `DECIDE-5`; grade item `SEC-G1` stays a DOCUMENTED
exemption with this rationale attached.

---

## DECIDE-6 — `identityLinkService` ownership: analytics domain vs host identity-floor

**Question:** should `features/analytics/identityLinkService.ts` graduate to a
`host/` identity-floor seam (decoupling cdp / crm / forms / campaign-intel), or
stay analytics' domain?

### The row's premise is wrong, and it changes the decision

`docs/steward/TODO.md` described it as *"imported by cdp/crm/forms as pure functions"* and the
edges as *"soft reads"* causing *"no runtime failure"*. That is not what the
module is. It:

- owns its **own `DurableCollection`** (`identityLinkService.ts:21`) — durable
  state, not a function library; and
- registers a **subject eraser AND an ADR 0381 subject-key resolver** at module
  load (`:22`, `:87`) — it sits on the DSAR erasure seam.

So the question is not graph tidiness between four features. It is: **a
host-level obligation (data-subject erasure, and the subject-key expansion that
tells the erasure which keys to reach) currently lives inside a feature
package**, and four other features depend sideways on that feature's store.

### Decision: **YES — graduate to `host/`. Effort M. No urgency.**

Two reasons, in order:

1. **The obligation is host-level.** Erasure completeness is not an analytics
   concern; it is a platform guarantee (ADR 0464). Its registration seam is
   already `host/subjectErasure.js`. The *concept* — "which sessions belong to
   which contact" — is identity-floor, which is exactly why cdp, crm, forms and
   campaign-intel all need it.
2. **ADR 0001 boundary.** Four features importing a fifth feature's service is
   the sideways dependency the feature-package model exists to prevent. A shared
   `host/` seam is the sanctioned shape.

**Why "no urgency", stated honestly.** I checked whether the module-load eraser
registration could silently fail to register (leaving a DSAR gap if no importing
feature loads). It could in principle — but **56 modules in this codebase
register erasers the same way**, so this is the house pattern, not a defect
unique to this module. That makes it a boundary correction, not a live integrity
bug. Do it when the module is next touched for another reason; do not open a
program for it.

**What would raise the urgency:** evidence that a deployment can boot with none
of {analytics, cdp, crm, forms, campaign-intel} loaded while still holding
identity-link rows. That would turn the boundary question into a DSAR gap, and it
should be checked as part of any future erasure-completeness audit — the
`ADR 0464` "one boot list" work is the natural place.

**Recorded in:** `docs/steward/TODO.md` `DECIDE-6`; ADR 0446 D.3 / gap `DEPMAP-3` — the `[2]`
classification it was left pending is now resolved in favour of graduation.
