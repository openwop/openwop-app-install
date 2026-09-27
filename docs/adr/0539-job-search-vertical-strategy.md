# ADR 0539 — a job-search vertical: compose the primitives, don't rebuild the app

Status: Proposed

Prior art: a studied external job-application agent (multi-user web app + a local host
driving a browser). Referenced throughout as **the prior art**; nothing is vendored.
Children: [0540](0540-job-search-domain-and-crm-mapping.md) ·
[0541](0541-apply-grant-bounded-auto-submit.md) ·
[0542](0542-job-board-adapters-and-listings.md) ·
[0543](0543-career-agent-and-work-loop.md).

## Context

A full job-search vertical, stated as a feature list, reads as ~22 features:
accounts, profile, resume studio, campaigns, scoring, dedupe, an apply engine, an
application pipeline, an inbox, networking, interviews, Upwork, self-promotion, an
autonomous pilot, push, a credential vault, a board registry, a public job index,
analytics, admin, retention, realtime.

**Measured against this host, most of that already exists.** a job-search product is a *vertical
application* over primitives; openwop-app is the platform those primitives live in. The
boundaries audit is therefore not a formality here — it is the entire decision.

### The audit (evidence, not impression)

| Capability the vertical needs | Owner in openwop-app today | Verdict |
|---|---|---|
| Application pipeline + stages + activity timeline | **CRM** — `Deal` with `pipelineId`/`stageId`, stage history, weighted reports (`features/crm/entities/deals.ts:37`) | exists |
| Employer / recruiter records, dedupe, merge | **CRM** `Company`/`Contact` + `contactIdentityService` + `crmMergeService` | exists |
| Inbox scan (Gmail → classify → match to an application) | **CRM `gmailSyncService`** — "Gmail inbox → CRM activity sync, opt-in store + scheduler wiring" | exists |
| Drive a browser: navigate, fill, submit | **`computer-use`** — recorded workflow steps (replay reads the trajectory, never re-drives), risk-tiered HITL | exists, **stronger** |
| Fit scoring / ranked selection | **`host/weightedScoring.ts`** (`rankByPriority`), already shared by 4 features | exists (ADR 0534 P0) |
| The autonomous loop (sense → decide → act → record) | **heartbeat daemon + kanban + ADR 0534/0535** | exists, **just shipped** |
| Resume documents, versions, generated output | **Documents & Templates** — versioned store + prompt-template binding + `outputSchema` validation | exists |
| Board/site credentials | **BYOK secret resolver + Connections** | exists |
| Ask the human; notify | **approvals / interrupt cards + Notifications** | exists |
| Public job index, public profile, leaderboard | **Publishing + CMS + Discovery + `entities`** | exists |
| Retention, realtime, admin, analytics | ADR 0371 retention, SSE channels, `operations`, `analytics` | exists |

**Genuinely new:** the job-search *domain* (a job listing, the application↔deal mapping,
resume-tailoring rules, eligibility rules), **board adapters**, **Upwork**, and a
**bounded auto-submit authority**. That is four feature-packages composing existing
owners — not twenty-two ports.

### Two name collisions that would have shadowed shipped features

- **`promotions`** here is the e-commerce discount engine (MERCH-B), *not* self-promotion
  posts. the self-promotion capability must not take that name.
- **`proposals`** here is governance for AI-authored artifacts (propose → review → apply),
  *not* sales or Upwork proposals. FEATURES.md says so explicitly: "NOT sales proposals".

Both are the `orgs`↔`accessControl` failure mode waiting to happen: Express matches the
first registrant, so an overlapping later feature is silently dead.

## Decision

**Build the vertical as a thin layer over existing owners** — as **ONE feature-package
behind ONE toggle, sold as ONE marketplace bundle.**

| ADR | Module of `job-search` | Owns | Composes |
|---|---|---|---|
| [0540](0540-job-search-domain-and-crm-mapping.md) | `domain/` | job digest, résumé-tailoring rules, eligibility rules | CRM (deal/company/contact), Documents, `weightedScoring` |
| [0541](0541-apply-grant-bounded-auto-submit.md) | `host/applyGrant.ts` (core seam) | `ApplyGrant` — bounded, revocable standing consent | `computer-use` commit gate, approvals |
| [0542](0542-job-board-adapters-and-listings.md) | `boards/` | board adapters + the listing façade | `entities` kernel, Connections, Publishing, `computer-use` |
| [0543](0543-career-agent-and-work-loop.md) | `agent/` | the persona + its chains/stacks | roster, heartbeat, kanban, ADR 0534/0535, the ONE chat |
| [0544](0544-application-intent-attestation.md) | `attestation/` | verifiable proof of how an application was made | audit chain, capability tokens, the grant ledger |
| [0545](0545-zero-toil-answer-bank-and-autopilot.md) | `autopilot/` | the answer bank + the policy that makes it hands-off | 0540 profile/variants, 0541 tiers, 0542 sources |
| [0546](0546-post-application-lifecycle.md) | `lifecycle/` | follow-ups, interview replies + prep, the response-rate scoreboard, warm intros | CRM stage history/activities, Documents, kanban, approvals |

