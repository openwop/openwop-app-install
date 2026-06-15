# Feature brief: "Board of Advisors" — multi-persona advisory councils

## Goal
Introduce a "Board of Advisors": a user-assembled group of named agents, each a
distinct persona, that can be summoned together into a single chat to advise on
strategy and to ideate/brainstorm. Each advisor reasons from its own persona
definition AND its own retrieval-grounded memory (RAG), so the board behaves like
a panel of distinct minds rather than one model wearing five hats.

## Core concept
- A **board** lives in a workspace and is an ordered set of **named advisor agents**.
  Example board: Elon Musk, Steve Jobs, Ben Franklin, Leonardo da Vinci, Jeff Bezos.
- Each advisor is a **digital-clone persona**: a profile + system instructions that
  capture how that individual thinks, strategizes, debates, and decides — voice,
  heuristics, biases, decision frameworks, characteristic questions.
- Each advisor draws from its **own RAG corpus** — biographies, books, articles,
  letters, interviews, talks, and other writings — so its contributions are grounded
  in (and ideally cite) that individual's actual body of work, not generic invention.
- The board is summoned in chat with a **double-at `@@` convention**: typing `@@`
  (optionally `@@<boardname>`) invokes the whole board into the conversation. A single
  `@<advisor>` should still address one advisor directly.
- In the conversation: the **user is addressed by name**, advisors **address each
  other by name**, can react to / build on / respectfully challenge each other's
  points, and the exchange reads like a round-table, not parallel monologues.
- Boards are created by **any user**, and can be **private** (creator only) or
  **shared** (workspace / specific members / link), reusing the existing sharing and
  access-control model.

## Build-on-what-exists discipline (NON-NEGOTIABLE — see ARCHITECTURE.md "Architecture contract for new work")
This app is an OpenWOP host + feature-package platform. Do NOT build a parallel system
for any concept the app already owns. Specifically, propose how to compose — not
replace — these existing owners, and call out the exact constructor/seam each rides:
- **Named advisors = roster agents** with rich `agentProfile` (ADR 0031). Persona
  text, voice, and decision frameworks are `agentProfile` content, NOT new hardcoded
  named-agent logic. Honor David's law: nothing capability-bearing may be unique to a
  named agent in source — capabilities live at the **core agent level** and are
  activated per named agent via `agentProfile` (ADR 0023 §Correction, ADR 0031, ADR 0036).
- **Persona seeding/reconciliation** rides the work-twin persona-reconciliation path
  (ADR 0032) and the seed pipeline (`host/seedEverything.ts`).
- **Per-advisor RAG = per-agent knowledge & memory (ADR 0038)** — bind each advisor's
  corpus as KB collections (cited docs via `kbService`/`KnowledgeBackend`, ADR 0011)
  plus the RFC-0004 memory namespace. A net-new per-agent store is FORBIDDEN
  (no-parallel-architecture). Confirm ADR 0038's `agent-knowledge` capability and
  dispatch-time retrieval composition cover the multi-advisor case.
- **Boards / membership** should reuse workspace tenancy (ADR 0015) and the existing
  board/orchestration-symmetry seams (`host.kanban`, ADR 0025) where a "board" already
  has an owner model — evaluate whether the advisory "board" is the same primitive or
  a distinct grouping, and justify either way (do NOT shadow an existing primitive with
  a fake id).
- **Private/shared** reuses the sharing feature + consent/access-control (ADR 0021/0024,
  `accessControl`), server-side as the authority.
- **Multi-agent orchestration** should extend the existing assistant/orchestration
  capability (ADR 0023, ADR 0025), not a new agent runtime. Runs, events, replay, and
  fork stay on the OpenWOP wire; stamp resolved board membership + advisor bindings into
  run metadata at creation and read them back verbatim on replay/fork.
- Product API lives under `/v1/host/openwop-app/*`; the feature gets a feature-package under
  `backend/typescript/src/features/<id>/` + `frontend/react/src/features/<id>/` and a
  toggle. Advertise only honored behavior in `/.well-known/openwop`.

