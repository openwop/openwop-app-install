# ADR 0438 — KickTodo Admin & Trust experience: the operations console over the existing operator/trust packages

| | |
|---|---|
| **Status** | **implemented** — **§ Status-correction (2026-07-23, code-verified audit):** the 2026-07-19 note below under-reports. A0–A3 AND A5/A6/A7/A8 are ALL shipped as `tier: 'admin'` pages in `frontend/react/src/features/kicktodo-admin/` — A7 `AuditMetricsPage` (B18-honest), A6 `AiConnectionsPage` (#2212, the real `GET calendar-status` read — the B20 honesty law), A5 `AdminCommercePage` (#2360/#2372, over the now-existing `requireKicktodoManage` reconcile/share-policy/payout-run routes), A8 folded into the console per the §13 verdict; A1 is realized via the ADR 0460 Exception Ledger (`host/exceptionProjection.ts` + `ExceptionLedgerRow`). Every §5 blocker-gate is closed or honestly disclosed (B15/B16/B17/B19/B21 fixed; B18 acute-half fixed + disclosed; B20 resolved-as-deferred with the honest read; B2 half-open — reviewer eligibility — rendered honestly in A2). **A4 SHIPPED 2026-07-23** as the read-only aggregate lens the §13 verdict permits: `GET …/kicktodo/org-programs/admin/people` (homed in `kicktodo-organizations` so no new feature→feature edge; `requireKicktodoManage`-gated; member counts by role + per-org link/library counts, NO per-person rows, NO cohort outcome aggregates — the B16 law — consent posture declared) + `PeopleAccessPage` at `/admin/kicktodo/people`; person- and consent-scoped surfaces stay linked at their own authority. Original 2026-07-19 note: A0+A2+A3 shipped (#2200/#2203) as an additive platform-admin tier (the `/architect` gate §13 ruled out re-homing the workspace pages — authz mismatch). See §12 + §13. |
| **Feature** | Frontend experience/design law over the EXISTING KickTodo operator + trust feature-packages (a workspace tier, not a new package) |
| **RFC verdict** | Host work — **no wire, no new RFC, no new toggle/feature-package** |
| **Requirements source** | `docs/kicktodo-ux-ui-recommendation.md` §7 (Administrator/operator), §4/§4.1/§4.4 (IA + workspace switcher), §8 (components), §9 (visual), §10 (a11y), §11 (notifications), §13 (roles/permissions), §14 (measurement), §15 (route map), §16 UX-3 (phased delivery) |
| **Composes (does not fork)** | ADR 0416 (trust page + audit export), ADR 0428 (organizations/cohorts/k-anon reports), ADR 0432 (metrics + verifier sampling), ADR 0420 (commerce/entitlements/payouts), ADR 0421 (integrations/calendar/messaging), ADR 0426 (community/moderation) |
| **Sibling experience ADRs** | ADR 0436 (participant), ADR 0437 (creator) — all three name the SAME shared foundations (SSoT: the recommendation doc §8/§9/§10 + `DESIGN.md`), each applied in its own register; see §7 below |

---

## 1. Why this exists

The KickTodo operator surfaces exist as capable but **scattered feature-owned admin
pages** (`/kicktodo/org-programs`, `/kicktodo/metrics`, `/kicktodo/community`, the
governance `AuditLogPage`, the commerce entitlement views). Read together against
§7 of the recommendation and the grade-D KickTodo audit in `docs/steward/CODEBASE-ASSESSMENT.md`,
two problems are structural, not cosmetic:

1. There is **no console**. An operator cannot answer "what needs me right now, who
   owns it, and what is the safe next action" from one place. Each feature ships its
   own page; the human has to remember which one to open when a payment fails or a
   flag is raised. §7.1's command center — "not a collection of vanity charts" — does
   not exist.
2. Several operator surfaces are exactly where the **security-F blockers concentrate**
   (KTFULL-B15…B21, `docs/steward/CODEBASE-ASSESSMENT.md` lines 1896–1902). A polished admin UI
   painted over an unenforced authorization boundary is worse than an ugly one — it
   *asserts* trust the code does not hold. The design law here is that the console
   must present authorization, scope, and metric trustworthiness **truthfully**, and
   must not render a surface as trustworthy while its blocker is open.

**Thesis (from §7):** the KickTodo Admin & Trust surface is *a trustworthy exception,
safety, and operations console* — decision-first, every exception owned, every metric
honest about its definition and its authority.

This ADR is **experience/design law over what already exists**. It stands up **no new
feature-package, no toggle, no route family, no component system, and nothing on the
wire.** It rides the existing app workspace/nav model (`<AdminLayout>`'s embedded
rail, DESIGN.md §5), the shared `ui/` primitives, and the operator packages listed
above.

---

## 2. Boundaries audit — what already exists (reuse, never rebuild)

| Concern | Existing owner | This ADR's relationship |
|---|---|---|
| Admin tier shell + nav | `<AdminLayout>` embedded rail + the single pinned `Admin` sidebar entry (`src/chrome/Sidebar.tsx`, DESIGN.md §5); nav declared once in `src/chrome/features.tsx` | The Admin & Trust workspace tier lives here; add IA groups (§4.4) to the existing rail — no second shell |
| Human-review inbox | `<ReviewInboxPanel>` + `<ReviewCard>` over the `/reviews` projection (ADR 0068, DESIGN.md §5) — the ONE unified review card; `<ApprovalsInbox>` migrates INTO it | Safety & approvals composes THIS inbox; it does **not** build a parallel queue renderer |
| Page chrome / collection kit | `<PageHeader>`, `<StateCard>`, `<Notice>`, `<DataTable>`, `.chip`, `.action-bar`, `<ViewToggle>`, right-side quick-look drawer, `<CommentsPanel>` (DESIGN.md §4.5, §5) | The console is assembled from these; the §4.5 canon (stats-are-filters, status-is-a-system, every-entity-has-a-URL) is applied, not re-invented |
| Audit truth + export | ADR 0301 tamper-evident chain; `GET …/governance/audit/export` (`host:members:manage`); `settings/AuditLogPage` (ADR 0416) | Audit tab surfaces these; no new audit store or export pipeline |
| Metrics | ADR 0432 computed-on-read projections + verifier sampling (`kicktodo-metrics`) | Metrics tab renders the projections; adds NO second read model |
| Orgs / cohorts / access | `accessControl` (the SINGLE org/team/member owner); ADR 0428 org programs; ADR 0419 cohorts | People & access composes accessControl + org programs; no KickTodo-local identity/org model |
| Commerce / payouts | Commerce / Billing / Commerce-Connect (ADR 0176/0385); ADR 0420 entitlements | Commerce & payouts reconciles the existing money truth; no second money route/ledger |
| Integrations | Connections (ADR 0024), notifications (ADR 0010), whatsapp (ADR 0394); ADR 0421 lanes | AI & connections surfaces consent/health/readiness; no second credential store |
| Moderation | approvals owner (`community-review`, `community-profile` kinds); ADR 0426 | Safety composes the approval kinds; no second moderation queue |
| Super-admin | **env-based** — `OPENWOP_SUPERADMIN_TENANTS` (never a DB field) | The UI presents superadmin as an environment fact, tenant-admin as server-authoritative scopes; §5 below |

**Assertion:** no new toggle, no new feature-package, no new component/token system, no
new route family on the wire. Any host-private READ the console needs that does not yet
exist is a **non-normative host-ext endpoint** (`/v1/host/openwop-app/*`) — see Open
Questions; none is required for UX-3 as scoped, because every group composes an
existing owner's read.

---

## 3. Decision — the Admin & Trust information architecture

The console is **one workspace tier** with the §4.4 groups, presented in the
`<AdminLayout>` embedded rail. Nav mirrors §4.4 / route map §15 (`/admin/kicktodo/*`):

| Group | Route (§15) | Composes | Blocker-gate prerequisite |
|---|---|---|---|
| **Command center** | `/admin/kicktodo` | every group's queue head (counts + oldest exception) | B17/B19 (a tile may not read as trustworthy until its metric is honest); B1/B2 |
| **Safety & approvals** | `/admin/kicktodo/safety`, `…/approvals` | `<ReviewInboxPanel>` over ADR 0426 `community-review`/`community-profile` + ADR 0432 `metrics-verifier-sample` + ADR 0415 publication approvals | **B15** (moderator authority on flag-resolve), **B2** (approval-reviewer eligibility), **B18** (verifier sample forgeable) |
| **Catalog & content health** | `/admin/kicktodo/catalog`, `…/content-health` | `kicktodo-core`/`kicktodo-creator` version + lifecycle + incident state | **B1** (publication authz) |
| **People & access** | `/admin/kicktodo/people`, `…/organizations` | `accessControl` + ADR 0428 org programs + ADR 0419 cohorts | **B16** (org admin reads a cohort aggregate without consent); B1/B2 |
| **Commerce & payouts** | `/admin/kicktodo/commerce` | ADR 0420 entitlements + Commerce/Connect money truth (ADR 0176/0385) | money-truth CAS (no code blocker; design law = paid-but-unfulfilled is a first-class incident) |
| **AI & connections** | `/admin/kicktodo/ai-operations`, `…/notifications` | Connections/notifications/whatsapp + ADR 0421 consent/health | **B20** (calendar-write port has NO production transport — must render as "port awaiting adapter", never "connected") |
| **Audit & metrics** | `/admin/kicktodo/metrics`, `…/audit` | ADR 0432 projections + ADR 0416 chain export + `AuditLogPage` | **B17/B18/B19** (a metric shown as sound while its definition/authority/sampling is open is a lie) |
| **Settings & distribution** | `/admin/kicktodo/settings` | feature-toggle + distribution posture (existing) | dangerous settings never share the weight of ordinary preferences (§7.11) |

### 3.1 The exception/queue model (the §16 UX-3 exit bar, made structural)

UX-3's exit evidence is verbatim: *"every participant-, content-, access-, and
money-critical exception has an owner, queue, safe action, and audit trail."* This ADR
turns that sentence into a **rendering contract** every group obeys:

- **Owner** — every exception row names a server-authoritative owner (a scope holder,
  a moderator, a reviewer), rendered with the §4.5-rule-7 avatar + status ring. "A
  different user" is never presented as "an authorized reviewer" (§7.2) — the row
  shows the *eligibility*, gated on the real check (B2/B15).
- **Queue** — each group is a decision-first queue (§4.5 rule 1): what needs the human
  is at the top; inventory (catalog, ledgers, tables) is below. An empty queue is
  *celebrated* ("You're all caught up"), never rendered as nothing.
- **Safe action** — one primary, reversible action per row (`btn-accent-solid`); bulk
  actions are restricted to safe, reversible operations (§7.3); publication/retirement
  stay per-release with confirmation + impact preview (the shared `confirm()`).
  Consequential decisions require a reason (§7.2).
- **Audit trail** — every consequential row expands to its ADR 0301 chain slice
  (actor/subject/resource, before→after, approval + dispatch provenance) and links to
  the ADR 0416 export. Configuration changes carry change-preview + rollback guidance
  (§7.11).

### 3.2 Command center (§7.1)

Five priority bands, in order: **Needs action now** (safety, money/entitlement
failure, broken active content, provider outage) → **Approvals waiting** → **Operational
health** (workflow/schedule/notification/calendar/provider readiness) → **Catalog &
participant health** → **Recent changes**. **Every metric tile is a filter into its
owning queue** (§7.1 + §4.5 rule 2) — a tile both reports a count and narrows the list
it heads; a static stat band next to a separate dropdown is forbidden (§4.5 rule 2).

### 3.3 Role & permission presentation (§13)

The UI **never derives permission from a display-role label** (§13). It renders
server-authoritative allowed actions and explains an unavailable action without leaking
a hidden resource. Concretely:

- **Super-admin is an environment fact.** The console surfaces `OPENWOP_SUPERADMIN_TENANTS`
  membership as *"granted by deployment configuration"* — not a toggle, not a role a
  DB row can grant or the UI can mint. There is no "make admin" button, because there
  is no such write.
- **Tenant-admin authority is a scope**, resolved server-side (`host:members:manage`,
  `host:kicktodo:manage`, `host:org:manage`). The rail entry and every group action
  reflect the caller's real scopes; a scope the caller lacks renders the action
  disabled with a plain reason, never hidden-then-403.
- **Uniform not-found stays in the product APIs; the authorized admin UI may show
  explicit access rationale + audit context** (§7.5) — the one place where "why can I
  see this" is answered, because the caller is already an authorized operator.

### 3.4 Metrics honesty is a rendering rule, not a footnote (§7.10 + B17/B18/B19)

Every metric cell discloses definition, unit of analysis, window, denominator, privacy
floor, freshness, and whether it is descriptive or causal (§7.10) via the
`MetricDefinitionPopover` (§8.1). While **B19** is open (definitions do not match their
PRD names — active-enrollments vs unique-participants, unbounded D7/D30, gap-counting
recovery), the affected cells render with an explicit *"definition under correction"*
qualifier and are **not** presented as the north star. While **B18** is open (verifier
sample is caller-selected and forgeable), the verifier FP/FN panel renders its sample
provenance and, until sampling is deterministic + reviewer-separated, is labeled
*"indicative, not audited"* — never a bare rate. Withheld (below-k-floor) cells render
as a labeled chip stating *why*, never a small number (ADR 0432 P4 already does this).

---

## 4. Design language — the operations-console register

A distinct identity **layered over DESIGN.md**, not a fork. The console is the app's
*dense, status-forward, decision-first* register — deliberately different from the
participant's generous single-decision surface (ADR 0436) and the creator's
medium-density production workspace (ADR 0437). It adds **no new font family and no new
base hue**; its distinctiveness comes from density, a mono-forward audit channel, and
the signature row below.

### 4.1 Semantic status palette (aliases over existing tokens — NOT color-only)

The console names a small semantic layer that **aliases the existing app-functional
tokens** (DESIGN.md §3); it introduces no new base hue and lands in `global.css :root`
as aliases, never as inline literals (the `check-tsx-color-literals` gate). Status is
**always label + icon/dot + optional color — never color alone** (§8.4, §10, §4.5
rule 7):

```css
/* console semantic layer — aliases, defined once in global.css :root */
--op-critical:  var(--color-danger);   /* oklch(55% 0.16 28)  — safety escalation, paid-but-unfulfilled, incident, broken active content */
--op-attention: var(--color-warning);  /* oklch(72% 0.14 75)  — approvals waiting, degraded, expiring, withheld, needs-review */
--op-safe:      var(--color-success);   /* oklch(62% 0.13 145) — resolved, verified, reconciled, published */
--op-info:      var(--color-info);      /* oklch(58% 0.12 240) — operational dispatch, syncing, provider-ready */
--op-neutral:   var(--ink-3);           /* oklch AA-muted ink  — draft, scheduled, paused, and the mono audit/id channel */
--op-rail:      var(--rule-2);           /* dense-grid hairline between queue rows / table columns */
```

Each carries a required glyph in the console's icon vocabulary (Lucide, DESIGN.md
§5): `shield-alert` (critical), `clock` (attention), `check` (safe), `radio` (info),
`circle` (neutral). The dark-mode luminance lift is inherited from §3 rule 2 — the
console adds nothing to maintain there.