### D0 — ONE package, ONE toggle, ONE sellable bundle

*(Decided after the packaging question was reopened by the marketplace requirement; it
supersedes an earlier four-package split in this ADR's own drafting.)*

Four toggles would make the vertical **partially purchasable**: `isSellableBundleFeature`
gates entitlement **per feature id** (`host/featureBundles.ts:83`), so a buyer could hold
`job-search` but not `job-boards` and get a product that half-works. For something sold as
one thing, that is incoherent — and it multiplies the paywall surface by four for no gain.

So: one package `src/features/job-search/`, one toggle `job-search`, internal modules for
the four concerns. The concerns stay separated **in code** (that is what the child ADRs are
for) without being separately gated or separately purchasable.

`ApplyGrant` keeps no toggle of its own — it is a core authority object, inert unless
`job-search` **and** `computer-use` are both on.

### D1 — An application IS a CRM deal. The digest is NOT a custom field.

Verified against the schema, not the docs. `Deal` (`crm/entities/deals.ts:37-57`) carries
`title`, `pipelineId`/`stageId`, `companyId`, `contactId`, `status` (`open|won|lost`), and
`amount`/`currency` — which is **genuinely salary**, not a forced fit. Scalar application
fields (jobUrl, board, matchScore, resumeVariantId) fit CRM's typed custom fields, whose
`FieldType` is `string|number|boolean|date|enum|reference` (`crm/entities/fieldDefs.ts:26`)
— `reference` even covers the resume-variant pointer.

**But `customFields` is `Record<string, string | number | boolean>` — scalars only**, and a
job digest is a structured object (`skills[]`, `requirements[]`, `responsibilities[]`).
Forcing it in (JSON-in-a-string) would be exactly the kind of quiet impedance mismatch that
rots. The digest belongs to the `job-search` package; the listing belongs to the `entities`
kernel as a system-type façade (the ADR 0409/0410 precedent, where company/deal/product are
already modelled that way). Detail in ADR 0540.

### D2 — Auto-submit is an authority problem, not a browser problem.

`computer-use` gates `commit`-class actions (submit/purchase/download/new-origin) behind a
per-action human approval. auto-apply's entire premise is submitting without one. The
temptation is to build a second browser driver that is not bound by that gate — **which is
the parallel-architecture violation this audit exists to prevent.**

Instead: an **`ApplyGrant`** — bounded (N submits), scoped (these boards, this resume
policy), time-limited, revocable, and attributable to a person. The commit gate consults
the grant; absent or expired, it falls back to per-action approval exactly as today. The
gate is never weakened for anything else. Detail in ADR 0541.

### D3 — The Pilot loop is already here.

the prior art's orchestrator (sense → decide → act → record → exit, with claims, a journal, and
one-item-per-cycle) maps onto the heartbeat daemon + kanban board + ADR 0534 ranked
selection + ADR 0535 work-item recovery. What is missing is a **career-agent persona** and
its **chains** — not a loop. Per `ARCHITECTURE.md`, a workflow ships as a chain or a stack,
never a hard-coded in-tree definition; those skills become chain packs and node
packs, and the agent reaches them through the ONE chat. Detail in ADR 0543.

### D3a — Completeness audit (2026-08-10)

A coverage pass against the full baseline surface found the ADR set had designed *sending an
application* and almost nothing after it. **Sending is the cheap half** — once ADR 0541 makes
submission automatic, everything downstream becomes the product. Five gaps closed:

| Gap | Closed by |
|---|---|
| Cover letters — absent entirely, and they are part of applying | [0540 D4a](0540-job-search-domain-and-crm-mapping.md) (a Documents kind under the same anti-fabrication guards) |
| Follow-up cadence | [0546 D1](0546-post-application-lifecycle.md) (kanban cards, per-stage, one-per-stage cap) |
| Interview replies | 0546 D2 — drafted, **never** sent |
| Interview prep sheets | 0546 D3 — a Documents artifact, generated once |
| Response-rate / funnel analytics | 0546 D4 — the vertical's only honest scoreboard |
| Warm intros (named but undesigned) | 0546 D5 — discover + draft, never auto-send |