## The genuinely new question: multi-party conversation on the wire
Today's chat/dispatch surface is effectively 1:1 (one agent per run/turn). A council
where **multiple named agents co-participate in one shared transcript, see each
other's turns, and address each other** is likely a wire-shape change, not just host
glue. Investigate and, if confirmed, propose new RFC(s) in `../openwop/RFCS/` (authored
from `0000-template.md` via the `/prd` skill, reaching at least Accepted before/with the
host work). Candidate RFC surface to evaluate:
- A **multi-party / group conversation envelope**: one run/thread with N agent
  participants, cross-participant turn visibility, and per-turn speaker attribution.
- **Turn-taking / moderation orchestration**: round-robin, addressed (`@advisor`)
  routing, debate/critique rounds, and a synthesizing moderator turn — define what is
  normative wire vs. host-local product behavior.
- The **`@@` group-summon** affordance itself is almost certainly a host UI/parse
  concern (no RFC), but the underlying "invoke a set of agents into one shared run with
  mutual visibility" likely is normative — draw that line explicitly.
Re-use already-Accepted RFCs where possible (e.g. roster/heartbeat RFC 0086, scheduler
RFC 0052, memory RFC 0004) and only open new RFCs for true wire additions.

## ADRs to author (per CLAUDE.md ADR practice, `docs/adr/NNNN-*.md`)
Decompose into feature-package ADRs as needed, e.g.:
1. The advisory-board feature-package (model, ownership, toggle, sharing, RBAC,
   replay/fork metadata, RFC gate) — author with `/feature-refinement` or `/architect`.
2. The persona-as-agentProfile contract for digital-clone advisors (what's seedable, how
   personas stay core-level not named-hardcoded) — extends ADR 0031/0032.
3. The multi-advisor RAG composition over ADR 0038 (per-advisor corpus binding, citation,
   dispatch retrieval for N advisors in one run).
4. The multi-party chat orchestration ADR that consumes the new RFC(s) above.
Cite the ADR + phase in commit messages.

## Incorporate from market/research analysis (how others do this)
- **Digital-clone-of-a-person products** (e.g. Delphi-style "digital minds",
  Character-style personas): the differentiator is RAG grounding in the *real person's
  corpus* so answers echo their actual frameworks and can cite sources — design for
  citation/attribution, not just stylistic mimicry, to reduce fabricated quotes.
- **Multi-agent debate / mixture-of-agents / "society of minds" research**: panels of
  agents that critique and build on each other measurably improve reasoning vs. a single
  model. Lean into this — engineer for **productive disagreement and viewpoint diversity**
  to avoid groupthink/sycophancy/convergence (advisors should sometimes dissent), and
  add a **moderator/synthesizer** role that summarizes the panel and surfaces the
  decision/options for the user.
- **Synthetic-panel / advisory-board patterns**: support board templates (e.g. "founder
  board", "product board"), addressing a single panelist mid-thread, and follow-up rounds.
- **Persona fidelity & guardrails**: keep advisors in-character but ground claims in the
  corpus; flag when a persona is speculating beyond its sources.
- **Legal / ethical surface to address explicitly**: cloning real and especially LIVING
  individuals raises right-of-publicity, likeness, and defamation/misattribution
  concerns. Require clear "simulated persona, not the real person" framing/disclaimers,
  treat living vs. historical figures differently, and source corpora responsibly. Note
  these as design constraints + open questions in the ADR(s).

## Deliverable
Produce the ADR(s) (and RFC proposal stub(s) where the wire is touched), with: the
decision, alternatives weighed, the exact existing owners/seams each piece composes
(with constructor references), a phased implementation plan, the toggle/RBAC/sharing/
replay story, the RFC gate decision, and an open-questions checklist (incl. the legal/
ethical items). Do not write feature code in this pass.
