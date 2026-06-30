# The Development Process

> How features get built in this codebase: from a vague idea to production code,
> shipped behind a feature toggle, with architecture, code, and UX reviewed at
> every step. This document describes the *method* — the actual skills, files,
> and gates referenced below (`/architect`, ADRs in `docs/adr/`, the toggle
> system in `FEATURES.md`, `/loop`) are real and in this repo.

The whole thing is one idea applied recursively: **nothing gets built until it is
proven to belong, and nothing is called done until four different reviewers — at
every phase, not just at the end — agree it is.** The first half is *discovery*
(making sure we build the right thing, grounded in what already exists). The
second half is the *build loop* (making sure we build the thing right, one
reviewed phase at a time, straight into production behind a toggle).

---

## At a glance

```
 DISCOVERY (decide what to build, prove it belongs)
 ─────────────────────────────────────────────────
 1. Deep research        AI-driven best-practice + competitive analysis
 2. PRD / RFC            multi-persona spec of the thing
 3. Roadmap              sequence features, surface dependencies
 4. ADR + feature toggle one decision record per feature, gated by a toggle
 5. Alignment check      grounded in existing architecture, design, features
                         → no duplication, it extends or fits cleanly

 BUILD LOOP (build it right, phase by phase, into production)
 ───────────────────────────────────────────────────────────
 6. Architect sign-off   reviews the FEATURE before any code is written
 7. Plan                 break the feature into implementation PHASES
 8. /goal — loop engineering, for each phase until the feature is done:
       a. Architect reviews the phase
       b. Developer implements
       c. Code reviewer reviews all the code
       d. UX reviewer reviews UX (a11y, theme, mobile breakpoints)
       e. Merge to production behind the feature toggle
 9. Documentation        feature, architecture, design kept in lockstep
```

The two halves map cleanly onto the two artifact systems in this repo: discovery
produces **RFCs** (the protocol/spec surface, in the `openwop` project) and
**ADRs** (`docs/adr/`, the per-feature decision records — there are 102 of them as
of this writing). The build loop turns each accepted ADR into merged, toggled
code.

---

## Phase 1 — Deep research

Every feature starts as a question, not a spec. The first move is **AI-driven
deep research**: gather industry best practices, survey how comparable products
solve the problem, and pull in competitive analysis. The point is to enter the
design with the landscape already mapped, so the eventual spec is grounded in
what good looks like rather than in a single person's first instinct.

**Output:** a research brief — what the problem is, how others solve it, what the
trade-offs are.

## Phase 2 — PRD / RFC (multi-persona)

The research becomes a **product requirements document**, authored through a
panel of **expert personas** rather than a single author. In this repo that is
the `/prd` skill, which runs a five-architect pass — Spec, Schema, Security,
Conformance, and Compatibility — over a template and lands a numbered RFC. Each
persona stresses the proposal from its own angle, so the spec that survives has
already been argued with from five directions before anyone writes code.

A hard rule lives here: **a change to the protocol wire needs an RFC, not just an
ADR.** The app is a *conformant host*. If a feature needs anything on the
protocol surface (a new event field, capability flag, endpoint contract), that
belongs in an accepted RFC in the `openwop` project *before or with* the host
work. An ADR records a decision for this host; it is not a license to change the
wire.

**Output:** an RFC (for protocol-affecting work) and/or the requirements that
feed the per-feature ADR.

## Phase 3 — Roadmap

The accepted requirements are sequenced into the **`ROADMAP.md`**. This is where
features get ordered and **dependencies surface** — feature B can't ship before
feature A's seam exists, this capability has to land at the core level before
three named features can ride it, and so on. The roadmap is the queue the build
loop pulls from.

**Output:** an ordered, dependency-aware feature list in `ROADMAP.md`.

## Phase 4 — ADR + feature toggle

Each roadmap item becomes an **Architecture Decision Record** in `docs/adr/`, one
file per decision (`NNNN-<kebab-slug>.md`, zero-padded sequentially). In this
repo the `/feature` and `/feature-refinement` skills author these against a fixed
evaluation matrix: feature-package architecture, toggle + admin UI, workflow +
node packs, AI-chat envelopes + agent packs, RBAC, replay safety, and the RFC
gate.

An ADR carries the decision, the alternatives weighed, the trade-offs, a **phased
implementation plan**, and an open-decisions checklist. Its `Status:` line moves
`Proposed → Accepted → implemented` as the work lands. The discipline that keeps
the trail honest: **correct, don't rewrite.** When implementation overturns a
decision, an inline correction note is added rather than silently editing the
original rationale — the reasoning trail is the product.

Every feature is born **behind a feature toggle** (`FEATURES.md`). A toggle has
three states — OFF (routes 404, nav hidden), ON (100% of eligible callers), and
BETA (on + badged, optionally narrowed to a cohort). Resolution is **server-side
from the authenticated principal** — never trusted from the client — and supports
**multivariant traffic-splitting** (sticky, deterministic bucketing: `A50/B50`,
or N weighted variants summing to 100, for A/B testing). The toggle is what makes
it safe to merge unfinished work straight to production: the code ships dark and
is flipped on deliberately.

**Output:** an accepted ADR + a registered feature toggle.

## Phase 5 — Alignment check

