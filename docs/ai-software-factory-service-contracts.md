# Service Contracts as the Backbone of an AI Software Factory

**A proposal for organization-wide adoption**

Status: Draft for review
Audience: Engineering leadership, platform architecture, service owners

---

## Executive summary

As AI agents take over a growing share of feature development, our binding constraint is
shifting from *writing code* to **coordinating change across the systems that depend on
each other.** Agents have no hallway conversations and no tribal knowledge; whatever they
need to integrate safely has to be explicit, machine-readable, and enforced — or they
will silently break consumers, advertise capabilities they don't actually honor, and ship
breaking changes nobody was ready for.

**This proposal makes those three failure modes structurally hard.** It defines a backbone
in which every shared service publishes a **versioned wire contract**, every contract is
changed through a governed **RFC process**, every implementation **proves** its claims via
a shared conformance suite and an honest discovery endpoint, and every system embeds an
**Architect agent** that negotiates contract changes with its peers over a coordination
bus — most of it without a human in the loop.

The defining property is that **honesty is mechanical, not promised**: a system cannot
advertise a capability it doesn't implement without failing its own tests, and a feature
that needs a wire change cannot ship until that change is provably accepted.

This is not theoretical. Every mechanism is drawn from a working reference implementation
that has governed a shared contract across a multi-system estate — with autonomous agents
doing the feature work — for an extended period. The specifics below are proven defaults.

**What we're asking for:** agreement to pilot this backbone on one shared service and two
of its consumers (a ~6-step incremental path, §9), and a small set of platform
conventions (discovery endpoint, conformance strict-mode, RFC lifecycle, coordination
bus). The investment compounds — every service that adopts it makes the next integration
cheaper and every agent in the estate more capable.

**The four primitives at a glance:**

| Primitive | What it is | Why the factory needs it |
|---|---|---|
| **The Contract** | A versioned, machine-readable spec of a service's wire surface | The single source of truth an agent reads before integrating |
| **The RFC process** | The governed way a contract changes | Makes change deliberate, reviewable, reversible |
| **Conformance + discovery** | Self-verification + honest advertisement | Turns "I support X" from a claim into a proof |
| **The Architect mesh** | One embedded agent per system + a coordination bus | Lets agents negotiate and roll out changes without humans |

---

## 1. The problem this solves

We are moving toward a software factory in which autonomous and semi-autonomous AI
agents do a large and growing share of feature development. That shifts the binding
constraint of the organization away from "can we write the code?" and toward **"can a
change to one service be coordinated safely across every system that depends on it?"**

In a hand-written codebase, integration knowledge lives in people's heads and in code
review. In an AI-driven factory, that knowledge has to be **explicit, machine-readable,
and enforced**, because the agent proposing a change has no hallway to walk down and no
tenured engineer's intuition about "what this will break."

Three failure modes dominate when this is left implicit:

1. **Silent contract drift** — a service changes its wire shape; consumers discover the
   break in production.
2. **Dishonest capability claims** — a system advertises a feature it doesn't actually
   honor, and integrators build against a fiction.
3. **Uncoordinated rollouts** — a breaking change ships before consumers can adopt it,
   or consumers are never told it exists.

This proposal describes a backbone that makes all three structurally hard, and that an
AI agent can operate without a human in the loop for the common case. **It is not
theoretical:** every mechanism below is drawn from a working reference implementation —
a shared service whose wire contract has been governed this way across a multi-system
estate for an extended period, with autonomous agents driving the feature work. The
specifics (comment-window lengths, status lifecycle, discovery endpoint, conformance
model) are presented as proven defaults, not aspirations.

### 1.1 The inverted SDLC — why this matters now

In a traditional software life cycle, most effort goes into running and maintaining what
already exists: roughly **80% to Operate, 10–15% to Create**, and a sliver to Plan and
Validate. When AI agents compress Create *and* Operate — generating implementation and
absorbing operational toil — that split inverts. The binding work moves to the **front of
the pipeline: Plan and Validate.**