### 4.2 Typography — a compact register within the one family

No new families. The console leans on the SAME Geist / Geist Mono triple but shifts its
baseline down a step for density:

- **Display / heads:** Geist 600 (group + section heads), 700 only on the group's
  `<PageHeader>` marquee (`--text-display`) — DESIGN.md §1, §5.1.
- **Body:** `--text-sm 13px` (Geist 400/500) as the console's working baseline —
  denser than the participant's `--text-body 14px`, which is what gives the console its
  own feel without a new font.
- **Mono is load-bearing here, not decorative:** Geist Mono for **ids, versions, policy
  refs, order/amount values, and audit metadata** (DESIGN.md §2, §9.2). The audit
  channel — actor/subject/resource, `before→after`, chain seq, order ids, minor-unit
  amounts — is *entirely* mono at `--text-eyebrow 11px`/`--text-sm`, so a scannable
  operator can tell an identifier from prose at a glance. Money is mono, right-aligned,
  minor-units-honest.

### 4.3 Density & motion

High but structured density (§9.4): decision queue first, tables below; `--space-5`
between major bands; colliding sibling borders are a layout bug (§4.5 rule 8). Motion is
restrained (§8.5): reveal-consequence and completion-acknowledgment only, no confetti,
reduced-motion respected; countdown pressure is used **only** for a real server-backed
expiring approval or seat hold — never manufactured urgency.

