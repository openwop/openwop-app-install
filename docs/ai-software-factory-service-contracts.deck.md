---
marp: true
theme: default
paginate: true
size: 16:9
header: 'Service Contracts — A Backbone for Our AI Software Factory'
footer: 'Draft for review'
style: |
  section {
    font-size: 26px;
    padding: 56px 64px;
  }
  h1 {
    font-size: 46px;
  }
  h2 {
    font-size: 36px;
  }
  section.lead {
    text-align: center;
    justify-content: center;
  }
  section.lead h1 {
    font-size: 56px;
  }
  table {
    font-size: 22px;
  }
  blockquote {
    font-size: 24px;
    border-left: 6px solid #888;
    padding-left: 18px;
    color: #333;
  }
  code {
    font-size: 0.9em;
  }
  .takeaway {
    background: #f0f4ff;
    border-left: 6px solid #3b5bdb;
    padding: 10px 16px;
    font-weight: 600;
    margin-bottom: 18px;
  }
  .flow table {
    font-size: 18px;
  }
  .flow td, .flow th {
    padding: 5px 12px;
  }
---

<!-- _class: lead -->

# Service Contracts

## A Backbone for Our AI Software Factory

Making agent-driven development coordinate safely across systems

<br>

*As agents write more of our code, integration — not coding — becomes the constraint.*

---

## The shift: what changes when agents do the work

<div class="takeaway">The binding constraint moves from <em>writing code</em> to <em>coordinating change across dependents</em>.</div>

- Agents do a growing share of feature development.
- They have **no hallway conversations** and **no tribal knowledge**.
- Whatever they need to integrate safely must be **explicit, machine-readable, and enforced**.

---

## The inverted SDLC

<div class="takeaway">When agents compress Create + Operate, effort moves to the front — Plan &amp; Validate.</div>

| Phase | Traditional | Agent-era |
|---|---|---|
| Plan / Validate | a sliver | **the binding work** |
| Create | 10–15% | compressed |
| Operate | ~80% | compressed |

- **Intent → interface** — define *how systems interact*, not syntax.
- **Validate = continuous contract conformance** — not outcome testing.
- **Front-loaded decisions** — RFCs (external) + decision records (local) rule out the wrong path *before code exists*.
- The strict schema is a **"friction partner"** — it forces agreeable models to confront ambiguity.

---

## The three failure modes — the "why now"

<div class="takeaway">Each is survivable with humans in the loop; each is catastrophic at agent scale.</div>

1. **Silent contract drift** — a service changes shape; consumers break in production.
2. **Dishonest capability claims** — a system advertises what it doesn't actually honor.
3. **Uncoordinated rollouts** — a breaking change ships before consumers can adopt it.

---

## The thesis — one sentence

> Every shared service publishes a **versioned wire contract**, every contract changes
> through a governed **RFC process**, every implementation **proves** its claims, and
> every system embeds an **Architect agent** that negotiates change with its peers.

<div class="takeaway">Defining property: <strong>honesty is mechanical, not promised.</strong></div>

A system cannot advertise a capability it doesn't implement without failing its own tests.

---

## The four primitives

<div class="takeaway">Everything else in this deck is one of these four.</div>

| Primitive | What it is | Why the factory needs it |
|---|---|---|
| **The Contract** | Versioned, machine-readable spec of a service's wire surface | The source of truth an agent reads before integrating |
| **The RFC process** | The governed way a contract changes | Makes change deliberate, reviewable, reversible |
| **Conformance + Discovery** | Self-verification + honest advertisement | Turns "I support X" from a claim into a proof |
| **The Architect mesh** | One embedded agent per system + a coordination bus | Lets agents negotiate and roll out change |

---

## Layer 1 — how a local feature is born

<div class="takeaway">Roadmap → decision record → feature package → catalog. The same identifier survives the journey.</div>

- **Roadmap** rows keyed to a decision-record number + a stable feature id.
- **Decision records (ADRs)** — every feature has one, before/with the code.
- **Toggle system** — OFF / ON / BETA, backend-authoritative, replay-safe variant stamps.
- **Planning agents** author the *decision*, not the code — against a fixed 10-row matrix so nothing is skipped.

---

## Layer 2 — the contract gate *(the key slide)*

<div class="takeaway">Three buckets. Only one escalates — and it escalates into governance, not a surprise.</div>

| Bucket | Contract action |
|---|---|
| **Host-extension** (own namespaced path) | None |
| **Rides an accepted contract** | None — pure implementation |
| **Touches the wire** (new field, flag, endpoint, normative rule) | **New RFC, accepted before/with the work** |

The gate is wired to a **failing test** — an agent can't forget it.

---

## Layer 3 — how a contract is governed

<div class="takeaway">"Accepted" means provably real, not agreed in principle.</div>

**RFC lifecycle:**

`Draft` → `Active` *(wire locked)* → `Accepted` *(spec + schema + conformance + reference impl)*
( + `Withdrawn`, `Superseded` )

**Comment windows scaled to risk:**

- **7 days** — normative addition (backward-compatible)
- **30 days** — breaking change
- **90 days** — safety-fix breaking change

---

## Conformance + discovery — claims become proofs

<div class="takeaway">One shared suite + per-host evidence — not a package per team.</div>

- **One black-box conformance suite** per contract; any implementation runs it against itself.
- **Strict mode** flips capability-gated scenarios from *skip* → *fail* — proves non-vacuous coverage.
- **Discovery endpoint** (`.well-known/<service>`) advertises only **live, reachable** capabilities.
- Per-host results captured as evidence: conformance report + interop matrix + certification bundle.