Service contracts are what make that shift tangible and safe:

- **From intent to interface.** Engineers spend less time writing syntax and more time
  formally defining how systems interact. The contract becomes the absolute source of
  truth for every external boundary; local design is driven by clear intent.
- **Validate = continuous contract conformance.** Validation stops being "did the output
  look right?" and becomes automated, continuous verification that an implementation
  strictly conforms to both its local specification and the shared contracts it touches.
- **Front-loaded decisions.** You ask the hardest questions first — external change via
  RFCs, local structure via decision records — ruling out the wrong approach *before any
  code is generated.* The strict, machine-readable contract is a **"friction partner"**:
  because agreeable models tend to smooth over ambiguity, the schema forces explicit
  structural decisions that would otherwise be deferred to production.

The rest of this document is the architecture, operating model, and harness that make an
inverted SDLC work across many systems at once.

---

## 2. The core thesis

> **Every shared service publishes its own versioned wire contract. Every contract is
> governed by an RFC process. Every service, app, and tool embeds an Architect agent
> that understands its own code, its contract, and its dependencies — and these agents
> negotiate contract changes with each other over a shared coordination bus.**

Four primitives follow from that sentence, and the rest of this document defines each:

| Primitive | What it is | Why the factory needs it |
|---|---|---|
| **The Contract** | A versioned, machine-readable spec of a service's wire surface | The single source of truth an agent reads before integrating |
| **The RFC process** | The governed way a contract changes | Makes change deliberate, reviewable, and reversible |
| **Conformance + discovery** | Self-verification + honest advertisement | Turns "I support X" from a claim into a proof |
| **The Architect mesh** | One embedded agent per system + a coordination bus | Lets agents negotiate and roll out changes without humans |

A key design principle threads through all four: **honesty is mechanically enforced, not
promised.** A system cannot advertise a capability it does not actually implement
without failing its own test suite. This is the property that makes an agent-operated
estate trustworthy.

---

## 3. Layer 1 — How a local feature is born

Before a feature ever touches a shared contract, it goes through a disciplined local
lifecycle inside the consuming system. This layer matters because **it is where the
"do we need a contract change?" question gets forced early** — not discovered late.

The lifecycle uses four artifacts, each of which an agent reads and writes:

### 3.1 The Roadmap

A sequenced plan of capabilities to build, maintained as a checked-in document. Its
central table is treated as a contract in its own right: **every row is keyed to a
decision-record number and a stable feature identifier**, with an explicit status
(planned / in-progress / done / exists-extend) and a pointer to the dependency it rides.

The flow is strict: **roadmap row → decision record → feature package → feature
catalog.** The same stable identifier survives that entire journey, so a feature is
traceable from "someone wanted it" to "it shipped" to "it's toggled on for these users."

### 3.2 The Feature Catalog + toggle system

A checked-in catalog of every product feature and the runtime system that gates it.
The recommended toggle model, proven in the reference implementation:

- **Three states** — OFF (routes return 404, nav hidden), ON (all eligible callers),
  BETA (badged; open or cohort-restricted).
- **The backend is the authority.** Toggle and variant resolution happen server-side
  from the authenticated principal; the frontend receives a read-only resolved map for
  rendering only. An agent cannot accidentally leak a feature by editing client code.
- **Multivariant splitting** — weighted variants whose integer weights sum to exactly
  100, with deterministic sticky bucketing (`hash(unit + ':' + toggle + ':' + salt)`),
  per-toggle bucket unit (user or tenant) and salt.
- **Replay-safe stamps** — the resolved variant is stamped into immutable run metadata
  at creation and read back verbatim on replay, never recomputed. This is what lets an
  agent re-run historical work and get historically-correct behavior.

The catalog also carries the **"Adding a feature"** contract, including the rule that
forces the contract question (Layer 2).

### 3.3 The decision-record discipline (ADRs)