### D4 — Deliberately NOT ported

- **The .NET PTY terminal host + agent dock.** It exists because the prior art runs the model on
  the *user's own* Claude/Codex subscription on their laptop. This host is multi-tenant and
  BYOK; the equivalent is the existing run/heartbeat machinery. Porting a local companion
  would be a second execution model.
- **Its auth, retention, SSE, admin, analytics and push.** All have owners here; re-porting
  them is how you end up with two of everything.
- **Self-promotion posts** (community "who wants to be hired" threads). Peripheral to
  applying, and posting on a user's behalf to a community carries reputational risk that
  deserves its own decision. Note `promotions` is already taken by the e-commerce discount
  engine, so it can never reuse that name.
- **Public candidate profile / portfolio / leaderboard.** A public-content surface that
  Publishing + CMS already own — a different product from a job-search agent.
- **The provider-neutral skill tree.** Its shape (one workflow per directory, `_shared/`
  docs, worker subagents) is excellent and worth *learning from* — recorded in
  `docs/steward/` — but this host's equivalent is packs + agents, and it already exists.

## What DOES port, as design (not code)

Recorded because these are the ideas worth keeping, independent of the code:

1. **Server-compiled ranking over a stored queue** — already adopted (ADR 0534).
2. **A tool that declares when its own output is untrustworthy** — the prior art's
   `verdict: 'trust' | 'deliberate'` on the fit scorer. Routed to `/grade-ai-exchange` as a
   rubric row rather than an ADR here.
3. **Eligibility rules as a named, testable list** — "what is NOT a skip" is as important as
   what is. Ports directly into ADR 0540.
4. **Untrusted-content discipline at every read** — postings and emails are attacker-authored.
   This host has `capability-firewall` + the `<UNTRUSTED>` fencing convention; ADR 0542 binds
   board content to it.

## Alternatives weighed

| Option | Verdict |
|---|---|
| **Build it as ~22 standalone features** | Rejected — the audit shows most already exist. Would create a second pipeline, a second inbox, a second browser driver, a second loop. |
| **One monolithic `job-search` feature** | Rejected — it would own entities CRM/Documents/`entities` already own, and its toggle would gate a dozen unrelated surfaces. |
| **Federate to an external MCP/A2A peer** | Genuinely viable and cheaper, and worth revisiting: it keeps the vertical out of this host entirely. Rejected for now because the ask is a first-party capability, and because the domain value (applications as first-class CRM records) is exactly what a remote peer cannot give. Recorded as OQ-3. |
| **Four packages composing existing owners** | **Chosen.** |

## What is actually being sold (and why it is not "apply to more jobs")

*(Added after competitive + legal research; it reframes the product and constrains
0541/0542.)*

The obvious product is *more applications, faster*. The evidence says that product harms the
person who buys it: application volume is up ~45% (mostly AI agents), employers are
discussing charging money to apply, and high-volume applicants are auto-rejected,
ATS-deprioritised and silently "do not contact"-flagged. Platforms independently detect
"human-impossible application velocity" and suspend accounts. Meanwhile the tool with the
best standing in this market autofills everything and **still requires the human to click
submit** — and has faced no enforcement, because every action is user-initiated.

### The two-track thesis

Cold applications convert at **2–3%**. Referred applications convert at **40–65%** — one
referral is worth roughly **forty** cold applications, and ~85% of roles are filled through
networking. That single ratio determines where an agent's cycles are worth spending:

1. **Auto-apply is the FLOOR.** Automatic, unattended, effectively free (ADR 0541 Tier A).
   It costs the user nothing and covers breadth. It is table stakes, not the product.
2. **The warm path is the MULTIPLIER, and it is the primary agent workload** (ADR 0546 D0).
   For every strong match: is there a path in? Find it, draft the intro, hand it over.

This is what resolves the tension the research created. The answer to "why not just fire off
500 applications" is not that volume is wrong — it is that **the 501st cold application is
worth 1/40th of one warm intro**, and the agent has finite cycles. Reallocating effort is a
better outcome for the user, not a restriction imposed on them.

So this vertical sells **applications that get read** — hands-off, but not indiscriminate:

- **auto-apply is fully automatic where submission is first-party and intended** — an
  employer's own ATS publishes a documented submission endpoint precisely to receive
  applications, and that path involves no platform account, no session, no CAPTCHA and no
  velocity heuristics. It is also *more* reliable than form-driving: deterministic and
  replayable. Only **platform-native** apply (LinkedIn/Indeed) — the surface the evidence
  actually indicts — stays human (ADR 0541 tiers);