Before any code, the proposal is checked against the **existing architecture,
design system, and features**. The governing law here is *no parallel
architecture*: when an ADR says a feature "is" or "rides" an existing primitive
(an agent, a board, a scheduler job, the one shared AI chat), it must actually
**instantiate that primitive** — not shadow it with a look-alike. The canonical
example in this repo: there is exactly **one** AI chat (the RFC 0005 conversation
primitive). Driving AI for a new feature means shipping an *agent pack* + *node
pack* and scoping the existing chat to it — never building a second chat panel.

This is the cohesion guarantee: every new feature either **extends** something
that already exists or **fits cleanly** into the established patterns. Duplication
is caught here, before it costs anything.

**Output:** confirmation the feature is grounded — it extends or fits, and
duplicates nothing.

---

## The build loop

Discovery decided *what*. The build loop — run inside a Claude Code coding
session — builds it *right*. The loop is driven by **loop engineering** (the
`/loop` mechanism): you say `/goal` once and it works autonomously through every
phase of the feature until the feature is done, applying the full review panel at
each phase.

### Phase 6 — Architect signs off on the feature

Before development begins, the **architect reviews the feature as a whole** (the
`/architect` skill — software-architecture track and, when the wire is touched,
the protocol track). This is the gate that enforces Phase 5's promise at the code
level: *are we building this on existing architecture? Are we duplicating any
effort?* Development does not start until the architect signs off.

### Phase 7 — Plan: break the feature into phases

The first thing development produces is **not code, it's a plan.** The plan
decomposes the feature into ordered **implementation phases** — each phase a
coherent, shippable slice. (This is the same `§6`-style phase table that the ADR
itself carries: a feature is a sequence of phases, each with its own tests.) The
phasing is what makes the rest of the loop tractable: each phase is small enough
to be fully reviewed and merged on its own.

### Phase 8 — The per-phase loop (`/goal`)

For **each phase**, in order, the same four-reviewer cycle runs:

1. **Architect reviews the phase** — does this phase's design still hold, given
   what the previous phases actually built? (`/architect`)
2. **Developer implements** — writes the phase's code against the plan.
3. **Code reviewer reviews all the code** — a senior code-review pass with
   zero-tolerance gates (no suppression patterns, schema discipline, the build
   gate must be green). In this repo that's the `/code-review` skill plus the
   canonical build gate: `cd frontend/react && npm run build` (which chains
   `tsc`, the CSS/token integrity checks, and `vite build`) and
   `cd backend/typescript && npm test`.
4. **UX reviewer reviews the UX** — checks **accessibility**, that it uses the
   **theme** (design tokens, light *and* dark), and that it honors **mobile
   breakpoints**. In this repo: `/ux-review`, `/grade-ux`, and the `/browser`
   skill, which drives a real headless Chromium to catch runtime/visual bugs
   static analysis misses.
5. **Merge to production behind the feature toggle.** Because the feature is
   gated (Phase 4), the merged phase ships dark — in production, reviewed, but not
   yet exposed.

Then the loop advances to the next phase and runs the same four reviewers again.
**The review panel is applied at every single phase — not once at the end.** That
is the core of the method: a defect, an architectural drift, an inaccessible
control, or an off-theme color is caught in the phase that introduced it, while
the context is fresh and the blast radius is one slice.

The loop continues — architect, developer, code reviewer, UX reviewer, merge —
until **every phase of the goal is implemented and the feature is done.**

### Phase 9 — Documentation kept in lockstep

Throughout, the artifacts stay current. The ADR's status line and phase→commit
table are updated as phases land; `FEATURES.md` records the feature and its
toggle; the design and architecture docs reflect what was actually built. Commits
cite the ADR and phase (`feat(crm): … (ADR 0001 §4 / Phase 4)`) so the
code↔decision link stays greppable forever. The reasoning trail is never allowed
to drift from the code.

---

## Why it works

- **Discovery makes duplication structurally hard.** By the time code is written,
  the feature has survived multi-persona spec review, been placed in a
  dependency-aware roadmap, been written up as a decision record, and been checked
  against every existing primitive. Building the wrong thing, or a second copy of
  an existing thing, is caught before it costs anything.

- **The toggle decouples "merged" from "released."** Work can go to production the
  moment a phase is reviewed, because the toggle keeps it dark. There are no
  long-lived feature branches rotting out of sync with main; integration happens
  continuously, exposure happens deliberately.

- **Four reviewers at every phase compounds quality.** Architecture, code, and UX
  are not end-of-project gates that everything piles up against — they run on each
  small slice. Problems are caught at the altitude and the moment they're cheapest
  to fix.

- **Loop engineering makes it autonomous and consistent.** `/goal` runs the same
  rigorous cycle on every phase without the discipline eroding as the work drags
  on. The process doesn't get tired on phase 9.

- **The decision trail is a first-class artifact.** RFCs, ADRs, `FEATURES.md`, and
  ADR-citing commits mean any future reader can reconstruct not just *what* the
  code does but *why* it was built that way — and what was tried and rejected.

The result is a system where every feature is, by construction, grounded in the
existing ecosystem, reviewed from four angles at every step, shipped safely behind
a toggle, and fully documented — cohesive by design, never by cleanup.