Every non-trivial change is recorded as an **Architecture Decision Record** before or
with the implementation: one file per decision, sequentially numbered, opening with a
`Status:` line that moves `Proposed → Accepted → implemented` (or `Superseded by NNNN`).

Two disciplines make ADRs agent-safe at scale:

- **Every feature MUST have an ADR.** A feature package with no decision record is the
  exact drift the system guards against. Code-to-decision links are cited in commit
  messages so the trail is greppable.
- **Correct, don't rewrite history.** If implementation overturns a decision, an inline
  correction note is added rather than silently editing the original rationale. The
  reasoning trail is the point — it is what a future agent reads to understand *why*.

### 3.4 Planning skills that author the decision, not the code

The factory separates **planning** from **building**. A planning agent (invoked as a
skill) takes a feature from concept to a fully-scoped, accepted decision record — and
explicitly does **not** write the implementation. It evaluates every proposed feature
against a fixed matrix so nothing is skipped:

1. Feature-package boundaries (self-contained; may depend on core, core must not depend
   on it)
2. Toggle + admin UI (stable id, default OFF, bucket unit, variants, salt)
3. Workflow/orchestration surface, **advertised at the discovery endpoint**
4. Capability packs (signed, integrity-checked)
5. Chat/AI integration envelopes + schema handshake
6. Agent persona pack (honestly "none" if not an AI surface)
7. Public surface (path prefixes, tenant derivation, uniform 404s, rate limits)
8. RBAC + tenant isolation (fail-closed)
9. Replay / fork safety
10. Frontend integration + design-system cohesion

**Row 3 and the matrix's dedicated contract-gate step are where Layer 1 hands off to
Layer 2.**

---

## 4. Layer 2 — The contract gate (the local→remote seam)

This is the hinge of the whole proposal. A decision record is a decision **for one
system**. It is **not** a license to change a shared contract.

When a planning agent scopes a feature, it must classify the work into exactly one of
three buckets:

| Bucket | Example | Contract action |
|---|---|---|
| **Host-extension** | A route under the system's own vendor-namespaced path | None — non-normative, never touches the wire |
| **Rides an accepted contract** | Implementing an auth profile from an already-accepted RFC | None — pure implementation work |
| **Touches the wire** | A new event field, capability flag, endpoint contract, or normative requirement | **A new RFC against the owning service's contract, accepted *before or with* the implementation** |

The enforcing principle: **advertising a capability whose contract change hasn't been
accepted is a dishonest wire claim** — and (per Layer 3) the system's own conformance
suite will fail it under strict mode. The gate is therefore not a policy an agent can
forget; it is wired to a test that goes red.

This single classification step is what keeps an AI software factory from
fragmenting its own integration surface. Most feature work resolves to bucket 1 or 2 and
proceeds entirely within the owning team. Only genuine wire changes escalate — and they
escalate into a governed, multi-party process rather than a surprise.

---

## 5. Layer 3 — How a contract is governed

A shared service's contract lives as its own git project, separate from any single
consumer. This is the artifact every integrating agent treats as ground truth.

### 5.1 Repository shape

A contract repo holds: the normative spec prose, the machine-readable schemas, the
conformance suite, and the RFC archive — plus governance docs (contribution rules,
maintainer roster, publishing/release process, compatibility policy). The publishable
artifact is small and stable on purpose: **the schemas and conformance suite are the
contract; everything else is documentation or tooling.**

### 5.2 The RFC process

Contract changes are proposed as **RFCs** — one file per change, authored from a
template, numbered sequentially, with numbers never reused. The pull request *is* the
comment thread.

**Status lifecycle** (this specific progression is the proven one):

| Status | Meaning |
|---|---|
| `Draft` | Under discussion; wire shapes may still move |
| `Active` | Accepted by maintainers; **wire shapes locked**, implementation pending |
| `Accepted` | Implemented, reflected in the spec, and covered by conformance |
| `Withdrawn` | Author/maintainers withdrew it |
| `Superseded` | Replaced by a later RFC (with a forward pointer) |