---

## Opt-out is first-class

<div class="takeaway">A heterogeneous estate moves at different speeds without lying about it.</div>

- **Protocol level** — don't advertise the capability; cleanly refuse requests that assume it.
- **Conformance level** — explicit opt-out distinguishes:
  - *"honestly chose not to implement"* → skips, logged
  - *"claims it but doesn't deliver"* → loud failure
- A claim-plus-opt-out conflict is surfaced — a typo can't mask a real bug.

---

## Layer 4 — the Architect mesh

<div class="takeaway">This is what makes it an <em>AI</em> software factory, not a well-documented manual one.</div>

- **One embedded Architect agent per system** — knows its code, its contract, its dependencies.
- A contract owner's agent **shepherds consumers**, drafts/triages RFCs, classifies requests.
- **Coordination bus** — typed work-delegation messages (`task` · `claim` · `progress` · `done` · `blocked`).
- **Orchestrator/worker** rollouts in isolated worktrees; **architect-gated** answers grounded in real state.

---

## A contract change, end to end

<div class="takeaway">No step requires a human — every step <em>can</em> escalate to one.</div>

<div class="flow">

| # | Flow | What happens |
|---|---|---|
| 1 | Consumer | Gate classifies the feature as **"touches the wire"** |
| 2 | Consumer **→** Owner | `task`: *need field X on event Y* |
| 3 | Owner | Architect agent drafts an RFC (`Draft`) |
| 4 | Owner **→** Consumer | `progress`: *RFC open, 7-day window, schema diff* |
| 5 | Consumer | Reviews the schema diff; comments |
| 6 | Owner | `Active` *(wire locked)* **→** `Accepted` *(spec + schema + conformance + impl)* |
| 7 | Owner **→** Consumer | `done`: *Accepted, suite vX.Y published* |
| 8 | Consumer | Implements behind a toggle; advertises; passes strict conformance |
| 9 | Estate | Others adopt on their schedule — or **opt out honestly** |

</div>

---

## Who operates it — Builder Teams

<div class="takeaway">Small, mission-focused teams in the mesh — not permanent siloed departments.</div>

| Role | Owns |
|---|---|
| **Product Owner** | Business need; proposes new contracts / RFCs |
| **UX Designer** | Research, design quality; authors the design-system contract |
| **AI Engineer** | Runs the factory loop; implements local logic + integrates contracts |

- Shared functions (Security, DevOps, Legal, Architecture) act as **Contract Guardians**.
- They **embed standards as validation rules in the contract** — not as a review queue.
- The move throughout: **push human judgment into the contract** so review is continuous.

---

## The agentic harness — the transferable substrate

<div class="takeaway">The base model is a commodity; the harness is the edge.</div>

- **Context as contracts** — docs become machine-readable rules; agents load specific versions.
- **Skills as contract-consumers** — plan / architect / review act strictly within published boundaries.
- **Hooks as contractual obligations** — blocking checks are non-negotiable clauses (e.g. a security gate).
- **Memory** — survives session resets, aligned to current decision records + active RFCs.

---

## Proposed pilot — the ask

<div class="takeaway">Incremental. Each step delivers value on its own.</div>

1. **One shared service** with multiple consumers + the most integration pain → contract repo, schemas, minimal suite.
2. **Discovery convention** + strict-mode conformance for it and its consumers.
3. **Stand up the RFC process**; run one real change end to end.
4. **Embed Architect agents** in the owner + two consumers; wire the bus; run one agent-mediated rollout.
5. **Codify the local feature lifecycle** as a planning skill.
6. **Generalize** into a platform standard; onboard the next service.

*Thin central platform: it sets conventions, not approvals.*

---

<!-- _class: lead -->

## Open questions + decision requested

Windows & reviewer pool · Architect-agent autonomy boundary ·
Discovery/conformance hosting · Bus governance · Contract granularity

<br>

<div class="takeaway">Ask: approve the pilot and name the first service.</div>

---

<!-- _class: lead -->

# Backup

Roles & responsibilities · the 10-row feature evaluation matrix ·
reference-implementation track record · pilot cost estimate

---

## Backup — roles & responsibilities

| Role | Human or agent | Owns |
|---|---|---|
| **Service owner** | Team + Architect agent | Contract repo, RFC adjudication, conformance suite, releases |
| **Consumer system** | Team + Architect agent | Implementing accepted capabilities, honest advertisement, opt-out |
| **Platform architecture** | Human, light-touch | Cross-cutting standards, discovery + bus conventions |
| **Planning agent** | Agent | Roadmap item → accepted decision record + contract classification |
| **Orchestrator agent** | Agent | Decomposing a rollout into phases, driving it across the estate |

<div class="takeaway">Push work to the owner ↔ consumer edge; keep central platform thin.</div>

---

## Backup — common objections

- **"A lot of process overhead?"** — Most work is buckets 1–2 and never touches governance. Only real wire changes pay the RFC cost — and it buys a non-breaking rollout.
- **"Why not just OpenAPI / our schemas?"** — Schemas don't carry a change process, a conformance proof, honest advertisement, or an opt-out story. This wraps the schema in all four.
- **"What if a team won't adopt?"** — Opt-out is first-class and honest; a team can't silently half-implement.
- **"Who's accountable for the agents?"** — Accountability stays with the owning team; the Architect agent is a tool that team operates.