- **toil is eliminated by answering once, not by asking politely** (ADR 0545): a seeded
  answer bank, batched exceptions that never stall a campaign, and 2–4 reused résumé
  variants instead of one generated document per job;
- discovery uses first-party published sources rather than authenticated scraping
  (ADR 0542 D5), which is both safer and better data;
- and each application can carry a **verifiable attestation** that a human sent it, from a
  résumé that was not fabricated, at a sane volume (ADR 0544).

The three decisions reinforce each other. A product that sells volume must inflate the
number; a product that sells intent must restrain it — which is why the caps in 0541 are the
product rather than a safety margin.

## Marketplace: sold as one bundle (ADR 0419 / ADR 0366)

The vertical is a **sellable bundle**, not a free feature.

- **`distributions/bundles.json`** gains a `job-search` bundle whose `features` list is
  exactly `["job-search"]`. Membership in a bundle is what makes a feature
  entitlement-gated — `isSellableBundleFeature` reads it, and `requireFeatureEnabled`
  consults it at the ONE central choke (`features/featureRoute.ts:50`), so **every** authed
  route in the package inherits the paywall without a single per-route change.
- **Money never enters `bundles.json`.** Pricing rides `OPENWOP_BILLING_BUNDLE_PRICES`,
  which maps a Stripe price to a bundle id. The catalog stays a composition manifest.
- **The `priced ⟹ gated` invariant is structural, not a review item.** A bundle may only be
  priced if its features actually gate; the `free` allowlist is *all bundle features minus
  the priced bundles'*. Because the vertical is one feature id in one bundle, this holds by
  construction — there is no second id that could be priced but ungated.
- **Flat per workspace.** Bundles grant per-tenant with unlimited seats, so the price is
  per workspace, not per seat. That matches the product: a workspace buys job search, and
  everyone in it uses it.
- **Anonymous and public callers are never paywalled.** The entitlement check is scoped to
  authenticated principals (the ADR 0176 shopper exemption), so a published listing page
  stays reachable.

**Honesty consequence:** the moment the bundle is priced, `job-search` must genuinely fail
closed without an entitlement. A feature that is sold but silently works unpaid is a worse
defect than one that is missing — so P0 of the build is the gate, not the domain.

## RFC gate

**Host work, no RFC — for all four.** Nothing lands on the OpenWOP wire: no run-event field,
no capability flag, no event type, no endpoint contract, no auth/scale profile, no normative
MUST. Routes are non-normative host-extension under `/v1/host/openwop-app/*`.

Two things to watch as the children are built:
- If board adapters ever need a **new connection-pack shape**, that rides the already-Accepted
  RFC 0095 — still no new RFC (the ADR 0033 precedent).
- If `ApplyGrant` ever needs to travel **between hosts**, it becomes wire and needs an RFC.
  Keeping it host-local is a deliberate constraint, not an oversight (ADR 0541 OQ-1).

## Open questions

- **OQ-1 — is a job application really a deal?** The mapping is strong on the schema, but
  CRM's reports (weighted pipeline, forecast) assume *revenue*. A job pipeline's "amount" is
  a salary that is never summed across rows. Does that make the Reports tab misleading for a
  job-search pipeline, and if so is that a per-pipeline reporting flag? Settle in ADR 0540
  before code.
- **OQ-2 — multi-tenant posture.** The prior art is single-user-per-machine: the applicant *is*
  the operator. Here a workspace could run job search on behalf of many people, which raises
  questions the prior art never had to answer (whose credentials, whose consent, whose PII in a
  shared board). ADR 0541's grant is attributable per person for exactly this reason.
- **OQ-3 — port vs federate.** Revisit the MCP/A2A alternative after ADR 0540 lands: if the
  domain turns out to be thinner than expected, federation may dominate.
- **OQ-4 — Upwork.** Deliberately unscoped in this batch. It is a second vertical (freelance
  bidding) with its own quality heuristics and proposal flow, and folding it in now would
  make the domain package incoherent. Its own ADR once 0540–0543 land.

## Consequences

- Four new feature-packages, all default OFF, each composing an existing owner.
- One new authority object (`ApplyGrant`) extending a shipped gate rather than bypassing it.
- No second pipeline, inbox, browser driver, credential store, or work loop.
- The `promotions` / `proposals` name collisions are recorded so a later session cannot
  wander into them.