An RFC reaches `Accepted` only when an explicit checklist is satisfied: spec text merged,
schemas updated, **at least one conformance scenario added**, changelog entry written,
and the reference implementation passes. "Accepted" therefore means *provably real*, not
*agreed in principle*.

### 5.3 Comment windows scaled to risk

Review time is proportional to blast radius — a proven default schedule:

- **7 days** for a normative *addition* (additive, backward-compatible).
- **30 days** for a *breaking* change.
- **90 days** for a *safety-fix* breaking change.

(The reference implementation also documents a bootstrap waiver for the early, sole-
maintainer phase, with a tripwire that forces a real review window once external
reviewers exist. An organization adopting this should size windows to its own reviewer
pool but keep the risk-proportionality principle.)

### 5.4 Conformance: claims become proofs

There is **one** shared, black-box conformance suite per contract — published as a
versioned package that any implementation, in any language, runs against itself. It does
**not** depend on the reference implementation.

> **Correction to a common misconception:** the model is *one shared suite + per-host
> evidence*, **not** a separate conformance package per implementer. Each implementer
> records its *results* — as a checked-in conformance report, an interoperability matrix
> row, and a machine-readable **certification bundle** that binds a profile claim to
> {suite version, pass list, host commit, discovery document}. This is far cheaper to
> maintain and impossible to fake.

The suite is **capability-gated**: optional-profile scenarios run only when a host
advertises the matching profile. A **strict mode** (a single environment flag) flips
those gated scenarios from *skip* to *fail* when the host doesn't advertise — which is
exactly how a host proves full, non-vacuous coverage rather than passing by omission.

### 5.5 Capability discovery + honest advertisement

Every implementation exposes a single public, unauthenticated JSON endpoint — a
`.well-known/<service>` document — that advertises what it actually supports:
protocol version, supported envelopes, schema versions, base limits, and optional
capability families at the document root. Consumers detect optional features here and
must never assume an unadvertised capability.

Crucially, the document is **assembled from live host state**, not hand-maintained: a
capability appears only when its implementation is actually reachable. Combined with
strict conformance mode, this closes the loop — **a system literally cannot advertise
what it doesn't honor without failing its own tests.**

### 5.6 Opting out / declining a change

Adoption is never forced. A system declines a contract capability in two complementary
ways:

- **Protocol level** — it simply doesn't advertise the capability. A normative refusal
  contract requires it to cleanly reject requests that assume the unadvertised feature,
  rather than misbehave.
- **Conformance level** — an explicit opt-out list distinguishes *"this host honestly
  chose not to implement this profile"* (skips, with a logged honest-opt-out line) from
  *"this host claims it but doesn't deliver"* (a loud failure). A claim-plus-opt-out
  conflict is surfaced as a warning so a typo can't mask a real bug.

This is what lets a heterogeneous estate move at different speeds without lying about it.

### 5.7 Release & versioning

Contracts version with SemVer aligned to the contract major. Additions are minor bumps;
breaking changes are majors with a documented support window for the prior major.
Publishing is tag-driven and idempotent (re-running a publish that already shipped is a
no-op), which matters because the publisher is frequently an agent.

---

## 6. Layer 4 — The Architect mesh: agents that negotiate contracts

The previous layers describe artifacts. This layer describes the **operators** — and is
what makes the whole thing an *AI* software factory rather than a well-documented manual
one.

### 6.1 One embedded Architect agent per system

**Every app, service, and tool in the estate embeds an Architect agent** — a skill that
understands that system's code, its contract (if it owns one), and its dependencies. An
Architect agent can:

- Answer questions about its own system's behavior, contract, and capabilities.
- Review a proposed change for boundary, coupling, replay, authorization, and
  conformance issues before it lands.
- For a contract-owning service: **shepherd consumer systems through requesting a
  contract change**, draft and triage new RFCs, and judge whether a request needs a new
  RFC, rides an accepted one, or is purely local (the Layer 2 classification).