### 4.4 Signature element — the **Exception Ledger Row**

The one distinctive, load-bearing element (and the visual embodiment of §3.1). Every
group's queue is built from a single dense row that composes the `<ReviewCard>`/
`<ReviewInboxPanel>` semantics + the §4.5 list-row canon into the *owner + safe action +
audit trail* contract:

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ◈ CRITICAL   order:ord_8f2a1c · challenge cq_run5k     ⟳ owner: M. Reyes ●    2h        │  ← severity glyph + mono id + owner avatar w/ status ring + age pill
│   Paid but not fulfilled — entitlement grant did not fire on pending→paid CAS          │  ← one honest sub-line, real fields only (§4.5 rule 6)
│   [ Reconcile safely ]  [ ⌄ audit trail ]                          eligible: commerce  │  ← ONE safe action (btn-accent-solid) + inline audit expander + server-authoritative eligibility
└──────────────────────────────────────────────────────────────────────────────────────┘
     └ expands to the ADR 0301 chain slice: actor → subject → resource, before→after (mono)
```

Properties that make it the signature (and keep it honest):
- **Owner + eligibility are server-authoritative**, gated on the real check — the row
  is what makes B2/B15 visible, so it renders eligibility only after the eligible-reviewer
  check passes. It never dresses "a different tenant user" as "a moderator."
- **Exactly one safe action**, reversible, with a required reason on consequential
  decisions; stale-safe (a decided row disables + the backend 409s a second decision —
  the `<ReviewCard>` posture).
- **The audit trail is inline and immutable** — the row *is* the entry point to the ADR
  0301 chain and the ADR 0416 export, so "queue" and "audit trail" are one object, not
  two screens.
- Used identically across Safety, Commerce, Content-health, and Access — one row shape
  for every exception, which is the console's coherence.

This element is deliberately the opposite of the generic AI-admin default (a grid of
colored stat cards with no owner and no action). It is a row that *names who, offers one
safe thing, and shows the receipt.*

---

## 5. Phased plan — maps to §16 UX-3 (Admin & Trust)

Each item names its surface + the blocker-gate that MUST close (or be truthfully
disclosed) before it may present trust. Another session is actively closing B15/B17/B21
(fixed 2026-07-19) and B16/B18/B19/B20 (open) — this ADR's UI must reflect the *current*
state, not the aspirational one.

| # | Surface | Composes | Gate before "trustworthy" |
|---|---|---|---|
| **A0** | Admin & Trust tier + rail groups (§4.4) in `<AdminLayout>`; workspace switcher shows the tier **only when authorized** (§4.1); env-super-admin + scope presentation (§3.3) | `<AdminLayout>`, `features.tsx`, accessControl scopes | — (presentation only; must be truthful about authority from day one) |
| **A1** | Command center — five priority bands, tiles-as-filters (§3.2) | every group's queue head | B17 closed (metrics scope) ✓; tiles reading B19-affected metrics carry the "under correction" qualifier |
| **A2** | Safety & approvals — `<ReviewInboxPanel>` over the three approval kinds; Exception Ledger Rows | ADR 0426, 0432, 0415 approvals | **B15** ✓ (moderator authority) · **B2** (reviewer eligibility — half-open) · **B18** (verifier sample) — the verifier-sample row renders "indicative, not audited" until B18 closes |
| **A3** | Catalog & content-health — version/lifecycle/incident tables + kill-switch readiness (§7.3/§7.4) | `kicktodo-core`/`kicktodo-creator` | **B1** ✓ (publication authz) |
| **A4** | People & access + Organizations/cohorts (§7.5/§7.6) — grants, suspensions, support-access mode with audit disclosure, k-anon report view | accessControl, ADR 0428, ADR 0419 | **B16** (org-admin cohort-aggregate consent) — the org-report link renders the exact aggregate + consent state before linking (§7.6); WITHHELD until B16 gates the read |
| **A5** | Commerce & payouts reconciliation (§7.7) — orders/entitlements/refunds/disputes; **paid-but-unfulfilled is a first-class incident** with retry/reconciliation | ADR 0420, Commerce/Connect (0176/0385) | money-truth CAS is the source of truth (never the API response); amounts verified before any flip |
| **A6** | AI & connections + notifications (§7.8/§7.9) — provider readiness by capability, BYOK health (reference/owner/scope/last-verified, **secrets hidden**), consent/quiet-hours/delivery | Connections, notifications, whatsapp, ADR 0421 | **B20** — calendar-write renders as "port awaiting adapter (no production transport)", never "connected"; B21 ✓ (ICS escaping) |
| **A7** | Audit & metrics (§7.10/§7.11) — the ADR 0432 metrics page (definitions, denominators, withheld cells) + the ADR 0416 chain export + immutable activity timeline | ADR 0432, ADR 0416, ADR 0301 | **B18/B19** disclosed per §3.4; export is unbounded-but-provable (ADR 0416 residual-risk note) |
| **A8** | Settings & distribution — feature-toggle + distribution posture; dangerous settings visually de-weighted, change-preview + rollback (§7.11) | existing toggle/config surfaces | — |

**UX-3 exit evidence (unchanged, restated):** every participant-, content-, access-,
and money-critical exception has an owner, queue, safe action, and audit trail — which
§3.1 + §4.4 render structurally via the Exception Ledger Row.

---

## 6. What the console surfaces from each composed ADR

- **ADR 0416** — the operator-published **trust page** (public CMS system-site page,
  seeded DRAFT) and the tenant-admin **audit-chain export** (`GET …/governance/audit/export`,
  `host:members:manage`, JSONL/CSV + `verifyChain` proof); rendered in Audit & metrics
  → Audit. The unbounded-export residual-risk note (ADR 0416) is honored — no false
  `limit`.
- **ADR 0428** — org libraries, org↔cohort links, brand refs, and the **k-anonymous
  report** (k≥5, withheld cells labeled) in People & access → Organizations. Design law:
  before linking a cohort, show ownership/consent eligibility + the exact aggregate the
  org receives (§7.6) — the UI must not enable the link while **B16** leaves that read
  ungated.
- **ADR 0432** — activation/engagement/factory projections + verifier FP/FN, each with
  its `MetricDefinitionPopover`, denominators, and withheld-cell chips, in Audit &
  metrics → Metrics. Honesty rules §3.4 apply while B18/B19 are open.
- **ADR 0420** — entitlements, order-CAS money truth, refund/dispute revoke, creator
  revenue projection (counts only), and the reconciliation queue in Commerce & payouts.
  Money-truth toggle-independence (ADR 0176/0385) means these surfaces render even when
  the discovery toggle is off.
- **ADR 0421** — per-lane consent (calendar-project/-write, wearable-evidence,
  messaging-reminders), the tokenized ICS feed health, and provider readiness in AI &
  connections. Calendar-write is shown as an **inert port** (B20) — honest at runtime,
  now honest in the UI.
- **ADR 0426** — creator-profile approvals + review moderation (`community-review`,
  `community-profile` kinds) flow into Safety & approvals via `<ReviewInboxPanel>`;
  moderator authority (B15, fixed) is the eligibility the row renders.

---

## 7. Shared design foundations (SSoT: the recommendation doc §8/§9/§10 + DESIGN.md; 0436/0437 name the same law)

The three KickTodo experience ADRs (0436 participant, 0437 creator, 0438 admin) share
ONE set of foundations. The SSoT is the recommendation doc §8/§9/§10 + `DESIGN.md`; this
ADR names the same shared law and applies it in the console register (no ADR depends on
a sibling):

- **Component system** — `docs/kicktodo-ux-ui-recommendation.md` §8.1 + DESIGN.md §4.5/§5.
  Reuse the OpenWOP cohesion layer (`PageHeader`, `.surface-card`, `.list-row`, `.chip`,
  `.action-bar`, `Notice`, `StateCard`, `DataTable`, `<ViewToggle>`, the quick-look
  drawer, `<ReviewInboxPanel>`). New KickTodo product components only when genuinely
  reusable, each with a DESIGN.md registry entry + loading/error/empty states + keyboard
  + localization contract (§8.1).
- **Visual direction** — §9 + DESIGN.md §1–§3. KickTodo blue = agency/links; progress
  green = verified completion only; warm paper neutrals; amber = attention/recovery;
  muted red = safety/payment/incident. The console maps these to §4.1's aliases; it adds
  no base hue.
- **Accessibility & localization** — §10 + DESIGN.md §8/§11. WCAG 2.2 AA: visible
  theme-safe focus (never obscured by sticky bars/drawers), keyboard alternatives for
  every drag/swipe, status = label + icon/dot (never color alone), **no chart without a
  table or narrative equivalent** (the ADR 0432 captioned-table decision), errors that
  name the field + suggest a correction, locale-separated UI vs content, RTL via logical
  properties, locale-aware time/number/currency.
- **Route-intent vocabulary** — §15 (`/admin/kicktodo/*`) + DESIGN.md §4.5 rule 12
  (every opened entity has a URL; inner tabs via `?tab=`; collection cells are real
  `<Link>`s; deep-link intents shared web↔native).
- **Permission/action contract** — §13 + §3.3 above: server-authoritative allowed
  actions, uniform not-found in product APIs, explicit rationale only in the authorized
  admin UI, env-super-admin as a deployment fact.
- **Status & error contract** — §8.4 status vocabulary + §12 failure UX (resumable
  multi-step operations, "Retry safely", reference id only when useful).
- **Notifications** — §11 hierarchy + no duplicate alerts across channels (the AI &
  connections → notifications surface presents delivery health against this policy).
- **Measurement** — §14 admin metrics (queue age by severity, MTTA/MTTR incident,
  paid-but-unfulfilled age, broken-source active exposure, approval reversal rate,
  unauthorized-action attempts, reconciliation success, metric-definition/privacy-floor
  audit failures) instrument the console's own UX quality; **private journal/evidence
  bodies are never captured in analytics** (§14).

---

## 8. Alternatives weighed

- **A dedicated `kicktodo-admin` feature-package with its own routes/pages/components** —
  rejected. It duplicates the operator surfaces the six composed ADRs already own and
  stands up a parallel workspace/component system — exactly the anti-pattern DESIGN.md
  and CLAUDE.md forbid ("No second chat system", the accessControl↔orgs collision
  cautionary tale). The console is *assembly + design law*, not a new owner.
- **Leave the operator pages where they shipped** (`/kicktodo/org-programs`,
  `/kicktodo/metrics`, `/kicktodo/community` in the KickTodo nav group) — rejected as
  the end state. §4.1 is explicit: operator queues must not mix with participant/creator
  actions in one nav list. Those pages **move** (re-home their routes/tabs into the
  Admin & Trust tier), they are not re-implemented — see the correction below.
- **A single mega-dashboard of stat cards** (the generic AI-admin default) — rejected by
  §7.1 ("not a collection of vanity charts") and §4.5 rule 2 (stats are filters). The
  Exception Ledger Row replaces the stat grid as the primary object.
- **Polish the UI now, close the blockers later** — rejected outright. §16 UX-0 and the
  grade-D audit are explicit: resolve authorization/consent/metric blockers *before*
  polishing UI over unsafe behavior. This ADR's design law makes truthful presentation a
  hard requirement, so an open blocker degrades the surface's *claim*, not just its code.

---

## 9. Open questions

1. **Route re-homing (PRD-vs-shipped).** ADR 0428 P4 / 0432 P4 / 0426 P4 shipped their
   operator pages under `/kicktodo/<feature>` in the KickTodo nav group. §4.1/§15
   consolidate them under `/admin/kicktodo/*` in the Admin & Trust tier. Recommendation:
   re-home the routes (keep the components; add redirects from the old paths per DESIGN.md
   §4.5 rule 12's `replace`-redirect rule). Confirm the operator wants the consolidation
   now vs. after the participant/creator tiers land.
2. **Host-ext reads for the command center.** The command center's cross-group "oldest
   exception per queue" head may need a small aggregation the individual owners don't
   expose. Is a single non-normative `GET /v1/host/openwop-app/kicktodo/admin/overview`
   (fan-in over the existing owner reads, admin-scoped) acceptable, or should the command
   center compose N client-side reads (respecting the rate-limit fan-out gotcha in
   CLAUDE.md)? Recommendation: one batched host-ext read to avoid an N-read page load.
3. **Support-access mode audit disclosure** (§7.5) — the exact ADR 0301 event shape for
   "operator viewed participant X under support scope" needs the audit owner's confirmation;
   the design assumes it is one appended chain entry with actor/subject/scope/reason.
4. **Verifier-sample authority (B18) presentation.** Until B18 lands deterministic
   sampling + reviewer separation, the verifier FP/FN panel is labeled "indicative." Does
   the operator want the panel hidden entirely while B18 is open, or shown-with-caveat?
   Recommendation: shown-with-caveat (an unstated denominator is a lie; a disclosed
   caveat is honest).

## 10. PRD-vs-architecture corrections

- **§7 assumes a unified operator console; the app ships scattered feature-owned pages.**
  This ADR is the correction — it defines the console as design law over those pages, not
  a new build. (Open question 1 records the route move.)
- **§7.10 lists metric views as if instrumented and sound; B19 shows the shipped
  definitions do not match their PRD names.** The correction is a *rendering* rule
  (§3.4): affected cells carry a "definition under correction" qualifier and are excluded
  from north-star presentation until B19 closes — the UI must not out-run the code's
  honesty.
- **§7.8 lists calendar among ready integrations; B20 shows calendar-write has no
  production transport.** Correction: the surface renders it as an inert port (ADR 0421's
  own 2026-07-19 correction note), never as a live connection.
- **§4.4 nav lists "Feature and distribution settings" as a peer group; §7.11 requires
  dangerous settings to be visually de-weighted.** Correction: distribution/toggle
  settings live in the tier but render with change-preview + rollback + reduced visual
  weight, not as ordinary preferences.

## 11. RFC verdict

**Host work — no new RFC, no wire change.** The Admin & Trust console composes existing
operator/trust packages (ADRs 0416/0428/0432/0420/0421/0426), the `accessControl` scopes,
the ADR 0301 audit chain, and the ADR 0176/0385 money truth through the existing app
workspace/nav model and `ui/` design system. It advertises nothing on the OpenWOP wire.
Any command-center aggregation read is a **non-normative** host-ext endpoint under
`/v1/host/openwop-app/*` (Open Question 2) — never a normative surface. Super-admin
remains env-based (`OPENWOP_SUPERADMIN_TENANTS`); the UI mints no authority.

---

## 12. Implementation record (2026-07-19)

**Status: partially implemented — A0, A2, A3, A7 shipped + A8 folded (#2200/#2203/#2206).**
The additive admin tier is live (`features/kicktodo-admin/`). Every FE-buildable read
surface is now built (each with an `/architect` gate + `/code-review` + `/ux-review`):
A0 command center, A2 Safety inbox, A3 Catalog-health, A7 verifier-quality/audit-link,
A8 folded as a settings link. **A1** is substantially realized in the A0 console.
**Remaining are NOT FE-buildable as composition:** A5 has no admin tenant-wide commerce
read (per-creator/per-buyer + a mutation only); A4 gates on B16 (org-aggregate consent);
A6 gates on B20 (no calendar-write transport). The load-bearing gate decision held in
every build: an **additive** admin tier composing owners at their own authority, NOT a
re-home of the workspace pages.

| Phase | Buildable now? | Blocker |
|---|---|---|
| **A0** — Admin & Trust tier + rail in `<AdminLayout>` (command center) | ✅ **shipped (#2200)** | `features/kicktodo-admin/AdminOverviewPage.tsx` (`/admin/kicktodo`, Operations group); leads with the Safety queue + links operator surfaces at their own authority (no re-home) |
| **A1** — Command center (priority bands / tiles-as-filters) | ◑ substantially realized in A0 | the A0 console IS the command center — leads with the Safety queue head (live pending count) + links each area; a fuller priority-band grid needs per-area queue-count reads most of which are not exposed today |
| **A2** — Safety & approvals inbox | ✅ **shipped (#2200)** | `features/kicktodo-admin/SafetyInboxPage.tsx` (`/admin/kicktodo/safety`); composes the SHARED review store + `<ReviewCard>` (ADR 0068/0074) filtered to `community-profile`/`community-review`/`challenge-publish` — no parallel queue; server enforces authority; kind filter unit-pinned. B2 half-open / B18 open render honest state. |
| **A3** — Catalog & content-health | ✅ **shipped (#2203)** | `features/kicktodo-admin/CatalogHealthPage.tsx` (`/admin/kicktodo/catalog`, linked from the console); candidate pipeline (`getFactory`, FlooredCell floor honored) + published catalog by lifecycle status (`countByState`, unit-pinned) — operator lens over tenant reads, not a re-home |
| **A4** — People & access + orgs/cohorts | ⚠ needs B16 + admin read | gates on B16 (org-aggregate consent); the composable reads (`/consents`, org programs) are per-SUBJECT/per-org, not an admin tenant-wide people/access view — that admin read is backend-feature work |
| **A5** — Commerce & payouts reconciliation | ⚠ NOT FE-buildable | no admin tenant-wide commerce read exists — `revenueProjectionFor` is a per-CREATOR self-view (`subjectOf(req)`, `entitlementService.ts:160`), `/mine` is per-buyer, and `/reconcile` is a mutation. An admin orders/entitlements/refunds/disputes read is backend-feature work, not FE composition. |
| **A6** — AI & connections + notifications | ⚠ NOT honestly-buildable yet | B20 requires rendering the calendar-write port as "awaiting adapter, never connected" — but the transport is a server-runtime port (`calendarWriteService.ts:33` `transport=null`) with **NO status GET route**. A hardcoded "awaiting adapter" would be DISHONEST if a deployment registers a transport — building it now would break the exact honesty law A6 exists to uphold. Needs a `GET calendar-write/status` read first. |
| **A7** — Audit & metrics | ✅ **shipped (#2206)** | `features/kicktodo-admin/AuditMetricsPage.tsx` — verifier-quality metric (`getVerifierQuality`, tenant lens, B18 "indicative not audited" honest) + LINKS the shared audit surface (`/audit-log`) at its superadmin authority (the `/architect` gate ruled OUT embedding the superadmin read behind `isAdminCaller`) |
| **A8** — Settings & distribution | ✅ **folded (#2206)** | folded into the A0 console per the `/architect` verdict (a links-only page is a hollow shell) — a Settings & distribution section links the platform `FeatureTogglePanel` (`/feature-toggles`), rides the toggle owner, never rebuilds it |

**Open decisions (updated by the §13 `/architect` gate):** OQ1 is **resolved** — the
tier is additive platform-admin (not a re-home). OQ2 is **narrowed** — not a missing
queue endpoint (the shared approvals projection already carries the KickTodo approval
kinds), but a composition check: can `<ReviewInboxPanel>` filter to those kinds, and do
the ADR 0432 metrics projections expose an admin cross-tenant read. A0 + the read
surfaces (A3/A5/A7/A8) + A2 (over the shared inbox) are the buildable-but-substantial
next KickTodo phase, sequenced behind that check and the §5 per-group blocker-gates.

---

## 13. Correction note — A0 authority-model finding (/architect, 2026-07-19)

An `/architect` review of A0 (before implementing) found that **§4.4's premise — that
the KickTodo operator/trust surfaces belong in a platform-admin tier — conflicts with
the as-built authority model**, and that a wholesale re-home would be a CRITICAL
authorization-boundary violation, not IA polish. Recording it here rather than silently
proceeding (correct-don't-rewrite).

**Evidence (backend authz, as-built):**

| Surface | Backend gate | Actual authority |
|---|---|---|
| `kicktodo-metrics` (A7) | `gate(req)` + `tenantOf`/`subjectOf`, **no scope check**; protection is the privacy floor (`FlooredCell`) — `kicktodo-metrics/routes.ts:37-91` | **tenant user** (any authenticated member) |
| `kicktodo-organizations` (A4) | `authorizeOrgScope(req, FEATURE, 'host:org:manage' \| 'manifest:read')` — `kicktodo-organizations/routes.ts:43-132` | **org-manager** (org-scoped, not platform) |
| `kicktodo-community` (A2) | `gate(req)` + `subjectOf`; routes are my-profile / put-review / public-profile (+ a moderation sub-action) — `kicktodo-community/routes.ts:61-134` | **participant** |

**Why Option 1 (re-home to `tier:'admin'`) is wrong:** `AdminLayout` enforces
`isAdminCaller` (platform admin, `chrome/AdminLayout.tsx:91`). None of the three
backends is platform-admin-gated, so moving their FE into the admin tier would strand
every legitimate non-platform-admin operator — org managers lose org-programs, tenant
users lose metrics, participants lose their own profile/reviews. That is a broken access
change masquerading as §4.4 nav grouping.

**Correction to §3/§4.4 + OQ1:** the Admin & Trust tier hosts only genuinely
**platform-admin** trust surfaces — moderation-queue oversight, audit export,
cross-tenant trust — and must NOT swallow the tenant/org-manager/participant surfaces
that sibling ADRs 0432/0428/0426 built at their own authority level. Those stay where
they are, gated as they are.

**Consequence for A0 (corrected):** an earlier draft of this note claimed the
moderation queue-read is entirely missing. That is wrong and is retracted — the
community flag (`reviews/resolve-flag`) and the publication submit
(`createChallengePublishApproval`, `kicktodo-creator/publishService.ts`) BOTH create
approvals on the **shared review/approvals projection** (ADR 0068), which the console is
meant to compose via `<ReviewInboxPanel>` (`chat/reviews/ReviewInboxPanel.tsx`), NOT via
a per-feature `GET pending-*` route. So the queue exists as the shared projection; the
genuine gating for A0/A2 is instead:

1. **OQ1, re-scoped:** the Admin & Trust tier is an **additive platform-admin surface**
   composing existing owners at admin authority (new `/admin/kicktodo/*` routes at
   `tier:'admin'`) — it does **not** re-home the tenant/org-manager/participant workspace
   pages. That correction is the load-bearing outcome of this review.
2. **Composition verification (open):** whether `<ReviewInboxPanel>` can be filtered to
   the KickTodo approval kinds (`community-review`/`community-profile`/publication), and
   whether ADR 0432's metrics projections expose an admin cross-tenant read, must be
   confirmed before A2/A7 compose them — a service-shape question, not a UI one.
3. **Per-group blocker-gates (§5):** B15 ✓ (moderator authority) but B2 half-open, B16
   (org-aggregate consent), B18 (verifier sample), B20 (calendar-write transport) still
   govern whether a given group may *present* trust — an open gate caps that group's
   surface at its honest/degraded state.

A0 + A2 are therefore a **real, buildable, but substantial** multi-surface console
sequenced behind (2) and the §5 gates — not a quick shell and (proven above) not a
re-home. Given that scope and the open composition questions, it is sequenced as the
next KickTodo phase rather than force-fit here; the decisive architectural output of
this gate is the **do-not-re-home authz finding** + the additive-tier re-scoping of OQ1.
