# ADR 0437 — KickTodo Creator Studio experience

| | |
|---|---|
| **Status** | **partially implemented** — 2026-07-19 · UX-2.0/2.1/2.2/2.6(read+kill)/2.7 shipped (#2196/#2208/#2209) + read-side of 2.3. Every FE-buildable creator phase built; UX-2.4/2.6-submit blocked on the plan client contract, 2.3-recording (agent-driven), 2.5 (media/sim wave). See §12. |
| **Feature** | Frontend experience (UX/UI design law) over the EXISTING `kicktodo-creator` feature-package — NOT a new backend feature-package |
| **RFC verdict** | **Host work, no RFC.** No wire shape, capability, event, or normative claim. Any new host-private READ endpoint rides `/v1/host/openwop-app/*` (non-normative). |
| **Requirements source** | `docs/kicktodo-ux-ui-recommendation.md` §6 (Creator experience), §4.1/§4.3 (IA + creator nav), §13 (role/permission presentation), §15 (route map), §16 (phased delivery, UX-2), §8/§9/§10 (shared component/visual/a11y foundations) |
| **Composes** | ADR 0415 (`kicktodo-creator` Challenge Factory — the backend this surfaces), ADR 0427 (chain-pack registry signature verification — signed release provenance), ADR 0433 (agent-dispatch provenance — specialist attribution) |
| **Sibling ADRs (shared frame)** | ADR 0436 (participant experience), ADR 0438 (admin & trust experience) — all three name the SAME shared design foundations (SSoT: the recommendation doc §8/§9/§10 + `DESIGN.md`), each applied in its own register |

> **Correction (ADR 0458, 2026-07-20/21):** the bespoke Studio AUTHORING surfaces
> this ADR planned (intake form, plan editors, submit/approve gate buttons) were
> demolished by ADR 0458 §2.4 after the shipped Studio graded D- as a
> duplicate/parallel chat — authoring is chat-first via the Challenge Author.
> This ADR's read-only surfaces (spine, dossier, monitor, insights) remain and
> were made honest by ADR 0460 (gate matrix, simulation panel, day strip).


## 1. Why this exists

The first KickTodo catalog "must feel researched and tested, not prompt-split" (ADR 0415 §Why). The backend already refuses one-click content: the Challenge Factory runs a reproducible `research → evidence graph → Challenge Plan → daily-action decomposition → media → gates → signed immutable release` pipeline and fails closed on stub retrieval, unsupported claims, and unknown rights. **What is missing is the operating surface a real creator drives that pipeline through.** Today the creator surface is `StudioPage.tsx` — "create/list candidates and N+1 publication state" (KTFULL-TD1), which is a listing, not a studio.

This ADR expresses the UX/UI recommendation's §6 as **design law**: Creator Studio is *"an evidence-aware production environment, not a form that generates content in one click"* (§6, line 677). It is a rigorous, AI-assisted challenge **production studio** — a control room where a creator sees what needs a human, moves a candidate stage by stage, and watches deterministic eligibility gates and a signed, immutable release earn their green. The design's whole job is to make the pipeline's honesty *legible* — the operator must never be shown a "publish" affordance the server would refuse, and must always see *why* a stage is blocked.

## 2. Boundaries audit — what exists, and what this ADR must NOT re-invent

Verified against the live tree before writing (per the CLAUDE.md boundaries discipline):

- **The backend production pipeline already exists — this ADR surfaces it, it does not redesign it.** ADR 0415 (implemented P1–P4) ships the candidate/intake+risk-classification, research/evidence-graph, `plan-generate`/`plan-validate`/`decompose`, `rights-decide`, `release-evaluate` gates via `core.approvalGate`/`gatedFlow`, `publish-version` (pin+sign+atomic immutable publish), `monitor` + kill switch, and the `feature.kicktodo.nodes` (12) + `feature.kicktodo.agents` packs. The `/kicktodo/studio` route already exists behind the EXISTING `kicktodo-creator` toggle (ADR 0415 D5 record). **The design lands ON that surface and toggle — no new feature id, no new toggle.**
- **The app workspace/nav model already exists** (`DESIGN.md` §5 `.app-shell`/`.app-sidebar`/`WorkspaceSwitcher`; recommendation §4.1). Creator Studio is the **"Creator Studio" workspace** in the existing switcher, not a bespoke shell. `frontend/react/src/chrome/features.tsx` declares nav routes/tiers/groups once — Studio's nav registers there.
- **The cohesion layer already exists** (`DESIGN.md` §5/§5.1): `PageHeader`, `.surface-card`, `.card-grid`, `.list-row`, `.chip`, `.action-bar`, `Notice`, `StateCard`, `<Tabs>`/`useUrlTab`, `<ViewToggle>`/`useViewMode`, `DataTable`, the shared `confirm()`, the right quick-look drawer, `<KanbanBoardView>` (for the candidate's linked Project board), `<KeyFigureBand>` (figure numerals), `<CommentsPanel>`, `MediaPickerDialog`/`GenerateImageDialog`. The §4.5 collection-canon (search + facets + URL-per-entity + Grid⇄List) governs every list here.
- **Provenance/signing primitives already exist**: ADR 0427 (signed release verdict — `verifyPinned`, publisher keyring, `OPENWOP_REQUIRE_CHAINPACK_SIGNATURES` posture) and ADR 0433 (`AgentDispatchProvenance` — specialist identity/version, workflow/node versions, budget, merge decision). The Release and Simulation surfaces **read** these, never re-derive them.

**Asserted non-goals (this ADR stands up NONE of these):** no new feature-package, no new toggle, no new nav shell, no new component/token/status system, no wire surface, no envelope kind. It EXTENDS ADR 0415's surface. Standing up a parallel Studio shell, a second card/chip/status system, or a bespoke design token palette is a defect, not a style choice.

## 3. Phase UX-0 blocker-gate (prerequisite — UI polish waits on safe behavior)

The recommendation §16 UX-0 is explicit: *"Resolve implementation blockers around authorization, workflow dataflow, scheduling, evidence, commerce, and metrics before polishing the UI over unsafe behavior."* Per the KickTodo grade-D audit (`docs/steward/CODEBASE-ASSESSMENT.md`), the gating blockers for Creator Studio and their live status (another session is actively closing them) are:

| Blocker | What it makes unsafe for the Studio | Status (2026-07-19) |
|---|---|---|
| **KTFULL-B1** | Core publication authz bypassable — any co-tenant could publish/retire | **FIXED** (`requireKicktodoManage` gate; adversarially test-pinned) |
| **KTFULL-B2** | Creator authz + approval-reviewer eligibility absent — a scope-holder could self-approve | **PARTIAL** — Factory routes now gated; **approval-reviewer ELIGIBILITY still OPEN** (a second identity with scope can still resolve). **The Studio's Gate Center + "Submit for publication" affordance MUST NOT present self-approval as safe until this half lands.** |
| **KTFULL-B3** | AI plan-generation couldn't satisfy its own validator (legacy vs `ChallengePlan` schema) | **FIXED** (node prompt requests authoritative shape; real validator wired in test) |
| **KTFULL-B4** | Built-in workflow dataflow incomplete (undeclared variables, dropped edges) | **FIXED** (declared-covers-referenced pinned; nodes publish what the next reads) |
| **KTFULL-B7** | Publication gates far below the PRD quality contract; research metadata caller-spoofable | **OPEN** — the gate matrix the Studio's **Gate Center + Release manifest** render is not yet backed by the full independent safety/a11y/privacy/alignment/behavior/media/simulation evaluations, quality floors, provider provenance, or a bound release id. **Until B7 lands the Studio must render gate rows HONESTLY as their real state (many "not evaluated"), never paint a full-green matrix it can't back.** |
| **KTFULL-TD1** | Candidate lifecycle + Projects composition absent (no `projectId`, plan/run/release refs, no candidate→plan→challenge binding) | **PARTIAL** — the candidate→**draft** binding slice landed (**ADR 0441**): `FactoryCandidate.draft` is stamped at decompose time, which unblocks UX-2.6 submit/complete (see §12). The full lifecycle (`projectId` + run/release refs + the linked-Project board of §5) is still OPEN. |

**Rule of this ADR:** each surface in §4/§6 names its blocker-gate prerequisite. A surface whose prerequisite is OPEN ships its *empty/degraded/honest* state first (the designed truth), and its full affordance only after the blocker closes. The Studio never papers over B1/B2/B7 — a bypassable or unbacked action is *not shown as safe*.

## 4. Decision — the Creator Studio information architecture

Creator Studio is the **"Creator Studio" workspace** (recommendation §4.1) with the §4.3 nav group and §15 routes. It has two altitudes: a **portfolio/overview altitude** (decision-first, per §4.5 rule 1) and a **candidate-workspace altitude** (the Factory, where production happens). Every opened entity has a URL; inner tabs bind to `?tab=` via `useUrlTab` (§4.5 rules 11–13).

### 4.1 Studio nav (recommendation §4.3, routes §15)

`Overview · Challenges · Research library · Media library · Reviews & approvals · Releases · Insights · Creator settings` — registered in `chrome/features.tsx` under the Creator Studio workspace, Lucide-iconed, tier-gated on `host:kicktodo:manage` (B1/B2 gate). Selecting a challenge opens its **candidate workspace** with the §4.3 inner tabs: `Brief · Research · Plan · Daily actions · Media · Simulation · Gates · Release · Monitor · Activity`.

### 4.2 Studio overview — decision-first (§6.2, §4.5 rule 1)

First viewport is a **"Needs you" queue** (the `/agents` precedent, §4.5 rule 1), not undifferentiated inventory: items needing the creator, blocked candidates, approvals returned with feedback, broken sources/media, upcoming releases, performance signals after privacy floors. Each queue item is a real, store-backed row (never fabricated — §4.5 rule 6) deep-linking to the exact candidate tab. An empty queue is *celebrated* ("You're all caught up"), never blank (`<StateCard>`). Below the queue: the **challenge portfolio** — a §4.5-canon collection (search + status facets `drafts · in review · approved · published · monitoring · retired` + Grid⇄List via `<ViewToggle>`/`useViewMode('kicktodo-studio')`) with a single **"Create challenge"** page CTA (the default clay `<button>`, §Button hierarchy). Stat tiles are filters (§4.5 rule 2): "3 blocked", "2 approvals returned" both report *and* narrow.

### 4.3 New-challenge intake (§6.3)

The §6.3 entry choices (`Research a new topic · Start from my materials · Adapt an existing version · Translate/localize · Import a structured plan`) render as a small chooser, then the **intake brief** form (§6.3: target outcome, audience, readiness, constraints/exclusions, time budget, formats, evidence strategy, a11y routes, risk/sensitivity declaration, monetization intent, materials upload via `MediaPickerDialog`). **On submit the surface immediately shows the server-side deterministic risk classification (tier + matched signals) and the required review lanes** — this already exists (ADR 0415 D5: "intake with server-side risk classification surfaced"). Prohibited topics are refused at intake with the matched signals shown (never a soft warning). *Blocker-gate: TD1 (candidate record must carry the intake→candidate binding).*

### 4.4 Candidate workspace — the Factory (§6.4)

The authoritative production surface. Header: challenge name + `DRAFT · General risk` status + primary actions `[Run research] [Preview as participant] [Submit for review]` — each action **enabled only when its server-authoritative precondition holds** (§13: "renders server-authoritative allowed actions and explains unavailable actions without leaking hidden resources"). A disabled "Submit for review" states *why* ("2 unsupported claims · 1 day over budget"), it is never a dead button.

Left rail = the **Provenance Spine** (§5, the signature element) listing the stages with a live "needs you" count each, mirroring §6.4's ASCII: `Brief · Research · Plan · Daily actions · Media · Simulation · Gates (6 passed · 4 blocked) · Release (Not eligible) · Monitor`. The candidate record is authoritative; its **linked OpenWOP Project** (shared board via `<KanbanBoardView>`, named coworkers, workflows, schedules, knowledge, memory, group conversation) is *linked, not duplicated* — "the UI should link the two without duplicating state" (§6.4). *Blocker-gate: TD1 (the record has no `projectId`/plan/run/release refs today — the workspace ships the intake+list first, the full spine as TD1 lands).*

### 4.5 The production surfaces (§6.5–6.11) — designed states

Each is a candidate inner tab; each renders the recommendation's content, and each renders its **degraded/honest state** when the backing evaluation isn't there yet (B7/TD1):

- **Research (§6.5)** — organized *around the claims the challenge intends to make*, never a wall of URLs. Source inbox, source viewer (metadata, rights disposition, freshness, extract history), the **evidence graph** (claim → supporting/contradicting sources), gaps/contradictions, run history + budgets. Unsupported claims are RECORDED and shown (ADR 0415 P1: "never silently kept"). Stub/demo retrieval is shown as a **fail-closed** state, not silent green. *Honesty note (B7): research REST currently trusts caller-supplied domain/hash/engine — the design surfaces provenance as `unverified` mono metadata until B7 makes it server-derived; the UI must not present spoofable metadata as trusted.*
- **Plan editor (§6.6)** — a **structured document, not raw JSON**: promise/audience, measurable outcomes, achievements + observable evidence, duration/daily budget, learning arc, safety boundaries, a11y + alternatives, recovery policy, source/evidence summary. An **alignment map** (Outcome → Achievement → Daily action → Evidence policy → Verifier rule); **unlinked elements are errors, not decorative warnings** (§6.6). Deterministic `validatePlan` defects (ADR 0415 P2 reports *every* defect at once) render as field-anchored, actionable errors (§10: "errors identify the field, explain the issue, suggest a correction"), feeding the ONE bounded error-fed repair.
- **Daily-action designer (§6.7)** — per-day editor (stable action id, day/window, one instruction, user-facing why, time estimate, content blocks, evidence policy, approved alternatives, a11y route, recovery, linked achievement, citations/rights) + week/timeline views + a **participant preview at phone width using the REAL participant component contract** (`ChallengeCard`/`ActionCard`/`PlanWeek` from §8.1), never a screenshot imitation.
- **Media production (§6.8)** — a **production queue** (source/import/generated, script + factual alignment, rights state, transcript/captions, alt text/audio description, rendition status, mobile/offline suitability, cost + provider, safety scan, replace/regenerate/version). Generated media discloses model/provider/version and binds to the release candidate. Reuses `GenerateImageDialog`/`EditImageDialog`/`MediaPickerDialog` — media owns media UX (DESIGN.md §5).
- **Simulation lab (§6.9)** — a **structured evaluation lab, not a chat transcript**. Default personas (`sim-newcomer`, `sim-time-poor`, `sim-skeptic` exist today per ADR 0415 D5; plus screen-reader/low-vision, missed-days/recovery, low-bandwidth/offline, sensitive-boundary routes). Results **group defects by severity, gate, day, owning artifact**; a creator regenerates/edits a targeted unit and reruns only affected evaluations while preserving the audit trail. Specialist runs surface their **ADR 0433 provenance** (specialist id/version, budget, merge decision) as mono metadata — attributable, not anonymous.
- **Gate center (§6.10)** — the §6.10 gate categories (evidence/citation, alignment, safety, a11y, privacy, rights, media integrity, behavioral quality, simulation, commerce/legal, provider/pack provenance, source freshness), each row showing `pass/block/escalate` + deterministic-or-reviewer/model source + evidence + policy version + owner + remediation + rerun/review history. **"Submit for publication" is enabled ONLY when deterministic eligibility passes; the submitting creator cannot approve their own release** (§6.10, separation of duties). *Blocker-gate B2/B7: until reviewer eligibility (B2) and the full gate contract (B7) land, the Gate Center renders honest state — many rows "not evaluated" — and the submit affordance stays gated; the design MUST NOT show a green matrix or a self-approvable submit as safe.*
- **Release & monitoring (§6.11)** — the **Release manifest**: immutable version summary, source snapshot, evidence-graph version, plan + daily-unit hashes, media manifest, evaluation bundle, rights decisions, approval decisions, pack/workflow/model provenance, locale/translation lineage, release notes, rollout scope. **This is where the signed immutable release (ADR 0427) becomes legible** — the release carries a signature verdict (`verified` / `unverified` / `revoked`), rendered as a mono hash + a status chip with the §5 **seal** treatment on a verified signature. Monitoring shows broken/redirected resources, rights freshness, factual incidents, participant reports, safety/privacy incidents, outcome/completion signals, time-estimate error, a11y parity, refund/dispute anomalies, and retirement impact — **distinguishing "no new enrollments" from active-participant treatment** (§6.11; the kill switch already keeps active enrollments on their pinned version, ADR 0415 P4).

### 4.6 Creator insights & earnings (§6.12)

Catalog reach, activation/completion, outcome evidence *after privacy floors*, recovery rate, participant clarity, review aggregate, source health, revision cycles, and the money block (gross sales, refunds, fees, net earnings, payout state, AI/media cost where authorized). Figure numerals use the shared `<KeyFigureBand>` (serif numerals, DESIGN.md §5.1) — the one sanctioned serif accent. **Never expose small-cell participant identity or unsupported causal claims** (§6.12) — a privacy-floor guard rendered as a designed "withheld — below reporting threshold" state, not a blank cell.

## 5. Design language — the Creator Studio visual identity

Creator Studio layers a **production studio / control-room** register over `DESIGN.md` — deliberately distinct from the participant app's calm-companion tone (ADR 0436) while sharing one design system. It **extends DESIGN.md's semantic layer; it never forks it** (DESIGN.md header rule). The register is achieved through *density, a mono-forward provenance treatment, one cooler console surface, and the signature spine* — NOT through a parallel hue palette. This avoids the generic-AI-tool default (indigo-gradient hero, purple everything) by anchoring on evidence, state, and provenance rather than decoration (§9.3: "creator and admin tools prioritize evidence and state over decorative imagery").

### 5.1 Semantic tokens (proposed additions to DESIGN.md §3 — all DERIVED, no new hue)

These register in `global.css :root` (+ the dark block) as **studio-semantic aliases over existing functional tokens** — so the studio reads as the same product, and a re-brand still changes one place. Values are on DESIGN.md's oklch functional band (raw hex in `.tsx` is a build failure, `check-tsx-color-literals`; consumed via token only):

| Token | Value / derivation | Meaning in the Studio |
|---|---|---|
| `--studio-console` | `oklch(from var(--paper-2) calc(l - 0.015) c h)` — a cooler, deeper paper | control-room chrome (the Spine rail, gate center, release manifest) — reads denser than a participant surface without leaving the palette |
| `--studio-spine` | `var(--color-info)` — azure `oklch(58% 0.12 240)` (dark: `68% 0.12 240`) | the **provenance/lineage** accent — the Spine, dispatch/handoff, publish; DESIGN.md already assigns azure to publish + handoff, so provenance inherits it |
| `--studio-verified` | `var(--color-success)` — forest `oklch(62% 0.13 145)` | citation-backed / evidence-verified / gate-passed |
| `--studio-attention` | `var(--color-warning)` — amber `oklch(72% 0.14 75)` | needs-you / escalate / expiring — *attention and recovery, not punishment* (§9.1) |
| `--studio-block` | `var(--color-danger)` — brick `oklch(55% 0.16 28)` | gate blocked / failed / incident |
| `--studio-seal` | `var(--star-glow)` — gold `oklch(80% 0.15 80)` | the **earned signature** glow on a *verified* immutable release (ADR 0427) — echoes §9.1 "completion should feel earned and semantically meaningful"; used ONLY on a real verified signature verdict, never decoratively |

Status is always **dot + ring + chip** (§4.5 rule 7, §8.4): color never carries meaning alone; every gate/source/release state pairs a Lucide icon + localized label.

### 5.2 Type pairing (within DESIGN.md's ladder)

- **Head/display:** `var(--sans)` (Geist) at `--weight-head` 600 / `--weight-marquee` 700 — DESIGN.md's SANS-headers directive holds; **no serif headers** (DESIGN.md §1). Studio uses the *compact* end of the scale (§9.2: "strong but compact hierarchy for creator/admin tools") — `--text-title`/`--text-subtitle` over `--text-display`, medium density (§9.4).
- **Body:** `var(--sans)` 400/500.
- **Mono / utility — elevated to a first-class role:** `var(--mono)` (Geist Mono) is the studio's technical voice. It carries **every id, version, policy ref, source hash, evidence id, provenance ref, release hash, gate policy version, and budget figure** (§9.2: "monospace only for ids, versions, policy refs, and technical audit metadata"). This mono-forward provenance treatment is what makes the Studio *feel* like a control room while every other surface stays sans. Mono metadata sits in `--ink-3` (AA muted), reusing DESIGN.md §5's chat/env-chip metadata precedent.
- **Serif:** survives ONLY as DESIGN.md permits — the `<KeyFigureBand>` figure numerals on the Insights/earnings tiles (§4.6).

### 5.3 Signature element — the **Provenance Spine**

**One signature visual, and it is load-bearing, not decorative.** The Provenance Spine is a vertical rail down the candidate workspace connecting the production stages in order — `Brief → Research → Plan → Days → Media → Simulation → Gates → Release` — that is simultaneously the workspace's navigation, its status readout, and the visual assertion of the pipeline's central promise: *the candidate is authoritative and the release is reproducible.*

- **It reuses the existing `.wf-track` autonomy-rail pattern (DESIGN.md §5), it does not invent a new rail.** The connecting **segment** marks the spine as a *journey* (production is earned over stages) — the same rationale that gives `.wf-track` its segment and denies it to the free-dot `.auto-meter`. Each stage is a node: passed = `--studio-verified` filled dot, blocked = `--studio-block`, needs-you = `--studio-attention` with a count, current = `--studio-spine` dot + the shared clay/soft current-glow halo.
- **The spine carries provenance in mono.** Once a stage is frozen for a release, its node shows the stage's **content hash** in `--mono` `--ink-3` (plan hash, daily-unit hash, evidence-graph version, media manifest hash). The spine literally *is* the release manifest's lineage (§6.11) made navigable.
- **The spine terminates in the signed seal.** The Release node shows the ADR 0427 signature verdict: a `verified` release lights the `--studio-seal` gold glow on the terminal node + a mono release hash; `unverified`/`revoked` shows `--studio-attention`/`--studio-block` with the honest verdict — never a false seal. This is the visual payoff of the "evidence-backed, immutable, signed" thesis, and it honestly refuses to glow when the backing (B7 gate contract, ADR 0427 posture) isn't there.

The Spine is the antidote to the generic AI-tool look: it makes *evidence and reproducible lineage* the hero, not a gradient. Restraint holds — one signature visual, token-only, `prefers-reduced-motion`-safe (no animated fill that obscures the real value, §8.5), `role="img"` + localized `aria-label` describing the stage states (the `.auto-meter` a11y precedent), with a keyboard-navigable list equivalent (§10: keyboard alternatives; no chart without a table/narrative equivalent).

### 5.4 Restraint & a11y floor

WCAG 2.2 AA (§10): visible theme-safe focus not obscured by sticky bars/drawers, logical focus order, keyboard alternatives for every drag/hover affordance, 44×44 preferred touch targets, status never color-only, reduced-motion honored, dark/light parity (DESIGN.md §2/§3 both themes). Density is *structured*, not cramped (§9.4 medium). No confetti, no countdown pressure except a real server-backed expiring approval (§8.5). The studio is intentional and evidence-forward — never a template default.

## 6. Phased plan (maps to recommendation §16 UX-2 — Creator Studio)

Each item names its surface + its blocker-gate prerequisite. Ordering respects UX-0: a surface whose prerequisite is OPEN ships its honest/degraded state first.

| Phase | Ships | Blocker-gate |
|---|---|---|
| **UX-2.0** | Studio workspace registration in `chrome/features.tsx` (Creator Studio switcher entry + §4.3 nav, tier-gated `host:kicktodo:manage`); the §5.1 semantic tokens in `global.css`; the shared design-foundations (§8) as the sibling-cited law | B1 ✅ (tier gate real) |
| **UX-2.1** | Studio **overview** (decision-first "Needs you" queue + §4.5-canon portfolio) + **intake** (choices + brief + surfaced server risk classification) | B1 ✅; intake needs TD1 for candidate binding — ships list+intake, candidate deep-link as TD1 lands |
| **UX-2.2** | **Candidate workspace** shell + the **Provenance Spine** (§5.3) over the candidate record | **TD1 (OPEN)** — spine renders the stages it can back; grows as the record gains `projectId`/plan/release refs |
| **UX-2.3** | **Research** + evidence-graph surfaces (claims-first; unsupported/stub shown honestly) | B7 (OPEN) for server-derived provenance — metadata shown `unverified` until B7 |
| **UX-2.4** | **Plan editor** (structured doc + alignment map, field-anchored `validatePlan` defects) + **Daily-action designer** (with real-contract participant preview) | B3 ✅, B4 ✅ (plan-generate + dataflow runnable) |
| **UX-2.5** | **Media** production queue (reusing media dialogs) + **Simulation lab** (persona defect grouping + ADR 0433 provenance) | B4 ✅; media/sim depth tracks the D5 live-provider wave (ADR 0415) |
| **UX-2.6** | **Gate center** + **Release manifest** (signed-seal verdict, ADR 0427) + **Monitoring** (retirement impact) | **B2 (reviewer eligibility, OPEN) + B7 (gate contract, OPEN)** — renders HONEST gate state + gated submit; full-green + safe-submit only after B2/B7 |
| **UX-2.7** | **Creator insights & earnings** (privacy-floored, `<KeyFigureBand>`) | metrics honesty (KTFULL-B19 family) — withheld-below-threshold state shipped regardless |

**Exit evidence (recommendation §16 UX-2):** a real-provider candidate travels from brief to independently approved immutable release with no direct API/manual data intervention — and every gate the Studio shows green is one the server actually enforces.

## 7. Composes — what the Studio surfaces from each ADR

- **ADR 0415** (`kicktodo-creator`): the entire production pipeline. The Studio surfaces intake+risk classification, the research/evidence-graph, `validatePlan`/`validateDays` defects, the media queue, the `release-evaluate` gate matrix, `publish-version`, and `monitor`+kill-switch. The Studio owns **zero** production logic — it is the operating surface over ADR 0415's services.
- **ADR 0427** (chain-pack signature verification): the Release node's **signature verdict** (`verified`/`unverified`/`revoked`) + release hash. The `--studio-seal` glow lights only on a real verified verdict; the posture flag `OPENWOP_REQUIRE_CHAINPACK_SIGNATURES` state is what the Release manifest reflects honestly.
- **ADR 0433** (agent-dispatch provenance): the Simulation lab and any specialist handoff surface the **provenance record** (parent agent, specialist id/version, workflow/node versions, budget spent, merge decision) as mono audit metadata — a specialist's output is attributable, never anonymous.

## 8. Shared design foundations (SSoT: the recommendation doc §8/§9/§10 + DESIGN.md; siblings 0436/0438 name the same law)

These are the cross-experience contracts the three KickTodo experience ADRs share. The SSoT is the recommendation doc §8/§9/§10 + `DESIGN.md`; each of the three ADRs names the same shared law (below) and applies it in its own register, so the workspaces stay one system without any ADR depending on a sibling:

- **Shared component system (§8.1):** reuse the OpenWOP cohesion layer (`DESIGN.md` §5/§5.1) — `PageHeader`, `.surface-card`, `.card-grid`, `.list-row`, `.chip`, `.action-bar`, `Notice`, `StateCard`, `<Tabs>`/`useUrlTab`, `<ViewToggle>`, `DataTable`, `confirm()`, quick-look drawer, `<KanbanBoardView>`. New KickTodo components (`OutcomePicker`, `ChallengeCard`/`ChallengeRow`, `PlanWeek`, `ActionCard`, `EvidenceCapture`, `ProgressTrace`, `PrivacyPreview`, `GateStatus`, `ReleaseManifest`, `MetricDefinitionPopover`) land ONLY when genuinely reusable, each with a `DESIGN.md` registry entry, loading/error/empty states, keyboard behavior, localization contract, and native-equivalent decision (§8.1).
- **Route-intent vocabulary (§15):** every opened entity has a URL; inner tabs use `?tab=`; invitations/actions/conversations/approvals/checkout-returns have stable deep-link intents shared by web and native (§4.5 rules 11–13).
- **Permission/action contract (§13):** the UI renders **server-authoritative allowed actions** and explains unavailable ones without leaking hidden resources — it never derives permission from display-role labels. (This is why the Studio's every gated action is *explained-when-disabled*, not hidden-or-dead.)
- **Status vocabulary (§8.4):** Neutral (draft/scheduled/paused) · Information (proposed/syncing/submitted) · Success (verified/complete/published/active) · Warning (needs review/expiring/degraded/withheld) · Danger (blocked/failed/incident/disputed/retired-for-safety) — always label + icon/dot + optional color, mapped to `DESIGN.md` §3 functional tokens + the §5.1 studio aliases.
- **Visual direction (§9):** warm-paper neutrals, brand blue = agency/links, green = *verified completion only* (not every button), amber = attention/recovery, muted red = safety/destructive. Retain the check-mark idea but *do not put a check on every card* — completion is earned.
- **Accessibility & localization (§10):** WCAG 2.2 AA; separate UI locale from content locale; BCP 47 internally; localize statuses + system-generated evidence explanations; RTL via logical properties; no text-in-images; preserve source/translation lineage; locale-aware time/number/currency. (KickTodo strings ship the 4-locale parity `DESIGN.md`/`FEATURES.md` require — a fatal build gate.)

## 9. Alternatives weighed

- **A bespoke Creator Studio shell + design system** — rejected. It fragments the app into "a dozen bolted-together apps" (DESIGN.md §5.1), duplicates nav/token/status machinery, and drifts. The studio register is achievable by *layering* over DESIGN.md (§5). This is the same "no parallel architecture" rule that removed the `AiAuthorPanel` (CLAUDE.md).
- **A new `kicktodo-studio` feature-package/toggle** — rejected. The surface + toggle already exist (ADR 0415 D5). A second toggle would fork the honesty gate and split the surface.
- **Polish the full pipeline UI now (green gate matrix, live submit)** — rejected, violates UX-0. B2 (reviewer eligibility) and B7 (gate contract) are OPEN; a green matrix or self-approvable submit over unsafe behavior is a *dishonest* UI. Honest degraded states ship first.
- **A decorative studio hero / gradient identity** — rejected as the generic-AI default (§9.3). The signature is the evidence-forward Provenance Spine, not decoration.
- **Serif headers for a "studio" editorial feel** — rejected: DESIGN.md §1 forbids serif headers (the faux-bold regression). Studio distinctiveness comes from density + mono-forward provenance, not serif.
- **A canvas/graph-editor for the plan** — rejected for the plan *document* (§6.6: "a structured document, not raw JSON"); the alignment map is a read-forward diagram, not an editable canvas. (The candidate's linked Project keeps the real board.)

## 10. Open questions & PRD-vs-architecture corrections

**Open questions:**

1. **Reviewer-eligibility surfacing (depends on B2's open half).** Once approval-reviewer eligibility is enforced server-side, does the Gate Center show the *eligible reviewer pool* (who can approve this, given separation-of-duties + qualified-domain) or only the caller's own can/can't-submit state? Recommend the latter first (§13's "explain unavailable actions without leaking hidden resources"), the pool as an authorized-admin view (defer to ADR 0438).
2. **Provenance Spine at partial TD1.** Until the candidate record carries `projectId`/plan/release refs (TD1), the spine can back only intake→research stages. Does UX-2.2 ship a *placeholder* spine (stages present, later ones inert) or gate the spine entirely behind TD1? Recommend the honest placeholder — stages visible, later nodes rendered as "not yet reached", never faked.
3. **Release-hash display before ADR 0427 enforcement.** With `OPENWOP_REQUIRE_CHAINPACK_SIGNATURES` unset (today's default), the release is signed-but-not-enforced. Does the seal render `verified` on a valid-but-unenforced signature, or reserve the gold seal for the *enforced* posture? Recommend: show the signature verdict truthfully but reserve the `--studio-seal` glow for `verified` under enforcement, so the seal never overstates the trust posture.
4. **Simulation persona scope.** ADR 0415 D5 ships 3 personas (`sim-newcomer`/`sim-time-poor`/`sim-skeptic`); §6.9 names 7. Which land in UX-2.5 vs. the D5 live-provider wave? (Design-ready for all 7; implementation tracks pack availability.)

**PRD-vs-architecture corrections:**

- **§6 implies a fully-green, publish-ready gate matrix.** Correction: per UX-0 + B7, the Gate Center MUST render honest partial state (many "not evaluated") until the full independent-evaluation contract lands. The design's job is to make the *gaps* legible, not to imply completeness the backend can't back. Recorded so a future reader doesn't "finish" the matrix UI over unsafe behavior.
- **§6.4 shows a single candidate record + linked Project.** Correction: TD1 confirms the record does not yet carry `projectId`/plan/run/release refs — the "link the two without duplicating state" contract is *design-ready but implementation-blocked*. The workspace ships intake+list first; the full spine + linked board arrive with TD1. (This is the same TD1 the grade-D audit tracks — not new scope.)
- **§6.10 "the submitting creator cannot approve their own release"** is a design assertion that is only *true* once B2's reviewer-eligibility half lands. Correction: the submit affordance stays gated and honestly explained until then — the UI must not present self-approval as available-and-safe.

## 11. RFC verdict

**Host work, no new RFC.** This ADR is frontend experience/design law over ADR 0415's existing host-extension surface. It adds no wire shape, no `/.well-known` advertisement, no capability, no run-event, no envelope kind, and no normative `MUST`. The §5.1 semantic tokens are host-local CSS; the surfaces are host UI; provenance/signing are read from existing host-internal records (ADR 0427/0433). Any new host-private READ endpoint needed to back a Studio panel rides `/v1/host/openwop-app/*` (non-normative, never wire). A new RFC would be triggered only if a *portable* cross-host challenge/release schema or a `challenge.*`/`studio.*` capability were proposed — none is.

---

## 12. Implementation record (2026-07-19)

**Status: implemented — all 8 phases surfaced (each with an `/architect` gate + `/code-review` + `/ux-review`).** UX-2.0/2.1/2.2 (workspace/overview/intake) + UX-2.6 (gate read + kill switch) + UX-2.7 (insights) are direct FE surfaces; UX-2.3 (research recording), UX-2.4 (plan authoring), and UX-2.5 (simulation + media) are AI-driven pipeline steps surfaced the ADR-mandated way — through the ONE chat scoped to the shipped kicktodo specialist agents (`plan-builder`/`safety-reviewer`/`sim-*`, deep-linked from the workspace) + the existing media dialogs, NOT bespoke Studio editors (which CLAUDE.md's "reuse the chat, never recreate" forbids). UX-2.6 **submit/complete-publication** is now also shipped — the **ADR 0441** candidate→draft binding (a minimal TD1 slice) lets the FE reference the decomposed draft, so the workspace drives submit → separation-of-duties approve on the endpoints that already existed. No honest residual remains in the creator experience; the full TD1 lifecycle (projectId/run/release refs + linked-Project board) + B7 gate-backing evaluations stay open but aren't needed for the submit mechanics.

> **CORRECTED 2026-09-15.** The sentence above saying the workspace "drives submit → separation-of-duties approve" was true on 2026-07-19 and is stale: **ADR 0458 P4 removed the `submitPublication`/`completePublication` client functions** ("intake is chat-first; the publication decision lives in the reviews inbox"), so no Studio surface calls those routes. What the workspace does today is STATE the publication status and link to the inbox; submission is the factory's terminal `submit-publication` node driven from the embedded Challenge Author chat, and approval is decided in the reviews inbox by a distinct identity. Measured: `grep -rn 'submit-publication\|complete-publication' frontend/react/src` hits only a comment and the manual-test suite. The page's own docblock and its `workspaceDeferredActions` notice said the opposite of each other until the same date; both now say this.

| Phase | Status | Evidence / note |
|---|---|---|
| **UX-2.0** | ✅ implemented | Studio workspace registration + `--studio-*` semantic tokens + shared foundations — `features/kicktodo-studio/routes.tsx`, `StudioPage.tsx`, `global.css` |
| **UX-2.1** | ✅ implemented | Decision-first "Needs you" queue + §4.5-canon portfolio + intake (topic/audience → server risk classification) — `StudioPage.tsx`; grade-ux enum-label fix (KTUX-9) #2193 |
| **UX-2.2** | ✅ implemented | **Candidate workspace + Provenance Spine + research (read) + publication gate (read)** — `CandidateWorkspacePage.tsx` (#2196). Spine honesty unit-pinned (`spineStatus.test`). |
| **UX-2.3** | ✅ **surfaced (#2196 read + #2215 authoring)** | The research dossier (sources/claims, **unsupported claims flagged**) renders read-only in the workspace; research *recording* is AI-driven (real search-adapter provenance), so it rides the chat scoped to the `safety-reviewer` agent (ADR 0058 deep-link) — never a manual provenance-spoofable form |
| **UX-2.4** | ✅ **surfaced (#2215, chat-drivable)** | The plan is a workflow ARTIFACT (`kicktodo.challenge-plan`), authored by the `plan-generate` node — so per CLAUDE.md "reuse the chat, never recreate" it rides the chat scoped to the `plan-builder` agent, NOT a bespoke Studio editor (which would be the forbidden recreate). Deep-linked from the workspace. |
| **UX-2.5** | ✅ **surfaced (#2215, chat-drivable + existing media dialogs)** | Simulation runs the shipped `sim-newcomer`/`sim-skeptic`/`sim-time-poor` persona agents via the chat deep-link; media production reuses the existing `MediaPickerDialog`/`GenerateImageDialog` (§2). Live-provider depth tracks the ADR 0415 D5 wave. |
| **UX-2.6** | ✅ **fully shipped** (#2209 kill + this PR submit/approve) | Gate state renders honestly; **kill switch** (`killCandidate`, confirm + audited reason, published-only); and now the **submit → separation-of-duties approve** flow — unblocked by the ADR 0441 candidate→draft binding. The server re-checks the hard gates (409) + enforces a distinct approver (403); the FE surfaces those honestly, never a bypassable green. |
| **UX-2.7** | ✅ **shipped (#2208)** | `CreatorInsightsPage` — the creator's own products' active/revoked entitlement counts (`getMyRevenue`/`revenueProjectionFor`, self-data counts-only so no k-anon floor); reach in **entitlements** not dollars (no monetary field exists — honest, never fabricated) |

**Correction to the original blocker call:** UX-2.2 was recorded (in the §6 plan and an earlier session note) as gated on **KTFULL-TD1** (candidate lifecycle). That was wrong — `GET /candidates/:id` (full record incl. research dossier), `/publication`, and `/monitor` already exist on the `kicktodo-creator` backend; only the FE client was unwired. The workspace ships read-first over those endpoints. TD1 remains relevant only to the *write* authoring flows (research recording, plan editing) and the gate-center approvals, which stay deferred. Graded via the shared KickTodo-experience grade pass (code #2192, ux #2193, data #2194) plus per-phase inline code/ux review + the spine test on #2196.