The same planning, decision-record, and contract-gate disciplines above are operated
*by these agents* — the human role shifts from doing the work to setting direction and
adjudicating the rare hard case.

### 6.2 The coordination bus

Architect agents negotiate over a shared **coordination bus** — a lightweight,
append-only message channel between agent sessions, with:

- **Distinct identities** per participating system.
- A **handshake** when an agent joins.
- **Reply threading** so a negotiation is a coherent conversation.
- **Typed messages** — chat, plus a work-delegation vocabulary: `task`, `claim`,
  `progress`, `done`, `blocked`.
- An **orchestrator/worker** model: the session that opens a coordination channel owns
  task assignment; it decomposes a rollout into phases, posts tasks (directed or
  claimable), arbitrates competing claims, and releases the next phase when the current
  one completes. Workers execute in **isolated worktrees** so parallel work never
  corrupts a shared checkout.
- **Architect-gated auto-replies** — an inbound question is first run through the
  receiving system's own Architect agent, so the answer is grounded in that system's
  real state rather than guessed.

### 6.3 A contract change, end to end

Putting it together, here is how a feature that needs a wire change flows through the
factory with agents doing the work:

| # | Where | What happens | Message on the bus |
|---|---|---|---|
| 1 | **Consumer** | Planning agent scopes a feature; the contract gate classifies it as "touches the wire." | — |
| 2 | **Consumer → Owner** | Consumer requests the change. | `task`: *"need field X on event Y; rationale …"* |
| 3 | **Owner** | Owner's Architect agent triages and drafts an RFC (`Draft`). | `progress`: *"RFC NNNN open, 7-day window, schema diff"* |
| 4 | **Consumer** | Reviews the schema diff, confirms it satisfies the feature, comments. | — |
| 5 | **Owner** | Window closes; RFC → `Active` (wire locked) → `Accepted` once spec + schema + conformance scenario + reference impl land. | `done`: *"RFC NNNN Accepted, suite vX.Y published"* |
| 6 | **Consumer** | Implements behind a toggle; advertises the new capability at its discovery endpoint; passes the new conformance scenario under strict mode. | — |
| 7 | **Estate** | Other consumers adopt on their own schedule, or opt out honestly. The owner orchestrates the rollout as delegated phases across the estate. | — |

No step in that sequence requires a human, though any step *can* escalate to one. The
guarantees that make it safe — wire locked at `Active`, capability provable at
`Accepted`, advertisement tied to live state, opt-out honest — are all mechanical.

---

## 7. Roles & responsibilities

| Role | Human or agent | Owns |
|---|---|---|
| **Service owner** | Team + its Architect agent | The contract repo, RFC adjudication, the conformance suite, releases |
| **Consumer system** | Team + its Architect agent | Implementing accepted capabilities, honest advertisement, passing conformance, opt-out decisions |
| **Platform architecture** | Human, light-touch | The cross-cutting standards (this document), the discovery convention, the bus convention |
| **Planning agent** | Agent | Turning a roadmap item into an accepted decision record and the correct contract classification |
| **Orchestrator agent** | Agent | Decomposing a rollout into phases and driving it across the estate over the bus |

The deliberate move here is to push as much as possible to the **owner ↔ consumer**
edge, mediated by their Architect agents, and keep central platform architecture thin —
it sets conventions, not approvals.

### 7.1 The Builder Team operating model

To run at this pace without growing bureaucracy, replace siloed departments with small,
**mission-focused Builder Teams** operating inside the Architect Mesh. A team forms around
a specific problem for a short cycle, then dissolves — it does not become a permanent,
heavyweight planning workstream. A minimal team is three roles:

| Role | Owns |
|---|---|
| **Product Owner** | The business need; proposes new contracts / RFCs |
| **UX Designer** | Research, design quality; authors the UI / design-system contract |
| **AI Engineer** | Runs the factory loop — implements local logic, integrates external contracts |

Teams work independently and reach shared functions — Architecture, Security, DevOps,
Legal — through the mesh, **using RFCs to request changes from other systems** rather than
standing meetings.

### 7.2 Shared functions as Contract Guardians

The shared functions are not review bottlenecks. They are **Contract Guardians**: instead
of gating every change through a queue, they **embed their standards directly as validation
rules inside the shared contracts and the local templates** — a mandatory security check
becomes a non-negotiable clause in the contract, enforced automatically on every change.
This is the organizational expression of the same principle that runs through the whole
backbone: **move the human judgment into the contract**, so review becomes continuous and
automatic rather than a hand-off.

### 7.3 The agentic harness — the transferable substrate

What lets a Builder Team operate this way is a version-controlled **agentic harness**, and
it is the most directly reusable artifact of this proposal:

- **Context as contracts** — key documents (architecture notes, decision records, working
  agreements) become machine-readable rules; an agent loads the *specific versions*
  relevant to its task.
- **Skills as contract-consumers** — reusable agent skills (plan, architect, review)
  interact with local code and external services strictly according to published contracts.
- **Hooks as contractual obligations** — blocking/warning checks become non-negotiable
  clauses embedded in a workflow or a shared contract (e.g. a mandatory security gate).
- **Memory** — survives session resets by keeping project state aligned with the current
  decision records and active RFCs.

---

## 8. Why this is the right backbone for an AI factory

- **It makes integration knowledge explicit and machine-readable.** An agent reads the
  contract, the discovery document, and the conformance suite — it doesn't need tribal
  knowledge.
- **It makes honesty structural.** Advertisement is tied to live state; conformance
  strict mode fails dishonest claims; the contract gate is wired to a red test. Agents
  can't drift the estate into lies.
- **It makes change deliberate and reversible.** RFC status lifecycle + comment windows
  scaled to risk + "correct, don't rewrite history" give a full, auditable reasoning
  trail.
- **It makes coordination an agent-native operation.** The bus + orchestrator model lets
  agents roll out a contract change across many systems as delegated, isolated work —
  the thing humans are worst at doing reliably and agents can do tirelessly.
- **It respects autonomy.** Opt-out is honest and first-class; consumers move at their
  own pace without breaking the estate or misrepresenting themselves.

---

## 9. Proposed adoption path

A pragmatic, incremental rollout — each step delivers value independently:

1. **Pick one shared service** that already has multiple consumers and the most
   integration pain. Stand up its contract repo, schemas, and a minimal conformance
   suite. *(Proves the model on a real dependency.)*
2. **Adopt the discovery convention** (`.well-known/<service>`) and the strict-mode
   conformance flag for that one service and its consumers. *(Turns claims into proofs.)*
3. **Stand up the RFC process** for that contract — template, status lifecycle, risk-
   scaled comment windows. Run one real change through it end to end.
4. **Embed an Architect agent** in the owner and in two consumers. Wire the coordination
   bus between them. Run one contract change as an agent-mediated rollout.
5. **Codify the local feature lifecycle** (roadmap → decision record → contract gate) as
   a planning skill, so new features hit the gate automatically.
6. **Generalize the conventions** into a platform standard and onboard the next service.

The investment compounds: every service that adopts the backbone makes the next
integration cheaper and every agent in the estate more capable, because the contracts it
needs are now readable, provable, and negotiable.

---

## 10. Open questions for review

- **Reviewer pool & windows.** What comment-window lengths fit our reviewer capacity?
  Do we need the bootstrap waiver for newly-stood-up contracts, and what's its tripwire?
- **Architect-agent autonomy boundary.** Which contract decisions may an Architect agent
  make autonomously, and which must escalate to a human owner?
- **Discovery & conformance hosting.** Where do certification bundles and interoperability
  matrices live, and who audits them?
- **Bus governance.** Is the coordination bus per-rollout, per-service, or estate-wide?
  How do we handle identity, authorization, and audit on it?
- **Contract granularity.** What counts as "a service worth its own contract" vs. a
  capability inside an existing one?

---

## Appendix A — Suggested slide outline

A ~14-slide deck for a 20–25 minute leadership/architecture review. Each slide lists its
one-line takeaway and the speaker's supporting points.

**1. Title — "Service Contracts: A Backbone for Our AI Software Factory"**
   - Subtitle: making agent-driven development coordinate safely across systems.
   - One line: *"As agents write more of our code, integration — not coding — becomes the constraint."*

**2. The shift — what changes when agents do the work**
   - Binding constraint moves from *writing code* → *coordinating change across dependents*.
   - Agents have no hallway, no tribal knowledge. Integration must be explicit, machine-readable, enforced.

**3. The three failure modes (the "why now")**
   - Silent contract drift · dishonest capability claims · uncoordinated rollouts.
   - Each is survivable with humans-in-the-loop; each is catastrophic at agent scale.

**4. The thesis — one sentence**
   - Versioned contracts + RFC governance + provable conformance + an agent mesh that negotiates change.
   - Defining property: **honesty is mechanical, not promised.**

**5. The four primitives (the at-a-glance table)**
   - Contract · RFC process · Conformance+Discovery · Architect mesh.
   - "Everything else in the deck is one of these four."

**6. Layer 1 — how a local feature is born**
   - Roadmap → decision record (ADR) → feature package → catalog; toggles + replay-safe stamps.
   - Planning agents author the *decision*, not the code; a fixed evaluation matrix means nothing is skipped.

**7. Layer 2 — the contract gate (the key slide)**
   - Three buckets: host-extension (no change) · rides-accepted (no change) · touches-the-wire (RFC required).
   - The gate is wired to a failing test — an agent can't forget it.

**8. Layer 3 — how a contract is governed**
   - RFC lifecycle: Draft → Active (wire locked) → Accepted (provably real).
   - Comment windows scaled to risk: 7 / 30 / 90 days.

**9. Conformance + discovery — claims become proofs**
   - One shared black-box suite + per-host evidence (not a package per team).
   - Strict mode fails dishonest claims; discovery advertises only live, reachable capabilities.

**10. Opt-out is first-class**
   - Honest decline at the protocol level + honest-opt-out vs. broken-claim at the conformance level.
   - Heterogeneous estate moves at different speeds without lying.

**11. Layer 4 — the Architect mesh**
   - One embedded Architect agent per system; a coordination bus with typed work-delegation messages.
   - Orchestrator/worker rollouts in isolated worktrees; architect-gated answers.

**12. A contract change, end to end (the sequence diagram)**
   - Walk the consumer → bus → owner flow; emphasize *no step requires a human, every step can escalate*.

**13. Proposed pilot (the ask)**
   - One shared service + two consumers; the 6-step incremental path.
   - Thin central platform: sets conventions, not approvals.

**14. Open questions + decision requested**
   - Windows, agent-autonomy boundary, bus governance, contract granularity.
   - Ask: approve the pilot and name the first service.

**Optional backup slides:** the full roles/responsibilities table; the 10-row feature
evaluation matrix; the reference-implementation track record; cost/effort estimate for
the pilot.

---

## Appendix B — Speaker notes for the hardest questions

- *"Isn't this a lot of process overhead?"* — Most feature work resolves to buckets 1–2
  of the contract gate and never touches governance. Only genuine wire changes pay the
  RFC cost, and that cost buys a coordinated, non-breaking rollout.
- *"Why not just use OpenAPI / schemas we already have?"* — Schemas are necessary but not
  sufficient. They don't carry a change process, a conformance proof, honest
  advertisement, or an opt-out story. This backbone wraps the schema in all four.
- *"What if a team won't adopt?"* — Opt-out is first-class and honest. A non-adopting
  team simply doesn't advertise the capability and cleanly refuses requests that assume
  it — it can't silently half-implement.
- *"Who runs the agents and who's accountable?"* — Accountability stays with the owning
  team; the Architect agent is a tool that team operates, not an unowned actor. Humans
  set direction and adjudicate the rare hard case.
